// api/config.go — Loads configuration from environment + .env hints.
package main

import (
	"bufio"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Host              string
	Port              string
	QGoTMCPCommand    string
	MCPTimeout        time.Duration
	MCPExecuteTimeout time.Duration
	RunsDir           string
	QGoTHTTP          string
}

func durationFromMillis(k string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return time.Duration(n) * time.Millisecond
}

func loadConfig() Config {
	loadDotenv(".env")
	if qgotEnv := os.Getenv("QGOT_ENV_PATH"); qgotEnv != "" {
		loadDotenv(qgotEnv)
	} else {
		loadDotenv("../../QGoT/.env")
	}
	c := Config{
		Host:              getenv("COPILOT_API_HOST", "127.0.0.1"),
		Port:              getenv("COPILOT_API_PORT", "7100"),
		QGoTMCPCommand:    getenv("QGOT_MCP_CMD", ""),
		MCPTimeout:        durationFromMillis("COPILOT_MCP_TIMEOUT_MS", 60*time.Second),
		MCPExecuteTimeout: durationFromMillis("COPILOT_MCP_EXECUTE_TIMEOUT_MS", durationFromMillis("QGOT_BRIDGE_EXECUTE_TIMEOUT_MS", 5*time.Minute)),
		RunsDir:           getenv("QGOT_RUN_DIR", "../runs"),
		QGoTHTTP:          getenv("QGOT_HTTP_BASE", "http://127.0.0.1:7300"),
	}
	abs, _ := filepath.Abs(c.RunsDir)
	c.RunsDir = abs
	return c
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadDotenv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		k := strings.TrimSpace(line[:eq])
		v := strings.TrimSpace(line[eq+1:])
		v = strings.Trim(v, `"'`)
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
	if err := sc.Err(); err != nil {
		log.Printf("[config] dotenv %s: %v", path, err)
	}
}
