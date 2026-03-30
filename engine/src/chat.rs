use crate::config::KernelConfig;
use crate::probe;
use crate::providers::ollama;
use crate::router;
use crate::types::{ChatMessage, ChatRequest};
use rustyline::DefaultEditor;

const VERSION: &str = "0.1.0";

pub async fn run_chat(config: KernelConfig) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("http client");

    print_banner(&config);
    print_status(&client, &config).await;

    let mut rl = DefaultEditor::new().expect("readline");
    let mut messages: Vec<ChatMessage> = Vec::new();
    let mut active_model = config.default_model.clone();
    let mut force_provider: Option<String> = None;

    loop {
        let prompt = format!("\x1b[1;32mopseeq\x1b[0m [{active_model}]> ");
        let line = match rl.readline(&prompt) {
            Ok(l) => l,
            Err(rustyline::error::ReadlineError::Interrupted | rustyline::error::ReadlineError::Eof) => break,
            Err(e) => {
                eprintln!("readline error: {e}");
                break;
            }
        };

        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        let _ = rl.add_history_entry(input);

        if input.starts_with('/') {
            let handled = handle_slash(&client, &config, input, &mut active_model, &mut force_provider, &mut messages).await;
            if handled == SlashResult::Quit {
                break;
            }
            continue;
        }

        messages.push(ChatMessage {
            role: "user".into(),
            content: input.to_string(),
            name: None,
            reasoning: None,
        });

        let model = if let Some(ref fp) = force_provider {
            let p = config.providers.iter().find(|p| p.name == *fp);
            p.and_then(|p| p.models.first().cloned()).unwrap_or(active_model.clone())
        } else {
            active_model.clone()
        };

        let req = ChatRequest {
            model: model.clone(),
            messages: messages.clone(),
            temperature: Some(0.0),
            max_tokens: None,
            stream: false,
            purpose: Some("hitl_chat".into()),
        };

        let trace_id = uuid::Uuid::new_v4().to_string()[..12].to_string();

        print!("\x1b[2m");
        match router::route_inference(&client, &config, &req, &trace_id).await {
            Ok(resp) => {
                let content = resp
                    .choices
                    .first()
                    .map(|c| c.message.content.as_str())
                    .unwrap_or("");
                let reasoning = resp
                    .choices
                    .first()
                    .and_then(|c| c.message.reasoning.as_deref());

                print!("\x1b[0m");

                if let Some(r) = reasoning {
                    println!("\x1b[2;3m[thinking] {}\x1b[0m", truncate(r, 200));
                }
                println!("{content}");
                println!(
                    "\x1b[2m({} via {} in {}ms | {})\x1b[0m",
                    resp.model, resp.opseeq.provider, resp.opseeq.latency_ms, trace_id
                );

                messages.push(ChatMessage {
                    role: "assistant".into(),
                    content: content.to_string(),
                    name: None,
                    reasoning: reasoning.map(|s| s.to_string()),
                });
            }
            Err(e) => {
                print!("\x1b[0m");
                eprintln!("\x1b[31mError: {e}\x1b[0m");
            }
        }
    }

    println!("\nopseeq-core exiting.");
}

#[derive(PartialEq)]
enum SlashResult {
    Handled,
    Quit,
}

