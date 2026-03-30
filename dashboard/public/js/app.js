(function () {
  const POLL_MS = 5000;

  function $(id) { return document.getElementById(id); }
  function dot(id, online) {
    const el = $(id);
    if (!el) return;
    el.className = 'dot ' + (online ? 'green' : 'red');
  }
  function text(id, val) {
    const el = $(id);
    if (el) el.textContent = val ?? '--';
  }
  function formatUptime(s) {
    if (!s) return '--';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  async function poll() {
    try {
      const res = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const d = await res.json();

      text('version-badge', `v${d.meta?.version || '?'}`);
      text('meta-version', `v${d.meta?.version || '?'}`);
      dot('dot-kernel', true);

      const provCount = d.inference?.providerCount || 0;
      const modelCount = d.inference?.models?.length || 0;
      text('meta-providers', String(provCount));
      text('meta-models', String(modelCount));

      // Mermate
      const mm = d.mermate || {};
      dot('dot-mermate', mm.running);
      text('mermate-status', mm.running ? 'Online' : 'Offline');
      text('mermate-agents', mm.agentsLoaded != null ? String(mm.agentsLoaded) : '--');
      text('mermate-tla', mm.tlaAvailable ? 'Available' : 'Unavailable');
      text('mermate-ts', mm.tsAvailable ? 'Available' : 'Unavailable');

      // Synth
      const st = d.synthesisTrade || {};
      dot('dot-synth', st.reachable);
      text('synth-status', st.reachable ? 'Online' : 'Offline');
      text('synth-sim', st.simulationMode != null ? (st.simulationMode ? 'On' : 'Off') : '--');
      text('synth-pred', st.predictionsAvailable != null ? (st.predictionsAvailable ? 'Yes' : 'No') : '--');
      text('synth-ai', st.aiEngineAvailable != null ? (st.aiEngineAvailable ? 'Active' : 'Inactive') : '--');

      // Ollama
      const ol = d.ollama || {};
      dot('dot-ollama', ol.available);
      text('ollama-status', ol.available ? 'Online' : 'Offline');
      text('ollama-default', ol.defaultModel || '--');
      text('ollama-count', ol.models ? String(ol.models.length) : '0');
      text('meta-ollama-models', ol.models ? `${ol.models.length} models` : '--');

      // Kernel
      text('kernel-uptime', formatUptime(d.meta?.uptimeSeconds));
      text('kernel-mcp', d.mcp?.enabled ? `Enabled (${d.mcp?.endpoint || '/mcp'})` : 'Disabled');

      // Providers
      const providerList = $('provider-list');
      if (providerList && d.providers) {
        providerList.innerHTML = d.providers.map(p =>
          `<div class="provider-row"><span class="dot" style="background:var(--success)"></span>${p.name}</div>`
        ).join('');
      }

    } catch { /* silent */ }
  }

  // Plugin connector
  const btnConnect = $('btn-connect');
  const pluginPath = $('plugin-path');
  const pluginOutput = $('plugin-output');

  if (btnConnect) {
    btnConnect.addEventListener('click', () => {
      const p = pluginPath?.value?.trim();
      if (!p) return;
      const name = p.split('/').pop() || 'my-app';
      const config = `# Add these to ${name}/.env\nOPENAI_BASE_URL=http://localhost:9090/v1\nOPSEEQ_URL=http://localhost:9090\n\n# Optional: ${name}/.mcp.json\n${JSON.stringify({ mcpServers: { opseeq: { url: "http://localhost:9090/mcp" } } }, null, 2)}`;
      if (pluginOutput) {
        pluginOutput.textContent = config;
        pluginOutput.classList.add('visible');
      }
    });
  }

  poll();
  setInterval(poll, POLL_MS);
})();
