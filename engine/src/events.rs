use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuntimeEvent {
    InferenceRequested {
        trace_id: String,
        model: String,
        provider: String,
        purpose: Option<String>,
    },
    InferenceCompleted {
        trace_id: String,
        model: String,
        provider: String,
        latency_ms: u64,
        tokens: Option<u32>,
        purpose: Option<String>,
    },
    ProviderFailed {
        trace_id: String,
        provider: String,
        error: String,
        attempt: u32,
    },
    ProbeResult {
        label: String,
        reachable: bool,
        latency_ms: u64,
    },
    KernelStarted {
        version: String,
        providers: Vec<String>,
        mode: String,
    },
    KernelStopped {
        reason: String,
    },
    PipelineStageCompleted {
        trace_id: String,
        run_id: String,
        stage: String,
        duration_ms: u64,
        validation_passed: Option<bool>,
        purpose: Option<String>,
    },
    DesktopScanCompleted {
        path: String,
        repos_found: u32,
    },
    QualityScored {
        trace_id: String,
        provider: String,
        model: String,
        score: f64,
        tau_tier: String,
        tau_threshold: f64,
        passed: bool,
        latency_ms: u64,
    },
}

static EVENTS_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn events_enabled() -> bool {
    *EVENTS_ENABLED.get_or_init(|| {
        std::env::var("OPSEEQ_KERNEL_EVENTS").map(|v| v == "1" || v == "true").unwrap_or(true)
    })
}

pub fn emit(event: &RuntimeEvent) {
    if !events_enabled() { return; }
    if let Ok(json) = serde_json::to_string(event) {
        eprintln!("[event] {json}");
    }
}
