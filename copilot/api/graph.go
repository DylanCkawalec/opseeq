// api/graph.go — Minimal hand-written GraphQL endpoint (no codegen).
// Supports query { run(id), runs, models } and mutation { submitPrompt, setRoleModel }.
// We intentionally hand-roll this for v0.1; see REFACTOR.md for gqlgen migration target.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type gqlReq struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

func registerGraphQL(mux *http.ServeMux, cfg Config) {
	mcp := NewMCPFromConfig(cfg)

	// SDL for tooling — served at /graphql/schema.
	mux.HandleFunc("/graphql/schema", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte(graphqlSDL))
	})

	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost { http.Error(w, "method", 405); return }
		var q gqlReq
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil { http.Error(w, err.Error(), 400); return }
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		op := strings.ToLower(q.Query)

		switch {
		case strings.Contains(op, "submitprompt"):
			prompt, _ := q.Variables["prompt"].(string)
			var envelope map[string]any
			if err := mcp.CallTool(ctx, "qgot.execute", map[string]any{"prompt": prompt}, &envelope); err != nil {
				gqlError(w, err); return
			}
			gqlData(w, map[string]any{"submitPrompt": envelope})

		case strings.Contains(op, "setrolemodel"):
			role, _ := q.Variables["role"].(string)
			provider, _ := q.Variables["provider"].(string)
			model, _ := q.Variables["model"].(string)
			var v map[string]any
			if err := mcp.CallTool(ctx, "qgot.models", map[string]any{
				"action": "set", "role": role, "provider": provider, "model": model,
			}, &v); err != nil {
				gqlError(w, err); return
			}
			gqlData(w, map[string]any{"setRoleModel": v})

		case strings.Contains(op, "models"):
			var v map[string]any
			if err := mcp.CallTool(ctx, "qgot.models", map[string]any{"action": "list"}, &v); err != nil {
				gqlError(w, err); return
			}
			gqlData(w, map[string]any{"models": v})

		case strings.Contains(op, "qgotstatus"):
			var v map[string]any
			if err := mcp.CallTool(ctx, "qgot.status", map[string]any{}, &v); err != nil {
				gqlError(w, err); return
			}
			gqlData(w, map[string]any{"qgotStatus": v})

		case strings.Contains(op, "run("):
			id, _ := q.Variables["id"].(string)
			if !isSafeRunID(id) {
				gqlError(w, errors.New("invalid run id"))
				return
			}
			st, err := os.ReadFile(filepath.Join(cfg.RunsDir, id, "state.json"))
			if err != nil { gqlError(w, err); return }
			var v map[string]any
			_ = json.Unmarshal(st, &v)
			gqlData(w, map[string]any{"run": v})

		case strings.Contains(op, "runs"):
			entries, _ := os.ReadDir(cfg.RunsDir)
			out := make([]map[string]any, 0, len(entries))
			for _, e := range entries {
				if !e.IsDir() { continue }
				if !isSafeRunID(e.Name()) { continue }
				st, err := os.ReadFile(filepath.Join(cfg.RunsDir, e.Name(), "state.json"))
				if err != nil { continue }
				var v map[string]any
				_ = json.Unmarshal(st, &v)
				out = append(out, v)
			}
			gqlData(w, map[string]any{"runs": out})

		default:
			gqlData(w, map[string]any{"hint": "unsupported query; see /graphql/schema"})
		}
	})
}

func gqlData(w http.ResponseWriter, data any) {
	writeJSON(w, 200, map[string]any{"data": data})
}

func gqlError(w http.ResponseWriter, err error) {
	writeJSON(w, 200, map[string]any{"errors": []map[string]any{{"message": err.Error()}}})
}

const graphqlSDL = `
scalar JSON
type Run {
  id: ID!
  prompt: String!
  status: String!
  driftMax: Float!
  startedAt: String!
  finishedAt: String
}

type Plan {
  id: ID!
  iteration: Int!
  summary: String!
  model: String!
  provider: String!
}

type Verification {
  id: ID!
  planId: ID!
  verdict: String!
  reason: String
  model: String!
  provider: String!
}

type RoleBinding {
  role: String!
  provider: String!
  model: String!
}

type ModelRegistry {
  bindings: [RoleBinding!]!
}

type Query {
  run(id: ID!): Run
  runs(limit: Int = 20): [Run!]!
  models: ModelRegistry!
  qgotStatus: JSON!
}

type Mutation {
  submitPrompt(prompt: String!): Run!
  setRoleModel(role: String!, provider: String!, model: String!): RoleBinding!
}
`
