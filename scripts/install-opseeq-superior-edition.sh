#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPERIOR_HOME="${HOME}/.opseeq-superior"
PROMPT_SRC="${ROOT}/config/nemoclaw-superior.system-prompt.md"
POLICY_SRC="${ROOT}/config/nemoclaw-superior-policy.yaml"
DASHBOARD_DIR="${ROOT}/dashboard"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_brew_pkg() {
  local pkg="$1"
  if need_cmd "$pkg"; then
    echo "[ok] ${pkg}"
    return 0
  fi
  if need_cmd brew; then
    echo "[install] brew install ${pkg}"
    brew install "$pkg"
  else
    echo "[error] Missing command: ${pkg} and Homebrew is not installed."
    exit 1
  fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer targets macOS only."
  exit 1
fi

mkdir -p "${SUPERIOR_HOME}/prompts" "${SUPERIOR_HOME}/policies" "${SUPERIOR_HOME}/logs" "${SUPERIOR_HOME}/rollback" "${SUPERIOR_HOME}/backups"

ensure_brew_pkg jq
ensure_brew_pkg tmux
ensure_brew_pkg python3
ensure_brew_pkg node
ensure_brew_pkg docker

if ! osascript -e 'id of application "iTerm"' >/dev/null 2>&1; then
  echo "[warn] iTerm2 does not appear to be installed in /Applications. Install iTerm2 before enabling the superior terminal bridge."
fi

python3 -m pip install --user --upgrade iterm2 watchdog pyyaml websockets >/dev/null

cp "${PROMPT_SRC}" "${SUPERIOR_HOME}/prompts/nemoclaw-superior.system-prompt.md"
cp "${POLICY_SRC}" "${SUPERIOR_HOME}/policies/nemoclaw-superior-policy.yaml"

if [[ -f "${ROOT}/.env" ]]; then
  cp "${ROOT}/.env" "${SUPERIOR_HOME}/backups/opseeq.env"
fi
if [[ -f "/Users/dylanckawalec/Desktop/developer/Synthesis-Trade/.env" ]]; then
  cp "/Users/dylanckawalec/Desktop/developer/Synthesis-Trade/.env" "${SUPERIOR_HOME}/backups/synth.env"
fi
if [[ -f "/Users/dylanckawalec/Desktop/developer/Lucidity/.env" ]]; then
  cp "/Users/dylanckawalec/Desktop/developer/Lucidity/.env" "${SUPERIOR_HOME}/backups/lucidity.env"
fi

if [[ -f "${DASHBOARD_DIR}/package.json" ]]; then
  (cd "${DASHBOARD_DIR}" && npm install)
fi

(cd "${ROOT}" && docker compose up -d --build opseeq)

echo ""
echo "Superior Edition assets installed to ${SUPERIOR_HOME}"
echo ""
echo "Next implementation steps:"
echo "1. Add the iTerm2 bridge, tmux broker, supervisor runtime, and guardrail engine described in docs/opseeq-nemoclaw-superior-edition.md"
echo "2. Run the validation suite before enabling superior mode as default"
echo "3. Launch the current dashboard with: ${ROOT}/scripts/launch-opseeq-desktop.sh"
echo ""
echo "Policy: ${SUPERIOR_HOME}/policies/nemoclaw-superior-policy.yaml"
echo "Prompt: ${SUPERIOR_HOME}/prompts/nemoclaw-superior.system-prompt.md"
