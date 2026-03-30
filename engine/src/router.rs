use crate::config::{KernelConfig, ProviderConfig};
use crate::events::{self, RuntimeEvent};
use crate::providers;
use crate::run_state::{RunEnvelope, RunStatus};
use crate::types::{ChatRequest, ChatResponse, ModelEntry};

fn resolve_provider<'a>(model: &str, config: &'a KernelConfig) -> Option<&'a ProviderConfig> {
    for p in &config.providers {
        if p.models.iter().any(|m| m == model) {
            return Some(p);
        }
    }
    for p in &config.providers {
        if p.models.iter().any(|m| model.starts_with(m.split('/').next().unwrap_or(""))) {
            return Some(p);
        }
    }
    config.providers.first()
}

pub async fn route_inference(
    client: &reqwest::Client,
    config: &KernelConfig,
    req: &ChatRequest,
    trace_id: &str,
) -> Result<ChatResponse, String> {
    let provider = resolve_provider(&req.model, config)
        .ok_or_else(|| format!("no provider for model: {}", req.model))?;

    let mut envelope = RunEnvelope::new(trace_id.to_string(), req.model.clone());
    envelope.resolved_provider = Some(provider.name.clone());
    envelope.started_at = Some(chrono::Utc::now().to_rfc3339());
    envelope.status = RunStatus::InFlight;

    events::emit(&RuntimeEvent::InferenceRequested {
        trace_id: trace_id.to_string(),
        model: req.model.clone(),
        provider: provider.name.clone(),
        purpose: req.purpose.clone(),
    });

    let max_retries = 2u32;
    let base_delay = std::time::Duration::from_millis(500);
    let mut last_err = String::new();
    let start = std::time::Instant::now();

    for attempt in 0..=max_retries {
        envelope.retry_count = attempt;
        match providers::call_provider(client, provider, req, trace_id).await {
            Ok(resp) => {
                envelope.completed_at = Some(chrono::Utc::now().to_rfc3339());
                envelope.latency_ms = Some(start.elapsed().as_millis() as u64);
                envelope.resolved_model = Some(resp.model.clone());
                envelope.status = RunStatus::Completed;

                let tokens = resp.usage.as_ref().map(|u| u.total_tokens);
                events::emit(&RuntimeEvent::InferenceCompleted {
                    trace_id: trace_id.to_string(),
                    model: resp.model.clone(),
                    provider: provider.name.clone(),
                    latency_ms: start.elapsed().as_millis() as u64,
                    tokens,
                    purpose: req.purpose.clone(),
                });

                return Ok(resp);
            }
            Err(e) => {
                events::emit(&RuntimeEvent::ProviderFailed {
                    trace_id: trace_id.to_string(),
                    provider: provider.name.clone(),
                    error: e.clone(),
                    attempt,
                });
                last_err = e;
                if attempt < max_retries {
                    let delay = base_delay * 2u32.pow(attempt);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    envelope.completed_at = Some(chrono::Utc::now().to_rfc3339());
    envelope.latency_ms = Some(start.elapsed().as_millis() as u64);
    envelope.status = RunStatus::Failed(last_err.clone());

    Err(last_err)
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
