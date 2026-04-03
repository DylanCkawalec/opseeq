#!/bin/bash
# One-time setup: register repo path, build macOS icon, copy Opseeq.app to Desktop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$HOME/.opseeq"
echo "$ROOT" > "$HOME/.opseeq/home"
echo "Wrote $HOME/.opseeq/home"

chmod +x "$ROOT/launch/mac/Opseeq.app/Contents/MacOS/Opseeq"

if [[ "$(uname -s)" == "Darwin" ]]; then
  "$ROOT/scripts/build-mac-icon.sh"
fi

DEST="$HOME/Desktop/Opseeq.app"
rm -rf "$DEST"
cp -R "$ROOT/launch/mac/Opseeq.app" "$DEST"
chmod +x "$DEST/Contents/MacOS/Opseeq"
echo "Installed $DEST"
echo ""
echo "Double-click Opseeq on your Desktop to open the dashboard."
echo "With OPSEEQ_SESSION_SHUTDOWN=1 (set by the launcher), closing all browser tabs stops the dashboard server."
echo "Optional: export OPSEEQ_OPEN_HITL=1 before opening the app to also launch opseeq-core chat in Terminal."
