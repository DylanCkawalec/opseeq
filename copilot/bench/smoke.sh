#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# bench/smoke.sh — Mock-backend smoke run that exercises plan→verify→execute
# end-to-end without Ollama/NIM. Mirrors QGoT's bench-hard-smoke target so we
# keep parity with the upstream harness.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

echo "[bench-smoke] forcing mock provider"
export OPSEEQ_PLANNER_MODEL=mock-planner
export OPSEEQ_VERIFIER_MODEL=mock-verifier
export OPSEEQ_CODER_MODEL=mock-coder
export OPSEEQ_EXECUTOR_MODEL=mock-executor
export OPSEEQ_OBSERVER_MODEL=mock-observer
export OPSEEQ_PLANNER_PROVIDER=mock
export OPSEEQ_VERIFIER_PROVIDER=mock
export OPSEEQ_CODER_PROVIDER=mock
export OPSEEQ_EXECUTOR_PROVIDER=mock
export OPSEEQ_OBSERVER_PROVIDER=mock
export QGOT_BRIDGE_MODE="${QGOT_BRIDGE_MODE:-local}"

# Inline node script so we don't ship a separate runner file.
# shellcheck disable=SC2016
npx tsx -e '
import { WorkflowEngine } from "./workflow/engine.ts";
(async () => {
  const e = new WorkflowEngine({ maxRejections: 1 });
  const env = await e.submit("smoke: write a 2-line README and stop");
  console.log(JSON.stringify({ id: env.id, status: env.status, plans: env.plans.length, tasks: env.tasks.length }));
})();
'
echo "[bench-smoke] done"
