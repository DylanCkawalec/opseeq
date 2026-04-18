/**
 * Keeps a WebSocket alive while any Opseeq dashboard tab is open.
 * When OPSEEQ_SESSION_SHUTDOWN=1 on the server, closing all tabs
 * triggers a graceful dashboard shutdown after a grace period.
 */
(function () {
  const path = '/session';
  let ws;
  let reconnectTimer;

  fetch('/session-info', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .then((d) => {
      if (!d.sessionShutdown) return;
      ['session-hint', 'session-hint-dash'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = false;
      });
    })
    .catch(() => {});

  function connect() {
    try {
      const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + path;
      ws = new WebSocket(url);
      ws.onopen = function () {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };
      ws.onclose = function () {
        // Tab closed: execution stops — no reconnect.
        // Transient errors / server restart: retry briefly.
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = function () {};
    } catch (_) {}
  }

  connect();
})();
