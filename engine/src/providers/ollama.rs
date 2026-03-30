use crate::config::ProviderConfig;
use crate::types::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub details: OllamaModelDetails,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct OllamaModelDetails {
    #[serde(default)]
    pub family: Option<String>,
}

pub async fn call_chat(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    req: &ChatRequest,
) -> Result<ChatResponse, String> {
    let url = format!("{}/api/chat", provider.base_url);

    let body = serde_json::json!({
        "model": req.model,
        "stream": false,
        "messages": req.messages,
        "options": {
            "temperature": req.temperature.unwrap_or(0.0),
        },
    });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
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

    let content = data["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let thinking = data["message"]["thinking"]
        .as_str()
        .map(|s| s.to_string());

    Ok(ChatResponse {
        id: format!("chatcmpl-{}", chrono::Utc::now().timestamp_millis()),
        object: "chat.completion".into(),
        created: chrono::Utc::now().timestamp() as u64,
        model: data["model"].as_str().unwrap_or(&req.model).into(),
        choices: vec![ChatChoice {
            index: 0,
            message: ChatMessage {
                role: "assistant".into(),
                content,
                name: None,
                reasoning: thinking,
            },
            finish_reason: "stop".into(),
        }],
        usage: Some(Usage {
            prompt_tokens: data["prompt_eval_count"].as_u64().unwrap_or(0) as u32,
            completion_tokens: data["eval_count"].as_u64().unwrap_or(0) as u32,
            total_tokens: (data["prompt_eval_count"].as_u64().unwrap_or(0)
                + data["eval_count"].as_u64().unwrap_or(0)) as u32,
        }),
        opseeq: OpseeqMeta {
            provider: String::new(),
            latency_ms: 0,
            trace_id: String::new(),
        },
    })
}

pub async fn list_models(
    client: &reqwest::Client,
    ollama_url: &str,
) -> Result<Vec<OllamaModel>, String> {
    if ollama_url.is_empty() {
        return Ok(vec![]);
    }
    let url = format!("{}/api/tags", ollama_url);
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| format!("ollama tags: {e}"))?;

    let data: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
    let models: Vec<OllamaModel> = data["models"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| serde_json::from_value(m.clone()).ok())
        .collect();

    Ok(models)
}
