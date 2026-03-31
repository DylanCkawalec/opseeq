use crate::config::KernelConfig;
use crate::events::{self, RuntimeEvent};
use crate::probe;
use crate::providers::ollama;
use crate::router;
use crate::types::ChatRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::RwLock;

const KERNEL_VERSION: &str = "5.0.0";

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

pub async fn run_rpc_server(config: KernelConfig) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("http client");

    let model_cache = router::new_model_cache();
    let start_time = std::time::Instant::now();

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    events::emit(&RuntimeEvent::KernelStarted {
        version: KERNEL_VERSION.into(),
        providers: config.providers.iter().map(|p| p.name.clone()).collect(),
        mode: "serve".into(),
    });
    eprintln!("[opseeq-core] RPC server ready v{KERNEL_VERSION} (stdin/stdout)");

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                eprintln!("[opseeq-core] stdin error: {e}");
                break;
            }
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: RpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = RpcResponse {
                    id: Value::Null,
                    result: None,
                    error: Some(RpcError {
                        code: -32700,
                        message: format!("parse error: {e}"),
                    }),
                };
                let mut out = serde_json::to_string(&err_resp).unwrap_or_default();
                out.push('\n');
                let _ = stdout.write_all(out.as_bytes()).await;
                let _ = stdout.flush().await;
                continue;
            }
        };

        let response = dispatch(&client, &config, &req, &model_cache, start_time).await;
        let mut out = serde_json::to_string(&response).unwrap_or_default();
        out.push('\n');
        let _ = stdout.write_all(out.as_bytes()).await;
        let _ = stdout.flush().await;
    }

    eprintln!("[opseeq-core] RPC server exiting");
}

