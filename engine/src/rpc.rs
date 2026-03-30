use crate::config::KernelConfig;
use crate::events::{self, RuntimeEvent};
use crate::probe;
use crate::providers::ollama;
use crate::router;
use crate::types::ChatRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    events::emit(&RuntimeEvent::KernelStarted {
        version: "0.1.0".into(),
        providers: config.providers.iter().map(|p| p.name.clone()).collect(),
        mode: "serve".into(),
    });
    eprintln!("[opseeq-core] RPC server ready (stdin/stdout)");

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
                let mut out = serde_json::to_string(&err_resp).unwrap();
                out.push('\n');
                let _ = stdout.write_all(out.as_bytes()).await;
                let _ = stdout.flush().await;
                continue;
            }
        };

        let response = dispatch(&client, &config, &req).await;
        let mut out = serde_json::to_string(&response).unwrap();
        out.push('\n');
        let _ = stdout.write_all(out.as_bytes()).await;
        let _ = stdout.flush().await;
    }

    eprintln!("[opseeq-core] RPC server exiting");
}

async fn dispatch(client: &reqwest::Client, config: &KernelConfig, req: &RpcRequest) -> RpcResponse {
    let id = req.id.clone();

    match req.method.as_str() {
        "inference.route" => {
            let chat_req: ChatRequest = match serde_json::from_value(req.params.clone()) {
                Ok(r) => r,
                Err(e) => {
                    return RpcResponse {
                        id,
                        result: None,
                        error: Some(RpcError { code: -32602, message: format!("invalid params: {e}") }),
                    };
                }
            };
            let trace_id = req.params.get("trace_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()[..12].to_string());
            match router::route_inference(client, config, &chat_req, &trace_id).await {
                Ok(resp) => RpcResponse {
                    id,
                    result: Some(serde_json::to_value(resp).unwrap()),
                    error: None,
                },
                Err(e) => RpcResponse {
                    id,
                    result: None,
                    error: Some(RpcError { code: -32000, message: e }),
                },
            }
        }
        "models.list" => {
            let models = router::list_models(config);
            RpcResponse {
                id,
                result: Some(serde_json::to_value(models).unwrap()),
                error: None,
            }
        }
        "ollama.models" => {
            match ollama::list_models(client, &config.ollama_url).await {
                Ok(models) => RpcResponse {
                    id,
                    result: Some(serde_json::to_value(models).unwrap()),
                    error: None,
                },
                Err(e) => RpcResponse {
                    id,
                    result: None,
                    error: Some(RpcError { code: -32000, message: e }),
                },
            }
        }
        "mermate.probe" => {
            let result = probe::probe_mermate(client, &config.mermate_url).await;
            RpcResponse {
                id,
                result: Some(serde_json::to_value(result).unwrap()),
                error: None,
            }
        }
        "synth.probe" => {
            let result = probe::probe_synth(client, &config.synth_url).await;
            RpcResponse {
                id,
                result: Some(serde_json::to_value(result).unwrap()),
                error: None,
            }
        }
        "synth.status" => {
            let result = probe::probe_synth_deep(client, &config.synth_url).await;
            RpcResponse { id, result: Some(result), error: None }
        }
        "synth.predict" => {
            let query = req.params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let wallet_id = req.params.get("wallet_id").and_then(|v| v.as_str());
            if query.is_empty() {
                RpcResponse { id, result: None, error: Some(RpcError { code: -32602, message: "query required".into() }) }
            } else {
                match probe::synth_predict(client, &config.synth_url, query, wallet_id).await {
                    Ok(data) => RpcResponse { id, result: Some(data), error: None },
                    Err(e) => RpcResponse { id, result: None, error: Some(RpcError { code: -32000, message: e }) },
                }
            }
        }
        "connectivity.probe" => {
            let mermate_health = format!("{}/api/copilot/health", config.mermate_url);
            let synth_health = format!("{}/api/health", config.synth_url);
            let targets: Vec<(&str, &str, &str)> = vec![
                ("NVIDIA NIM", "https://integrate.api.nvidia.com/v1/models", "HEAD"),
                ("OpenAI", "https://api.openai.com/v1/models", "HEAD"),
                ("Anthropic", "https://api.anthropic.com/v1/messages", "HEAD"),
                ("GitHub", "https://github.com/", "HEAD"),
                ("Mermate", &mermate_health, "GET"),
                ("Synth", &synth_health, "GET"),
            ];
            let mut probes = Vec::new();
            for (label, url, method) in targets {
                probes.push(probe::probe_url(client, label, url, method, 5000).await);
            }
            RpcResponse {
                id,
                result: Some(serde_json::to_value(probes).unwrap()),
                error: None,
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
