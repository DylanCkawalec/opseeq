import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveAppSurface } from './app-launcher.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPSEEQ_ROOT = path.resolve(HERE, '..', '..');
const NEMOCLAW_CLI = path.join(OPSEEQ_ROOT, 'bin', 'nemoclaw.js');
const REGISTRY_FILE = path.join(os.homedir(), '.nemoclaw', 'sandboxes.json');

const GATEWAY_ERROR_PATTERN = /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i;

export class NemoClawControlError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'NemoClawControlError';
    this.statusCode = statusCode;
  }
}

export interface NemoClawGatewaySummary {
  available: boolean;
  openshellPath: string | null;
  state: 'healthy_named' | 'named_unreachable' | 'named_unhealthy' | 'connected_other' | 'missing_named' | 'openshell_missing';
  summary: string;
  activeGateway: string | null;
  connected: boolean;
  namedGateway: boolean;
  statusOutput: string | null;
  gatewayInfoOutput: string | null;
}

export interface NemoClawSandboxSummary {
  name: string;
  isDefault: boolean;
  createdAt: string | null;
  model: string | null;
  provider: string | null;
  gpuEnabled: boolean;
  policies: string[];
  state: 'present' | 'missing' | 'gateway_error' | 'unknown_error' | 'openshell_missing';
  reachable: boolean;
  summary: string;
}

export interface NemoClawKnownApp {
  id: string;
  label: string;
  url: string;
  reachable: boolean;
}

export interface NemoClawOverview {
  generatedAt: string;
  registryPath: string;
  cliAvailable: boolean;
  defaultSandbox: string | null;
  sandboxes: NemoClawSandboxSummary[];
  stats: {
    total: number;
    reachable: number;
    gpuEnabled: number;
  };
  gateway: NemoClawGatewaySummary;
  apps: NemoClawKnownApp[];
}

export interface NemoClawActionResult {
  action: 'connect' | 'status' | 'logs';
  sandboxName: string;
  launched: boolean;
  output: string | null;
  message: string;
}

interface SandboxRegistryEntry {
  name: string;
  createdAt?: string | null;
  model?: string | null;
  nimContainer?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  policies?: string[];
}

interface SandboxRegistryData {
  sandboxes: Record<string, SandboxRegistryEntry>;
  defaultSandbox: string | null;
}

let cachedOpenshellPath: string | null | undefined;

function toUtf8(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stripAnsi(value = ''): string {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function hasNamedGateway(output = ''): boolean {
  return stripAnsi(output).includes('Gateway: nemoclaw');
}

function getActiveGatewayName(output = ''): string | null {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

function resolveOpenshellBinary(): string | null {
  if (cachedOpenshellPath !== undefined) {
    return cachedOpenshellPath;
  }

  try {
    const found = execSync('command -v openshell', { encoding: 'utf8' }).trim();
    if (found.startsWith('/')) {
      cachedOpenshellPath = found;
      return cachedOpenshellPath;
    }
  } catch {
    // Fall through to common install locations.
  }

  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'openshell'),
    '/usr/local/bin/openshell',
    '/usr/bin/openshell',
  ];
  cachedOpenshellPath = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
  return cachedOpenshellPath;
}

function loadRegistry(): SandboxRegistryData {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) {
      return { sandboxes: {}, defaultSandbox: null };
    }
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Partial<SandboxRegistryData>;
    return {
      sandboxes: parsed.sandboxes && typeof parsed.sandboxes === 'object' ? parsed.sandboxes : {},
      defaultSandbox: typeof parsed.defaultSandbox === 'string' ? parsed.defaultSandbox : null,
    };
  } catch {
    return { sandboxes: {}, defaultSandbox: null };
  }
}

function saveRegistry(data: SandboxRegistryData): void {
  const dir = path.dirname(REGISTRY_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function getDefaultSandboxName(data: SandboxRegistryData): string | null {
  if (data.defaultSandbox && data.sandboxes[data.defaultSandbox]) {
    return data.defaultSandbox;
  }
  const first = Object.keys(data.sandboxes)[0];
  return first || null;
}

async function captureCommand(
  file: string,
  args: string[],
  options: { ignoreError?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...options.env },
    });
    return { status: 0, output: `${stdout || ''}${stderr || ''}`.trim() };
  } catch (error) {
    const err = error as Error & { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer };
    const output = `${toUtf8(err.stdout)}${toUtf8(err.stderr)}`.trim() || err.message;
    const status = typeof err.code === 'number' ? err.code : 1;
    if (!options.ignoreError) {
      throw new NemoClawControlError(output || `${path.basename(file)} failed`, 502);
    }
    return { status, output };
  }
}

async function captureOpenshell(args: string[], ignoreError = true): Promise<{ status: number; output: string }> {
  const openshellPath = resolveOpenshellBinary();
  if (!openshellPath) {
    return { status: 127, output: 'openshell CLI not found' };
  }
  return await captureCommand(openshellPath, args, { ignoreError });
}

async function captureNemoclaw(args: string[], ignoreError = true): Promise<{ status: number; output: string }> {
  if (!fs.existsSync(NEMOCLAW_CLI)) {
    return { status: 127, output: 'nemoclaw CLI not found' };
  }
  return await captureCommand(process.execPath, [NEMOCLAW_CLI, ...args], { ignoreError });
}

