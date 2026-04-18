'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execSync, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const OPSEEQ_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const HOME = os.homedir();
const CONTROL_DIR = path.join(HOME, '.opseeq');
const APP_REGISTRY_FILE = path.join(CONTROL_DIR, 'apps.json');
const NEMOCLAW_REGISTRY_FILE = path.join(HOME, '.nemoclaw', 'sandboxes.json');
const NEMOCLAW_CLI = path.join(OPSEEQ_ROOT, 'bin', 'nemoclaw.js');
const MERMAID_EXTENSION_PATH = process.env.MERMATE_EXTENSION_PATH || path.resolve(OPSEEQ_ROOT, '..', 'gpt-oss', 'gpt_oss', 'extensions', 'mermaid_enhancer');
const MERMATE_PRECISION_PATH = path.join(OPSEEQ_ROOT, 'service', 'src', 'mermate-lucidity-ooda.ts');
const LIVING_GRAPH_PATH = path.join(OPSEEQ_ROOT, 'service', 'src', 'living-architecture-graph.ts');
const LUCIDITY_EXTENSION_PATH = process.env.LUCIDITY_REPO || path.resolve(OPSEEQ_ROOT, '..', 'Lucidity');
const OPSEEQ_DOCS_PATH = path.join(OPSEEQ_ROOT, 'docs', 'wp');
const SANDBOX_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const GATEWAY_ERROR_PATTERN = /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i;

class AppControlError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AppControlError';
    this.statusCode = statusCode;
  }
}

class NemoClawControlError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'NemoClawControlError';
    this.statusCode = statusCode;
  }
}

