//! # Anthropic API Client — Absorbed from General-Clawd
//!
//! **Axiom A10**: The Anthropic API client is a native Opseeq capability, not an external dependency.
//! **Postulate P9**: All API communication uses typed request/response structures with retry and SSE streaming.
//! **Corollary C8**: General-Clawd's Rust API crate is fully absorbed — no external bridge remains.
//! **Behavioral Contract**: `AnthropicClient` is the single canonical Anthropic API surface within Opseeq.
//! **Tracing Invariant**: Every API call is logged with request_id for end-to-end observability.

mod client;
mod error;
mod sse;
mod types;

pub use client::{AnthropicClient, MessageStream};
pub use error::ApiError;
pub use sse::{parse_frame, SseParser};
pub use types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};
