// web/main.ts — Tabs, prompt submission, live event timeline, model bindings.
import {
  getQgotStatus,
  listModels,
  listRuns,
  setRoleModel,
  streamRun,
  submitPrompt,
  type QgotReadinessReport,
  type QgotStatusEnvelope,
  type ServiceComponentStatus,
} from "./api";

document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab!));
});
function switchTab(name: string) {
  document.querySelectorAll<HTMLElement>("main section").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "status") void refreshQgotStatus();
  if (name === "runs") refreshRuns();
  if (name === "models") refreshModels();
}
const CORE_COMPONENTS: Array<[keyof QgotReadinessReport, string]> = [
  ["http", "HTTP"],
  ["mcp", "MCP"],
  ["graphql", "GraphQL"],
  ["openapi", "OpenAPI"],
  ["qal", "QAL"],
  ["executor", "Executor"],
  ["model_roles", "Model roles"],
];

const EXTENDED_COMPONENTS: Array<[keyof QgotReadinessReport, string]> = [
  ["run_store", "Run store"],
  ["orm", "ORM"],
  ["ooda", "OODA"],
  ["frontend", "Frontend"],
];

const live = document.getElementById("live")!;
const submitButton = document.getElementById("submit") as HTMLButtonElement;
let activeStream: EventSource | null = null;

document.getElementById("status-refresh")?.addEventListener("click", () => {
  void refreshQgotStatus();
});

void refreshQgotStatus();

submitButton.addEventListener("click", async () => {
  const prompt = (document.getElementById("prompt") as HTMLTextAreaElement).value.trim();
  if (!prompt) {
    live.innerHTML = `<div class="notice warn">Enter a prompt before submitting.</div>`;
    return;
  }
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Running…";
  live.innerHTML = `
    <div class="notice">Submitting to the copilot protocol…</div>
    <div class="timeline-empty muted">Trace events will appear here without blocking the prompt controls.</div>
  `;
  try {
    const env = await submitPrompt(prompt);
    live.innerHTML = renderRunSummary(env);
    activeStream = streamRun(env.id, (ev) => {
      renderEvent(ev);
      if (ev.type === "RunFinished" && activeStream) {
        activeStream.close();
        activeStream = null;
      }
    });
    activeStream.onerror = () => {
      renderNotice("Trace stream is unavailable; the run envelope above remains authoritative.", "warn");
    };
    void refreshQgotStatus();
  } catch (e) {
    live.innerHTML = `<div class="notice err">Submit failed: ${escapeHtml((e as Error).message)}</div>`;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Submit";
  }
});

function renderEvent(ev: any) {
  const div = document.createElement("div");
  div.className = `event ${ev.type}`;
  const role = ev.role ?? roleFor(ev.type);
  const tag = role ? `<span class="role ${role}">${role}</span>` : "";
  div.innerHTML = `${tag}<strong>${ev.type}</strong> <span class="muted">${ev.ts ?? ""}</span><br/><code>${escapeHtml(JSON.stringify(stripBig(ev), null, 0)).slice(0, 320)}</code>`;
  live.prepend(div);
}

function renderNotice(message: string, tone: "warn" | "err" | "ok" | "" = "") {
  const div = document.createElement("div");
  div.className = `notice ${tone}`.trim();
  div.textContent = message;
  live.prepend(div);
}

function roleFor(type: string): string {
  if (type.startsWith("Plan")) return "planner";
  if (type.startsWith("Verifier")) return "verifier";
  if (type.startsWith("Task")) return "executor";
  if (type.startsWith("Drift") || type.startsWith("Paused") || type.startsWith("Resumed") || type.startsWith("Redirected")) return "observer";
  return "";
}

async function refreshRuns() {
  const root = document.getElementById("runs")!;
  root.innerHTML = '<p class="muted">loading runs…</p>';
  try {
    const list = await listRuns();
    root.innerHTML = list.length === 0
      ? '<p class="muted">No runs yet. Submit a prompt to create the first trace.</p>'
      : list.map((r) => `
          <div class="run-card">
            <div class="run-card-head">
              <h3>${escapeHtml(r.id)}</h3>
              ${badge(r.status, statusTone(r.status))}
            </div>
            <p class="muted">${escapeHtml(r.prompt).slice(0, 220)}</p>
            <div class="meta-row">
              <span>${countLabel(r.plans, "plan")}</span>
              <span>${countLabel(r.verifications, "verification")}</span>
              <span>${countLabel(r.tasks, "task")}</span>
              <span>drift ${(r.drift_max ?? 0).toFixed(3)}</span>
            </div>
            <div class="drift-bar" aria-label="Maximum drift ${Math.min(1, Math.max(0, r.drift_max ?? 0)).toFixed(2)}">
              <span style="width:${Math.min(100, Math.max(0, (r.drift_max ?? 0) * 100)).toFixed(1)}%"></span>
            </div>
          </div>
        `).join("");
  } catch (e) {
    root.innerHTML = `<div class="notice err">Could not load runs: ${escapeHtml((e as Error).message)}</div>`;
  }
}

