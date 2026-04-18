import { promises as fsp } from 'node:fs';
import path from 'node:path';

const DEFAULT_OPSEEQ_URL = 'http://localhost:9090';
const DEFAULT_MERMATE_URL = 'http://host.docker.internal:3333';
const DEFAULT_SYNTH_URL = 'http://host.docker.internal:8420';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_MODELS = 'claude-4-opus,claude-4-sonnet,claude-3.5-sonnet';

export class RepoConnectError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'RepoConnectError';
    this.statusCode = statusCode;
  }
}

export interface RepoAnalysis {
  repoName: string;
  repoPath: string;
  detectedKinds: string[];
  containerized: boolean;
  desktopWrapper: { detected: boolean; kind: string | null };
  runtime: {
    startCommand: string | null;
    inferredPort: number | null;
    openUrl: string | null;
  };
  files: {
    hasPackageJson: boolean;
    hasPyprojectToml: boolean;
    hasRequirementsTxt: boolean;
    hasCargoToml: boolean;
    hasDockerfile: boolean;
    hasDockerCompose: boolean;
    hasEnv: boolean;
    hasMcpJson: boolean;
    hasReadme: boolean;
    hasRunScript: boolean;
  };
  notes: string[];
}

export interface RepoConnectCheck {
  item: string;
  status: string;
  action?: string;
}

export interface RepoConnectResult {
  repoPath: string;
  analysis: RepoAnalysis;
  checks: RepoConnectCheck[];
  warnings: string[];
}

interface RepoConnectOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  mcpUrl?: string;
  opseeqUrl?: string;
}