async fn dispatch(
    client: &reqwest::Client,
    config: &KernelConfig,
    req: &RpcRequest,
    model_cache: &Arc<RwLock<Option<router::ModelCache>>>,
    start_time: std::time::Instant,
) -> RpcResponse {
    let id = req.id.clone();

    match req.method.as_str() {
        // ── kernel.ping ──────────────────────────────────────────
        "kernel.ping" => RpcResponse {
            id,
            result: Some(serde_json::json!({
                "version": KERNEL_VERSION,
                "uptime_ms": start_time.elapsed().as_millis() as u64,
                "providers": config.providers.len(),
            })),
            error: None,
        },

        // ── inference.route ──────────────────────────────────────
        "inference.route" => {
            let chat_req: ChatRequest = match serde_json::from_value(req.params.clone()) {
                Ok(r) => r,
                Err(e) => {
                    return RpcResponse {
                        id,
                        result: None,
                        error: Some(RpcError {
                            code: -32602,
                            message: format!("invalid params: {e}"),
                        }),
                    };
                }
            };
            let trace_id = req
                .params
                .get("trace_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()[..12].to_string());
            match router::route_inference(client, config, &chat_req, &trace_id).await {
                Ok(resp) => RpcResponse {
                    id,
                    result: Some(serde_json::to_value(resp).unwrap_or_default()),
                    error: None,
                },
                Err(e) => {
                    let code = if e.contains("no provider for model") {
                        -32602
                    } else if e.contains("429") || e.to_lowercase().contains("rate limit") {
                        -32002
                    } else if e.contains("401")
                        || e.contains("403")
                        || e.to_lowercase().contains("auth")
                    {
                        -32001
                    } else if e.contains("timeout") || e.contains("timed out") {
                        -32003
                    } else {
                        -32000
                    };
                    RpcResponse {
                        id,
                        result: None,
                        error: Some(RpcError { code, message: e }),
                    }
                }
            }
        }

        // ── models.list (cached) ─────────────────────────────────
        "models.list" => {
            let models = router::list_models_cached(config, client, model_cache).await;
            RpcResponse {
                id,
                result: Some(serde_json::to_value(models).unwrap_or_default()),
                error: None,
            }
        }

        // ── ollama.models ────────────────────────────────────────
        "ollama.models" => {
            match ollama::list_models(client, &config.ollama_url).await {
                Ok(models) => RpcResponse {
                    id,
                    result: Some(serde_json::to_value(models).unwrap_or_default()),
                    error: None,
                },
                Err(e) => RpcResponse {
                    id,
                    result: None,
                    error: Some(RpcError {
                        code: -32000,
                        message: e,
                    }),
                },
            }
        }

        // ── mermate.probe ────────────────────────────────────────
        "mermate.probe" => {
            let result = probe::probe_mermate(client, &config.mermate_url).await;
            RpcResponse {
                id,
                result: Some(serde_json::to_value(result).unwrap_or_default()),
                error: None,
            }
        }

        // ── synth.probe ──────────────────────────────────────────
        "synth.probe" => {
            let result = probe::probe_synth(client, &config.synth_url).await;
            RpcResponse {
                id,
                result: Some(serde_json::to_value(result).unwrap_or_default()),
                error: None,
            }
        }

        // ── synth.status ─────────────────────────────────────────
        "synth.status" => {
            let result = probe::probe_synth_deep(client, &config.synth_url).await;
            RpcResponse {
                id,
                result: Some(result),
                error: None,
            }
        }

        // ── synth.predict ────────────────────────────────────────
        "synth.predict" => {
            let query = req
                .params
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let wallet_id = req.params.get("wallet_id").and_then(|v| v.as_str());
            if query.is_empty() {
                RpcResponse {
                    id,
                    result: None,
                    error: Some(RpcError {
                        code: -32602,
                        message: "query required".into(),
                    }),
                }
            } else {
                match probe::synth_predict(client, &config.synth_url, query, wallet_id).await {
                    Ok(data) => RpcResponse {
                        id,
                        result: Some(data),
                        error: None,
                    },
                    Err(e) => RpcResponse {
                        id,
                        result: None,
                        error: Some(RpcError {
                            code: -32000,
                            message: e,
                        }),
                    },
                }
            }
        }

        // ── connectivity.probe (parallel) ────────────────────────
        "connectivity.probe" => {
            let mermate_health = format!("{}/api/copilot/health", config.mermate_url);
            let synth_health = format!("{}/api/health", config.synth_url);
            let targets: Vec<(String, String, String)> = vec![
                ("NVIDIA NIM".into(), "https://integrate.api.nvidia.com/v1/models".into(), "HEAD".into()),
                ("OpenAI".into(), "https://api.openai.com/v1/models".into(), "HEAD".into()),
                ("Anthropic".into(), "https://api.anthropic.com/v1/messages".into(), "HEAD".into()),
                ("GitHub".into(), "https://github.com/".into(), "HEAD".into()),
                ("Mermate".into(), mermate_health, "GET".into()),
                ("Synth".into(), synth_health, "GET".into()),
            ];
            let futs = targets.into_iter().map(|(label, url, method)| {
                let client = client.clone();
                async move {
                    probe::probe_url(&client, &label, &url, &method, 5000).await
                }
            });
            let probes: Vec<_> = futures_util::future::join_all(futs).await;
            RpcResponse {
                id,
                result: Some(serde_json::to_value(probes).unwrap_or_default()),
                error: None,
            }
        }

        // ── desktop.scan (async fs) ──────────────────────────────
        "desktop.scan" => {
            let dir = req
                .params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("~/Desktop/developer");
            let expanded = if dir.starts_with("~/") {
                format!(
                    "{}{}",
                    std::env::var("HOME").unwrap_or_default(),
                    &dir[1..]
                )
            } else {
                dir.to_string()
            };
            let result = probe::scan_directory_async(&expanded).await;
            let count = result["repos_found"].as_u64().unwrap_or(0) as u32;
            events::emit(&RuntimeEvent::DesktopScanCompleted {
                path: expanded.clone(),
                repos_found: count,
            });
            RpcResponse {
                id,
                result: Some(result),
                error: None,
            }
        }

        // ── desktop.verify_binary (async fs) ─────────────────────
        "desktop.verify_binary" => {
            let bin_path = req
                .params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if bin_path.is_empty() {
                RpcResponse {
                    id,
                    result: None,
                    error: Some(RpcError {
                        code: -32602,
                        message: "path required".into(),
                    }),
                }
            } else {
                let expanded = if bin_path.starts_with("~/") {
                    format!(
                        "{}{}",
                        std::env::var("HOME").unwrap_or_default(),
                        &bin_path[1..]
                    )
                } else {
                    bin_path.to_string()
                };
                RpcResponse {
                    id,
                    result: Some(probe::verify_binary_async(&expanded).await),
                    error: None,
                }
            }
        }

        _ => RpcResponse {
            id,
            result: None,
            error: Some(RpcError {
                code: -32601,
                message: format!("method not found: {}", req.method),
            }),
        },
    }
}
