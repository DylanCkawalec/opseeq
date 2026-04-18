#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPERIOR_HOME="${HOME}/.opseeq-superior"
PROMPT_SRC="${ROOT}/config/nemoclaw-godmode.system-prompt.md"
POLICY_SRC="${ROOT}/config/nemoclaw-godmode-policy.yaml"
ROLLBACK_DIR="${SUPERIOR_HOME}/rollback"
BACKUP_DIR="${SUPERIOR_HOME}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_cmd() {
  local name="$1"
  if ! need_cmd "$name"; then
    echo "[error] missing required command: $name"
    exit 1
  fi
}

mkdir -p "${SUPERIOR_HOME}/prompts" "${SUPERIOR_HOME}/policies" "${SUPERIOR_HOME}/logs" "${ROLLBACK_DIR}" "${BACKUP_DIR}"

ensure_cmd node
ensure_cmd python3
ensure_cmd tmux
ensure_cmd docker

if ! need_cmd osascript; then
  echo "[error] AppleScript support is required on macOS."
  exit 1
fi

if git -C "${ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "${ROOT}" diff > "${ROLLBACK_DIR}/pre-godmode-${STAMP}.patch" || true
fi

for file in "${ROOT}/.env" \
            "/Users/dylanckawalec/Desktop/developer/Lucidity/.env" \
            "/Users/dylanckawalec/Desktop/developer/Synthesis-Trade/.env"; do
  if [[ -f "$file" ]]; then
    cp "$file" "${BACKUP_DIR}/$(basename "$(dirname "$file")")-$(basename "$file").${STAMP}.bak"
  fi
done

cp "${PROMPT_SRC}" "${SUPERIOR_HOME}/prompts/nemoclaw-godmode.system-prompt.md"
cp "${POLICY_SRC}" "${SUPERIOR_HOME}/policies/nemoclaw-godmode-policy.yaml"

if [[ -f "${ROOT}/service/package.json" ]]; then
  (cd "${ROOT}/service" && npm install)
fi
if [[ -f "${ROOT}/dashboard/package.json" ]]; then
  (cd "${ROOT}/dashboard" && npm install)
fi

(cd "${ROOT}/service" && ./node_modules/.bin/tsc -p tsconfig.json --noEmit)
(cd "${ROOT}" && docker compose up -d --build opseeq)

cat <<MSG
Opseeq God-Mode assets installed.
Prompt: ${SUPERIOR_HOME}/prompts/nemoclaw-godmode.system-prompt.md
Policy: ${SUPERIOR_HOME}/policies/nemoclaw-godmode-policy.yaml
Rollback patch: ${ROLLBACK_DIR}/pre-godmode-${STAMP}.patch
MSG
