use crate::config::ProviderConfig;
use crate::types::*;
use serde_json::Value;

pub async fn call(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    req: &ChatRequest,
) -> Result<ChatResponse, String> {
    let url = format!("{}/chat/completions", provider.base_url);

    let mut body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": false,
    });

    if let Some(t) = req.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = req.max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", provider.api_key))
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

    let choices = data["choices"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .enumerate()
        .map(|(i, c)| ChatChoice {
            index: i as u32,
            message: ChatMessage {
                role: c["message"]["role"].as_str().unwrap_or("assistant").into(),
                content: c["message"]["content"].as_str().unwrap_or("").into(),
                name: None,
                reasoning: None,
            },
            finish_reason: c["finish_reason"].as_str().unwrap_or("stop").into(),
        })
        .collect();

    let usage = if data["usage"].is_object() {
        Some(Usage {
            prompt_tokens: data["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: data["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32,
            total_tokens: data["usage"]["total_tokens"].as_u64().unwrap_or(0) as u32,
        })
    } else {
        None
    };

    Ok(ChatResponse {
        id: data["id"].as_str().unwrap_or("").into(),
        object: "chat.completion".into(),
        created: data["created"].as_u64().unwrap_or(0),
        model: data["model"].as_str().unwrap_or(&req.model).into(),
        choices,
        usage,
        opseeq: OpseeqMeta {
            provider: String::new(),
            latency_ms: 0,
            trace_id: String::new(),
        },
    })
}
