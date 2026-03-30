use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub priority: u8,
}

#[derive(Debug, Clone)]
pub struct KernelConfig {
    pub providers: Vec<ProviderConfig>,
    pub default_model: String,
    pub mermate_url: String,
    pub synth_url: String,
    pub ollama_url: String,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn parse_models(key: &str, default: &str) -> Vec<String> {
    env_or(key, default)
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn load_config() -> KernelConfig {
    let mut providers = Vec::new();

    if let Ok(key) = std::env::var("NVIDIA_API_KEY") {
        providers.push(ProviderConfig {
            name: "nvidia-nim".into(),
            base_url: env_or("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
            api_key: key,
            models: parse_models(
                "NVIDIA_MODELS",
                "nvidia/nemotron-3-super-120b-a12b,nvidia/llama-3.3-nemotron-super-49b-v1",
            ),
            priority: 1,
        });
    }

    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        providers.push(ProviderConfig {
            name: "openai".into(),
            base_url: env_or("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key: key,
            models: parse_models(
                "OPENAI_MODELS",
                "gpt-5.4,gpt-5.2,gpt-4.1,gpt-4.1-mini,gpt-4.1-nano,gpt-4o,gpt-4o-mini,o3,o3-mini,o1,gpt-image-1",
            ),
            priority: 2,
        });
    }

    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        providers.push(ProviderConfig {
            name: "anthropic".into(),
            base_url: env_or("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"),
            api_key: key,
            models: parse_models(
                "ANTHROPIC_MODELS",
                "claude-4-opus,claude-4-sonnet,claude-3.5-sonnet",
            ),
            priority: 3,
        });
    }

    let ollama_url_raw = std::env::var("OLLAMA_URL")
        .or_else(|_| std::env::var("LOCAL_LLM_BASE_URL"))
        .unwrap_or_default();
    let ollama_url = ollama_url_raw.trim_end_matches('/').to_string();

    if !ollama_url.is_empty() {
        providers.push(ProviderConfig {
            name: "ollama".into(),
            base_url: ollama_url.clone(),
            api_key: "ollama".into(),
            models: parse_models("OLLAMA_MODELS", "gpt-oss:20b"),
            priority: 10,
        });
    }

    if let Ok(url) = std::env::var("NIM_LOCAL_URL") {
        providers.push(ProviderConfig {
            name: "nim-local".into(),
            base_url: url,
            api_key: env_or("NIM_LOCAL_API_KEY", "unused"),
            models: parse_models(
                "NIM_LOCAL_MODELS",
                "nvidia/nemotron-3-super-120b-a12b",
            ),
            priority: 0,
        });
    }

    providers.sort_by_key(|p| p.priority);

    let has_nim = providers.iter().any(|p| p.name.contains("nim"));
    let default_model = env_or(
        "OPSEEQ_DEFAULT_MODEL",
        if has_nim {
            "nvidia/nemotron-3-super-120b-a12b"
        } else {
            "gpt-4o"
        },
    );

    KernelConfig {
        providers,
        default_model,
        mermate_url: env_or("MERMATE_URL", "http://127.0.0.1:3333")
            .trim_end_matches('/')
            .to_string(),
        synth_url: env_or("SYNTHESIS_TRADE_URL", "http://127.0.0.1:8420")
            .trim_end_matches('/')
            .to_string(),
        ollama_url,
    }
}
