// api/sse.go — SSE stream that tails runs/<id>/trace.ndjson.
package main

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func registerSSE(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc("/v1/copilot/runs/sse/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet { http.Error(w, "method", 405); return }
		runID := strings.TrimPrefix(r.URL.Path, "/v1/copilot/runs/sse/")
		if !isSafeRunID(runID) { http.Error(w, "invalid run id", 400); return }
		path := filepath.Join(cfg.RunsDir, runID, "trace.ndjson")

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		fl, ok := w.(http.Flusher)
		if !ok { http.Error(w, "stream unsupported", 500); return }

		var f *os.File
		// Wait briefly for the file to exist.
		for i := 0; i < 30; i++ {
			ff, err := os.Open(path)
			if err == nil { f = ff; break }
			time.Sleep(200 * time.Millisecond)
		}
		if f == nil { http.Error(w, "run not found", 404); return }
		defer f.Close()

		reader := bufio.NewReader(f)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			line, err := reader.ReadString('\n')
			if err == nil {
				fmt.Fprintf(w, "data: %s\n\n", strings.TrimRight(line, "\n"))
				fl.Flush()
				continue
			}
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				// keep-alive ping
				fmt.Fprint(w, ": ping\n\n")
				fl.Flush()
			}
		}
	})
}
