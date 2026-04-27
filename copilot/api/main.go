// api/main.go — Single binary for the Opseeq Copilot gateway.
// Speaks REST, GraphQL, SSE, and /mcp/rpc; talks to QGoT MCP through QGOT_MCP_CMD.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg := loadConfig()
	mux := http.NewServeMux()

	registerHealth(mux)
	registerREST(mux, cfg)
	registerMetrics(mux, cfg)
	registerGraphQL(mux, cfg)
	registerSSE(mux, cfg)
	registerMCPProxy(mux, cfg)

	srv := &http.Server{
		Addr:              cfg.Host + ":" + cfg.Port,
		Handler:           withCORS(withLogging(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[api] listening on http://%s:%s", cfg.Host, cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("[api] shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
