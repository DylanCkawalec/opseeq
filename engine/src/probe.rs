use crate::types::ProbeResult;
use std::time::Instant;

pub async fn probe_url(
    client: &reqwest::Client,
    label: &str,
    url: &str,
    method: &str,
    timeout_ms: u64,
) -> ProbeResult {
    let start = Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    let result = match method {
        "HEAD" => client.head(url).timeout(timeout).send().await,
        _ => client.get(url).timeout(timeout).send().await,
    };

    match result {
        Ok(resp) => ProbeResult {
            label: label.into(),
            url: url.into(),
            reachable: true,
            http_status: Some(resp.status().as_u16()),
            latency_ms: start.elapsed().as_millis() as u64,
        },
        Err(_) => ProbeResult {
            label: label.into(),
            url: url.into(),
            reachable: false,
            http_status: None,
            latency_ms: start.elapsed().as_millis() as u64,
        },
    }
}

pub async fn probe_mermate(client: &reqwest::Client, base_url: &str) -> ProbeResult {
    probe_url(
        client,
        "Mermate",
        &format!("{}/api/copilot/health", base_url),
        "GET",
        2500,
    )
    .await
}

pub async fn probe_synth(client: &reqwest::Client, base_url: &str) -> ProbeResult {
    probe_url(
        client,
        "Synth",
        &format!("{}/api/health", base_url),
        "GET",
        2500,
    )
    .await
}

pub async fn probe_synth_deep(
    client: &reqwest::Client,
    base_url: &str,
) -> serde_json::Value {
    if base_url.is_empty() {
        return serde_json::json!({ "reachable": false, "error": "SYNTH_URL not configured" });
    }
    let url = format!("{}/api/health", base_url);
    match client.get(&url).timeout(std::time::Duration::from_secs(3)).send().await {
        Ok(resp) => {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                serde_json::json!({
                    "purpose": "synth_trading_desk",
                    "reachable": true,
                    "status": data.get("status"),
                    "simulation_mode": data.get("simulation_mode"),
                    "approval_required": data.get("approval_required"),
                    "ai_engine_available": data.get("ai_engine_available"),
                    "predictions": data.get("predictions"),
                    "opseeq": data.get("opseeq"),
                })
            } else {
                serde_json::json!({ "reachable": true, "error": "invalid json" })
            }
        }
        Err(e) => serde_json::json!({ "reachable": false, "error": e.to_string() }),
    }
}

pub async fn synth_predict(
    client: &reqwest::Client,
    base_url: &str,
    query: &str,
    wallet_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    if base_url.is_empty() {
        return Err("SYNTH_URL not configured".into());
    }
    let url = format!("{}/api/predictions/generate", base_url);
    let mut body = serde_json::json!({ "query": query });
    if let Some(wid) = wallet_id {
        body["wallet_id"] = serde_json::json!(wid);
    }
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("synth predict: {e}"))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("synth predict json: {e}"))
}

pub async fn probe_ollama(client: &reqwest::Client, base_url: &str) -> ProbeResult {
    if base_url.is_empty() {
        return ProbeResult {
            label: "Ollama".into(),
            url: String::new(),
            reachable: false,
            http_status: None,
            latency_ms: 0,
        };
    }
    probe_url(
        client,
        "Ollama",
        &format!("{}/api/tags", base_url),
        "GET",
        2000,
    )
    .await
}
