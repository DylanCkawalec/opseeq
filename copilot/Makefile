# Opseeq Copilot Makefile — flat, greppable targets.
.PHONY: help install dev run stop test lint typecheck qc depth-check \
        bench bench-smoke api-integration clean refactor todo go-check \
        api-build api-run mcp-run web-run db-up db-down \
        agents-build agents-test schema

QGOT_ENV ?= ../../QGoT/.env
NODE_BIN ?= node
PNPM     ?= pnpm
GO       ?= go

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  %-20s %s\n",$$1,$$2}'
	@echo ""
	@echo "Quick start:  make install && make dev"

install: ## Install all toolchain deps (TS + Go + Prisma)
	$(PNPM) install
	cd api && $(GO) mod tidy
	$(PNPM) prisma generate --schema store/schema.prisma

dev: db-up ## Start full local dev stack (mcp + api + web)
	@echo "[copilot] launching mcp, api, web (Ctrl-C to stop)"
	@$(PNPM) run dev:all

run: dev ## Alias for dev

stop: ## Stop dev services and Postgres
	-@$(PNPM) run dev:stop
	-@$(MAKE) db-down

go-check:
	@if ! command -v $(GO) >/dev/null 2>&1; then \
	  echo "[go-check] $(GO) not found on PATH; install Go 1.22+ or set GO=/path/to/go"; \
	  exit 1; \
	fi

api-build: go-check ## Build the Go gateway binary
	cd api && $(GO) build -o ../bin/qgot-copilot-api .

api-run: api-build ## Run the gateway binary
	./bin/qgot-copilot-api

mcp-run: ## Run the MCP gateway server (stdio + SSE)
	$(PNPM) run mcp:start

web-run: ## Run the browser dashboard (Vite)
	$(PNPM) --filter ./web run dev

db-up: ## Start local Postgres (docker)
	docker compose -f store/docker-compose.yml up -d

db-down: ## Stop local Postgres
	docker compose -f store/docker-compose.yml down

schema: ## Apply Prisma migrations
	$(PNPM) prisma migrate dev --schema store/schema.prisma

test: ## Run all tests (TS + Go)
	$(PNPM) test
	@if command -v $(GO) >/dev/null 2>&1; then \
	  cd api && $(GO) test ./...; \
	else \
	  echo "[test] $(GO) not found on PATH; skipping Go tests"; \
	fi

lint: ## Run all linters
	$(PNPM) run lint
	@if command -v $(GO) >/dev/null 2>&1; then \
	  cd api && $(GO) vet ./...; \
	else \
	  echo "[lint] $(GO) not found on PATH; skipping Go vet"; \
	fi

typecheck: ## TS typecheck only
	$(PNPM) run typecheck

depth-check: ## Enforce ≤2 folder levels under copilot/ (excludes vendor/runtime)
	@violations=$$(find . -mindepth 3 -type d \
	  -not -path './node_modules/*' \
	  -not -path './*/node_modules/*' \
	  -not -path './runs/*' \
	  -not -path './api/vendor/*' \
	  -not -path './web/node_modules/*' \
	  -not -path './web/dist/*' \
	  -not -path './store/migrations/*' \
	  -not -path './bin/*'); \
	if [ -n "$$violations" ]; then \
	  echo "DEPTH VIOLATION (>2 levels):"; echo "$$violations"; exit 1; \
	else echo "[depth-check] OK — all owned dirs ≤ 2 levels"; fi

bench-smoke: ## Smoke benchmark via QGoT bench-hard-smoke (no Ollama)
	./bench/smoke.sh
api-integration: ## Verify API boundary → MCP → workflow → agents (mock providers)
	./bench/api_integration.sh

bench: ## Full paired bench against QGoT
	./bench/paired.sh
qc: lint typecheck depth-check bench-smoke api-integration ## Quality-control gate
	@echo "[qc] PASS"

refactor: ## Show refactor ledger
	@cat REFACTOR.md

todo: ## Show TODO ledger
	@cat TODO.md

clean: ## Remove build artifacts (keeps runs/)
	rm -rf bin/ web/dist/ api/vendor/