async fn handle_slash(
    client: &reqwest::Client,
    config: &KernelConfig,
    input: &str,
    active_model: &mut String,
    force_provider: &mut Option<String>,
    messages: &mut Vec<ChatMessage>,
) -> SlashResult {
    let parts: Vec<&str> = input.splitn(2, ' ').collect();
    let cmd = parts[0];
    let arg = parts.get(1).unwrap_or(&"").trim();

    match cmd {
        "/quit" | "/exit" | "/q" => return SlashResult::Quit,

        "/model" => {
            if arg.is_empty() {
                println!("Current: {active_model}");
            } else {
                *active_model = arg.to_string();
                *force_provider = None;
                println!("Model set to: {active_model}");
            }
        }

        "/models" => {
            let models = router::list_models(config);
            println!("  {:40} {}", "MODEL", "PROVIDER");
            println!("  {:40} {}", "─".repeat(40), "─".repeat(16));
            for m in &models {
                let marker = if m.id == *active_model { " ◀" } else { "" };
                println!("  {:40} {}{}", m.id, m.provider, marker);
            }
        }

        "/status" => {
            print_status(client, config).await;
        }

        "/ollama" => {
            match ollama::list_models(client, &config.ollama_url).await {
                Ok(models) => {
                    println!("  Ollama models ({}):", models.len());
                    for m in &models {
                        println!(
                            "    {} ({}GB, {})",
                            m.name,
                            m.size / 1_000_000_000,
                            m.details.family.as_deref().unwrap_or("?")
                        );
                    }
                }
                Err(e) => println!("  Ollama: {e}"),
            }
        }

        "/provider" => {
            if arg.is_empty() {
                println!("Current: {}", force_provider.as_deref().unwrap_or("auto"));
                println!("Available: {}", config.providers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "));
            } else if arg == "auto" {
                *force_provider = None;
                println!("Provider: auto (priority-based)");
            } else if config.providers.iter().any(|p| p.name == arg) {
                *force_provider = Some(arg.to_string());
                println!("Provider forced: {arg}");
            } else {
                println!("Unknown provider: {arg}");
            }
        }

        "/mermate" => {
            let subcmd_parts: Vec<&str> = arg.splitn(2, ' ').collect();
            let subcmd = subcmd_parts[0];
            let subarg = subcmd_parts.get(1).unwrap_or(&"").trim();

            match subcmd {
                "" => {
                    let r = probe::probe_mermate(client, &config.mermate_url).await;
                    println!("  Mermate: {} ({}ms)", if r.reachable { "online" } else { "offline" }, r.latency_ms);
                    if r.reachable {
                        let agents_url = format!("{}/api/agents", config.mermate_url);
                        if let Ok(resp) = client.get(&agents_url).timeout(std::time::Duration::from_secs(3)).send().await {
                            if let Ok(data) = resp.json::<serde_json::Value>().await {
                                let count = data["agents"].as_array().map(|a| a.len()).unwrap_or(0);
                                println!("  Agents:  {count} loaded");
                            }
                        }
                        for (label, path) in [("TLA+", "/api/render/tla/status"), ("TS", "/api/render/ts/status")] {
                            let url = format!("{}{}", config.mermate_url, path);
                            if let Ok(resp) = client.get(&url).timeout(std::time::Duration::from_secs(2)).send().await {
                                if let Ok(data) = resp.json::<serde_json::Value>().await {
                                    let avail = data["available"].as_bool().unwrap_or(false);
                                    println!("  {label:6} {}", if avail { "available" } else { "unavailable" });
                                }
                            }
                        }
                    }
                }
                "render" => {
                    if subarg.is_empty() { println!("  Usage: /mermate render <text>"); }
                    else {
                        println!("  Sending to Mermate render...");
                        let url = format!("{}/api/render", config.mermate_url);
                        let body = serde_json::json!({ "prompt": subarg, "mode": "mermaid" });
                        match client.post(&url).json(&body).timeout(std::time::Duration::from_secs(60)).send().await {
                            Ok(resp) => println!("{}", resp.text().await.unwrap_or_default()),
                            Err(e) => println!("  Error: {e}"),
                        }
                    }
                }
                "tla" => {
                    if subarg.is_empty() { println!("  Usage: /mermate tla <runId>"); }
                    else {
                        let url = format!("{}/api/render/tla", config.mermate_url);
                        let body = serde_json::json!({ "run_id": subarg });
                        match client.post(&url).json(&body).timeout(std::time::Duration::from_secs(60)).send().await {
                            Ok(resp) => println!("{}", resp.text().await.unwrap_or_default()),
                            Err(e) => println!("  Error: {e}"),
                        }
                    }
                }
                "ts" => {
                    if subarg.is_empty() { println!("  Usage: /mermate ts <runId>"); }
                    else {
                        let url = format!("{}/api/render/ts", config.mermate_url);
                        let body = serde_json::json!({ "run_id": subarg });
                        match client.post(&url).json(&body).timeout(std::time::Duration::from_secs(60)).send().await {
                            Ok(resp) => println!("{}", resp.text().await.unwrap_or_default()),
                            Err(e) => println!("  Error: {e}"),
                        }
                    }
                }
                "agents" => {
                    let url = format!("{}/api/agent/modes", config.mermate_url);
                    match client.get(&url).timeout(std::time::Duration::from_secs(5)).send().await {
                        Ok(resp) => {
                            if let Ok(data) = resp.json::<serde_json::Value>().await {
                                if let Some(modes) = data["modes"].as_array() {
                                    for m in modes {
                                        println!("  {} — {} [{}]",
                                            m["id"].as_str().unwrap_or("?"),
                                            m["label"].as_str().unwrap_or(""),
                                            m["stage"].as_str().unwrap_or(""),
                                        );
                                    }
                                }
                            }
                        }
                        Err(e) => println!("  Error: {e}"),
                    }
                }
                _ => println!("  /mermate [render|tla|ts|agents] or bare for status"),
            }
        }

        "/synth" => {
            let subcmd_parts: Vec<&str> = arg.splitn(2, ' ').collect();
            let subcmd = subcmd_parts[0];
            let subarg = subcmd_parts.get(1).unwrap_or(&"").trim();

            match subcmd {
                "" => {
                    let data = probe::probe_synth_deep(client, &config.synth_url).await;
                    println!("  Synth Trading Desk");
                    println!("  reachable:    {}", data["reachable"].as_bool().unwrap_or(false));
                    println!("  simulation:   {}", data["simulation_mode"]);
                    println!("  approval:     {}", data["approval_required"]);
                    println!("  ai_engine:    {}", data["ai_engine_available"]);
                    println!("  predictions:  {}", data["predictions"]);
                    if let Some(o) = data.get("opseeq") {
                        println!("  opseeq link:  {}", o);
                    }
                }
                "predict" => {
                    if subarg.is_empty() { println!("  Usage: /synth predict <market question>"); }
                    else {
                        println!("  Generating prediction...");
                        match probe::synth_predict(client, &config.synth_url, subarg, None).await {
                            Ok(data) => {
                                if let Some(p) = data.get("prediction") {
                                    println!("  Thesis:     {}", p["thesis"].as_str().unwrap_or("?"));
                                    println!("  Confidence: {}", p["confidence"]);
                                    println!("  Action:     {}", p.get("suggested_execution").and_then(|e| e.get("action")).unwrap_or(&serde_json::Value::Null));
                                } else {
                                    println!("{}", serde_json::to_string_pretty(&data).unwrap_or_default());
                                }
                            }
                            Err(e) => println!("  Error: {e}"),
                        }
                    }
                }
                "history" => {
                    let url = format!("{}/api/predictions/history?limit=5", config.synth_url);
                    match client.get(&url).timeout(std::time::Duration::from_secs(5)).send().await {
                        Ok(resp) => println!("{}", resp.text().await.unwrap_or_default()),
                        Err(e) => println!("  Error: {e}"),
                    }
                }
                "markets" => {
                    if subarg.is_empty() { println!("  Usage: /synth markets <query>"); }
                    else {
                        let url = format!("{}/api/markets/search/{}", config.synth_url, subarg);
                        match client.get(&url).timeout(std::time::Duration::from_secs(10)).send().await {
                            Ok(resp) => println!("{}", resp.text().await.unwrap_or_default()),
                            Err(e) => println!("  Error: {e}"),
                        }
                    }
                }
                _ => println!("  /synth [predict|history|markets] or bare for status"),
            }
        }

        "/clear" => {
            messages.clear();
            println!("Conversation cleared.");
        }

        "/help" => {
            println!("  /model <name>       Switch model");
            println!("  /models             List all models");
            println!("  /provider <name>    Force provider (or 'auto')");
            println!("  /status             System health");
            println!("  /ollama             Ollama models");
            println!("  /mermate            Deep Mermate status");
            println!("  /mermate render <t> Render through pipeline");
            println!("  /mermate tla <id>   Generate TLA+ for run");
            println!("  /mermate ts <id>    Generate TypeScript for run");
            println!("  /mermate agents     List agent modes");
            println!("  /synth              Deep Synth status");
            println!("  /synth predict <q>  Generate prediction");
            println!("  /synth history      Recent predictions");
            println!("  /synth markets <q>  Search markets");
            println!("  /clear              Clear history");
            println!("  /quit               Exit");
        }

        _ => {
            println!("Unknown command: {cmd}. Type /help");
        }
    }

    SlashResult::Handled
}

fn print_banner(config: &KernelConfig) {
    println!();
    println!("  \x1b[1m╔══════════════════════════════════════════╗\x1b[0m");
    println!("  \x1b[1m║     OPSEEQ RUNTIME KERNEL v{VERSION:<14}║\x1b[0m");
    println!("  \x1b[1m╚══════════════════════════════════════════╝\x1b[0m");
    println!();
    println!("  Providers: {}", config.providers.iter().map(|p| format!("{} ({})", p.name, p.models.len())).collect::<Vec<_>>().join(", "));
    println!("  Default:   {}", config.default_model);
    println!();
}

async fn print_status(client: &reqwest::Client, config: &KernelConfig) {
    let (m, s, o) = tokio::join!(
        probe::probe_mermate(client, &config.mermate_url),
        probe::probe_synth(client, &config.synth_url),
        probe::probe_ollama(client, &config.ollama_url),
    );

    let ollama_models = if o.reachable {
        ollama::list_models(client, &config.ollama_url).await.map(|v| v.len()).unwrap_or(0)
    } else {
        0
    };

    println!("  ── Status ─────────────────────────────────");
    println!("  Providers:  {} configured, {} models total",
        config.providers.len(),
        config.providers.iter().map(|p| p.models.len()).sum::<usize>(),
    );
    println!("  Mermate:    {} ({}ms)", if m.reachable { "online" } else { "offline" }, m.latency_ms);
    println!("  Synth:      {} ({}ms)", if s.reachable { "online" } else { "offline" }, s.latency_ms);
    println!("  Ollama:     {} ({} models, {}ms)", if o.reachable { "online" } else { "offline" }, ollama_models, o.latency_ms);
    println!("  ────────────────────────────────────────────");
    println!();
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max { s } else { &s[..max] }
}
