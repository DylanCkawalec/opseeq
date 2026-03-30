#!/usr/bin/env bash
set -euo pipefail

OPSEEQ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPSEEQ_PORT="${OPSEEQ_PORT:-9090}"
OPSEEQ_URL="http://127.0.0.1:${OPSEEQ_PORT}"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║      OPSEEQ DESKTOP LAUNCHER              ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

ensure_ollama() {
  if command -v ollama &>/dev/null; then
    if ! curl -sf http://127.0.0.1:11434/api/tags &>/dev/null; then
      echo "  Starting Ollama..."
      ollama serve &>/dev/null &
      sleep 3
    fi
    local count
    count=$(curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('models',[])))" 2>/dev/null || echo 0)
    echo "  Ollama: running ($count models)"
  else
    echo "  Ollama: not installed (skipping)"
  fi
}

ensure_opseeq() {
  if curl -sf "${OPSEEQ_URL}/health" &>/dev/null; then
    local ver
    ver=$(curl -sf "${OPSEEQ_URL}/health" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null || echo "?")
    echo "  Opseeq: already running (v${ver})"
    return 0
  fi

  echo "  Starting Opseeq gateway..."
  if docker start opseeq &>/dev/null; then
    echo "  Opseeq: restarted existing container"
  else
    docker run -d --name opseeq \
      -p "${OPSEEQ_PORT}:9090" \
      --restart unless-stopped \
      --env-file "${OPSEEQ_DIR}/.env" \
      opseeq:latest &>/dev/null \
    && echo "  Opseeq: started new container" \
    || { echo "  ERROR: could not start opseeq container"; return 1; }
  fi

  for i in 1 2 3 4 5; do
    sleep 2
    if curl -sf "${OPSEEQ_URL}/health" &>/dev/null; then
      local ver
      ver=$(curl -sf "${OPSEEQ_URL}/health" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null || echo "?")
      echo "  Opseeq: healthy (v${ver})"
      return 0
    fi
  done
  echo "  WARNING: opseeq did not become healthy in 10s"
  return 1
}

print_status() {
  echo ""
  echo "  ── System Status ──────────────────────────"
  curl -sf "${OPSEEQ_URL}/api/status" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  Providers:  {d[\"inference\"][\"providerCount\"]} ({len(d[\"inference\"][\"models\"])} models)')
print(f'  Mermate:    {\"online\" if d[\"mermate\"][\"running\"] else \"offline\"}')
print(f'  Synth:      {\"online\" if d[\"synthesisTrade\"][\"reachable\"] else \"offline\"}')
o=d.get('ollama',{})
print(f'  Ollama:     {\"online (\" + str(len(o.get(\"models\",[]))) + \" models)\" if o.get(\"available\") else \"offline\"}')
print(f'  MCP:        {\"enabled\" if d[\"mcp\"][\"enabled\"] else \"disabled\"}')
" 2>/dev/null || echo "  (status unavailable)"
  echo "  ─────────────────────────────────────────"
  echo ""
  echo "  Gateway:    ${OPSEEQ_URL}"
  echo "  API:        ${OPSEEQ_URL}/v1/chat/completions"
  echo "  Status:     ${OPSEEQ_URL}/api/status"
  echo "  MCP:        ${OPSEEQ_URL}/mcp"
  echo ""
}

ensure_ollama
ensure_opseeq
print_status
