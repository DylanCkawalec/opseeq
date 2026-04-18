use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

use crate::config::{KernelConfig, ProviderConfig};
use crate::events::{self, RuntimeEvent};
use crate::providers;
use crate::run_state::{RunEnvelope, RunStatus};
use crate::types::{ChatRequest, ChatResponse, ModelEntry};

// ── O(1) model resolution ────────────────────────────────────────

fn resolve_provider<'a>(model: &str, config: &'a KernelConfig) -> Option<&'a ProviderConfig> {
    if let Some(&idx) = config.model_map.get(model) {
        return config.providers.get(idx);
    }
    for p in &config.providers {
        let prefix = model.split('/').next().unwrap_or("");
        if !prefix.is_empty() && p.models.iter().any(|m| m.starts_with(prefix)) {
            return Some(p);
        }
    }
    config.providers.first()
}

// ── Retry classification ─────────────────────────────────────────

fn is_retryable(error: &str) -> bool {
    for code in ["HTTP 400:", "HTTP 401:", "HTTP 403:", "HTTP 404:", "HTTP 422:"] {
        if error.contains(code) {
            return false;
        }
    }
    true
}

fn jitter_factor() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    0.5 + (nanos as f64 % 1000.0) / 2000.0
}

// ── Quality scoring (TraceRank C(z) aligned) ─────────────────────

const LATENCY_BASELINE_MS: f64 = 2000.0;

fn compute_quality_score(resp: &ChatResponse, latency_ms: u64) -> f64 {
    let mut score = 0.0;
    let mut factors = 0u32;

    let latency_factor = (LATENCY_BASELINE_MS / (latency_ms as f64).max(100.0)).min(1.0);
    score += latency_factor;
    factors += 1;

    if let Some(usage) = &resp.usage {
        if usage.prompt_tokens > 0 {
            let ratio = (usage.completion_tokens as f64 / usage.prompt_tokens as f64).min(2.0) / 2.0;
            score += ratio;
            factors += 1;
        }
    }

    let has_content = resp
        .choices
        .first()
        .map(|c| !c.message.content.trim().is_empty())
        .unwrap_or(false);
    score += if has_content { 1.0 } else { 0.0 };
    factors += 1;

    if factors > 0 {
        score / factors as f64
    } else {
        0.0
    }
}

fn active_tau<'a>(config: &'a KernelConfig, purpose: Option<&'a str>) -> (&'a str, f64) {
    match purpose {
        Some("deploy") | Some("production_deploy") => ("deploy", config.tau_deploy),
        Some("production") | Some("pipeline") | Some("mermate_pipeline") => {
            ("production", config.tau_production)
        }
        _ => ("explore", config.tau_explore),
    }
}

// ── Cascade inference with smart retry ───────────────────────────

