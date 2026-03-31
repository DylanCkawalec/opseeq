#!/usr/bin/env bash
# Build the canonical Opseeq image: opseeq:v5
# Synth (synthesis-trade/docker-compose.yml) and run.sh use this tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "Building opseeq:v5 from Dockerfile.service …"
docker build -f Dockerfile.service -t opseeq:v5 .
echo ""
echo "Done. Canonical image: opseeq:v5"
echo "Push to DockerHub:"
echo "  docker tag opseeq:v5 dylanckawalec/opseeq:v5 && docker push dylanckawalec/opseeq:v5"
