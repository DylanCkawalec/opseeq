'use strict';

const express = require('express');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const {
  AppControlError,
  NemoClawControlError,
  getAppRegistry,
  setAppInference,
  openAppSurface,
  getNemoClawOverview,
  runNemoClawAction,
  setNemoClawDefaultSandbox,
  redeployOpseeqRuntime,
} = require('./lib/local-control');

const PORT = parseInt(process.env.OPSEEQ_DASHBOARD_PORT || '7070', 10);
const HOST = process.env.OPSEEQ_DASHBOARD_HOST || '127.0.0.1';
const GATEWAY = process.env.OPSEEQ_GATEWAY_URL || 'http://127.0.0.1:9090';
const SESSION_SHUTDOWN = process.env.OPSEEQ_SESSION_SHUTDOWN === '1';
const OPSEEQ_ROOT = path.resolve(__dirname, '..');
const NEMOCLAW_CLI = path.join(OPSEEQ_ROOT, 'bin', 'nemoclaw.js');
// NOTE: GENERAL_CLAWD_ROOT bridge eliminated — execution runtime is now absorbed into Opseeq (service/src/execution-runtime.ts)
const PTY_BRIDGE = path.join(__dirname, 'scripts', 'pty_bridge.py');
const SANDBOX_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const app = express();
app.use(express.json());

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveExecutable(name) {
  try {
    const found = execSync(`command -v ${name}`, { encoding: 'utf8' }).trim();
    return found.startsWith('/') ? found : null;
  } catch (_) {
    return null;
  }
}

const PYTHON_BIN = resolveExecutable('python3') || resolveExecutable('python');

