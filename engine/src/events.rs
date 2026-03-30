use serde::{Deserialize, Serialize};

/// Phase 2 stub: typed runtime events.
/// In Phase 1 these are defined but not emitted.
/// Phase 2 will emit these on every major kernel operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuntimeEvent {
    InferenceRequested {
        trace_id: String,
        model: String,
        provider: String,
    },
    InferenceCompleted {
        trace_id: String,
        model: String,
        provider: String,
        latency_ms: u64,
        tokens: Option<u32>,
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
}