async function refreshModels() {
  const root = document.getElementById("models")!;
  root.innerHTML = '<p class="muted">loading model bindings…</p>';
  try {
    const m = await listModels();
    root.innerHTML = `
      <div class="section-note">Role bindings are shown without secrets. “mock” is explicit when the bridge is using local deterministic fallback.</div>
      <div class="bindings"><strong>role</strong><strong>provider</strong><strong>model</strong><strong>state</strong><span></span>
      ${m.bindings.map((b) => `
        <span>${escapeHtml(b.role)}</span>
        <select data-role="${escapeHtml(b.role)}" class="prov">${["nvidia","ollama","openai","kimi","qwen","mock"].map((p) => `<option value="${p}" ${p===b.provider?"selected":""}>${p}</option>`).join("")}</select>
        <input data-role="${escapeHtml(b.role)}" class="model" value="${escapeHtml(b.model)}" />
        <span>${b.envOverride ? badge("env override", "ok") : badge("default", "")}</span>
        <button data-role="${escapeHtml(b.role)}" class="save">save</button>`).join("")}
      </div>`;
  } catch (e) {
    root.innerHTML = `<div class="notice err">Could not load model bindings: ${escapeHtml((e as Error).message)}</div>`;
    return;
  }
  root.querySelectorAll<HTMLButtonElement>("button.save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const role = btn.dataset.role!;
      const provider = (root.querySelector(`select.prov[data-role="${role}"]`) as HTMLSelectElement).value;
      const model = (root.querySelector(`input.model[data-role="${role}"]`) as HTMLInputElement).value;
      btn.disabled = true;
      btn.textContent = "saving…";
      try {
        await setRoleModel(role, provider, model);
        btn.textContent = "saved ✓";
        setTimeout(() => (btn.textContent = "save"), 1500);
      } catch (e) {
        btn.textContent = "failed";
        btn.title = (e as Error).message;
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = "save";
          btn.title = "";
        }, 1800);
      }
    });
  });
}
async function refreshQgotStatus() {
  const promptHost = document.getElementById("qgot-status");
  const statusSummary = document.getElementById("status-summary");
  const statusChecks = document.getElementById("protocol-checks");
  const statusDetail = document.getElementById("status-detail");
  const bridge = document.getElementById("bridge-indicator");
  if (promptHost) promptHost.innerHTML = '<p class="muted">checking QGoT readiness…</p>';
  if (statusSummary) statusSummary.innerHTML = '<p class="muted">checking readiness…</p>';
  try {
    const payload = await getQgotStatus();
    const report = readinessReport(payload);
    const level = readinessLevel(payload, report);
    const source = payload.source ?? (report?.service ? "qgot" : "opseeq.api");
    const summary = renderReadinessSummary(payload, report, level, source);
    const checks = renderProtocolChecks(report);
    if (promptHost) promptHost.innerHTML = summary;
    if (statusSummary) statusSummary.innerHTML = summary;
    if (statusChecks) statusChecks.innerHTML = checks;
    if (statusDetail) statusDetail.textContent = JSON.stringify(payload, null, 2);
    if (bridge) bridge.innerHTML = `${dot(level)} ${summaryLabel(level)} <span>${escapeHtml(source)}</span>`;
  } catch (e) {
    const message = `QGoT status unavailable: ${(e as Error).message}`;
    if (promptHost) promptHost.innerHTML = `<div class="notice err">${escapeHtml(message)}</div>`;
    if (statusSummary) statusSummary.innerHTML = `<div class="notice err">${escapeHtml(message)}</div>`;
    if (statusChecks) statusChecks.innerHTML = "";
    if (statusDetail) statusDetail.textContent = "";
    if (bridge) bridge.innerHTML = `${dot("err")} <span>status unavailable</span>`;
  }
}

function renderRunSummary(env: { id: string; status: string; drift_max?: number; plans?: any[]; verifications?: any[]; tasks?: any[] }) {
  return `
    <div class="run-summary">
      <div>
        <span class="muted">run</span>
        <code>${escapeHtml(env.id)}</code>
      </div>
      ${badge(env.status, statusTone(env.status))}
      <span>${countLabel(env.plans, "plan")}</span>
      <span>${countLabel(env.verifications, "verification")}</span>
      <span>${countLabel(env.tasks, "task")}</span>
      <span>drift ${(env.drift_max ?? 0).toFixed(3)}</span>
    </div>
  `;
}

