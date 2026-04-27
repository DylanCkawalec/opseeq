(function () {
  const CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in SVG
  const OODA_STEPS = ['observe', 'orient', 'decide', 'act'];
  const DEFAULT_BUTTON_HTML = '<span class="precision-icon" aria-hidden="true">&#9889;</span> Plan Precision Workflow';
  const DEFAULT_OUTPUT = 'Awaiting workflow plan...';
  let pipelineRunning = false;
  let currentOodaStep = -1;

  function $(id) { return document.getElementById(id); }
  function escapeHtml(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function text(id, val) {
    const el = $(id);
    if (el) el.textContent = val ?? '--';
  }
  async function fetchJson(url, options, timeoutMs) {
    const res = await fetch(url, { ...(options || {}), signal: AbortSignal.timeout(timeoutMs || 10000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ── OODA Ring ──────────────────────────────────
  function setOodaProgress(step) {
    currentOodaStep = step;
    const progress = $('ooda-progress');
    const label = $('ooda-stage-label');
    if (step < 0) {
      if (progress) progress.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
      if (label) label.textContent = 'Idle';
      OODA_STEPS.forEach((s) => {
        const el = $('ooda-' + s);
        if (el) el.className = 'ooda-step';
      });
      return;
    }
    const fraction = (step + 1) / OODA_STEPS.length;
    const offset = CIRCUMFERENCE * (1 - fraction);
    if (progress) progress.setAttribute('stroke-dashoffset', String(offset));
    if (label) label.textContent = OODA_STEPS[step].charAt(0).toUpperCase() + OODA_STEPS[step].slice(1);
    OODA_STEPS.forEach((s, i) => {
      const el = $('ooda-' + s);
      if (!el) return;
      if (i < step) el.className = 'ooda-step completed';
      else if (i === step) el.className = 'ooda-step active';
      else el.className = 'ooda-step';
    });
  }

  // ── Stage rendering ────────────────────────────
  function normalizeStageStatus(status) {
    switch (status) {
      case 'executed': return 'done';
      case 'planned':
      case 'ready': return 'ready';
      case 'pending_approval': return 'pending';
      case 'blocked': return 'blocked';
      case 'unavailable': return 'unavailable';
      case 'running':
      case 'done':
      case 'failed': return status;
      default: return 'pending';
    }
  }

  function stageStatusLabel(status) {
    switch (status) {
      case 'done': return 'done';
      case 'ready': return 'ready';
      case 'pending': return 'approval required';
      case 'blocked': return 'blocked';
      case 'unavailable': return 'unavailable';
      case 'running': return 'running';
      case 'failed': return 'failed';
      default: return status;
    }
  }

  function renderStage(stage, status, durationMs, summary) {
    const stagesEl = $('precision-stages');
    if (!stagesEl) return;
    if (stagesEl.querySelector('.empty-state')) stagesEl.innerHTML = '';
    const safeStageSelector = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(stage)) : String(stage).replace(/"/g, '\\"');
    const existing = stagesEl.querySelector(`[data-stage="${safeStageSelector}"]`);
    const cls = normalizeStageStatus(status);
    const timeStr = durationMs != null ? `${durationMs}ms` : '';
    const html = `<div class="precision-stage-item ${cls}" data-stage="${escapeHtml(stage)}">
      <span class="stage-body">
        <span class="stage-name">${escapeHtml(stage)}</span>
        ${summary ? `<span class="stage-summary">${escapeHtml(summary)}</span>` : ''}
      </span>
      <span class="stage-status">${escapeHtml(stageStatusLabel(cls))}</span>
      <span class="stage-time">${timeStr}</span>
    </div>`;
    if (existing) {
      existing.outerHTML = html;
    } else {
      stagesEl.insertAdjacentHTML('beforeend', html);
    }
  }

  function appendOutput(msg) {
    const el = $('precision-output');
    if (!el) return;
    if (el.textContent === DEFAULT_OUTPUT || el.textContent === 'Awaiting pipeline execution...') el.textContent = '';
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function renderPlan(plan, permission) {
    const el = $('precision-plan');
    if (!el) return;
    if (!plan || !plan.length) {
      el.innerHTML = '<div class="empty-state">Plan will appear after the workflow is prepared.</div>';
      return;
    }
    const planHtml = plan.map((step, i) =>
      `<div class="precision-stage-item ready" style="font-size:12px;">
        <span class="stage-body">
          <span class="stage-name">${i + 1}. ${escapeHtml(step)}</span>
        </span>
      </div>`
    ).join('');
    const approvalHtml = permission
      ? `<div class="precision-stage-item pending" style="font-size:12px;">
          <span class="stage-body">
            <span class="stage-name">Approval envelope</span>
            <span class="stage-summary">${escapeHtml(permission.summary || 'Review the proposed scope before execution.')}</span>
          </span>
          <span class="stage-status">${permission.requiresApproval ? 'approval required' : 'not required'}</span>
        </div>`
      : '';
    el.innerHTML = planHtml + approvalHtml;
  }

  function renderApprovalSummary(result) {
    const el = $('precision-approval-summary');
    if (!el) return;
    const envelope = result?.executionEnvelope || {};
    const permission = result?.ooda?.permission || {};
    const approved = envelope.approved === true;
    const commands = Array.isArray(envelope.commands) && envelope.commands.length
      ? envelope.commands.join(', ')
      : 'No effectful commands approved';
    const files = Array.isArray(envelope.fileScope) && envelope.fileScope.length
      ? envelope.fileScope.join(', ')
      : 'No file scope declared';
    const network = Array.isArray(envelope.networkScope) && envelope.networkScope.length
      ? envelope.networkScope.join(', ')
      : 'Local services only or not declared';
    const task = envelope.taskId || result?.taskId || 'unassigned';
    el.className = `precision-approval-card ${approved ? 'approved' : 'blocked'}`;
    el.innerHTML = `<span class="state-pill ${approved ? 'ok' : 'warn'}">${approved ? 'Approved' : 'Approval required'}</span>
      <p>${approved
        ? 'The returned envelope is approved for execution.'
        : 'No effectful render, codegen, file, terminal, or external service action has been approved from this screen.'}</p>
      <div class="approval-scope">
        <div><span>Task</span><code>${escapeHtml(task)}</code></div>
        <div><span>Why</span><code>${escapeHtml(permission.summary || 'Plan and inspect before execution.')}</code></div>
        <div><span>Tools</span><code>${escapeHtml(commands)}</code></div>
        <div><span>Files</span><code>${escapeHtml(files)}</code></div>
        <div><span>Network</span><code>${escapeHtml(network)}</code></div>
      </div>`;
  }

  // ── Precision Orchestration Pipeline ─────────────
  async function runPrecisionPipeline() {
    const input = $('precision-input');
    const source = input?.value?.trim();
    if (!source) {
      appendOutput('[error] Please enter an idea, markdown, or Mermaid source.');
      return;
    }
    const btn = $('btn-precision-run');
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing Plan...'; }
    pipelineRunning = true;
    let succeeded = false;

    const stagesEl = $('precision-stages');
    if (stagesEl) stagesEl.innerHTML = '';
    const outputEl = $('precision-output');
    if (outputEl) outputEl.textContent = '';
    const approvalEl = $('precision-approval-summary');
    if (approvalEl) {
      approvalEl.className = 'precision-approval-card blocked';
      approvalEl.innerHTML = '<span class="state-pill warn">Approval required</span><p>Preparing a plan. No effectful action is approved yet.</p>';
    }

    try {
      setOodaProgress(0);
      renderPlan(['Capture intent and repo context.', 'Build OODA plan and permission envelope.', 'Return proposed services, files, network scope, and artifacts.']);
      renderStage('observe_orient', 'running', null, 'Building local context and permission envelope.');
      appendOutput('[ooda] Observe: preparing local planning context...');
      setOodaProgress(1);
      appendOutput('[ooda] Orient: requesting Precision Orchestration plan from the gateway...');

      const t0 = Date.now();
      const result = await fetchJson('/api/ooda/precision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: source,
          inputMode: 'idea',
          maxMode: true,
          approved: false,
          execute: false,
          includeTla: true,
          includeTs: true,
          includeRust: false,
        }),
      }, 120000);
      const elapsed = Date.now() - t0;

      setOodaProgress(2);
      renderPlan(result.ooda?.detailedPlan, result.ooda?.permission);
      renderApprovalSummary(result);
      if (stagesEl) stagesEl.innerHTML = '';
      const stages = Array.isArray(result.stageResults) ? result.stageResults : [];
      if (stages.length === 0) {
        renderStage('planning', 'done', elapsed, 'Plan returned without stage detail.');
      } else {
        stages.forEach((stage) => {
          renderStage(stage.stage, stage.status, stage.durationMs, stage.summary);
          appendOutput(`[stage] ${stage.stage}: ${stage.status} (${stage.durationMs ?? 0}ms)`);
        });
      }

      appendOutput(`[plan] ${result.title || 'Precision workflow'} prepared as ${result.taskId || 'unknown task'}.`);
      if (result.livingArchitectureGraph?.versionId) {
        appendOutput(`[artifact] Living Architecture Graph version: ${result.livingArchitectureGraph.versionId}`);
      }
      if (Array.isArray(result.artifacts) && result.artifacts.length) {
        result.artifacts.forEach((artifact) => {
          appendOutput(`[artifact] ${artifact.kind}: ${artifact.path}`);
        });
      }
      appendOutput('[approval] Required before render, codegen, file, terminal, or service execution.');
      succeeded = true;
    } catch (err) {
      appendOutput(`[error] Workflow failed: ${err instanceof Error ? err.message : String(err)}`);
      renderStage('planning', 'failed', null, err instanceof Error ? err.message : String(err));
    } finally {
      pipelineRunning = false;
      if (btn) { btn.disabled = false; btn.innerHTML = DEFAULT_BUTTON_HTML; }
      if (!succeeded) setTimeout(() => setOodaProgress(-1), 3000);
    }
  }

  // ── Cross-Repo Search ──────────────────────────
  async function runCrossRepoSearch() {
    const input = $('crossrepo-search-input');
    const results = $('crossrepo-results');
    const query = input?.value?.trim();
    if (!query || !results) return;
    results.innerHTML = '<div class="empty-state">Searching...</div>';
    try {
      const data = await fetchJson(`/api/ooda/graph/search?q=${encodeURIComponent(query)}`, {}, 15000);
      const result = data.result || {};
      const steps = Array.isArray(result.nodes) ? result.nodes : [];
      const repos = Array.isArray(result.repos) ? result.repos : [];
      const repoMap = {};
      repos.forEach((r) => { repoMap[r.id] = r; });
      if (steps.length === 0) {
        results.innerHTML = '<div class="empty-state">No results found.</div>';
        return;
      }
      results.innerHTML = steps.map((step) => {
        const repo = repoMap[step.repoId] || {};
        const isPriority = repo.priority || false;
        return `<div class="crossrepo-result-item">
          <div style="display:flex;flex-direction:column;gap:4px;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="crossrepo-result-kind">${escapeHtml(step.kind)}</span>
              <span class="crossrepo-result-label">${escapeHtml(step.label)}</span>
            </div>
            <div class="crossrepo-result-meta">${escapeHtml(step.description || step.filePath || '')}</div>
            <div class="crossrepo-result-meta">${escapeHtml(step.filePath)}:${step.startLine}</div>
          </div>
          <span class="crossrepo-result-repo ${isPriority ? 'priority' : 'normal'}">${escapeHtml(repo.label || step.repoId)}</span>
        </div>`;
      }).join('');
    } catch (err) {
      results.innerHTML = `<div class="empty-state">Search failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
  }

  // ── Living Graph ───────────────────────────────
  async function refreshGraph() {
    const btn = $('btn-graph-refresh');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
    try {
      const data = await fetchJson('/api/ooda/dashboard?refresh=true', {}, 30000);
      const dash = data.dashboard || {};
      const summary = dash.summary || {};
      text('graph-nodes', String(summary.nodeCount || 0));
      text('graph-edges', String(summary.edgeCount || 0));
      text('graph-repos', String(summary.repoCount || 0));
      text('graph-versions', String(summary.versionCount || 0));
      text('graph-backlinks', String(summary.backlinkCount || 0));

      // Priority repos
      const priorityEl = $('graph-priority-repos');
      const repos = Array.isArray(dash.repos) ? dash.repos : [];
      const priorityRepos = repos.filter((r) => r.priority);
      if (priorityEl) {
        if (priorityRepos.length === 0) {
          priorityEl.innerHTML = '<div class="empty-state">No priority repos discovered.</div>';
        } else {
          priorityEl.innerHTML = priorityRepos.map((r) => {
            const env = r.envHealth;
            const envBadge = env
              ? (env.exists
                ? `<span class="env-health-badge healthy">.env ${env.keyCount} keys${env.backedUp ? ' (backed up)' : ''}</span>`
                : '<span class="env-health-badge missing">.env missing</span>')
              : '';
            return `<article class="sandbox-item">
              <div class="sandbox-overview">
                <div class="sandbox-title-row">
                  <div class="sandbox-name" style="color:#FFD700;">${escapeHtml(r.label)}</div>
                  <span class="state-pill ${r.status === 'connected' ? 'ok' : 'warn'}">${escapeHtml(r.status)}</span>
                  ${envBadge}
                </div>
                <div class="sandbox-meta">${escapeHtml(r.path)}</div>
                <div class="sandbox-meta">Files indexed: ${r.indexedFileCount} · Contributions: ${r.contributionCount}</div>
              </div>
            </article>`;
          }).join('');
        }
      }

      // Diagram viewer
      const viewer = $('graph-viewer');
      if (viewer && dash.diagram) {
        viewer.textContent = dash.diagram;
      }

      // Version list
      const versionList = $('graph-version-list');
      const versions = Array.isArray(dash.recentVersions) ? dash.recentVersions : [];
      if (versionList) {
        if (versions.length === 0) {
          versionList.innerHTML = '<div class="empty-state">No versions recorded yet.</div>';
        } else {
          versionList.innerHTML = versions.slice(0, 10).map((v) =>
            `<article class="sandbox-item">
              <div class="sandbox-overview">
                <div class="sandbox-title-row">
                  <div class="sandbox-name">${escapeHtml(v.summary)}</div>
                  <span class="state-pill muted">${escapeHtml(v.hash?.slice(0, 16) || '')}</span>
                </div>
                <div class="sandbox-meta">${escapeHtml(v.createdAt)} · ${v.nodeCount} nodes · ${v.edgeCount} edges · ${v.repoCount} repos</div>
              </div>
            </article>`
          ).join('');
        }
      }

      // Update sidebar repos
      renderSidebarRepos(repos);
    } catch (err) {
      const viewer = $('graph-viewer');
      if (viewer) viewer.textContent = `Failed to load graph: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh Index'; }
    }
  }

  // ── Sidebar Repos ──────────────────────────────
  function renderSidebarRepos(repos) {
    const container = $('sidebar-repos');
    if (!container || !repos) return;
    if (repos.length === 0) {
      container.innerHTML = '<div class="sidebar-item"><span class="dot gray"></span><span class="label">No repos</span></div>';
      return;
    }
    container.innerHTML = repos.map((r) => {
      const dotColor = r.status === 'connected' ? (r.priority ? '#FFD700' : 'var(--success)') : 'var(--danger)';
      const envHint = r.envHealth ? (r.envHealth.exists ? `${r.envHealth.keyCount}k` : '!env') : '';
      return `<div class="sidebar-repo-item${r.priority ? ' priority' : ''}">
        <span class="sidebar-repo-dot" style="background:${dotColor};"></span>
        <span class="sidebar-repo-label">${escapeHtml(r.label)}</span>
        <span class="sidebar-repo-meta">${envHint}</span>
      </div>`;
    }).join('');
  }

  // ── Drag and Drop ──────────────────────────────
  const textarea = $('precision-input');
  if (textarea) {
    textarea.addEventListener('dragover', (e) => {
      e.preventDefault();
      textarea.classList.add('drag-over');
    });
    textarea.addEventListener('dragleave', () => {
      textarea.classList.remove('drag-over');
    });
    textarea.addEventListener('drop', (e) => {
      e.preventDefault();
      textarea.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        const reader = new FileReader();
        reader.onload = () => { textarea.value = reader.result; };
        reader.readAsText(file);
      }
    });
  }

  // ── Event Bindings ─────────────────────────────
  const btnPrecision = $('btn-precision-run');
  if (btnPrecision) {
    btnPrecision.addEventListener('click', () => {
      if (!pipelineRunning) runPrecisionPipeline();
    });
  }

  const btnSearch = $('btn-crossrepo-search');
  const searchInput = $('crossrepo-search-input');
  if (btnSearch) btnSearch.addEventListener('click', runCrossRepoSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runCrossRepoSearch(); }
    });
  }

  const btnGraphRefresh = $('btn-graph-refresh');
  if (btnGraphRefresh) btnGraphRefresh.addEventListener('click', refreshGraph);

  // ── Keyboard shortcut: Ctrl+G → Precision tab ──
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
      e.preventDefault();
      document.querySelector('[data-view-target="precision"]')?.click();
    }
  });

  // Auto-load graph data on first graph tab visit
  let graphLoaded = false;
  document.querySelectorAll('[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('data-view-target') === 'graph' && !graphLoaded) {
        graphLoaded = true;
        refreshGraph();
      }
    });
  });

  // Load sidebar repos on startup
  setTimeout(() => {
    fetchJson('/api/ooda/dashboard', {}, 15000)
      .then((data) => {
        const dash = data.dashboard || {};
        if (dash.repos) renderSidebarRepos(dash.repos);
      })
      .catch(() => {});
  }, 2000);
})();
