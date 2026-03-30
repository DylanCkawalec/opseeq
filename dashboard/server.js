'use strict';

const express = require('express');
const path = require('path');
const http = require('http');

const PORT = parseInt(process.env.OPSEEQ_DASHBOARD_PORT || '7070', 10);
const GATEWAY = process.env.OPSEEQ_GATEWAY_URL || 'http://127.0.0.1:9090';

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

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('');
  console.log('  Opseeq Dashboard');
  console.log('  http://localhost:' + PORT);
  console.log('  Gateway: ' + GATEWAY);
  console.log('');
});