function summarizeGatewayState(state: NemoClawGatewaySummary['state'], activeGateway: string | null): string {
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

async function getGatewaySummary(): Promise<NemoClawGatewaySummary> {
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
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const namedGateway = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanStatus);

  let state: NemoClawGatewaySummary['state'] = 'missing_named';
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

function summarizeSandboxState(state: NemoClawSandboxSummary['state']): string {
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

async function getSandboxState(name: string): Promise<Pick<NemoClawSandboxSummary, 'state' | 'reachable' | 'summary'>> {
  const openshellPath = resolveOpenshellBinary();
  if (!openshellPath) {
    return {
      state: 'openshell_missing',
      reachable: false,
      summary: 'OpenShell unavailable',
    };
  }

  const lookup = await captureOpenshell(['sandbox', 'get', name], true);
  if (lookup.status === 0) {
    return { state: 'present', reachable: true, summary: 'Reachable' };
  }
  if (/NotFound|sandbox not found/i.test(lookup.output)) {
    return { state: 'missing', reachable: false, summary: summarizeSandboxState('missing') };
  }
  if (GATEWAY_ERROR_PATTERN.test(lookup.output)) {
    return { state: 'gateway_error', reachable: false, summary: summarizeSandboxState('gateway_error') };
  }
  return { state: 'unknown_error', reachable: false, summary: summarizeSandboxState('unknown_error') };
}

async function probeUrl(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getKnownApps(env: NodeJS.ProcessEnv = process.env): Promise<NemoClawKnownApp[]> {
  const surfaces = [resolveAppSurface('mermate', env), resolveAppSurface('synth', env)];
  return await Promise.all(surfaces.map(async (surface) => ({
    id: surface.id,
    label: surface.label,
    url: surface.url,
    reachable: await probeUrl(surface.url),
  })));
}

function validateSandboxName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed)) {
    throw new NemoClawControlError(`Invalid sandbox name: ${name}`, 400);
  }
  return trimmed;
}

async function openTerminalCommand(command: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
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

  const child = spawn(env.SHELL || '/bin/sh', ['-lc', command], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
}

function buildNemoclawShellCommand(sandboxName: string, action: 'connect' | 'logs'): string {
  const segments = [
    `cd ${shellQuote(OPSEEQ_ROOT)}`,
    `${shellQuote(process.execPath)} ${shellQuote(NEMOCLAW_CLI)} ${shellQuote(sandboxName)} ${action}${action === 'logs' ? ' --follow' : ''}`,
  ];
  return segments.join(' && ');
}

export async function getNemoClawOverview(env: NodeJS.ProcessEnv = process.env): Promise<NemoClawOverview> {
  const registry = loadRegistry();
  const defaultSandbox = getDefaultSandboxName(registry);
  const gateway = await getGatewaySummary();
  const entries = Object.values(registry.sandboxes).sort((left, right) => left.name.localeCompare(right.name));
  const sandboxes = await Promise.all(entries.map(async (entry) => {
    const name = entry.name || '';
    const state = name ? await getSandboxState(name) : { state: 'unknown_error' as const, reachable: false, summary: 'Needs inspection' };
    return {
      name,
      isDefault: name === defaultSandbox,
      createdAt: entry.createdAt || null,
      model: entry.model || null,
      provider: entry.provider || null,
      gpuEnabled: Boolean(entry.gpuEnabled),
      policies: Array.isArray(entry.policies) ? entry.policies : [],
      state: state.state,
      reachable: state.reachable,
      summary: state.summary,
    } satisfies NemoClawSandboxSummary;
  }));
  sandboxes.sort((left, right) => {
    if (left.isDefault && !right.isDefault) return -1;
    if (!left.isDefault && right.isDefault) return 1;
    return left.name.localeCompare(right.name);
  });

  return {
    generatedAt: new Date().toISOString(),
    registryPath: REGISTRY_FILE,
    cliAvailable: fs.existsSync(NEMOCLAW_CLI),
    defaultSandbox,
    sandboxes,
    stats: {
      total: sandboxes.length,
      reachable: sandboxes.filter((sandbox) => sandbox.reachable).length,
      gpuEnabled: sandboxes.filter((sandbox) => sandbox.gpuEnabled).length,
    },
    gateway,
    apps: await getKnownApps(env),
  };
}

export function setNemoClawDefaultSandbox(sandboxName: string): { defaultSandbox: string } {
  const safeName = validateSandboxName(sandboxName);
  const registry = loadRegistry();
  if (!registry.sandboxes[safeName]) {
    throw new NemoClawControlError(`Sandbox not found: ${safeName}`, 404);
  }
  registry.defaultSandbox = safeName;
  saveRegistry(registry);
  return { defaultSandbox: safeName };
}

export async function runNemoClawAction(
  action: 'connect' | 'status' | 'logs',
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NemoClawActionResult> {
  const safeName = validateSandboxName(sandboxName);
  const registry = loadRegistry();
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
    if (detailOutput) {
      lines.push('', detailOutput);
    }
    return {
      action,
      sandboxName: safeName,
      launched: false,
      output: lines.join('\n'),
      message: `Captured status for ${safeName}.`,
    };
  }

  const command = buildNemoclawShellCommand(safeName, action);
  try {
    await openTerminalCommand(command, env);
  } catch (error) {
    throw new NemoClawControlError(
      `Unable to open terminal for ${safeName}: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }

  return {
    action,
    sandboxName: safeName,
    launched: true,
    output: null,
    message: action === 'connect'
      ? `Opened terminal for ${safeName} connect.`
      : `Opened terminal for ${safeName} logs.`,
  };
}
