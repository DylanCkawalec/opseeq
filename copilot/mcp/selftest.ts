// mcp/selftest.ts — list-tools + call qgot.plan against the running stdio server.
// Used by `make qc`. Spawns mcp/server.ts via tsx as a subprocess.
import { spawn } from "node:child_process";

interface JsonRpcReq { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown }

const child = spawn("npx", ["tsx", "mcp/server.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, QGOT_BRIDGE_MODE: process.env.QGOT_BRIDGE_MODE ?? "local" },
});

function send(req: JsonRpcReq) {
  child.stdin.write(JSON.stringify(req) + "\n");
}

let buf = "";
let received = 0;
const expected = 3;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    process.stdout.write(`[mcp.selftest] ${line.slice(0, 200)}…\n`);
    received++;
    if (received >= expected) {
      child.kill();
      process.exit(0);
    }
  }
});

send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "qgot.plan", arguments: { prompt: "selftest: write a 3-line README" } },
});
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "qgot.status", arguments: {} },
});

setTimeout(() => { console.error("mcp.selftest timeout"); child.kill(); process.exit(1); }, 30_000);
