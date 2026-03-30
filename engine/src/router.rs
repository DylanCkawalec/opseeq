use crate::config::{KernelConfig, ProviderConfig};
use crate::providers;
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

    let max_retries = 2u32;
    let base_delay = std::time::Duration::from_millis(500);
    let mut last_err = String::new();

    for attempt in 0..=max_retries {
        match providers::call_provider(client, provider, req, trace_id).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = e;
                if attempt < max_retries {
                    let delay = base_delay * 2u32.pow(attempt);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

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