function validateSandboxName(raw) {
  const name = String(raw || '').trim();
  if (!SANDBOX_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid sandbox name: ${raw}`);
  }
  return name;
}

function buildTerminalSpec(profile, payload) {
  switch (profile) {
    case 'opseeq-shell':
      return {
        label: 'Opseeq Shell',
        command: `cd ${shellQuote(OPSEEQ_ROOT)} && printf '%s\n' 'Opseeq workspace ready.' 'Repo: ${OPSEEQ_ROOT}' '' 'Use this shell for local commands.' '' && exec /bin/sh`,
      };
    case 'general-clawd':
    case 'execution-runtime':
      return {
        label: 'Execution Runtime Shell (absorbed)',
        command: `cd ${shellQuote(OPSEEQ_ROOT)} && printf '%s\n' 'Opseeq Execution Runtime (General-Clawd absorbed).' 'Repo: ${OPSEEQ_ROOT}' '' 'The execution runtime is now native to Opseeq.' 'See: service/src/execution-runtime.ts' '' && exec /bin/sh`,
      };
    case 'nemoclaw-connect': {
      const sandboxName = validateSandboxName(payload.sandboxName);
      return {
        label: `NemoClaw Connect: ${sandboxName}`,
        command: `cd ${shellQuote(OPSEEQ_ROOT)} && exec ${shellQuote(process.execPath)} ${shellQuote(NEMOCLAW_CLI)} ${shellQuote(sandboxName)} connect`,
      };
    }
    case 'nemoclaw-logs': {
      const sandboxName = validateSandboxName(payload.sandboxName);
      return {
        label: `NemoClaw Logs: ${sandboxName}`,
        command: `cd ${shellQuote(OPSEEQ_ROOT)} && exec ${shellQuote(process.execPath)} ${shellQuote(NEMOCLAW_CLI)} ${shellQuote(sandboxName)} logs --follow`,
      };
    }
    default:
      throw new Error(`Unknown terminal profile: ${profile}`);
  }
}

function spawnTerminalProcess(spec) {
  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
  };
  if (PYTHON_BIN) {
    return spawn(PYTHON_BIN, [PTY_BRIDGE, '--cwd', OPSEEQ_ROOT, '--command', spec.command], {
      cwd: OPSEEQ_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn('/bin/sh', ['-c', spec.command], {
    cwd: OPSEEQ_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

class TerminalBridge {
  constructor(ws) {
    this.ws = ws;
    this.child = null;
    this.currentProfile = null;
    this.killTimer = null;
  }

  send(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  start(profile, payload) {
    const spec = buildTerminalSpec(profile, payload || {});
    this.stop(false);
    const child = spawnTerminalProcess(spec);
    this.child = child;
    this.currentProfile = profile;
    this.send({ type: 'started', profile, label: spec.label });

    child.stdout.on('data', (chunk) => {
      this.send({ type: 'output', data: chunk.toString('utf8') });
    });
    child.stderr.on('data', (chunk) => {
      this.send({ type: 'output', data: chunk.toString('utf8') });
    });
    child.on('error', (err) => {
      this.send({ type: 'error', message: err.message });
    });
    child.on('close', (code, signal) => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.child = null;
      this.send({ type: 'exit', code, signal, profile });
    });
  }

  write(data) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(data);
  }

  stop(notify = true) {
    if (!this.child) {
      if (notify) this.send({ type: 'stopped' });
      return;
    }
    const child = this.child;
    this.child = null;
    try {
      child.stdin.end();
    } catch (_) {}
    child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, 1000);
    if (notify) this.send({ type: 'stopped' });
  }

  close() {
    this.stop(false);
  }

  handle(message) {
    switch (message.type) {
      case 'start':
        this.start(message.profile, message);
        break;
      case 'input':
        this.write(String(message.data || ''));
        break;
      case 'stop':
        this.stop();
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      default:
        this.send({ type: 'error', message: `Unknown terminal message: ${message.type}` });
    }
  }
}

function proxyToGateway(prefix) {
  return function (req, res) {
    const target = `${GATEWAY}${prefix}${req.url}`;
    const opts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    fetch(target, opts)
      .then(async (up) => {
        const text = await up.text();
        res.status(up.status)
          .set('Content-Type', up.headers.get('content-type') || 'application/json')
          .send(text);
      })
      .catch((err) => {
        res.status(502).json({ error: 'Gateway unreachable: ' + err.message });
      });
  };
}

app.get('/api/apps/registry', async (_req, res) => {
  try {
    res.json(await getAppRegistry(process.env));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/apps/inference', async (req, res) => {
  const appId = req.body?.appId || req.body?.id;
  try {
    res.json(await setAppInference(appId, req.body || {}, process.env));
  } catch (err) {
    if (err instanceof AppControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/apps/open', async (req, res) => {
  const appId = req.body?.appId || req.body?.id;
  try {
    res.json(await openAppSurface(appId, process.env));
  } catch (err) {
    if (err instanceof AppControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/nemoclaw/status', async (_req, res) => {
  try {
    res.json(await getNemoClawOverview(process.env));
  } catch (err) {
    if (err instanceof NemoClawControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/nemoclaw/actions', async (req, res) => {
  const action = req.body?.action;
  const sandboxName = req.body?.sandboxName || req.body?.name;
  if (!sandboxName || typeof sandboxName !== 'string') {
    res.status(400).json({ error: 'sandboxName is required' });
    return;
  }
  if (action !== 'connect' && action !== 'status' && action !== 'logs') {
    res.status(400).json({ error: 'action must be one of connect, status, or logs' });
    return;
  }
  try {
    res.json(await runNemoClawAction(action, sandboxName, process.env));
  } catch (err) {
    if (err instanceof NemoClawControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/nemoclaw/default', async (req, res) => {
  const sandboxName = req.body?.sandboxName || req.body?.name;
  if (!sandboxName || typeof sandboxName !== 'string') {
    res.status(400).json({ error: 'sandboxName is required' });
    return;
  }
  try {
    res.json(setNemoClawDefaultSandbox(sandboxName));
  } catch (err) {
    if (err instanceof NemoClawControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/runtime/redeploy', async (_req, res) => {
  try {
    res.json(await redeployOpseeqRuntime(process.env));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.use('/api', proxyToGateway('/api'));
app.use('/v1', proxyToGateway('/v1'));
app.get('/health', proxyToGateway(''));

app.get('/session-info', (req, res) => {
  res.json({
    sessionShutdown: SESSION_SHUTDOWN,
    graceMs: parseInt(process.env.OPSEEQ_SHUTDOWN_GRACE_MS || '30000', 10),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const terminalWss = new WebSocket.Server({ noServer: true });

let clients = 0;
let hadClient = false;
let shutdownTimer = null;

function scheduleShutdown() {
  if (!SESSION_SHUTDOWN) return;
  clearTimeout(shutdownTimer);
  const grace = parseInt(process.env.OPSEEQ_SHUTDOWN_GRACE_MS || '30000', 10);
  shutdownTimer = setTimeout(() => {
    if (clients === 0) {
      console.log('[session] all browser tabs closed — shutting down dashboard');
      clearInterval(pingInterval);
      wss.close(() => {
        server.close(() => process.exit(0));
      });
      setTimeout(() => process.exit(0), 5000);
    }
  }, grace);
}

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  });
}, 30000);

wss.on('connection', (ws) => {
  hadClient = true;
  clients++;
  clearTimeout(shutdownTimer);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('close', () => {
    clients = Math.max(0, clients - 1);
    if (clients === 0 && hadClient) scheduleShutdown();
  });
  ws.on('error', () => {});
});

terminalWss.on('connection', (ws) => {
  const bridge = new TerminalBridge(ws);
  bridge.send({ type: 'ready', scriptAvailable: Boolean(PYTHON_BIN), executionRuntimeAbsorbed: true });

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw));
      bridge.handle(message);
    } catch (err) {
      bridge.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
  ws.on('close', () => {
    bridge.close();
  });
  ws.on('error', () => {
    bridge.close();
  });
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch (_) {
    pathname = '';
  }
  if (pathname === '/session') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  if (pathname === '/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req);
    });
    return;
  }
  socket.destroy();
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[dashboard] port ${PORT} in use — stop the other process or set OPSEEQ_DASHBOARD_PORT`);
  } else {
    console.error('[dashboard]', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Opseeq Dashboard');
  console.log('  http://' + HOST + ':' + PORT);
  console.log('  Gateway: ' + GATEWAY);
  console.log(
    SESSION_SHUTDOWN
      ? '  Session:    close all browser tabs to stop this dashboard'
      : '  Session:    OPSEEQ_SESSION_SHUTDOWN=1 to exit when all tabs close'
  );
  console.log('');
});