interface EnsuredFile {
  check: RepoConnectCheck;
  warnings: string[];
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeUrl(raw: string): string {
  return raw.replace(/^http:\/\/127\.0\.0\.1/, 'http://localhost').replace(/\/+$/, '');
}

function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  if (!(await exists(filePath))) return null;
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function detectDesktopKind(packageJson: Record<string, unknown> | null, foundFiles: Set<string>): string | null {
  const deps = {
    ...(packageJson?.dependencies as Record<string, unknown> | undefined),
    ...(packageJson?.devDependencies as Record<string, unknown> | undefined),
  };
  if (foundFiles.has('src-tauri/tauri.conf.json') || foundFiles.has('tauri.conf.json') || 'tauri' in deps || '@tauri-apps/cli' in deps) {
    return 'tauri';
  }
  if (
    foundFiles.has('electron-builder.json') ||
    foundFiles.has('electron.vite.config.js') ||
    foundFiles.has('electron.vite.config.ts') ||
    foundFiles.has('electron.vite.config.mjs') ||
    'electron' in deps ||
    'electron-builder' in deps
  ) {
    return 'electron';
  }
  if (foundFiles.has('wails.json') || 'wails' in deps) return 'wails';
  return null;
}

function detectStartCommand(packageJson: Record<string, unknown> | null, foundFiles: Set<string>, detectedKinds: string[]): string | null {
  const scripts = (packageJson?.scripts as Record<string, string> | undefined) || {};
  if (typeof scripts.start === 'string') return 'npm start';
  if (typeof scripts.dev === 'string') return 'npm run dev';
  if (foundFiles.has('run.sh')) return './run.sh';
  if (foundFiles.has('docker-compose.yml')) return 'docker compose up -d --build';
  if (detectedKinds.includes('rust')) return 'cargo run';
  if (detectedKinds.includes('python') && foundFiles.has('server.py')) return 'python server.py';
  if (detectedKinds.includes('python') && foundFiles.has('main.py')) return 'python main.py';
  return null;
}

async function inferPort(repoPath: string): Promise<number | null> {
  const candidates = [
    'server.mjs',
    'server.js',
    'app/server/index.ts',
    'app/server/index.js',
    'src/server/index.ts',
    'src/server/index.js',
    'src/server/app.py',
    'server.py',
    'main.py',
  ];
  const patterns = [
    /PORT\s*\|\|\s*(\d{2,5})/,
    /PORT\s*\?\?\s*(\d{2,5})/,
    /listen\(\s*(\d{2,5})/,
    /localhost:(\d{2,5})/,
    /127\.0\.0\.1:(\d{2,5})/,
  ];

  for (const relativePath of candidates) {
    const absolutePath = path.join(repoPath, relativePath);
    if (!(await exists(absolutePath))) continue;
    const content = await fsp.readFile(absolutePath, 'utf8').catch(() => '');
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

export async function analyzeRepo(repoPath: string): Promise<RepoAnalysis> {
  const repoName = path.basename(repoPath);
  const foundFiles = new Set<string>();
  for (const relativePath of [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'Dockerfile',
    'docker-compose.yml',
    '.env',
    '.mcp.json',
    'README.md',
    'run.sh',
    'server.mjs',
    'server.js',
    'server.py',
    'main.py',
    'src-tauri/tauri.conf.json',
    'tauri.conf.json',
    'electron-builder.json',
    'electron.vite.config.js',
    'electron.vite.config.ts',
    'electron.vite.config.mjs',
    'wails.json',
    'index.html',
  ]) {
    if (await exists(path.join(repoPath, relativePath))) foundFiles.add(relativePath);
  }

  const packageJson = await readJsonFile<Record<string, unknown>>(path.join(repoPath, 'package.json'));
  const detectedKinds: string[] = [];
  if (foundFiles.has('package.json')) detectedKinds.push('node');
  if (foundFiles.has('pyproject.toml') || foundFiles.has('requirements.txt')) detectedKinds.push('python');
  if (foundFiles.has('Cargo.toml')) detectedKinds.push('rust');
  if (foundFiles.has('index.html') && !detectedKinds.includes('node')) detectedKinds.push('static-web');
  if (detectedKinds.length === 0) detectedKinds.push('unknown');

  const desktopKind = detectDesktopKind(packageJson, foundFiles);
  const inferredPort = await inferPort(repoPath);
  const startCommand = detectStartCommand(packageJson, foundFiles, detectedKinds);
  const openUrl = inferredPort ? `http://127.0.0.1:${inferredPort}` : null;
  const containerized = foundFiles.has('Dockerfile') || foundFiles.has('docker-compose.yml');

  const notes: string[] = [];
  if (!desktopKind) {
    notes.push('No Electron/Tauri/Wails desktop wrapper detected. This repo is Opseeq-connectable, but not desktop-packaged yet.');
  }
  if (foundFiles.has('index.html') && foundFiles.has('server.mjs')) {
    notes.push('Detected a local web application with a small Node server.');
  }
  if (!startCommand) {
    notes.push('No obvious start command was detected. Add run metadata or a launcher manifest before expecting one-click startup.');
  }
  if (containerized) {
    notes.push('Docker assets detected. For containerized apps, host.docker.internal should be preferred for host-local dependencies.');
  }

  return {
    repoName,
    repoPath,
    detectedKinds,
    containerized,
    desktopWrapper: { detected: desktopKind !== null, kind: desktopKind },
    runtime: { startCommand, inferredPort, openUrl },
    files: {
      hasPackageJson: foundFiles.has('package.json'),
      hasPyprojectToml: foundFiles.has('pyproject.toml'),
      hasRequirementsTxt: foundFiles.has('requirements.txt'),
      hasCargoToml: foundFiles.has('Cargo.toml'),
      hasDockerfile: foundFiles.has('Dockerfile'),
      hasDockerCompose: foundFiles.has('docker-compose.yml'),
      hasEnv: foundFiles.has('.env'),
      hasMcpJson: foundFiles.has('.mcp.json'),
      hasReadme: foundFiles.has('README.md'),
      hasRunScript: foundFiles.has('run.sh'),
    },
    notes,
  };
}

async function ensureEnvFile(repoPath: string, options: RepoConnectOptions): Promise<EnsuredFile> {
  const envPath = path.join(repoPath, '.env');
  const envVars = options.env ?? process.env;
  const opseeqUrl = normalizeUrl(options.opseeqUrl || envVars.OPSEEQ_SELF_URL || DEFAULT_OPSEEQ_URL);
  const anthropicApiKey = envVars.ANTHROPIC_API_KEY || '';
  const groupedEntries = [
    {
      title: '# Opseeq local services',
      entries: [
        ['OPENAI_BASE_URL', `${opseeqUrl}/v1`],
        ['OPSEEQ_URL', opseeqUrl],
        ['MERMATE_URL', DEFAULT_MERMATE_URL],
        ['SYNTHESIS_TRADE_URL', DEFAULT_SYNTH_URL],
      ],
    },
    {
      title: '# General-Clawd Anthropic passthrough',
      entries: anthropicApiKey
        ? [
            ['ANTHROPIC_API_KEY', anthropicApiKey],
            ['ANTHROPIC_BASE_URL', envVars.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL],
            ['ANTHROPIC_MODELS', envVars.ANTHROPIC_MODELS || DEFAULT_ANTHROPIC_MODELS],
          ]
        : [],
    },
  ];

  const warnings: string[] = [];
  const renderLines = (missingKeys: Set<string>) => {
    const lines: string[] = [];
    for (const group of groupedEntries) {
      const sectionEntries = group.entries.filter(([key]) => missingKeys.has(key));
      if (sectionEntries.length === 0) continue;
      if (lines.length > 0) lines.push('');
      lines.push(group.title, ...sectionEntries.map(([key, value]) => `${key}=${value}`));
    }
    return lines;
  };

  if (!(await exists(envPath))) {
    const allKeys = new Set(groupedEntries.flatMap((group) => group.entries.map(([key]) => key)));
    const lines = renderLines(allKeys);
    if (!options.dryRun) {
      await fsp.writeFile(envPath, `${lines.join('\n')}\n`, 'utf8');
    }
    return {
      check: { item: '.env', status: 'created', action: `Generated with ${[...allKeys].join(', ')}` },
      warnings,
    };
  }

  const existingContent = await fsp.readFile(envPath, 'utf8');
  const existingKeys = parseEnvKeys(existingContent);
  const missingKeys = new Set(
    groupedEntries.flatMap((group) => group.entries.map(([key]) => key)).filter((key) => !existingKeys.has(key)),
  );

  if (missingKeys.size === 0) {
    return { check: { item: '.env', status: 'found' }, warnings };
  }

  const appendLines = renderLines(missingKeys);
  if (!options.dryRun) {
    const separator = existingContent.endsWith('\n') ? '\n' : '\n\n';
    await fsp.appendFile(envPath, `${separator}${appendLines.join('\n')}\n`, 'utf8');
  }
  if (!anthropicApiKey && missingKeys.has('ANTHROPIC_API_KEY')) {
    warnings.push('Anthropic passthrough was skipped because ANTHROPIC_API_KEY is not configured in Opseeq.');
  }
  return {
    check: { item: '.env', status: 'updated', action: `Appended ${[...missingKeys].join(', ')}` },
    warnings,
  };
}

async function ensureMcpFile(repoPath: string, options: RepoConnectOptions): Promise<EnsuredFile> {
  const mcpPath = path.join(repoPath, '.mcp.json');
  const opseeqUrl = normalizeUrl(options.opseeqUrl || (options.env ?? process.env).OPSEEQ_SELF_URL || DEFAULT_OPSEEQ_URL);
  const mcpUrl = normalizeUrl(options.mcpUrl || `${opseeqUrl}/mcp`);
  const warnings: string[] = [];

  if (!(await exists(mcpPath))) {
    const payload = { mcpServers: { opseeq: { url: mcpUrl } } };
    if (!options.dryRun) {
      await fsp.writeFile(mcpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    return {
      check: { item: '.mcp.json', status: 'created', action: `Generated opseeq MCP target ${mcpUrl}` },
      warnings,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fsp.readFile(mcpPath, 'utf8')) as Record<string, unknown>;
  } catch {
    warnings.push('.mcp.json exists but is not valid JSON. Opseeq left it unchanged.');
    return { check: { item: '.mcp.json', status: 'warning', action: 'Existing file is invalid JSON' }, warnings };
  }

  const next = { ...parsed } as Record<string, unknown>;
  const mcpServers = typeof next.mcpServers === 'object' && next.mcpServers !== null && !Array.isArray(next.mcpServers)
    ? { ...(next.mcpServers as Record<string, unknown>) }
    : {};
  const currentOpseeq = typeof mcpServers.opseeq === 'object' && mcpServers.opseeq !== null && !Array.isArray(mcpServers.opseeq)
    ? { ...(mcpServers.opseeq as Record<string, unknown>) }
    : {};

  if (currentOpseeq.url === mcpUrl) {
    return { check: { item: '.mcp.json', status: 'found' }, warnings };
  }

  currentOpseeq.url = mcpUrl;
  mcpServers.opseeq = currentOpseeq;
  next.mcpServers = mcpServers;
  if (!options.dryRun) {
    await fsp.writeFile(mcpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  return {
    check: { item: '.mcp.json', status: 'updated', action: `Set opseeq MCP target to ${mcpUrl}` },
    warnings,
  };
}

export async function connectRepo(repoPath: string, options: RepoConnectOptions = {}): Promise<RepoConnectResult> {
  const envVars = options.env ?? process.env;
  const homeDir = path.resolve(options.homeDir || envVars.HOME || '/tmp');
  const resolved = path.resolve(repoPath);
  if (!isWithinRoot(resolved, homeDir)) {
    throw new RepoConnectError(`Path must be under ${homeDir}`);
  }

  let stat;
  try {
    stat = await fsp.lstat(resolved);
  } catch {
    throw new RepoConnectError(`Path not accessible: ${resolved}`, 404);
  }
  if (stat.isSymbolicLink()) throw new RepoConnectError('Symlinks are not allowed for repo roots');
  if (!stat.isDirectory()) throw new RepoConnectError(`Path is not a directory: ${resolved}`);

  const analysis = await analyzeRepo(resolved);
  const checks: RepoConnectCheck[] = [];
  const warnings = [...analysis.notes];

  checks.push({ item: 'project_kind', status: analysis.detectedKinds.join(', ') });
  checks.push({ item: 'desktop_wrapper', status: analysis.desktopWrapper.detected ? 'found' : 'missing', action: analysis.desktopWrapper.kind || 'web-only' });
  checks.push({ item: 'containerization', status: analysis.containerized ? 'detected' : 'not_detected' });
  checks.push({ item: 'start_command', status: analysis.runtime.startCommand ? 'detected' : 'missing', action: analysis.runtime.startCommand || undefined });
  if (analysis.runtime.openUrl) {
    checks.push({ item: 'app_url', status: 'detected', action: analysis.runtime.openUrl });
  }
  checks.push({ item: 'README.md', status: analysis.files.hasReadme ? 'found' : 'missing' });
  checks.push({ item: 'run.sh', status: analysis.files.hasRunScript ? 'found' : 'missing' });

  const envResult = await ensureEnvFile(resolved, options);
  checks.push(envResult.check);
  warnings.push(...envResult.warnings);

  const mcpResult = await ensureMcpFile(resolved, options);
  checks.push(mcpResult.check);
  warnings.push(...mcpResult.warnings);

  return {
    repoPath: resolved,
    analysis,
    checks,
    warnings: [...new Set(warnings)],
  };
}
