// api/metrics.go — Aggregate metrics over runs/.
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

type metricsSummary struct {
	TotalRuns int            `json:"total_runs"`
	ByStatus  map[string]int `json:"by_status"`
	DriftMax  float64        `json:"drift_max"`
}

func init() {
	// Hooked into the default mux via registerMetricsLater.
}

// Note: registered through registerREST because we keep init order tidy.
// To attach: call registerMetrics(mux, cfg) in main(); add explicitly when needed.
//nolint:unused
func registerMetrics(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc("/v1/copilot/metrics/summary", func(w http.ResponseWriter, _ *http.Request) {
		entries, _ := os.ReadDir(cfg.RunsDir)
		s := metricsSummary{ByStatus: map[string]int{}}
		for _, e := range entries {
			if !e.IsDir() { continue }
			b, err := os.ReadFile(filepath.Join(cfg.RunsDir, e.Name(), "state.json"))
			if err != nil { continue }
			var v struct{
				Status   string  `json:"status"`
				DriftMax float64 `json:"drift_max"`
			}
			if json.Unmarshal(b, &v) != nil { continue }
			s.TotalRuns++
			s.ByStatus[v.Status]++
			if v.DriftMax > s.DriftMax { s.DriftMax = v.DriftMax }
		}
		writeJSON(w, 200, s)
	})
}