pub async fn route_inference(
    client: &reqwest::Client,
    config: &KernelConfig,
    req: &ChatRequest,
    trace_id: &str,
) -> Result<ChatResponse, String> {
    let primary = resolve_provider(&req.model, config)
        .ok_or_else(|| format!("no provider for model: {}", req.model))?;

    let mut cascade: Vec<&ProviderConfig> = vec![primary];
    for p in &config.providers {
        if !cascade.iter().any(|c| c.name == p.name) {
            cascade.push(p);
        }
    }

    let max_retries_per = 2u32;
    let base_delay = Duration::from_millis(500);
    let mut last_err = String::new();
    let start = Instant::now();

    let mut envelope = RunEnvelope::new(trace_id.to_string(), req.model.clone());

    for provider in &cascade {
        envelope.resolved_provider = Some(provider.name.clone());
        envelope.status = RunStatus::InFlight;

        events::emit(&RuntimeEvent::InferenceRequested {
            trace_id: trace_id.to_string(),
            model: req.model.clone(),
            provider: provider.name.clone(),
            purpose: req.purpose.clone(),
        });

        for attempt in 0..=max_retries_per {
            envelope.retry_count += 1;
            match providers::call_provider(client, provider, req, trace_id).await {
                Ok(resp) => {
                    let latency_ms = start.elapsed().as_millis() as u64;
                    envelope.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    envelope.latency_ms = Some(latency_ms);
                    envelope.resolved_model = Some(resp.model.clone());
                    envelope.status = RunStatus::Completed;

                    let tokens = resp.usage.as_ref().map(|u| u.total_tokens);
                    events::emit(&RuntimeEvent::InferenceCompleted {
                        trace_id: trace_id.to_string(),
                        model: resp.model.clone(),
                        provider: provider.name.clone(),
                        latency_ms,
                        tokens,
                        purpose: req.purpose.clone(),
                    });

                    let quality = compute_quality_score(&resp, latency_ms);
                    let (tier, threshold) = active_tau(config, req.purpose.as_deref());
                    let passed = quality >= threshold;
                    events::emit(&RuntimeEvent::QualityScored {
                        trace_id: trace_id.to_string(),
                        provider: provider.name.clone(),
                        model: resp.model.clone(),
                        score: (quality * 1000.0).round() / 1000.0,
                        tau_tier: tier.to_string(),
                        tau_threshold: threshold,
                        passed,
                        latency_ms,
                    });

                    if !passed {
                        eprintln!(
                            "[opseeq-core] quality_warning trace_id={} score={:.3} < tau_{}={:.2}",
                            trace_id, quality, tier, threshold
                        );
                    }

                    return Ok(resp);
                }
                Err(e) => {
                    events::emit(&RuntimeEvent::ProviderFailed {
                        trace_id: trace_id.to_string(),
                        provider: provider.name.clone(),
                        error: e.clone(),
                        attempt,
                    });

                    let retryable = is_retryable(&e);
                    eprintln!(
                        "[opseeq-core] provider_{} trace_id={} provider={} attempt={}/{} retryable={} error={}",
                        if retryable { "retry" } else { "cascade" },
                        trace_id,
                        provider.name,
                        attempt + 1,
                        max_retries_per + 1,
                        retryable,
                        &e
                    );
                    last_err = e;

                    if !retryable || attempt >= max_retries_per {
                        break;
                    }

                    let delay = base_delay * 2u32.pow(attempt);
                    let actual =
                        Duration::from_millis((delay.as_millis() as f64 * jitter_factor()) as u64);
                    tokio::time::sleep(actual).await;
                }
            }
        }
    }

    envelope.completed_at = Some(chrono::Utc::now().to_rfc3339());
    envelope.latency_ms = Some(start.elapsed().as_millis() as u64);
    envelope.status = RunStatus::Failed(last_err.clone());

    eprintln!(
        "[opseeq-core] inference_exhausted trace_id={} cascade_depth={} total_ms={}",
        trace_id,
        cascade.len(),
        start.elapsed().as_millis()
    );

    Err(last_err)
}

// ── TTL model cache ──────────────────────────────────────────────

pub struct ModelCache {
    entries: Vec<ModelEntry>,
    fetched_at: Instant,
}

const MODEL_CACHE_TTL: Duration = Duration::from_secs(60);

pub fn new_model_cache() -> Arc<RwLock<Option<ModelCache>>> {
    Arc::new(RwLock::new(None))
}

pub async fn list_models_cached(
    config: &KernelConfig,
    client: &reqwest::Client,
    cache: &Arc<RwLock<Option<ModelCache>>>,
) -> Vec<ModelEntry> {
    {
        let guard = cache.read().await;
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < MODEL_CACHE_TTL {
                return c.entries.clone();
            }
        }
    }

    let entries = build_model_list(config, client).await;

    {
        let mut guard = cache.write().await;
        *guard = Some(ModelCache {
            entries: entries.clone(),
            fetched_at: Instant::now(),
        });
    }

    entries
}

async fn build_model_list(config: &KernelConfig, client: &reqwest::Client) -> Vec<ModelEntry> {
    let mut entries: Vec<ModelEntry> = config
        .providers
        .iter()
        .flat_map(|p| {
            p.models.iter().map(move |m| ModelEntry {
                id: m.clone(),
                provider: p.name.clone(),
            })
        })
        .collect();

    if let Ok(ollama_models) =
        crate::providers::ollama::list_models(client, &config.ollama_url).await
    {
        for om in ollama_models {
            if !entries.iter().any(|e| e.id == om.name) {
                entries.push(ModelEntry {
                    id: om.name,
                    provider: "ollama".into(),
                });
            }
        }
    }

    entries
}

pub fn list_models(config: &KernelConfig) -> Vec<ModelEntry> {
    config
        .providers
        .iter()
        .flat_map(|p| {
            p.models.iter().map(move |m| ModelEntry {
                id: m.clone(),
                provider: p.name.clone(),
            })
        })
        .collect()
}
