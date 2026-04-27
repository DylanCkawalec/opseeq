package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMCPClientRequiresQGoTMCPCommand(t *testing.T) {
	client := NewMCPClient(MCPClientConfig{Timeout: time.Second})
	var out map[string]any
	err := client.CallTool(context.Background(), "qgot.status", map[string]any{}, &out)
	if err == nil {
		t.Fatal("expected missing QGOT_MCP_CMD error")
	}
	if !strings.Contains(err.Error(), "QGOT_MCP_CMD is required") {
		t.Fatalf("expected production QGOT_MCP_CMD error, got %v", err)
	}
}

func TestMCPCallToolUsesQGoTMCPCommand(t *testing.T) {
	cmd := writeFakeQGoTMCPCommand(t)
	client := NewMCPClient(MCPClientConfig{
		QGoTMCPCommand: cmd,
		Timeout:        time.Second,
	})

	var out map[string]any
	if err := client.CallTool(context.Background(), "qgot.status", map[string]any{}, &out); err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if out["source"] != "qgot-mcp-test" {
		t.Fatalf("expected qgot-mcp-test source, got %#v", out)
	}
}

func TestMCPProxyUsesQGoTMCPCommandOnly(t *testing.T) {
	cmd := writeFakeQGoTMCPCommand(t)
	client := NewMCPClient(MCPClientConfig{
		QGoTMCPCommand: cmd,
		Timeout:        time.Second,
	})

	body := []byte(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"qgot.status","arguments":{}}}`)
	payload, status, err := client.Proxy(context.Background(), body)
	if err != nil {
		t.Fatalf("Proxy failed: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	var rpc struct {
		Result struct {
			StructuredContent map[string]any `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(payload, &rpc); err != nil {
		t.Fatalf("invalid JSON-RPC payload: %v", err)
	}
	if rpc.Result.StructuredContent["source"] != "qgot-mcp-test" {
		t.Fatalf("expected qgot-mcp-test source, got %s", string(payload))
	}
}

func writeFakeQGoTMCPCommand(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-qgot-mcp.sh")
	script := `#!/bin/sh
REQ="$(cat)"
case "$REQ" in
  *'"method":"tools/list"'*)
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"qgot.status"}]}}'
    ;;
  *'"name":"qgot.status"'*)
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"ok\":false}"}],"structuredContent":{"ok":true,"source":"qgot-mcp-test"},"isError":false}}'
    ;;
  *)
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"unexpected fake request"}}'
    ;;
esac
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake MCP command: %v", err)
	}
	return path
}