function exists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stripAnsi(value = '') {
  return String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function normalizeUrl(raw) {
  return String(raw || '').replace(/\/+$/, '');
}

function loadJson(filePath, fallback) {
  try {
    if (!exists(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseEnvFile(filePath) {
  const values = {};
  if (!exists(filePath)) return values;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function updateEnvFile(filePath, updates) {
  const nextValues = Object.fromEntries(Object.entries(updates).filter(([, value]) => value != null));
  const original = exists(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = original.length ? original.split(/\r?\n/) : [];
  const seen = new Set();
  const output = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/);
    if (!match) return line;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(nextValues, key)) return line;
    seen.add(key);
    return `${key}=${nextValues[key]}`;
  });
  const missing = Object.keys(nextValues).filter((key) => !seen.has(key));
  if (missing.length) {
    if (output.length && output[output.length - 1] !== '') output.push('');
    for (const key of missing) output.push(`${key}=${nextValues[key]}`);
  }
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${output.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

function patchLucidityDefaults(filePath, provider, model) {
  if (!exists(filePath)) return false;
  const current = fs.readFileSync(filePath, 'utf8');
  const match = current.match(/const defaultSettings = \{([\s\S]*?)\n\};/);
  if (!match) return false;
  const nextProvider = provider === 'ollama' ? 'ollama' : 'opseeq';
  let block = match[0];
  block = block.replace(/aiMode:\s*'[^']*'/, `aiMode: '${nextProvider}'`);
  if (model && nextProvider === 'opseeq') {
    block = block.replace(/opseeqModel:\s*'[^']*'/, `opseeqModel: '${model}'`);
  }
  if (model && nextProvider === 'ollama') {
    block = block.replace(/ollamaModel:\s*'[^']*'/, `ollamaModel: '${model}'`);
  }
  if (block === match[0]) return false;
  fs.writeFileSync(filePath, current.replace(match[0], block), 'utf8');
  return true;
}

function readLucidityDefaults(repoPath) {
  const appJsPath = path.join(repoPath, 'app.js');
  if (!exists(appJsPath)) {
    return {
      provider: 'opseeq',
      model: 'gateway-default',
      fallbackModel: 'kimi-k2.5:cloud',
      source: 'default',
      editable: false,
      writeTarget: null,
    };
  }
  const content = fs.readFileSync(appJsPath, 'utf8');
  const settingsMatch = content.match(/const defaultSettings = \{([\s\S]*?)\n\};/);
  const block = settingsMatch ? settingsMatch[1] : '';
  const aiMode = (block.match(/aiMode:\s*'([^']+)'/) || [null, 'opseeq'])[1];
  const opseeqModel = (block.match(/opseeqModel:\s*'([^']*)'/) || [null, ''])[1];
  const ollamaModel = (block.match(/ollamaModel:\s*'([^']+)'/) || [null, 'kimi-k2.5:cloud'])[1];
  const provider = aiMode === 'ollama' || aiMode === 'kimi' ? 'ollama' : 'opseeq';
  return {
    provider,
    model: provider === 'ollama' ? ollamaModel : (opseeqModel || 'gateway-default'),
    fallbackModel: ollamaModel,
    source: 'app.js defaultSettings',
    editable: true,
    writeTarget: appJsPath,
  };
}

function inferProviderFromBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes(':9090') || normalized.includes('opseeq')) return 'opseeq';
  if (normalized.includes(':11434') || normalized.includes('ollama')) return 'ollama';
  if (normalized.includes('api.openai.com')) return 'openai';
  if (normalized.includes('anthropic')) return 'anthropic';
  return 'external';
}

function resolveExecutable(name) {
  try {
    const found = execSync(`command -v ${name}`, { encoding: 'utf8' }).trim();
    return found.startsWith('/') ? found : null;
  } catch (_) {
    return null;
  }
}

function resolveOpenshellBinary() {
  const candidates = [
    resolveExecutable('openshell'),
    path.join(HOME, '.local', 'bin', 'openshell'),
    '/usr/local/bin/openshell',
    '/usr/bin/openshell',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

function buildExtensionCatalog() {
  return [
    {
      id: 'mermaid-enhancer',
      label: 'Mermaid Enhancer',
      description: 'Mermate architecture extension pack for diagram enhancement and copilot suggestions.',
      path: MERMAID_EXTENSION_PATH,
      exists: isDirectory(MERMAID_EXTENSION_PATH),
    },
    {
      id: 'mermate-max-ooda',
      label: 'Mermate MAX OODA',
      description: 'Precision Orchestration Mermate pack for idea assessment, MAX render, and the TLA+/TS/Rust bridge.',
      path: MERMATE_PRECISION_PATH,
      exists: exists(MERMATE_PRECISION_PATH),
    },
    {
      id: 'lucidity-semantic-polish',
      label: 'Lucidity Semantic Polish',
      description: 'Lucidity cleanup and image-analysis comparison pack for final Mermaid reconciliation.',
      path: LUCIDITY_EXTENSION_PATH,
      exists: isDirectory(LUCIDITY_EXTENSION_PATH),
    },
    {
      id: 'living-architecture-graph',
      label: 'Living Architecture Graph',
      description: 'Immutable provenance graph and temporal causality pack for OODA-driven execution.',
      path: LIVING_GRAPH_PATH,
      exists: exists(LIVING_GRAPH_PATH),
    },
    {
      id: 'opseeq-docs-wp',
      label: 'Opseeq GoT Docs',
      description: 'Opseeq whitepaper and GoT reference library for extension and optimization workflows.',
      path: OPSEEQ_DOCS_PATH,
      exists: isDirectory(OPSEEQ_DOCS_PATH),
    },
  ];
}

function readAppRegistry() {
  const parsed = loadJson(APP_REGISTRY_FILE, { schemaVersion: 1, apps: {} });
  if (!parsed || typeof parsed !== 'object') {
    return { schemaVersion: 1, apps: {} };
  }
  return {
    schemaVersion: parsed.schemaVersion || 1,
    apps: parsed.apps && typeof parsed.apps === 'object' ? parsed.apps : {},
  };
}

function saveAppRegistry(registry) {
  writeJson(APP_REGISTRY_FILE, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    apps: registry.apps || {},
  });
}

function buildDefaultApps(env = process.env) {
  const synthRepo = env.SYNTH_REPO || path.resolve(OPSEEQ_ROOT, '..', 'Synthesis-Trade');
  const lucidityRepo = env.LUCIDITY_REPO || path.resolve(OPSEEQ_ROOT, '..', 'Lucidity');
  const mermateRepo = env.MERMATE_REPO || path.resolve(OPSEEQ_ROOT, '..', 'Mermate');
  const synthEnv = parseEnvFile(path.join(synthRepo, '.env'));
  const synthProvider = inferProviderFromBaseUrl(synthEnv.OPENAI_BASE_URL || 'http://localhost:9090/v1');
  const lucidityDefaults = readLucidityDefaults(lucidityRepo);
  const mermateEntries = isDirectory(mermateRepo) ? fs.readdirSync(mermateRepo).filter((entry) => entry !== '.DS_Store') : [];

  return {
    mermate: {
      id: 'mermate',
      label: 'Mermate',
      url: normalizeUrl(env.MERMATE_DASHBOARD_URL || env.MERMATE_URL || 'http://127.0.0.1:3333'),
      repoPath: mermateRepo,
      repoExists: isDirectory(mermateRepo) && mermateEntries.some((entry) => entry !== 'dumps'),
      launchCommand: env.MERMATE_LAUNCH_CMD || null,
      launchReady: Boolean(env.MERMATE_LAUNCH_CMD),
      inference: {
        provider: 'ollama',
        model: env.MERMATE_MODEL || 'gpt-oss:20b',
        source: env.MERMATE_MODEL ? 'environment' : 'registry default',
        editable: true,
        writeTarget: null,
        mode: 'extension',
      },
      notes: isDirectory(mermateRepo) && !mermateEntries.some((entry) => entry !== 'dumps')
        ? ['Repo path only contains historical dumps. Launch/writeback is registry-only until the runnable Mermate app is restored.']
        : [],
      extensions: ['mermaid-enhancer', 'mermate-max-ooda', 'living-architecture-graph', 'opseeq-docs-wp'],
    },
    synth: {
      id: 'synth',
      label: 'Synth',
      url: normalizeUrl(env.SYNTHESIS_TRADE_DASHBOARD_URL || env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420'),
      repoPath: synthRepo,
      repoExists: isDirectory(synthRepo),
      launchCommand: env.SYNTHESIS_TRADE_LAUNCH_CMD || (exists(path.join(synthRepo, 'docker-compose.yml')) ? `cd ${shellQuote(synthRepo)} && docker compose up -d --build synth` : null),
      launchReady: Boolean(env.SYNTHESIS_TRADE_LAUNCH_CMD || exists(path.join(synthRepo, 'docker-compose.yml'))),
      inference: {
        provider: synthProvider,
        model: synthEnv.OPENAI_MODEL || 'gpt-oss:20b',
        source: exists(path.join(synthRepo, '.env')) ? '.env' : 'default',
        editable: true,
        writeTarget: exists(path.join(synthRepo, '.env')) ? path.join(synthRepo, '.env') : null,
        mode: 'gateway',
      },
      notes: [],
      extensions: ['living-architecture-graph', 'opseeq-docs-wp'],
    },
    lucidity: {
      id: 'lucidity',
      label: 'Lucidity',
      url: normalizeUrl(env.LUCIDITY_URL || 'http://127.0.0.1:4173'),
      repoPath: lucidityRepo,
      repoExists: isDirectory(lucidityRepo),
      launchCommand: env.LUCIDITY_LAUNCH_CMD || (exists(path.join(lucidityRepo, 'server.mjs')) ? `cd ${shellQuote(lucidityRepo)} && node server.mjs` : null),
      launchReady: Boolean(env.LUCIDITY_LAUNCH_CMD || exists(path.join(lucidityRepo, 'server.mjs'))),
      inference: {
        provider: lucidityDefaults.provider,
        model: lucidityDefaults.model,
        fallbackModel: lucidityDefaults.fallbackModel,
        source: lucidityDefaults.source,
        editable: lucidityDefaults.editable,
        writeTarget: lucidityDefaults.writeTarget,
        mode: 'ui-managed',
      },
      notes: ['Lucidity routes AI through its own UI mode selector. Opseeq can set defaults, but the app still allows in-app overrides.'],
      extensions: ['lucidity-semantic-polish', 'living-architecture-graph', 'opseeq-docs-wp'],
    },
  };
}

async function probeUrl(url, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: ctrl.signal });
    return response.status < 500;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReachable(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeUrl(url, 1500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function launchBackgroundCommand(command, env = process.env) {
  const child = spawn(env.SHELL || '/bin/sh', ['-lc', command], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
}

async function openUrl(url) {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url]);
    return;
  }
  await execFileAsync('xdg-open', [url]);
}

async function getAppRegistry(env = process.env) {
  const defaults = buildDefaultApps(env);
  const persisted = readAppRegistry();
  const extensionCatalog = buildExtensionCatalog();
  const apps = await Promise.all(Object.values(defaults).map(async (base) => {
    const override = persisted.apps[base.id] || {};
    const mergedInference = {
      ...base.inference,
      ...(override.inference && typeof override.inference === 'object' ? override.inference : {}),
    };
    const resolved = {
      ...base,
      ...override,
      repoPath: override.repoPath || base.repoPath,
      url: override.url || base.url,
      launchCommand: override.launchCommand || base.launchCommand,
      inference: mergedInference,
      notes: [...new Set([...(base.notes || []), ...(override.notes || [])])],
      extensions: Array.isArray(override.extensions) ? override.extensions : base.extensions,
    };
    const reachable = await probeUrl(resolved.url);
    const extensionEntries = (resolved.extensions || []).map((extensionId) => {
      const entry = extensionCatalog.find((item) => item.id === extensionId);
      return entry || { id: extensionId, label: extensionId, description: '', path: null, exists: false };
    });
    return {
      ...resolved,
      repoExists: isDirectory(resolved.repoPath),
      launchReady: Boolean(resolved.launchCommand),
      reachable,
      extensions: extensionEntries,
    };
  }));

  return {
    generatedAt: new Date().toISOString(),
    registryPath: APP_REGISTRY_FILE,
    apps,
    extensionCatalog,
  };
}

function validateHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new AppControlError(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppControlError(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function validateAppId(appId) {
  const safe = String(appId || '').trim().toLowerCase();
  if (!safe) throw new AppControlError('appId is required', 400);
  if (!['mermate', 'synth', 'lucidity'].includes(safe)) {
    throw new AppControlError(`Unknown app: ${appId}`, 404);
  }
  return safe;
}

async function openAppSurface(appId, env = process.env) {
  const safeAppId = validateAppId(appId);
  const registry = await getAppRegistry(env);
  const app = registry.apps.find((entry) => entry.id === safeAppId);
  if (!app) throw new AppControlError(`Unknown app: ${appId}`, 404);
  const url = validateHttpUrl(app.url);
  const beforeReachable = await probeUrl(url, 1500);
  if (!beforeReachable && !app.launchCommand) {
    throw new AppControlError(`${app.label} is offline and no launch command is configured.`, 503);
  }
  let launched = false;
  if (!beforeReachable && app.launchCommand) {
    launchBackgroundCommand(app.launchCommand, env);
    launched = true;
  }
  const reachable = beforeReachable || await waitForReachable(url, launched ? 20000 : 1500);
  if (!reachable) {
    throw new AppControlError(`${app.label} launch was requested, but ${url} did not become reachable.`, 502);
  }
  await openUrl(url);
  return {
    id: app.id,
    label: app.label,
    url,
    launched,
    reachable,
  };
}

async function setAppInference(appId, payload, env = process.env) {
  const safeAppId = validateAppId(appId);
  const provider = String(payload.provider || '').trim() || 'opseeq';
  const model = String(payload.model || '').trim() || (provider === 'ollama' ? 'gpt-oss:20b' : 'gateway-default');
  const defaults = buildDefaultApps(env);
  const registry = readAppRegistry();
  const base = defaults[safeAppId];
  if (!base) throw new AppControlError(`Unknown app: ${appId}`, 404);
  const nextEntry = {
    ...(registry.apps[safeAppId] || {}),
    inference: {
      ...base.inference,
      ...((registry.apps[safeAppId] && registry.apps[safeAppId].inference) || {}),
      provider,
      model,
      source: 'opseeq registry',
    },
  };

  if (safeAppId === 'synth') {
    const envPath = path.join(base.repoPath, '.env');
    if (exists(envPath)) {
      updateEnvFile(envPath, {
        OPENAI_BASE_URL: provider === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:9090/v1',
        OPSEEQ_URL: 'http://localhost:9090',
        OPENAI_MODEL: model,
      });
      nextEntry.inference.source = '.env';
    }
  }

  if (safeAppId === 'lucidity') {
    const appJsPath = path.join(base.repoPath, 'app.js');
    if (patchLucidityDefaults(appJsPath, provider, model)) {
      nextEntry.inference.source = 'app.js defaultSettings';
    }
  }

  registry.apps[safeAppId] = nextEntry;
  saveAppRegistry(registry);
  const fresh = await getAppRegistry(env);
  return fresh.apps.find((entry) => entry.id === safeAppId);
}

function loadNemoclawRegistry() {
  const parsed = loadJson(NEMOCLAW_REGISTRY_FILE, { sandboxes: {}, defaultSandbox: null });
  return {
    sandboxes: parsed.sandboxes && typeof parsed.sandboxes === 'object' ? parsed.sandboxes : {},
    defaultSandbox: typeof parsed.defaultSandbox === 'string' ? parsed.defaultSandbox : null,
  };
}

function saveNemoclawRegistry(data) {
  writeJson(NEMOCLAW_REGISTRY_FILE, data);
}

function normalizeExecResult(result) {
  if (typeof result === 'string') {
    return { stdout: result, stderr: '' };
  }
  if (Array.isArray(result)) {
    return { stdout: result[0] || '', stderr: result[1] || '' };
  }
  if (result && typeof result === 'object') {
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }
  return { stdout: '', stderr: '' };
}

function captureCommand(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  }).then((result) => {
    const { stdout, stderr } = normalizeExecResult(result);
    return {
    status: 0,
    output: `${stdout || ''}${stderr || ''}`.trim(),
    };
  }).catch((error) => {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message;
    if (!options.ignoreError) {
      throw new NemoClawControlError(output || `${path.basename(file)} failed`, 502);
    }
    return { status: typeof error.code === 'number' ? error.code : 1, output };
  });
}

function captureOpenshell(args, ignoreError = true) {
  const openshellPath = resolveOpenshellBinary();
  if (!openshellPath) {
    return Promise.resolve({ status: 127, output: 'openshell CLI not found' });
  }
  return captureCommand(openshellPath, args, { ignoreError });
}

function hasNamedGateway(output = '') {
  return stripAnsi(output).includes('Gateway: nemoclaw');
}

function getActiveGatewayName(output = '') {
  const clean = stripAnsi(output).replace(/[^\x20-\x7E\n]/g, '');
  const match = clean.match(/Gateway:\s+([^\n]+)/m);
  return match ? match[1].trim() : null;
}

function summarizeGatewayState(state, activeGateway) {
  switch (state) {
    case 'healthy_named':
      return 'Gateway connected';
    case 'named_unreachable':
      return 'Gateway selected but unreachable';
    case 'named_unhealthy':
      return 'Gateway selected but unhealthy';
    case 'connected_other':
      return `Connected to ${activeGateway || 'another gateway'}`;
    case 'missing_named':
      return 'NemoClaw gateway not selected';
    case 'openshell_missing':
    default:
      return 'OpenShell unavailable';
  }
}

async function getGatewaySummary() {
  const openshellPath = resolveOpenshellBinary();
  if (!openshellPath) {
    return {
      available: false,
      openshellPath: null,
      state: 'openshell_missing',
      summary: 'OpenShell unavailable',
      activeGateway: null,
      connected: false,
      namedGateway: false,
      statusOutput: null,
      gatewayInfoOutput: null,
    };
  }
  const [status, gatewayInfo] = await Promise.all([
    captureOpenshell(['status'], true),
    captureOpenshell(['gateway', 'info', '-g', 'nemoclaw'], true),
  ]);
  const cleanStatus = stripAnsi(status.output).replace(/[^\x20-\x7E\n]/g, '');
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /Status:\s*Connected\b/im.test(cleanStatus);
  const namedGateway = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanStatus);

  let state = 'missing_named';
  if (connected && activeGateway === 'nemoclaw' && namedGateway) {
    state = 'healthy_named';
  } else if (activeGateway === 'nemoclaw' && namedGateway && refusing) {
    state = 'named_unreachable';
  } else if (activeGateway === 'nemoclaw' && namedGateway) {
    state = 'named_unhealthy';
  } else if (connected) {
    state = 'connected_other';
  }

  return {
    available: true,
    openshellPath,
    state,
    summary: summarizeGatewayState(state, activeGateway),
    activeGateway,
    connected,
    namedGateway,
    statusOutput: status.output || null,
    gatewayInfoOutput: gatewayInfo.output || null,
  };
}

function summarizeSandboxState(state) {
  switch (state) {
    case 'present':
      return 'Reachable';
    case 'missing':
      return 'Missing from gateway';
    case 'gateway_error':
      return 'Gateway unavailable';
    case 'unknown_error':
      return 'Needs inspection';
    case 'openshell_missing':
    default:
      return 'OpenShell unavailable';
  }
}

async function getSandboxState(name) {
  const openshellPath = resolveOpenshellBinary();
  if (!openshellPath) {
    return { state: 'openshell_missing', reachable: false, summary: 'OpenShell unavailable' };
  }
  const lookup = await captureOpenshell(['sandbox', 'get', name], true);
  if (lookup.status === 0) return { state: 'present', reachable: true, summary: 'Reachable' };
  if (/NotFound|sandbox not found/i.test(lookup.output)) {
    return { state: 'missing', reachable: false, summary: summarizeSandboxState('missing') };
  }
  if (GATEWAY_ERROR_PATTERN.test(lookup.output)) {
    return { state: 'gateway_error', reachable: false, summary: summarizeSandboxState('gateway_error') };
  }
  return { state: 'unknown_error', reachable: false, summary: summarizeSandboxState('unknown_error') };
}

function validateSandboxName(name) {
  const trimmed = String(name || '').trim();
  if (!SANDBOX_NAME_PATTERN.test(trimmed)) {
    throw new NemoClawControlError(`Invalid sandbox name: ${name}`, 400);
  }
  return trimmed;
}

async function getNemoClawOverview(env = process.env) {
  const registry = loadNemoclawRegistry();
  const defaultSandbox = registry.defaultSandbox && registry.sandboxes[registry.defaultSandbox] ? registry.defaultSandbox : (Object.keys(registry.sandboxes)[0] || null);
  const gateway = await getGatewaySummary();
  const sandboxes = await Promise.all(Object.values(registry.sandboxes).sort((left, right) => String(left.name).localeCompare(String(right.name))).map(async (entry) => {
    const sandboxState = entry.name ? await getSandboxState(entry.name) : { state: 'unknown_error', reachable: false, summary: 'Needs inspection' };
    return {
      name: entry.name || '',
      isDefault: entry.name === defaultSandbox,
      createdAt: entry.createdAt || null,
      model: entry.model || null,
      provider: entry.provider || null,
      gpuEnabled: Boolean(entry.gpuEnabled),
      policies: Array.isArray(entry.policies) ? entry.policies : [],
      state: sandboxState.state,
      reachable: sandboxState.reachable,
      summary: sandboxState.summary,
    };
  }));
  const appRegistry = await getAppRegistry(env);
  return {
    generatedAt: new Date().toISOString(),
    registryPath: NEMOCLAW_REGISTRY_FILE,
    cliAvailable: exists(NEMOCLAW_CLI),
    defaultSandbox,
    sandboxes,
    stats: {
      total: sandboxes.length,
      reachable: sandboxes.filter((sandbox) => sandbox.reachable).length,
      gpuEnabled: sandboxes.filter((sandbox) => sandbox.gpuEnabled).length,
    },
    gateway,
    apps: appRegistry.apps.filter((entry) => entry.id === 'mermate' || entry.id === 'synth').map((entry) => ({
      id: entry.id,
      label: entry.label,
      url: entry.url,
      reachable: entry.reachable,
    })),
  };
}

function setNemoClawDefaultSandbox(sandboxName) {
  const safeName = validateSandboxName(sandboxName);
  const registry = loadNemoclawRegistry();
  if (!registry.sandboxes[safeName]) {
    throw new NemoClawControlError(`Sandbox not found: ${safeName}`, 404);
  }
  registry.defaultSandbox = safeName;
  saveNemoclawRegistry(registry);
  return { defaultSandbox: safeName };
}

async function openTerminalCommand(command, env = process.env) {
  if (process.platform === 'darwin') {
    const preferred = String(env.OPSEEQ_TERMINAL_APP || '').trim().toLowerCase();
    if (preferred === 'iterm' || preferred === 'iterm2') {
      const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execFileAsync('osascript', [
        '-e', 'tell application "iTerm"',
        '-e', 'activate',
        '-e', 'if (count of windows) = 0 then',
        '-e', 'create window with default profile',
        '-e', 'end if',
        '-e', 'tell current window',
        '-e', 'create tab with default profile',
        '-e', `tell current session to write text "${escaped}"`,
        '-e', 'end tell',
        '-e', 'end tell',
      ]);
      return;
    }
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await execFileAsync('osascript', [
      '-e', 'tell application "Terminal"',
      '-e', 'activate',
      '-e', `do script "${escaped}"`,
      '-e', 'end tell',
    ]);
    return;
  }
  launchBackgroundCommand(command, env);
}

async function runNemoClawAction(action, sandboxName, env = process.env) {
  const safeName = validateSandboxName(sandboxName);
  const registry = loadNemoclawRegistry();
  if (!registry.sandboxes[safeName]) {
    throw new NemoClawControlError(`Sandbox not found: ${safeName}`, 404);
  }
  if (action === 'status') {
    const sandbox = registry.sandboxes[safeName];
    const [gateway, state, rawSandbox] = await Promise.all([
      getGatewaySummary(),
      getSandboxState(safeName),
      captureOpenshell(['sandbox', 'get', safeName], true),
    ]);
    const lines = [
      `Sandbox: ${safeName}`,
      `Model: ${sandbox.model || 'unknown'}`,
      `Provider: ${sandbox.provider || 'unknown'}`,
      `GPU: ${sandbox.gpuEnabled ? 'yes' : 'no'}`,
      `Policies: ${(sandbox.policies || []).join(', ') || 'none'}`,
      `State: ${state.summary}`,
      '',
      `Gateway: ${gateway.summary}${gateway.activeGateway ? ` (${gateway.activeGateway})` : ''}`,
    ];
    const detailOutput = stripAnsi(rawSandbox.output || gateway.statusOutput || '').trim();
    if (detailOutput) lines.push('', detailOutput);
    return {
      action,
      sandboxName: safeName,
      launched: false,
      output: lines.join('\n'),
      message: `Captured status for ${safeName}.`,
    };
  }
  const command = `cd ${shellQuote(OPSEEQ_ROOT)} && ${shellQuote(process.execPath)} ${shellQuote(NEMOCLAW_CLI)} ${shellQuote(safeName)} ${action}${action === 'logs' ? ' --follow' : ''}`;
  await openTerminalCommand(command, env);
  return {
    action,
    sandboxName: safeName,
    launched: true,
    output: null,
    message: action === 'connect' ? `Opened terminal for ${safeName} connect.` : `Opened terminal for ${safeName} logs.`,
  };
}

async function redeployOpseeqRuntime(env = process.env) {
  const startedAt = Date.now();
  const command = 'docker compose up -d --build opseeq';
  const result = await execFileAsync(env.SHELL || '/bin/sh', ['-lc', command], {
    cwd: OPSEEQ_ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 20,
  });
  const { stdout, stderr } = normalizeExecResult(result);
  return {
    command,
    cwd: OPSEEQ_ROOT,
    durationMs: Date.now() - startedAt,
    output: `${stdout || ''}${stderr || ''}`.trim(),
  };
}

module.exports = {
  AppControlError,
  NemoClawControlError,
  getAppRegistry,
  setAppInference,
  openAppSurface,
  getNemoClawOverview,
  runNemoClawAction,
  setNemoClawDefaultSandbox,
  redeployOpseeqRuntime,
};
