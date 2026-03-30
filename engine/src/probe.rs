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
