mod chat;
mod config;
mod events;
mod probe;
mod providers;
mod router;
mod rpc;
mod run_state;
mod types;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "opseeq-core", version = "0.1.0")]
#[command(about = "Deterministic runtime kernel for Opseeq local-first intelligence")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// JSON-RPC stdio server (spawned by Node.js shell)
    Serve,
    /// Interactive HITL terminal chat
    Chat,
}

#[tokio::main]
async fn main() {
    let _ = try_load_dotenv();

    let cli = Cli::parse();

    let cfg = config::load_config();

    match cli.command {
        Commands::Serve => {
            rpc::run_rpc_server(cfg).await;
        }
        Commands::Chat => {
            chat::run_chat(cfg).await;
        }
    }
}

fn try_load_dotenv() -> bool {
    let candidates = [".env", "../.env"];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            for line in std::fs::read_to_string(path).unwrap_or_default().lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, val)) = line.split_once('=') {
                    let key = key.trim();
                    let val = val.trim();
                    if std::env::var(key).is_err() {
                        std::env::set_var(key, val);
                    }
                }
            }
            return true;
        }
    }
    false
}
