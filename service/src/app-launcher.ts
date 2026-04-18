import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class AppLauncherError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AppLauncherError';
    this.statusCode = statusCode;
  }
}

export interface AppSurface {
  id: string;
  label: string;
  url: string;
  launchCommand: string | null;
}

export interface AppOpenResult {
  id: string;
  label: string;
  url: string;
  launched: boolean;
  reachable: boolean;
}

function normalizeUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

async function probeUrl(url: string, timeoutMs = 2500): Promise<boolean> {
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

function validateHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppLauncherError(`Invalid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppLauncherError(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function resolveAppSurface(id: string, env: NodeJS.ProcessEnv = process.env): AppSurface {
  switch (id) {
    case 'mermate':
      return {
        id,
        label: 'Mermate',
        url: normalizeUrl(env.MERMATE_DASHBOARD_URL || env.MERMATE_URL || 'http://127.0.0.1:3333'),
        launchCommand: env.MERMATE_LAUNCH_CMD || null,
      };
    case 'synth':
    case 'synthesis-trade':
      return {
        id: 'synth',
        label: 'Synth',
        url: normalizeUrl(env.SYNTHESIS_TRADE_DASHBOARD_URL || env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420'),
        launchCommand: env.SYNTHESIS_TRADE_LAUNCH_CMD || null,
      };
    default:
      throw new AppLauncherError(`Unknown app surface: ${id}`, 404);
  }
}

async function openUrl(url: string): Promise<void> {
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

function launchBackgroundCommand(command: string): void {
  const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export async function openAppSurface(id: string, env: NodeJS.ProcessEnv = process.env): Promise<AppOpenResult> {
  const surface = resolveAppSurface(id, env);
  const validatedUrl = validateHttpUrl(surface.url);
  const launched = Boolean(surface.launchCommand);
  if (surface.launchCommand) {
    launchBackgroundCommand(surface.launchCommand);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  await openUrl(validatedUrl);
  const reachable = await probeUrl(validatedUrl, 2000);
  return {
    id: surface.id,
    label: surface.label,
    url: validatedUrl,
    launched,
    reachable,
  };
}
