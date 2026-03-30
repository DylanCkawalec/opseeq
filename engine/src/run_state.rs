use serde::{Deserialize, Serialize};

/// Phase 2 stub: canonical runtime execution envelope.
/// In Phase 1 only trace_id is populated and threaded through requests.
/// Phase 2 will wire this into every inference call as a durable record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEnvelope {
    pub trace_id: String,
    pub requested_model: String,
    pub resolved_provider: Option<String>,
    pub resolved_model: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub latency_ms: Option<u64>,
    pub retry_count: u32,
    pub status: RunStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RunStatus {
    Pending,
    InFlight,
    Completed,
    Failed(String),
}

impl RunEnvelope {
    pub fn new(trace_id: String, model: String) -> Self {
        Self {
            trace_id,
            requested_model: model,
            resolved_provider: None,
            resolved_model: None,
            started_at: None,
            completed_at: None,
            latency_ms: None,
            retry_count: 0,
            status: RunStatus::Pending,
        }
    }
}
