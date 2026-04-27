#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# bench/paired.sh — Live paired bench against QGoT's bench-hard target.
# Requires Ollama to be reachable per QGoT's expectations.
set -euo pipefail

cd "$(dirname "$0")/../.." || exit 1 # opseeq root
QGOT_REPO="${QGOT_REPO:-../QGoT}"

if [ ! -d "$QGOT_REPO" ]; then
  echo "QGoT repo not found at $QGOT_REPO; set QGOT_REPO=" >&2
  exit 1
fi

echo "[bench-paired] running QGoT bench-hard against local Ollama"
make -C "$QGOT_REPO" bench-hard
echo "[bench-paired] artifact: $QGOT_REPO/artifacts/bench-hard/<run>/result.md"
