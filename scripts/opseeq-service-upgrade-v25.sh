#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# =============================================================================
# Opseeq service layer optimization v2.5 — one-command build + rollback
#
# Axiom A1: Backup is a tarball of service/src only (reproducible restore).
# Postulate P1: Rollback runs tsc after extract so dist/ matches src/.
# Corollary C1: Failure prints rollback hint with exact backup path.
# Behavioral contract: Idempotent rollback with explicit BACKUP path argument.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/service"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/.opseeq-upgrade-backup-$STAMP.tar.gz"

echo "[opseeq-upgrade] Backing up service/src to $BACKUP"
tar -czf "$BACKUP" -C "$ROOT/service" src

rollback() {
  local archive="${1:?archive path required}"
  echo "[opseeq-upgrade] ROLLBACK: extracting $archive into $ROOT/service"
  tar -xzf "$archive" -C "$ROOT/service"
  (cd "$ROOT/service" && npm run build)
  echo "[opseeq-upgrade] Rollback complete."
}

trap 'echo "[opseeq-upgrade] Failed (exit $?). Rollback: $0 --rollback $BACKUP"' ERR

if [[ "${1:-}" == "--rollback" && -n "${2:-}" ]]; then
  rollback "$2"
  exit 0
fi

echo "[opseeq-upgrade] Building service (tsc)…"
npm run build
echo "[opseeq-upgrade] Done. Backup: $BACKUP"
echo "[opseeq-upgrade] Rollback: $0 --rollback $BACKUP"
