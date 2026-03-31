'use strict';

const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.env.OPSEEQ_DASHBOARD_PORT || '7070', 10);
const GATEWAY = process.env.OPSEEQ_GATEWAY_URL || 'http://127.0.0.1:9090';
const SESSION_SHUTDOWN = process.env.OPSEEQ_SESSION_SHUTDOWN === '1';

const app = express();
app.use(express.json());

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
const wss = new WebSocket.Server({ server, path: '/session' });

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

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[dashboard] port ${PORT} in use — stop the other process or set OPSEEQ_DASHBOARD_PORT`);
  } else {
    console.error('[dashboard]', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Opseeq Dashboard');
  console.log('  http://localhost:' + PORT);
  console.log('  Gateway: ' + GATEWAY);
  console.log(
    SESSION_SHUTDOWN
      ? '  Session:    close all browser tabs to stop this dashboard'
      : '  Session:    OPSEEQ_SESSION_SHUTDOWN=1 to exit when all tabs close'
  );
  console.log('');
});