function renderReadinessSummary(
  payload: QgotStatusEnvelope,
  report: QgotReadinessReport | null,
  level: "ok" | "warn" | "err",
  source: string,
) {
  const title = level === "ok" ? "Protocol ready" : level === "warn" ? "Protocol degraded" : "Protocol offline";
  const base = report?.qgot_http_base ?? payload.qgot_http_base ?? "not configured";
  const reasons = report
    ? [...CORE_COMPONENTS, ...EXTENDED_COMPONENTS]
        .flatMap(([key]) => componentReasons(report[key] as ServiceComponentStatus | undefined))
        .slice(0, 2)
    : payload.reasons ?? (payload.error ? [payload.error] : []);
  return `
    <div class="status-summary ${level}">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">source <code>${escapeHtml(source)}</code> • base <code>${escapeHtml(base)}</code></p>
      </div>
      ${badge(summaryLabel(level), level)}
      ${reasons.length > 0 ? `<p class="status-reason">${escapeHtml(reasons.join(" · "))}</p>` : ""}
    </div>
  `;
}

function renderProtocolChecks(report: QgotReadinessReport | null) {
  if (!report) {
    return `<div class="notice warn">No structured readiness report available. Opseeq will label this as fallback until QGoT responds with component status.</div>`;
  }
  const cards = [...CORE_COMPONENTS, ...EXTENDED_COMPONENTS].map(([key, label]) => {
    const component = report[key] as ServiceComponentStatus | undefined;
    const level = componentLevel(component);
    return `
      <div class="check-card ${level}">
        <div class="check-title">${escapeHtml(label)} ${badge(component?.state ?? (component?.ready ? "ready" : "unknown"), level)}</div>
        <p>${escapeHtml(component?.status ?? "not reported")}</p>
        ${componentReasons(component).length ? `<small>${escapeHtml(componentReasons(component).join(" · "))}</small>` : ""}
      </div>
    `;
  }).join("");
  const bindings = report.role_model_bindings ?? [];
  return `
    <div class="check-grid">${cards}</div>
    <h2>Role bindings</h2>
    <div class="bindings compact"><strong>role</strong><strong>provider</strong><strong>model</strong><strong>state</strong>
      ${bindings.map((b) => `
        <span>${escapeHtml(b.role)}</span>
        <span>${escapeHtml(b.provider)}</span>
        <code>${escapeHtml(b.model)}</code>
        <span>${b.envOverride ? badge("env override", "ok") : badge("default", "")}</span>
      `).join("")}
    </div>
  `;
}

function readinessReport(payload: QgotStatusEnvelope): QgotReadinessReport | null {
  const status = payload.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  return status as QgotReadinessReport;
}

function readinessLevel(payload: QgotStatusEnvelope, report: QgotReadinessReport | null): "ok" | "warn" | "err" {
  if (payload.ok === false && !report) return "err";
  if (!report) return payload.ok ? "warn" : "err";
  const coreReady = CORE_COMPONENTS.every(([key]) => (report[key] as ServiceComponentStatus | undefined)?.ready === true);
  if (!coreReady) return "err";
  const allReady = [...CORE_COMPONENTS, ...EXTENDED_COMPONENTS].every(([key]) => (report[key] as ServiceComponentStatus | undefined)?.ready === true);
  return allReady ? "ok" : "warn";
}

function componentLevel(component?: ServiceComponentStatus): "ok" | "warn" | "err" {
  if (component?.ready) return "ok";
  if (component?.state === "missing_configuration" || component?.state === "disabled" || component?.state === "degraded") return "warn";
  return "err";
}

function componentReasons(component?: ServiceComponentStatus): string[] {
  return Array.isArray(component?.reasons) ? component.reasons : [];
}

function summaryLabel(level: "ok" | "warn" | "err") {
  if (level === "ok") return "ready";
  if (level === "warn") return "degraded";
  return "offline";
}

function statusTone(status: string): "ok" | "warn" | "err" | "" {
  const s = status.toLowerCase();
  if (s.includes("done") || s.includes("pass") || s.includes("ready")) return "ok";
  if (s.includes("fail") || s.includes("error")) return "err";
  if (s.includes("pause") || s.includes("running") || s.includes("degraded")) return "warn";
  return "";
}

function badge(text: string, tone: "ok" | "warn" | "err" | "") {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function dot(tone: "ok" | "warn" | "err") {
  return `<span class="dot ${tone}" aria-hidden="true"></span>`;
}

function countLabel(value: any[] | undefined, singular: string) {
  const n = Array.isArray(value) ? value.length : 0;
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

function escapeHtml(s: string) { return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!)); }

function stripBig(o: any): any {
  if (!o || typeof o !== "object") return o;
  const out: any = Array.isArray(o) ? [] : {};
  for (const k of Object.keys(o)) {
    const v = (o as any)[k];
    if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 200) + "…";
    else if (Array.isArray(v) && v.length > 8) out[k] = v.slice(0, 8);
    else if (typeof v === "object") out[k] = stripBig(v);
    else out[k] = v;
  }
  return out;
}
