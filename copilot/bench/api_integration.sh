#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# bench/api_integration.sh — verifies the TypeScript MCP dev workflow end-to-end.
#
# Uses the TypeScript MCP HTTP JSON-RPC boundary so it runs even on machines
# without Go installed. The production Go API uses QGOT_MCP_CMD directly.

cd "$(dirname "$0")/.." || exit 1

export COPILOT_MCP_PORT="${COPILOT_MCP_PORT:-7102}"
export OPSEEQ_PLANNER_PROVIDER=mock
export OPSEEQ_VERIFIER_PROVIDER=mock
export OPSEEQ_CODER_PROVIDER=mock
export OPSEEQ_EXECUTOR_PROVIDER=mock
export OPSEEQ_OBSERVER_PROVIDER=mock
export OPSEEQ_PLANNER_MODEL=mock-planner
export OPSEEQ_VERIFIER_MODEL=mock-verifier
export OPSEEQ_CODER_MODEL=mock-coder
export OPSEEQ_EXECUTOR_MODEL=mock-executor
export OPSEEQ_OBSERVER_MODEL=mock-observer
export QGOT_BRIDGE_MODE="${QGOT_BRIDGE_MODE:-local}"

server_log="$(mktemp)"
npx tsx mcp/server.ts >"$server_log" 2>&1 &
server_pid="$!"
trap 'kill "$server_pid" >/dev/null 2>&1 || true; rm -f "$server_log"' EXIT

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${COPILOT_MCP_PORT}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.3
done

if [ "$ready" != "1" ]; then
  echo "[api-integration] MCP HTTP server did not become ready" >&2
  cat "$server_log" >&2
  exit 1
fi

response="$(curl -fsS "http://127.0.0.1:${COPILOT_MCP_PORT}/rpc" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"qgot.execute","arguments":{"prompt":"api integration: create a concise service readiness note"}}}')"

# shellcheck disable=SC2016
if ! node -e '
const res = JSON.parse(process.argv[1]);
if (res.error) throw new Error(res.error.message);
const text = res.result?.content?.[0]?.text;
if (!text) throw new Error("missing MCP text content");
const env = JSON.parse(text);
if (env.status !== "DONE") throw new Error(`expected DONE, got ${env.status}`);
if (!Array.isArray(env.plans) || env.plans.length < 1) throw new Error("missing plan");
if (!Array.isArray(env.verifications) || env.verifications[0]?.verdict !== "APPROVED") throw new Error("missing approved verification");
if (!Array.isArray(env.tasks) || !env.tasks.some((t) => t?.status === "DONE")) throw new Error("missing completed task");
console.log(JSON.stringify({ ok: true, run_id: env.id, status: env.status, plans: env.plans.length, tasks: env.tasks.length, done_tasks: env.tasks.filter((t) => t?.status === "DONE").length }));
' "$response"; then
  echo "[api-integration] assertion failed" >&2
  exit 1
fi

status_response="$(curl -fsS "http://127.0.0.1:${COPILOT_MCP_PORT}/rpc" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"qgot.status","arguments":{}}}')"
# shellcheck disable=SC2016
if ! node -e '
const res = JSON.parse(process.argv[1]);
if (res.error) throw new Error(res.error.message);
if (!res.result?.structuredContent) throw new Error("missing structuredContent");
const status = res.result.structuredContent;
if (!status.source) throw new Error("missing QGoT status source");
console.log(JSON.stringify({ qgot_status_source: status.source, ok: status.ok }));
' "$status_response"; then
  echo "[api-integration] qgot.status assertion failed" >&2
  exit 1
fi

echo "[api-integration] PASS"
