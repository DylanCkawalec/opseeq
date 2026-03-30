pub mod openai;
pub mod anthropic;
pub mod ollama;

use crate::config::ProviderConfig;
use crate::types::{ChatRequest, ChatResponse};

pub async fn call_provider(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    req: &ChatRequest,
    trace_id: &str,
) -> Result<ChatResponse, String> {
    let start = std::time::Instant::now();

    let result = if provider.name == "anthropic" || provider.base_url.contains("anthropic.com") {
        anthropic::call(client, provider, req).await
    } else if provider.name == "ollama" {
        ollama::call_chat(client, provider, req).await
    } else {
        openai::call(client, provider, req).await
    };

    match result {
        Ok(mut resp) => {
            resp.opseeq.provider = provider.name.clone();
            resp.opseeq.latency_ms = start.elapsed().as_millis() as u64;
            resp.opseeq.trace_id = trace_id.to_string();
            Ok(resp)
        }
        Err(e) => Err(format!("{}: {}", provider.name, e)),
    }
}
