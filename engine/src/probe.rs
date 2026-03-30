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

pub fn scan_directory(dir: &str) -> serde_json::Value {
    let path = std::path::Path::new(dir);
    if !path.is_dir() {
        return serde_json::json!({ "error": format!("{} is not a directory", dir), "repos": [] });
    }

    let mut repos = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let ep = entry.path();
            if !ep.is_dir() { continue; }
            let name = ep.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "target" { continue; }

            let has_pkg = ep.join("package.json").exists();
            let has_cargo = ep.join("Cargo.toml").exists();
            let has_env = ep.join(".env").exists();
            let has_mcp = ep.join(".mcp.json").exists();

            let opseeq_connected = if has_env {
                std::fs::read_to_string(ep.join(".env"))
                    .map(|c| c.contains("OPSEEQ_URL") || c.contains("OPENAI_BASE_URL"))
                    .unwrap_or(false)
            } else { false };

            let modified = ep.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            repos.push(serde_json::json!({
                "name": name,
                "path": ep.to_string_lossy(),
                "has_package_json": has_pkg,
                "has_cargo_toml": has_cargo,
                "has_env": has_env,
                "has_mcp_json": has_mcp,
                "opseeq_connected": opseeq_connected,
                "modified_epoch": modified,
            }));
        }
    }
    repos.sort_by(|a, b| {
        b["modified_epoch"].as_u64().cmp(&a["modified_epoch"].as_u64())
    });

    serde_json::json!({ "path": dir, "repos_found": repos.len(), "repos": repos })
}

pub fn verify_binary(bin_path: &str) -> serde_json::Value {
    let path = std::path::Path::new(bin_path);
    if !path.exists() {
        return serde_json::json!({ "exists": false, "path": bin_path, "error": "file not found" });
    }

    let is_executable = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            path.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
        }
        #[cfg(not(unix))]
        { true }
    };

    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
    let is_app_bundle = bin_path.ends_with(".app");

    serde_json::json!({
        "exists": true,
        "path": bin_path,
        "is_executable": is_executable,
        "size_bytes": size,
        "is_app_bundle": is_app_bundle,
    })
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
