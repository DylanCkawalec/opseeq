// api/rest.go — REST endpoints for prompt submission, run lookup, model bindings.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func isSafeRunID(runID string) bool {
	if runID == "" || len(runID) > 128 {
		return false
	}
	for _, r := range runID {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func registerHealth(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ready": true})
	})
}

func registerREST(mux *http.ServeMux, cfg Config) {
	mcp := NewMCPFromConfig(cfg)
	mux.HandleFunc("/v1/copilot/qgot/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet { http.Error(w, "method", 405); return }
		var v map[string]any
		if err := mcp.CallTool(r.Context(), "qgot.status", map[string]any{}, &v); err != nil {
			writeJSON(w, 200, map[string]any{
				"ok": false,
				"source": "opseeq.api",
				"status": "qgot_status_unavailable",
				"qgot_http_base": cfg.QGoTHTTP,
				"error": err.Error(),
			})
			return
		}
		writeJSON(w, 200, v)
	})

	mux.HandleFunc("/v1/copilot/prompt", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost { http.Error(w, "method", 405); return }
		var body struct{ Prompt string `json:"prompt"` }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil { http.Error(w, err.Error(), 400); return }
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		var envelope map[string]any
		if err := mcp.CallTool(ctx, "qgot.execute", map[string]any{"prompt": body.Prompt}, &envelope); err != nil {
			http.Error(w, err.Error(), 502); return
		}
		writeJSON(w, 200, envelope)
	})

	mux.HandleFunc("/v1/copilot/runs/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet { http.Error(w, "method", 405); return }
		// /v1/copilot/runs/<id>          → state.json
		// /v1/copilot/runs/<id>/events   → trace.ndjson
		path := strings.TrimPrefix(r.URL.Path, "/v1/copilot/runs/")
		parts := strings.Split(path, "/")
		runID := parts[0]
		if !isSafeRunID(runID) { http.Error(w, "invalid run id", 400); return }
		if len(parts) == 2 && parts[1] == "events" {
			http.ServeFile(w, r, filepath.Join(cfg.RunsDir, runID, "trace.ndjson"))
			return
		}
		if len(parts) != 1 {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(cfg.RunsDir, runID, "state.json"))
	})

	mux.HandleFunc("/v1/copilot/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet { http.Error(w, "method", 405); return }
		entries, err := os.ReadDir(cfg.RunsDir)
		if err != nil { writeJSON(w, 200, []any{}); return }
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
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("/v1/copilot/models", func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		switch r.Method {
		case http.MethodGet:
			var v map[string]any
			if err := mcp.CallTool(ctx, "qgot.models", map[string]any{"action": "list"}, &v); err != nil {
				http.Error(w, err.Error(), 502); return
			}
			writeJSON(w, 200, v)
		case http.MethodPut:
			var body struct{ Role, Provider, Model string }
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil { http.Error(w, err.Error(), 400); return }
			var v map[string]any
			if err := mcp.CallTool(ctx, "qgot.models", map[string]any{
				"action": "set", "role": body.Role, "provider": body.Provider, "model": body.Model,
			}, &v); err != nil {
				http.Error(w, err.Error(), 502); return
			}
			writeJSON(w, 200, v)
		default:
			http.Error(w, "method", 405)
		}
	})

	mux.HandleFunc("/v1/copilot/runs/control", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost { http.Error(w, "method", 405); return }
		var body struct{ RunID, Action, Reason, NewPrompt string }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil { http.Error(w, err.Error(), 400); return }
		if !isSafeRunID(body.RunID) { http.Error(w, "invalid run id", 400); return }
		var v map[string]any
		if err := mcp.CallTool(r.Context(), "qgot.observe", map[string]any{
			"run_id": body.RunID, "action": body.Action, "reason": body.Reason, "new_prompt": body.NewPrompt,
		}, &v); err != nil {
			http.Error(w, err.Error(), 502); return
		}
		writeJSON(w, 200, v)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
