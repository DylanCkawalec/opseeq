#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# ── Opseeq Dashboard Phase 2 Upgrade Script ──────
# Backs up .env files, verifies TypeScript, runs tests, and reports status.

OPSEEQ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$HOME/.opseeq-superior/env-backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf "${GREEN}[phase2]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[phase2]${NC} %s\n" "$1"; }
fail() {
  printf "${RED}[phase2]${NC} %s\n" "$1"
  exit 1
}

# ── Step 1: Backup .env files ─────────────────────
info "Backing up .env files from priority repos..."
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

DEVELOPER_ROOT="$(dirname "$OPSEEQ_ROOT")"
for repo in Lucidity mermaid; do
  ENV_FILE="$DEVELOPER_ROOT/$repo/.env"
  if [ -f "$ENV_FILE" ]; then
    BACKUP_FILE="$BACKUP_DIR/${repo}.env.${TIMESTAMP}.bak"
    cp "$ENV_FILE" "$BACKUP_FILE"
    chmod 600 "$BACKUP_FILE"
    info "  ✓ Backed up $repo/.env → $BACKUP_FILE"
  else
    warn "  ⚠ $repo/.env not found (skipping)"
  fi
done

# ── Step 2: Verify TypeScript ─────────────────────
info "Verifying TypeScript compilation..."
if (cd "$OPSEEQ_ROOT/service" && npx tsc --noEmit 2>&1); then
  info "  ✓ tsc --noEmit passed"
else
  fail "  ✗ TypeScript compilation failed. Aborting upgrade."
fi

# ── Step 3: Run Phase 2 tests ────────────────────
info "Running Phase 2 test suite..."
if (cd "$OPSEEQ_ROOT" && npx vitest run test/dashboard-phase2.test.js --reporter verbose 2>&1); then
  info "  ✓ All Phase 2 tests passed"
else
  fail "  ✗ Phase 2 tests failed. Aborting upgrade."
fi

# ── Step 4: Verify new files exist ────────────────
info "Verifying new files..."
REQUIRED_FILES=(
  "dashboard/public/js/precision-orchestration.js"
  "test/dashboard-phase2.test.js"
)
for f in "${REQUIRED_FILES[@]}"; do
  if [ -f "$OPSEEQ_ROOT/$f" ]; then
    info "  ✓ $f"
  else
    fail "  ✗ Missing: $f"
  fi
done

# ── Step 5: Verify HTML contains new tabs ─────────
info "Verifying dashboard HTML..."
HTML="$OPSEEQ_ROOT/dashboard/public/index.html"
for pattern in 'data-view-target="precision"' 'data-view-target="graph"' 'precision-orchestration.js' 'sidebar-repos'; do
  if grep -q "$pattern" "$HTML"; then
    info "  ✓ HTML contains $pattern"
  else
    fail "  ✗ HTML missing: $pattern"
  fi
done

# ── Step 6: Report ────────────────────────────────
echo ""
info "═══════════════════════════════════════════════"
info "  Dashboard Phase 2 Upgrade Complete"
info "═══════════════════════════════════════════════"
info ""
info "  New features:"
info "    • Precision Orchestration tab with Scientific OODA progress ring"
info "    • Living Architecture Graph tab"
info "    • Cross-repo search (Lucidity & Mermate prioritized)"
info "    • Sidebar connected repos with .env health"
info "    • Drag-and-drop idea box"
info "    • Keyboard shortcut: Ctrl+G → Precision Orchestration"
info ""
info "  Modified files:"
info "    • dashboard/public/index.html"
info "    • dashboard/public/css/opseeq.css"
info "    • dashboard/public/js/precision-orchestration.js (new)"
info "    • service/src/cross-repo-index.ts"
info "    • service/src/living-architecture-graph.ts"
info "    • service/src/extension-registry.ts"
info "    • config/nemoclaw-precision-orchestration.system-prompt.md"
info "    • config/nemoclaw-precision-orchestration-policy.yaml"
info "    • test/dashboard-phase2.test.js (new)"
info ""
info "  .env backups:"
ls -la "$BACKUP_DIR"/*."${TIMESTAMP}".bak 2>/dev/null || info "    (none created)"
info ""
info "  Rollback: git stash or git checkout -- <files>"
info "  .env restore: cp $BACKUP_DIR/<repo>.env.<ts>.bak <repo>/.env"
info ""
