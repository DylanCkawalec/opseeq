// api/proxy.go — Mounts the MCP HTTP transport at /mcp/* for IDEs/MCP clients.
package main

import (
	"io"
	"net/http"
)

func registerMCPProxy(mux *http.ServeMux, cfg Config) {
	mcp := NewMCPFromConfig(cfg)
	mux.HandleFunc("/mcp/rpc", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost { http.Error(w, "method", 405); return }
		body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		if err != nil { http.Error(w, err.Error(), 400); return }
		payload, status, err := mcp.Proxy(r.Context(), body)
		if err != nil { http.Error(w, err.Error(), status); return }
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(payload)
	})
}
