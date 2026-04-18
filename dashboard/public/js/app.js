(function () {
  const POLL_MS = 5000;
  const TERMINAL_PATH = '/terminal';
  const TERMINAL_PLACEHOLDER = 'No terminal session started.';
  let terminalSocket = null;
  let terminalReconnectTimer = null;
  let terminalPendingStart = null;
  let latestGatewayStatus = null;
  let latestAppRegistry = null;

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
  function appendEventLine(message) {
    const list = $('events-list');
    if (!list) return;
    const line = document.createElement('div');
    line.className = 'event-line';
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    list.prepend(line);
    while (list.children.length > 12) list.removeChild(list.lastChild);
  }
  function formatUptime(s) {
    if (!s) return '--';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }
  function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
  }
  function formatDate(value) {
    if (!value) return 'unknown';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'unknown';
    return parsed.toLocaleString();
  }
  function statePillClass(state) {
    switch (state) {
      case 'present': return 'ok';
      case 'gateway_error': return 'warn';
      case 'missing': return 'error';
      default: return 'muted';
    }
  }
  function setActiveView(view) {
    document.querySelectorAll('[data-view-target]').forEach((button) => {
      const active = button.getAttribute('data-view-target') === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-view]').forEach((panel) => {
      const active = panel.getAttribute('data-view') === view;
      panel.hidden = !active;
      panel.classList.toggle('view-panel-active', active);
    });
  }
  function renderRepoConnectSummary(result) {
    const lines = [
      `Repo: ${result.analysis?.repoName || result.repoPath}`,
      `Kinds: ${(result.analysis?.detectedKinds || []).join(', ') || 'unknown'}`,
      `Desktop: ${result.analysis?.desktopWrapper?.detected ? result.analysis.desktopWrapper.kind : 'not detected'}`,
      `Start: ${result.analysis?.runtime?.startCommand || 'not detected'}`,
      `App URL: ${result.analysis?.runtime?.openUrl || 'not detected'}`,
      '',
      'Checks:',
      ...(result.checks || []).map((check) => `- ${check.item}: ${check.status}${check.action ? ` (${check.action})` : ''}`),
    ];
    if (result.warnings?.length) {
      lines.push('', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`));
    }
    return lines.join('\n');
  }
  async function fetchJson(url, options, timeoutMs = 5000) {
    const res = await fetch(url, { ...(options || {}), signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function setTerminalState(label, tone) {
    const el = $('nemoclaw-terminal-state');
    if (!el) return;
    el.textContent = label;
    el.className = `state-pill ${tone || 'muted'}`;
  }
  function normalizeTerminalChunk(chunk) {
    return String(chunk ?? '')
      .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\x08/g, '')
      .replace(/[^\x09\x0A\x20-\x7E]/g, '');
  }
  function clearTerminalOutput(message) {
    const screen = $('nemoclaw-terminal-screen');
    if (!screen) return;
    screen.textContent = message || TERMINAL_PLACEHOLDER;
  }
  function appendTerminalOutput(chunk, replace = false) {
    const screen = $('nemoclaw-terminal-screen');
    if (!screen) return;
    const normalized = normalizeTerminalChunk(chunk);
    if (!normalized && !replace) return;
    if (replace) {
      screen.textContent = normalized || TERMINAL_PLACEHOLDER;
    } else if (screen.textContent === TERMINAL_PLACEHOLDER) {
      screen.textContent = normalized;
    } else {
      screen.textContent += normalized;
    }
    screen.scrollTop = screen.scrollHeight;
  }
  function sendTerminalMessage(message) {
    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
      terminalSocket.send(JSON.stringify(message));
      return true;
    }
    appendTerminalOutput('\n[terminal] session socket is not ready.\n');
    setTerminalState('Disconnected', 'error');
    return false;
  }
  function connectTerminalSocket() {
    if (terminalSocket && (terminalSocket.readyState === WebSocket.OPEN || terminalSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const screen = $('nemoclaw-terminal-screen');
    if (!screen) return;
    const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + TERMINAL_PATH;
    terminalSocket = new WebSocket(url);
    terminalSocket.onopen = () => {
      if (terminalReconnectTimer) {
        clearTimeout(terminalReconnectTimer);
        terminalReconnectTimer = null;
      }
      setTerminalState('Ready', 'ok');
      if (terminalPendingStart) {
        sendTerminalMessage(terminalPendingStart);
        terminalPendingStart = null;
      }
    };
    terminalSocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case 'ready':
            setTerminalState(message.scriptAvailable ? 'Ready' : 'Shell fallback', message.scriptAvailable ? 'ok' : 'warn');
            break;
          case 'started':
            setTerminalState(message.label || 'Running', 'ok');
            appendTerminalOutput(`[session] ${message.label || message.profile} started\n`, true);
            break;
          case 'output':
            appendTerminalOutput(message.data);
            break;
          case 'stopped':
            setTerminalState('Stopped', 'muted');
            appendTerminalOutput('\n[session] stopped\n');
            break;
          case 'exit':
            setTerminalState('Exited', message.code === 0 || message.code == null ? 'muted' : 'warn');
            appendTerminalOutput(`\n[session] exited${message.code != null ? ` with code ${message.code}` : ''}${message.signal ? ` (${message.signal})` : ''}\n`);
            break;
          case 'error':
            setTerminalState('Error', 'error');
            appendTerminalOutput(`\n[session] error: ${message.message}\n`);
            break;
          case 'pong':
            break;
          default:
            appendTerminalOutput(`\n[session] ${event.data}\n`);
        }
      } catch {
        appendTerminalOutput(`\n${String(event.data)}\n`);
      }
    };
    terminalSocket.onclose = () => {
      setTerminalState('Disconnected', 'error');
      terminalReconnectTimer = setTimeout(connectTerminalSocket, 2000);
    };
    terminalSocket.onerror = () => {
      setTerminalState('Error', 'error');
    };
  }
  function startTerminalSession(profile, payload) {
    setActiveView('nemoclaw');
    terminalPendingStart = { type: 'start', profile, ...(payload || {}) };
    clearTerminalOutput(`[session] starting ${profile}\n`);
    setTerminalState('Starting…', 'warn');
    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
      sendTerminalMessage(terminalPendingStart);
      terminalPendingStart = null;
      return;
    }
    connectTerminalSocket();
  }
  function summarizeInference(app) {
    const provider = app?.inference?.provider || 'unknown';
    const model = app?.inference?.model || 'unknown';
    return `${provider} • ${model}`;
  }
  function getProviderOptions(currentProvider) {
    return unique([currentProvider || 'opseeq', 'opseeq', 'ollama']);
  }
  function getModelOptions(provider, currentModel) {
    const ollamaModels = (latestGatewayStatus?.ollama?.models || []).map((entry) => entry.name).filter(Boolean);
    const gatewayModels = latestGatewayStatus?.inference?.models || [];
    let options = [];
    if (provider === 'ollama') {
      options = ollamaModels;
    } else if (provider === 'opseeq') {
      options = gatewayModels;
      if (!options.includes('gateway-default')) options = ['gateway-default', ...options];
    } else {
      options = [currentModel];
    }
    return unique([currentModel, ...options]);
  }
  function buildSelectOptions(values, selectedValue) {
    return values.map((value) => `<option value="${escapeAttr(value)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
  }
  function populateModelSelect(select, provider, currentValue) {
    if (!select) return;
    const options = getModelOptions(provider, currentValue);
    const nextValue = options.includes(currentValue) ? currentValue : (options[0] || '');
    select.innerHTML = buildSelectOptions(options, nextValue);
  }
  function renderAppRegistry(data) {
    latestAppRegistry = data;
    const apps = Array.isArray(data?.apps) ? data.apps : [];
    const extensionCatalog = Array.isArray(data?.extensionCatalog) ? data.extensionCatalog : [];
    text('app-registry-path', data?.registryPath || '--');
    text('app-registry-count', String(apps.length));
    text('models-local-count', String((latestGatewayStatus?.ollama?.models || []).length));
    const mermate = apps.find((app) => app.id === 'mermate');
    const synth = apps.find((app) => app.id === 'synth');
    text('mermate-model', mermate ? summarizeInference(mermate) : '--');
    text('synth-model', synth ? summarizeInference(synth) : '--');
    text('ollama-assigned', String(apps.filter((app) => app.inference?.provider === 'ollama').length));

    const extensionList = $('extension-list');
    if (extensionList) {
      extensionList.innerHTML = extensionCatalog.length
        ? extensionCatalog.map((extension) => `
          <article class="extension-item">
            <div class="extension-overview">
              <div class="extension-title">${escapeHtml(extension.label)}</div>
              <div class="extension-meta">${escapeHtml(extension.description || 'No description')}</div>
              <div class="extension-meta">${escapeHtml(extension.path || 'No local path')}</div>
            </div>
            <div class="app-routing-tags">
              <span class="state-pill ${extension.exists ? 'ok' : 'warn'}">${extension.exists ? 'Present' : 'Missing'}</span>
            </div>
          </article>
        `).join('')
        : '<div class="empty-state">No extension packs registered.</div>';
    }

    const appRoutingList = $('app-routing-list');
    if (appRoutingList) {
      appRoutingList.innerHTML = apps.length
        ? apps.map((app) => {
          const providerOptions = getProviderOptions(app.inference?.provider);
          const modelOptions = getModelOptions(app.inference?.provider, app.inference?.model);
          const tags = [
            app.reachable ? '<span class="state-pill ok">Reachable</span>' : '<span class="state-pill warn">Offline</span>',
            app.launchReady ? '<span class="state-pill ok">Launch Ready</span>' : '<span class="state-pill muted">No Launch Cmd</span>',
            app.repoExists ? '<span class="state-pill ok">Repo Found</span>' : '<span class="state-pill warn">Repo Missing</span>',
          ].join('');
          return `
            <article class="app-routing-item" data-app-routing-id="${escapeAttr(app.id)}">
              <div class="app-routing-overview">
                <div class="app-routing-title">${escapeHtml(app.label)}</div>
                <div class="app-routing-meta">${escapeHtml(app.url)}</div>
                <div class="app-routing-meta">Mode: ${escapeHtml(app.inference?.mode || 'unknown')} · Source: ${escapeHtml(app.inference?.source || 'unknown')}</div>
                <div class="app-routing-meta">Current: ${escapeHtml(summarizeInference(app))}</div>
                <div class="app-routing-meta ${app.notes?.length ? '' : 'app-routing-note'}">${escapeHtml(app.notes?.[0] || 'No extra notes.')}</div>
                <div class="app-routing-tags">
                  ${tags}
                  ${(app.extensions || []).map((extension) => `<span class="state-pill muted">${escapeHtml(extension.label)}</span>`).join('')}
                </div>
              </div>
              <div class="app-routing-actions">
                <select class="app-routing-select" data-app-provider data-app-id="${escapeAttr(app.id)}">
                  ${buildSelectOptions(providerOptions, app.inference?.provider || providerOptions[0])}
                </select>
                <select class="app-routing-select" data-app-model data-app-id="${escapeAttr(app.id)}">
                  ${buildSelectOptions(modelOptions, app.inference?.model || modelOptions[0])}
                </select>
                <button class="btn-open" type="button" data-app-action="save" data-app-id="${escapeAttr(app.id)}">Save</button>
                <button class="btn-open" type="button" data-app-action="open" data-app-id="${escapeAttr(app.id)}">Open</button>
              </div>
            </article>
          `;
        }).join('')
        : '<div class="empty-state">No app assignments registered.</div>';
    }
  }
  function renderNemoClawOverview(data) {
    const gateway = data.gateway || {};
    const sandboxes = Array.isArray(data.sandboxes) ? data.sandboxes : [];
    const apps = Array.isArray(data.apps) ? data.apps : [];
    const mermate = apps.find((app) => app.id === 'mermate');
    const synth = apps.find((app) => app.id === 'synth');

    text('nemoclaw-gateway', gateway.summary || '--');
    text('nemoclaw-active-gateway', gateway.activeGateway || 'not selected');
    text('nemoclaw-default', data.defaultSandbox || 'none');
    text('nemoclaw-reachable', `${data.stats?.reachable || 0}/${data.stats?.total || 0}`);
    text('nemoclaw-registry', data.registryPath || '--');
    text('nemoclaw-mermate-status', mermate ? (mermate.reachable ? 'Online' : 'Offline') : '--');
    text('nemoclaw-synth-status', synth ? (synth.reachable ? 'Online' : 'Offline') : '--');
    text('nemoclaw-gateway-path', gateway.openshellPath || 'not found');
    dot('dot-nemoclaw', gateway.state === 'healthy_named' || (data.stats?.reachable || 0) > 0);
    text('meta-nemoclaw', data.defaultSandbox || `${data.stats?.total || 0} sandboxes`);

    const list = $('nemoclaw-sandboxes');
    if (!list) return;
    if (sandboxes.length === 0) {
      list.innerHTML = '<div class="empty-state">No sandboxes registered. Run <code>nemoclaw onboard</code> to provision the first sandbox.</div>';
      return;
    }

    list.innerHTML = sandboxes.map((sandbox) => {
      const policies = sandbox.policies?.length ? sandbox.policies.join(', ') : 'none';
      return `
        <article class="sandbox-item${sandbox.isDefault ? ' is-default' : ''}">
          <div class="sandbox-overview">
            <div class="sandbox-title-row">
              <div class="sandbox-name">${escapeHtml(sandbox.name)}</div>
              ${sandbox.isDefault ? '<span class="state-pill default">Default</span>' : ''}
              <span class="state-pill ${statePillClass(sandbox.state)}">${escapeHtml(sandbox.summary)}</span>
            </div>
            <div class="sandbox-meta">${escapeHtml(sandbox.provider || 'unknown provider')} · ${escapeHtml(sandbox.model || 'unknown model')} · ${sandbox.gpuEnabled ? 'GPU' : 'CPU'} · created ${escapeHtml(formatDate(sandbox.createdAt))}</div>
            <div class="sandbox-meta">Policies: ${escapeHtml(policies)}</div>
          </div>
          <div class="sandbox-actions">
            <button class="btn-open" type="button" data-sandbox-action="status" data-sandbox-name="${escapeHtml(sandbox.name)}">Inspect</button>
            <button class="btn-open" type="button" data-sandbox-action="connect" data-sandbox-name="${escapeHtml(sandbox.name)}">Connect</button>
            <button class="btn-open" type="button" data-sandbox-action="logs" data-sandbox-name="${escapeHtml(sandbox.name)}">Logs</button>
            ${sandbox.isDefault ? '<span class="state-pill default">Default</span>' : `<button class="btn-open" type="button" data-sandbox-action="default" data-sandbox-name="${escapeHtml(sandbox.name)}">Make Default</button>`}
          </div>
        </article>`;
    }).join('');
  }

  async function refreshNemoclaw() {
    const data = await fetchJson('/api/nemoclaw/status');
    renderNemoClawOverview(data);
    return data;
  }

  async function refreshAppRegistry() {
    const data = await fetchJson('/api/apps/registry');
    renderAppRegistry(data);
    return data;
  }

  async function handleAppOpen(appId, node) {
    const pluginOutput = $('plugin-output');
    const original = node.textContent;
    node.textContent = 'Opening...';
    node.disabled = true;
    try {
      const data = await fetchJson('/api/apps/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId }),
      });
      appendEventLine(`${data.label} open requested${data.reachable ? '' : ' (surface not yet reachable)'}.`);
    } catch (err) {
      appendEventLine(`${appId} open failed.`);
      if (pluginOutput) {
        pluginOutput.textContent = `Open failed\n\n${err instanceof Error ? err.message : String(err)}`;
        pluginOutput.classList.add('visible');
      }
    } finally {
      node.textContent = original;
      node.disabled = false;
    }
  }

  async function handleAppInferenceSave(appId, node) {
    const item = node.closest('[data-app-routing-id]');
    if (!item) return;
    const provider = item.querySelector('[data-app-provider]')?.value || 'opseeq';
    const model = item.querySelector('[data-app-model]')?.value || '';
    const output = $('runtime-action-output');
    const original = node.textContent;
    node.textContent = 'Saving...';
    node.disabled = true;
    try {
      const data = await fetchJson('/api/apps/inference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, provider, model }),
      }, 15000);
      if (output) {
        output.textContent = [
          `Saved ${data.label || appId}`,
          '',
          `Provider: ${data.inference?.provider || provider}`,
          `Model: ${data.inference?.model || model}`,
          `Source: ${data.inference?.source || 'unknown'}`,
        ].join('\n');
      }
      appendEventLine(`Saved ${data.label || appId} model assignment to ${provider} • ${model}.`);
      await refreshAppRegistry();
    } catch (err) {
      if (output) {
        output.textContent = `Model save failed\n\n${err instanceof Error ? err.message : String(err)}`;
      }
      appendEventLine(`Model assignment failed for ${appId}.`);
    } finally {
      node.textContent = original;
      node.disabled = false;
    }
  }

  async function handleRuntimeRedeploy(node) {
    const output = $('runtime-action-output');
    const original = node.textContent;
    node.textContent = 'Redeploying...';
    node.disabled = true;
    if (output) output.textContent = 'Redeploying Opseeq v5 from the current repo...';
    try {
      const data = await fetchJson('/api/runtime/redeploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, 300000);
      if (output) {
        output.textContent = [
          `Command: ${data.command}`,
          `Duration: ${data.durationMs}ms`,
          '',
          data.output || 'Redeploy completed with no output.',
        ].join('\n');
      }
      appendEventLine('Redeployed opseeq:v5 from the current repo.');
      await poll();
      await refreshAppRegistry();
    } catch (err) {
      if (output) {
        output.textContent = `Redeploy failed\n\n${err instanceof Error ? err.message : String(err)}`;
      }
      appendEventLine('Opseeq redeploy failed.');
    } finally {
      node.textContent = original;
      node.disabled = false;
    }
  }

  async function handleSandboxAction(action, sandboxName, node) {
    const inspector = $('nemoclaw-inspector');
    const original = node.textContent;
    node.textContent = action === 'default' ? 'Saving...' : action === 'status' ? 'Inspecting...' : 'Opening...';
    node.disabled = true;
    try {
      if (action === 'default') {
        const data = await fetchJson('/api/nemoclaw/default', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxName }),
        });
        appendEventLine(`Default NemoClaw sandbox set to ${data.defaultSandbox}.`);
        await refreshNemoclaw();
        return;
      }

      if (action === 'connect' || action === 'logs') {
        startTerminalSession(action === 'connect' ? 'nemoclaw-connect' : 'nemoclaw-logs', { sandboxName });
        appendEventLine(`${action === 'connect' ? 'Opened' : 'Attached'} embedded terminal for ${sandboxName}.`);
        return;
      }

      const data = await fetchJson('/api/nemoclaw/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxName, action }),
      }, action === 'status' ? 30000 : 5000);

      if (inspector) {
        inspector.textContent = data.output || `${data.message}\n\nUse the spawned terminal window for the live ${action} session.`;
      }
      appendEventLine(data.message);
      await refreshNemoclaw();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (inspector) {
        inspector.textContent = `NemoClaw ${action} failed\n\n${message}`;
      }
      appendEventLine(`NemoClaw ${action} failed for ${sandboxName}.`);
    } finally {
      node.textContent = original;
      node.disabled = false;
    }
  }

  async function poll() {
    const [statusResult, nemoclawResult] = await Promise.allSettled([
      fetchJson('/api/status'),
      fetchJson('/api/nemoclaw/status'),
    ]);

    if (statusResult.status === 'fulfilled') {
      const d = statusResult.value;
      latestGatewayStatus = d;
      text('version-badge', `v${d.meta?.version || '?'}`);
      text('meta-version', `v${d.meta?.version || '?'}`);
      dot('dot-kernel', true);

      const provCount = d.inference?.providerCount || 0;
      const modelCount = d.inference?.models?.length || 0;
      text('meta-providers', String(provCount));
      text('meta-models', String(modelCount));

      const mm = d.mermate || {};
      dot('dot-mermate', mm.running);
      text('mermate-status', mm.running ? 'Online' : 'Offline');
      text('mermate-agents', mm.agentsLoaded != null ? String(mm.agentsLoaded) : '--');
      text('mermate-tla', mm.tlaAvailable ? 'Available' : 'Unavailable');
      text('mermate-ts', mm.tsAvailable ? 'Available' : 'Unavailable');

      const st = d.synthesisTrade || {};
      dot('dot-synth', st.reachable);
      text('synth-status', st.reachable ? 'Online' : 'Offline');
      text('synth-sim', st.simulationMode != null ? (st.simulationMode ? 'On' : 'Off') : '--');
      text('synth-pred', st.predictionsAvailable != null ? (st.predictionsAvailable ? 'Yes' : 'No') : '--');
      text('synth-ai', st.aiEngineAvailable != null ? (st.aiEngineAvailable ? 'Active' : 'Inactive') : '--');

      const ol = d.ollama || {};
      dot('dot-ollama', ol.available);
      text('ollama-status', ol.available ? 'Online' : 'Offline');
      text('ollama-default', ol.defaultModel || '--');
      text('ollama-count', ol.models ? String(ol.models.length) : '0');
      text('meta-ollama-models', ol.models ? `${ol.models.length} models` : '--');

      text('kernel-uptime', formatUptime(d.meta?.uptimeSeconds));
      text('kernel-mcp', d.mcp?.enabled ? `Enabled (${d.mcp?.endpoint || '/mcp'})` : 'Disabled');

      const providerList = $('provider-list');
      if (providerList && d.providers) {
        providerList.innerHTML = d.providers.map((p) =>
          `<div class="provider-row"><span class="dot" style="background:var(--success)"></span>${escapeHtml(p.name)}</div>`
        ).join('');
      }
    }

    if (nemoclawResult.status === 'fulfilled') {
      renderNemoClawOverview(nemoclawResult.value);
    }

    await refreshAppRegistry().catch(() => {});
  }

  const btnConnect = $('btn-connect');
  const pluginPath = $('plugin-path');
  const pluginOutput = $('plugin-output');
  const btnNemoclawRefresh = $('btn-nemoclaw-refresh');
  const sandboxList = $('nemoclaw-sandboxes');
  const btnTerminalShell = $('btn-terminal-shell');
  const btnTerminalGeneralClawd = $('btn-terminal-general-clawd');
  const btnTerminalStop = $('btn-terminal-stop');
  const btnTerminalClear = $('btn-terminal-clear');
  const btnTerminalSend = $('btn-nemoclaw-terminal-send');
  const btnTerminalInterrupt = $('btn-nemoclaw-terminal-interrupt');
  const terminalInput = $('nemoclaw-terminal-input');
  const terminalScreen = $('nemoclaw-terminal-screen');
  const appRoutingList = $('app-routing-list');
  const btnModelsRefresh = $('btn-models-refresh');
  const btnRuntimeRedeploy = $('btn-runtime-redeploy');

  document.querySelectorAll('[data-view-target]').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.getAttribute('data-view-target')));
  });

  document.querySelectorAll('[data-app-id]').forEach((node) => {
    node.addEventListener('click', async (event) => {
      event.preventDefault();
      const el = event.currentTarget;
      const appId = el?.getAttribute('data-app-id');
      if (!appId) return;
      await handleAppOpen(appId, el);
    });
  });

  if (btnConnect) {
    btnConnect.addEventListener('click', async () => {
      const p = pluginPath?.value?.trim();
      if (!p) return;
      btnConnect.disabled = true;
      btnConnect.textContent = 'Working...';
      try {
        const data = await fetchJson('/api/repos/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: p }),
        }, 15000);
        if (pluginOutput) {
          pluginOutput.textContent = renderRepoConnectSummary(data);
          pluginOutput.classList.add('visible');
        }
        appendEventLine(`Prepared ${data.analysis?.repoName || p} for Opseeq.`);
      } catch (err) {
        if (pluginOutput) {
          pluginOutput.textContent = `Connect failed\n\n${err instanceof Error ? err.message : String(err)}`;
          pluginOutput.classList.add('visible');
        }
        appendEventLine(`Repo connect failed for ${p}.`);
      } finally {
        btnConnect.disabled = false;
        btnConnect.textContent = 'Generate';
      }
    });
  }

  if (btnNemoclawRefresh) {
    btnNemoclawRefresh.addEventListener('click', async () => {
      btnNemoclawRefresh.disabled = true;
      btnNemoclawRefresh.textContent = 'Refreshing...';
      try {
        await refreshNemoclaw();
        appendEventLine('NemoClaw overview refreshed.');
      } catch (err) {
        const inspector = $('nemoclaw-inspector');
        if (inspector) {
          inspector.textContent = `Refresh failed\n\n${err instanceof Error ? err.message : String(err)}`;
        }
      } finally {
        btnNemoclawRefresh.disabled = false;
        btnNemoclawRefresh.textContent = 'Refresh';
      }
    });
  }

  if (sandboxList) {
    sandboxList.addEventListener('click', async (event) => {
      const node = event.target.closest('[data-sandbox-action]');
      if (!node) return;
      const action = node.getAttribute('data-sandbox-action');
      const sandboxName = node.getAttribute('data-sandbox-name');
      if (!action || !sandboxName) return;
      await handleSandboxAction(action, sandboxName, node);
    });
  }

  if (btnTerminalShell) {
    btnTerminalShell.addEventListener('click', () => {
      startTerminalSession('opseeq-shell');
      appendEventLine('Opened embedded Opseeq shell.');
    });
  }

  if (btnTerminalGeneralClawd) {
    btnTerminalGeneralClawd.addEventListener('click', () => {
      startTerminalSession('general-clawd');
      appendEventLine('Opened General-Clawd workspace shell.');
    });
  }

  if (btnTerminalStop) {
    btnTerminalStop.addEventListener('click', () => {
      sendTerminalMessage({ type: 'stop' });
    });
  }

  if (btnTerminalClear) {
    btnTerminalClear.addEventListener('click', () => {
      clearTerminalOutput();
    });
  }

  if (btnTerminalSend && terminalInput) {
    const submitTerminalInput = () => {
      const value = terminalInput.value;
      if (!value) return;
      sendTerminalMessage({ type: 'input', data: `${value}\n` });
      terminalInput.value = '';
    };
    btnTerminalSend.addEventListener('click', submitTerminalInput);
    terminalInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitTerminalInput();
      }
    });
  }

  if (btnTerminalInterrupt) {
    btnTerminalInterrupt.addEventListener('click', () => {
      sendTerminalMessage({ type: 'input', data: '\u0003' });
    });
  }

  if (appRoutingList) {
    appRoutingList.addEventListener('change', (event) => {
      const providerSelect = event.target.closest('[data-app-provider]');
      if (!providerSelect) return;
      const item = providerSelect.closest('[data-app-routing-id]');
      const modelSelect = item?.querySelector('[data-app-model]');
      populateModelSelect(modelSelect, providerSelect.value, modelSelect?.value || '');
    });
    appRoutingList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-app-action]');
      if (!button) return;
      const appId = button.getAttribute('data-app-id');
      const action = button.getAttribute('data-app-action');
      if (!appId || !action) return;
      if (action === 'save') {
        await handleAppInferenceSave(appId, button);
        return;
      }
      if (action === 'open') {
        await handleAppOpen(appId, button);
      }
    });
  }

  if (btnModelsRefresh) {
    btnModelsRefresh.addEventListener('click', async () => {
      btnModelsRefresh.disabled = true;
      btnModelsRefresh.textContent = 'Refreshing...';
      try {
        await poll();
        appendEventLine('Model routing view refreshed.');
      } finally {
        btnModelsRefresh.disabled = false;
        btnModelsRefresh.textContent = 'Refresh';
      }
    });
  }

  if (btnRuntimeRedeploy) {
    btnRuntimeRedeploy.addEventListener('click', async () => {
      await handleRuntimeRedeploy(btnRuntimeRedeploy);
    });
  }

  if (terminalScreen && terminalInput) {
    terminalScreen.addEventListener('click', () => terminalInput.focus());
  }

  // ── v2.5 Systems Tab ────────────────────────────────────────────
  async function pollV25Systems() {
    try {
      const [absorptionRes, toolsRes, sessionsRes, stagesRes, vendorRes, subagentRes] = await Promise.all([
        fetch('/api/absorption/status').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/execution/tools').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/execution/sessions').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/pipeline/stages').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/pipeline/mermate-vendor').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/subagents/dashboard').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      if (absorptionRes) {
        text('absorption-status', absorptionRes.absorbed ? 'Complete' : 'Pending');
        text('absorption-source', absorptionRes.source || '--');
        text('absorption-bridge', absorptionRes.externalBridgeRemaining ? 'Active' : 'Eliminated');
        text('absorption-modules', (absorptionRes.modules || []).join(', ') || '--');
      }

      if (toolsRes) {
        const tools = toolsRes.tools || [];
        text('exec-tools', String(tools.length));
        const commands = toolsRes.commands || toolsRes.registrySize || '--';
        text('exec-commands', String(typeof commands === 'number' ? commands : tools.length));
      }

      if (sessionsRes) {
        text('exec-sessions', String(Array.isArray(sessionsRes) ? sessionsRes.length : 0));
      }

      const stagesList = $('pipeline-stages-list');
      if (stagesRes && Array.isArray(stagesRes) && stagesList) {
        stagesList.innerHTML = stagesRes.map(s =>
          `<div class="sandbox-item"><span class="state-pill ${s.required ? 'ok' : 'muted'}">${escapeHtml(s.id)}</span> <span>${escapeHtml(s.label)}</span> <span style="color:var(--text-dim);font-size:11px;">${s.dependencies.length ? 'deps: ' + s.dependencies.join(', ') : 'no deps'}</span></div>`
        ).join('');
      }

      if (vendorRes) {
        text('pipeline-repo', vendorRes.repoExists ? 'Found' : 'Not found');
        text('pipeline-tla2tools', vendorRes.tla2toolsJarExists ? 'Present' : 'Missing');
        text('pipeline-warp', vendorRes.warpEngineExists ? 'Present' : 'Missing');
      }

      if (subagentRes) {
        text('subagent-total', String(subagentRes.totalTasks || 0));
        text('subagent-active', String(subagentRes.activeTasks || 0));
        text('subagent-completed', String(subagentRes.completedTasks || 0));
        text('subagent-failed', String(subagentRes.failedTasks || 0));

        const capList = $('subagent-capabilities');
        if (capList && Array.isArray(subagentRes.capabilities)) {
          capList.innerHTML = subagentRes.capabilities.map(c =>
            `<div class="sandbox-item"><span class="state-pill muted">${escapeHtml(c.capability)}</span> <span style="font-size:12px;">${escapeHtml(c.description)}</span> <span style="color:var(--text-dim);font-size:11px;">(${c.taskCount} tasks)</span></div>`
          ).join('');
        }

        const taskList = $('subagent-recent-tasks');
        if (taskList && Array.isArray(subagentRes.recentTasks)) {
          if (subagentRes.recentTasks.length === 0) {
            taskList.innerHTML = '<div class="empty-state">No subagent tasks recorded yet.</div>';
          } else {
            taskList.innerHTML = subagentRes.recentTasks.map(t =>
              `<div class="sandbox-item"><span class="state-pill ${t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'error' : 'muted'}">${escapeHtml(t.status)}</span> <span>${escapeHtml(t.description)}</span> <span style="color:var(--text-dim);font-size:11px;">${escapeHtml(t.taskId.slice(0, 8))}</span></div>`
            ).join('');
          }
        }
      }
    } catch (_) { /* v2.5 panel non-critical */ }
  }

  const btnExecRefresh = $('btn-exec-refresh');
  if (btnExecRefresh) {
    btnExecRefresh.addEventListener('click', () => pollV25Systems());
  }
  const btnSubagentRefresh = $('btn-subagent-refresh');
  if (btnSubagentRefresh) {
    btnSubagentRefresh.addEventListener('click', () => pollV25Systems());
  }

  // Poll v2.5 systems on tab switch
  document.querySelectorAll('[data-view-target="v25systems"]').forEach(tab => {
    tab.addEventListener('click', () => pollV25Systems());
  });

  setActiveView('overview');
  connectTerminalSocket();
  poll().catch(() => {});
  pollV25Systems();
  setInterval(() => {
    poll().catch(() => {});
  }, POLL_MS);
  setInterval(() => pollV25Systems(), 15_000);
})();
