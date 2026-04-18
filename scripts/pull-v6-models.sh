#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Opseeq v6.0 — Pull required local models for SeeQ role routing
#
# Usage: bash scripts/pull-v6-models.sh
#
# This script pulls qwen3-coder:30b and deepseek-r1:32b with automatic
# retry and resume support. Run when network connectivity is good.
# Ollama resumes from partial downloads, so safe to interrupt and re-run.

set -euo pipefail

MODELS=("qwen3-coder:30b" "deepseek-r1:32b")
MAX_RETRIES=50
RETRY_DELAY=10

for model in "${MODELS[@]}"; do
  echo "=== Pulling $model ==="
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    if ollama pull "$model" 2>&1; then
      echo "✅ Successfully pulled $model"
      break
    fi
    if [ "$attempt" -eq "$MAX_RETRIES" ]; then
      echo "❌ Failed to pull $model after $MAX_RETRIES attempts"
      exit 1
    fi
    echo "⚠️  Attempt $attempt failed for $model, retrying in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
  done
done

echo ""
echo "=== Model verification ==="
ollama list
echo ""
echo "Expected models: gpt-oss:20b, nemotron-3-nano:4b, kimi-k2.5:cloud, qwen3-coder:30b, deepseek-r1:32b"
