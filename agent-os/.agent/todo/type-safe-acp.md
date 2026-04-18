# Type-Safe ACP Protocol Types

## Problem

Our ACP session/protocol layer has no real types. Everything flows through as `unknown` and gets cast at consumption sites. Meanwhile, `@agentclientprotocol/sdk` exports 141 fully-typed interfaces we're not using.

### Current state

- `protocol.ts` defines generic JSON-RPC 2.0 types with `params?: unknown`, `result?: unknown`
- `session.ts` hand-rolls incomplete versions of SDK types (`PermissionRequest`, `SessionMode`, `AgentCapabilities`, etc.)
- Event handlers receive `JsonRpcNotification` with untyped params
- Permission request fields extracted via unsafe `as string` casts
- `prompt()`, `setMode()`, etc. all return `JsonRpcResponse` with `result?: unknown`

### Plan

Keep `AcpClient` for transport (ManagedProcess stdio, timeouts, exit handling). Layer SDK types on top.

1. **Delete `protocol.ts`** — keep only the serialize/deserialize helpers, import JSON-RPC base types from SDK or keep minimal versions
2. **Delete hand-rolled ACP types** from `session.ts` — `PermissionRequest`, `SessionMode`, `SessionModeState`, `AgentCapabilities`, `SessionConfigOption`, `AgentInfo` — replace with SDK imports (`RequestPermissionRequest`, `SessionMode`, `SessionModeState`, `AgentCapabilities`, `SessionConfigOption`, `Implementation`)
3. **Type `Session` event handlers** — `onSessionEvent` receives `SessionNotification` instead of raw `JsonRpcNotification`; `onPermissionRequest` receives `RequestPermissionRequest`
4. **Type `Session` method return values** — `prompt()` returns `PromptResponse`, `setMode()` returns `SetSessionModeResponse`, `respondPermission()` returns `RequestPermissionResponse`, etc.
5. **Type `SequencedEvent`** — wraps `SessionNotification` instead of `JsonRpcNotification`
6. **Update `getEvents()`** — returns typed `SessionNotification[]` instead of `JsonRpcNotification[]`
7. **Update downstream consumers** — actor layer in `~/r-aos`, tests, quickstart examples

### Key SDK types to import

```typescript
import type {
  SessionNotification,
  SessionUpdate,
  RequestPermissionRequest,
  RequestPermissionResponse,
  PromptRequest,
  PromptResponse,
  NewSessionRequest,
  NewSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ContentBlock,
  ToolCall,
  ToolCallUpdate,
  AgentCapabilities,
  SessionCapabilities,
  SessionModeState,
  SessionConfigOption,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  CancelNotification,
  StopReason,
  Implementation,
  PermissionOption,
} from '@agentclientprotocol/sdk';
```

### Not changing

- `AcpClient` transport layer — works fine, just stays loosely typed at the JSON-RPC level
- `AcpClient.request()` signature stays `unknown` return; `Session` methods cast to specific response types
