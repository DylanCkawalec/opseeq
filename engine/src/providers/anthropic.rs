use crate::config::ProviderConfig;
use crate::types::*;
use serde_json::Value;

pub async fn call(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    req: &ChatRequest,
) -> Result<ChatResponse, String> {
    let url = format!("{}/messages", provider.base_url);

    let system_msg = req.messages.iter().find(|m| m.role == "system");
    let non_system: Vec<_> = req.messages.iter().filter(|m| m.role != "system").collect();

    let mut body = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(8192),
        "temperature": req.temperature.unwrap_or(0.0),
        "messages": non_system,
    });

    if let Some(sys) = system_msg {
        body["system"] = serde_json::json!(sys.content);
    }

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("x-api-key", &provider.api_key)
        .header("anthropic-version", "2024-10-22")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let data: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;

    let content = data["content"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|c| c["text"].as_str())
        .unwrap_or("")
        .to_string();

    let usage = if data["usage"].is_object() {
        let inp = data["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32;
        let out = data["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32;
        Some(Usage {
            prompt_tokens: inp,
            completion_tokens: out,
            total_tokens: inp + out,
        })
    } else {
        None
    };

    Ok(ChatResponse {
        id: data["id"].as_str().unwrap_or("").into(),
        object: "chat.completion".into(),
        created: chrono::Utc::now().timestamp() as u64,
        model: data["model"].as_str().unwrap_or(&req.model).into(),
        choices: vec![ChatChoice {
            index: 0,
            message: ChatMessage {
                role: "assistant".into(),
                content,
                name: None,
                reasoning: None,
            },
            finish_reason: "stop".into(),
        }],
        usage,
        opseeq: OpseeqMeta {
            provider: String::new(),
            latency_ms: 0,
            trace_id: String::new(),
        },
    })
}
