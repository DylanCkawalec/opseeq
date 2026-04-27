// api/mcp.go — JSON-RPC client/proxy for the production QGoT MCP gateway.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcRes struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type MCPClientConfig struct {
	QGoTMCPCommand string
	Timeout        time.Duration
	ExecuteTimeout time.Duration
}

type MCPClient struct {
	QGoTMCPCommand string
	Timeout        time.Duration
	ExecuteTimeout time.Duration
	id             uint64
}

// NewMCP is retained for older call sites. Production use must provide
// QGOT_MCP_CMD through NewMCPFromConfig.
func NewMCP(_ string) *MCPClient {
	return NewMCPClient(MCPClientConfig{})
}

func NewMCPFromConfig(cfg Config) *MCPClient {
	return NewMCPClient(MCPClientConfig{
		QGoTMCPCommand: cfg.QGoTMCPCommand,
		Timeout:        cfg.MCPTimeout,
		ExecuteTimeout: cfg.MCPExecuteTimeout,
	})
}

func NewMCPClient(cfg MCPClientConfig) *MCPClient {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	executeTimeout := cfg.ExecuteTimeout
	if executeTimeout <= 0 {
		executeTimeout = 5 * time.Minute
	}
	return &MCPClient{
		QGoTMCPCommand: strings.TrimSpace(cfg.QGoTMCPCommand),
		Timeout:        timeout,
		ExecuteTimeout: executeTimeout,
	}
}

func (m *MCPClient) Call(ctx context.Context, method string, params any, out any) error {
	id := atomic.AddUint64(&m.id, 1)
	body, err := json.Marshal(rpcReq{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return err
	}
	payload, err := m.callQGoTMCPRaw(ctx, body, m.timeoutFor(inspectRPCRequest(body)))
	if err != nil {
		return err
	}
	return decodeRPCResult(payload, out)
}

// Proxy forwards one raw JSON-RPC request to the configured QGoT MCP command.
// It does not fall back to TS/local transports; missing or failing QGoT MCP is a
// production integration failure and returns 502.
func (m *MCPClient) Proxy(ctx context.Context, body []byte) ([]byte, int, error) {
	payload, err := m.callQGoTMCPRaw(ctx, body, m.timeoutFor(inspectRPCRequest(body)))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	return payload, http.StatusOK, nil
}

func (m *MCPClient) callQGoTMCPRaw(ctx context.Context, body []byte, timeout time.Duration) ([]byte, error) {
	if strings.TrimSpace(m.QGoTMCPCommand) == "" {
		return nil, fmt.Errorf("QGOT_MCP_CMD is required for production QGoT MCP integration")
	}
	ctx, cancel := contextWithDefaultTimeout(ctx, timeout)
	defer cancel()

	cmd := shellCommand(ctx, m.QGoTMCPCommand)
	cmd.Stdin = bytes.NewReader(append(bytes.TrimSpace(body), '\n'))
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	line := firstJSONLine(stdout.String())
	if len(line) > 0 {
		return line, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("QGoT MCP command failed: %s", msg)
	}
	if msg := strings.TrimSpace(stderr.String()); msg != "" {
		return nil, fmt.Errorf("QGoT MCP command produced no JSON-RPC response: %s", msg)
	}
	return nil, fmt.Errorf("QGoT MCP command returned no JSON-RPC response")
}

func shellCommand(ctx context.Context, command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.CommandContext(ctx, "cmd", "/C", command)
	}
	return exec.CommandContext(ctx, "/bin/sh", "-lc", command)
}

func firstJSONLine(stdout string) []byte {
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "{") || strings.HasPrefix(line, "[") {
			return []byte(line)
		}
	}
	return nil
}

func contextWithDefaultTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, timeout)
}

func decodeRPCResult(body []byte, out any) error {
	var r rpcRes
	if err := json.Unmarshal(body, &r); err != nil {
		return err
	}
	if r.Error != nil {
		return fmt.Errorf("mcp: %s", r.Error.Message)
	}
	if out == nil || len(r.Result) == 0 {
		return nil
	}
	return json.Unmarshal(r.Result, out)
}

type rpcMeta struct {
	Method string
	Tool   string
}

func inspectRPCRequest(body []byte) rpcMeta {
	var raw struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	_ = json.Unmarshal(body, &raw)
	return rpcMeta{Method: raw.Method, Tool: raw.Params.Name}
}

func (m *MCPClient) timeoutFor(meta rpcMeta) time.Duration {
	switch meta.Tool {
	case "qgot.execute", "qgot.qal.simulate":
		return m.ExecuteTimeout
	default:
		return m.Timeout
	}
}

// CallTool wraps tools/call, unwrapping MCP structuredContent when present.
// Older text-only MCP responses are accepted only when the text is valid JSON.
func (m *MCPClient) CallTool(ctx context.Context, name string, args any, out any) error {
	var raw struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           bool            `json:"isError"`
	}
	if err := m.Call(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &raw); err != nil {
		return err
	}
	if raw.IsError {
		msg := "tool returned error"
		if len(raw.Content) > 0 && strings.TrimSpace(raw.Content[0].Text) != "" {
			msg = raw.Content[0].Text
		}
		return fmt.Errorf("mcp tool %s: %s", name, msg)
	}
	if len(raw.StructuredContent) > 0 && string(raw.StructuredContent) != "null" && out != nil {
		return json.Unmarshal(raw.StructuredContent, out)
	}
	if len(raw.Content) == 0 || out == nil {
		return nil
	}
	return json.Unmarshal([]byte(raw.Content[0].Text), out)
}
