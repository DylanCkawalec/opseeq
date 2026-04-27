// mcp/server.ts — MCP gateway: exposes QGoT-backed copilot tools to MCP clients.
// Transports: stdio (always), HTTP/SSE (when COPILOT_MCP_PORT is set).
import * as http from "node:http";
import { ulid } from "ulid";
import { WorkflowEngine } from "../workflow/engine.ts";
import { PlannerAgent } from "../agents/planner.ts";
import { VerifierAgent } from "../agents/verifier.ts";
import { registry } from "../models/registry.ts";
import { env, loadEnv } from "../models/env.ts";
import { qgotBridge, qgotServiceBridge } from "./qgot_bridge.ts";

loadEnv();
const engine = new WorkflowEngine({ qgotBridge: qgotBridge() });
const qgotService = qgotServiceBridge();
const planner = new PlannerAgent();
const verifier = new VerifierAgent();

interface JsonRpcReq { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown }
interface JsonRpcRes { jsonrpc: "2.0"; id: string | number; result?: unknown; error?: { code: number; message: string } }

const TOOLS = [
  {
    name: "qgot.plan",
    description: "Run the Expert Planner for a prompt, returning a structured Plan.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  },
  {
    name: "qgot.verify",
    description: "Run the Expert Verifier against a (prompt, plan) pair.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, plan: { type: "object" } }, required: ["prompt", "plan"] },
  },
  {
    name: "qgot.execute",
    description: "Submit a prompt to the full workflow (plan→verify→execute) and stream a run envelope.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  },
  {
    name: "qgot.observe",
    description: "Pause/resume/redirect a running run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        action: { type: "string", enum: ["pause", "resume", "redirect"] },
        reason: { type: "string" },
        new_prompt: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "qgot.qal.simulate",
    description: "Pass-through to QGoT QAL stream-lab simulation endpoint.",
    inputSchema: { type: "object" },
  },
  {
    name: "qgot.models",
    description: "List or update role→model bindings.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "set"] },
        role: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "qgot.status",
    description: "Report Rust QGoT HTTP/MCP/readiness status as seen by Opseeq.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function dispatch(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method) {
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const structuredContent = await callTool(name, args);
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false,
      };
    }
    case "initialize":
      return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "qgot-copilot", version: "0.1.0" } };
    case "ping":
      return {};
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "qgot.plan":
      return await qgotService.plan(args) ?? planner.plan({ run_id: ulid(), prompt: String(args.prompt ?? ""), iteration: 0 });
    case "qgot.verify":
      return await qgotService.verify(args) ?? verifier.verify({ prompt: String(args.prompt ?? ""), plan: args.plan as never });
    case "qgot.execute":
      return await qgotService.execute(args) ?? engine.submit(String(args.prompt ?? ""));
    case "qgot.observe": {
      if (!args.action || args.action === "status") {
        return await qgotService.observe(args) ?? qgotService.status();
      }
      const run_id = String(args.run_id);
      switch (args.action) {
        case "pause": return { ok: engine.pause(run_id, String(args.reason ?? "")) };
        case "resume": return { ok: engine.resume(run_id) };
        case "redirect": return { ok: engine.redirect(run_id, String(args.new_prompt ?? "")) };
      }
      throw new Error("invalid action");
    }
    case "qgot.qal.simulate":
      return qgotBridge().qalSimulate(args);
    case "qgot.models": {
      if (!args.action || args.action === "list") {
        const remote = await qgotService.models(args);
        if (remote) return remote;
      }
      const reg = registry();
      if (args.action === "list") return { bindings: reg.list() };
      if (args.action === "set") {
        return reg.setRole(args.role as never, args.provider as never, String(args.model ?? ""));
      }
      throw new Error("invalid action");
    }
    case "qgot.status":
      return qgotService.status();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── stdio transport (canonical MCP) ─────────────────────
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req: JsonRpcReq;
    try { req = JSON.parse(line) as JsonRpcReq; } catch { continue; }
    const res: JsonRpcRes = { jsonrpc: "2.0", id: req.id };
    try { res.result = await dispatch(req.method, (req.params ?? {}) as Record<string, unknown>); }
    catch (e) { res.error = { code: -32000, message: (e as Error).message }; }
    process.stdout.write(JSON.stringify(res) + "\n");
  }
});

// ── HTTP/SSE transport (optional) ───────────────────────
const port = Number(env("COPILOT_MCP_PORT", "0"));
if (port > 0) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const r = JSON.parse(body) as JsonRpcReq;
          const out: JsonRpcRes = { jsonrpc: "2.0", id: r.id };
          try { out.result = await dispatch(r.method, (r.params ?? {}) as Record<string, unknown>); }
          catch (e) { out.error = { code: -32000, message: (e as Error).message }; }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(400);
          res.end((e as Error).message);
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[mcp] HTTP/SSE on http://127.0.0.1:${port}\n`);
  });
}

process.stderr.write("[mcp] qgot-copilot MCP server ready (stdio)\n");
