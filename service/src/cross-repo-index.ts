/**
 * @module cross-repo-index — Multi-repo filesystem scan → logical steps snapshot
 *
 * **Axiom A1 — Local-first** — Indexing reads only local paths under configured repo roots; no network.
 * **Axiom A2 — Bounded scan** — `DEFAULT_MAX_FILES`, `MAX_FILE_SIZE_BYTES`, and `SKIP_DIRS` cap work.
 * **Postulate P1 — Step detection** — `STEP_PATTERN` classifies leading lines into logical kinds for
 * `CrossRepoLogicalStepMatch`.
 * **Postulate P2 — Repo graph** — `ConnectedRepoRecord` carries contribution and env health metadata
 * for Living Architecture sync.
 * **Corollary C1 — Snapshot consumers** — `buildCrossRepoIndexSnapshot` is pure w.r.t. Opseeq graph
 * state; `living-architecture-graph` merges results and runs backlink inference.
 * **Lemma L1 — Determinism** — Same tree + env yields the same snapshot ordering for a given version.
 * **Behavioral contract** — Public types are stable; internal scan helpers may change for performance.
 * **Tracing invariant** — No persistent side effects except optional env backup paths when invoked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type CrossRepoLogicalStepKind = 'axiom' | 'postulate' | 'lemma' | 'corollary' | 'decision' | 'approval' | 'validation' | 'artifact' | 'service';
export type ConnectedRepoStatus = 'connected' | 'missing' | 'partial';

export interface EnvHealthRecord {
  repoId: string;
  envPath: string;
  exists: boolean;
  keyCount: number;
  lastModified: string | null;
  sizeBytes: number;
  backedUp: boolean;
  backupPath: string | null;
}

export interface LivingReference {
  label: string;
  href: string;
  repoId: string;
  repoPath: string;
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  direction: 'source' | 'backlink';
}

export interface ConnectedRepoRecord {
  id: string;
  label: string;
  path: string;
  status: ConnectedRepoStatus;
  color: string;
  priority: boolean;
  indexedFileCount: number;
  contributionCount: number;
  lastIndexedAt: string | null;
  envHealth: EnvHealthRecord | null;
}

export interface CrossRepoLogicalStepMatch {
  id: string;
  repoId: string;
  repoPath: string;
  kind: CrossRepoLogicalStepKind;
  label: string;
  description: string;
  tags: string[];
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  hyperlinks: LivingReference[];
}

export interface CrossRepoIndexSnapshot {
  repos: ConnectedRepoRecord[];
  steps: CrossRepoLogicalStepMatch[];
  indexedFiles: number;
  discoveredAt: string;
  priorityRepos: ConnectedRepoRecord[];
}

interface DiscoverReposOptions {
  rootPaths?: string[];
  repoPaths?: string[];
}

interface ScanRepoLogicalStepsOptions {
  maxFiles?: number;
}

const STEP_PATTERN = /^(axiom|postulate|lemma|corollary|decision|approval|validation|artifact|service)\b(?:\s*[:\-]\s*|\s+)(.*)$/i;
const EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.tla', '.yaml', '.yml', '.json']);
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'venv', '.venv', '__pycache__', 'target', 'out', 'tmp', 'logs']);
const MAX_FILE_SIZE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 320;
const KNOWN_REPO_NAMES = ['opseeq', 'mermate', 'mermaid', 'lucidity', 'general-clawd', 'general_clawd', 'synthesis-trade', 'synth'];
const PRIORITY_REPO_NAMES = new Set(['lucidity', 'mermaid', 'mermate']);
const PRIORITY_COLOR = '#FFD700';
const COLOR_PALETTE = ['#f5f7ff', '#e9fef5', '#fff6e9', '#f1ebff', '#ffeef3', '#edf7ff'];
const ENV_BACKUP_DIR = path.join(os.homedir(), '.opseeq-superior', 'env-backups');
const REDACTED_KEY_PATTERNS = [/API_KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /CREDENTIAL/i];

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function exists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function stableId(parts: string[]): string {
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function humanizeRepoLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'synthesis-trade' || lower === 'synth') return 'Synth';
  if (lower === 'opseeq') return 'Opseeq';
  if (lower === 'mermate' || lower === 'mermaid') return 'Mermate';
  if (lower === 'lucidity') return 'Lucidity';
  if (lower === 'general-clawd' || lower === 'general_clawd') return 'General-Clawd';
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isPriorityRepo(name: string): boolean {
  return PRIORITY_REPO_NAMES.has(name.toLowerCase());
}

function repoColor(id: string): string {
  const base = id.replace(/^repo-/, '');
  if (isPriorityRepo(base)) return PRIORITY_COLOR;
  let hash = 0;
  for (const char of id) hash = ((hash << 5) - hash) + char.charCodeAt(0);
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

function probeEnvHealth(repoPath: string, repoId: string): EnvHealthRecord {
  const envPath = path.join(repoPath, '.env');
  const backupPath = path.join(ENV_BACKUP_DIR, `${path.basename(repoPath)}.env.bak`);
  const record: EnvHealthRecord = {
    repoId,
    envPath,
    exists: false,
    keyCount: 0,
    lastModified: null,
    sizeBytes: 0,
    backedUp: false,
    backupPath: null,
  };
  try {
    const stat = fs.statSync(envPath);
    if (!stat.isFile()) return record;
    record.exists = true;
    record.sizeBytes = stat.size;
    record.lastModified = stat.mtime.toISOString();
    const content = fs.readFileSync(envPath, 'utf8');
    record.keyCount = content.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes('=');
    }).length;
    if (exists(backupPath)) {
      record.backedUp = true;
      record.backupPath = backupPath;
    }
  } catch {
    // .env not found or not readable
  }
  return record;
}

export function backupEnvFile(repoPath: string): { backed: boolean; backupPath: string } {
  const envPath = path.join(repoPath, '.env');
  const repoName = path.basename(repoPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(ENV_BACKUP_DIR, `${repoName}.env.${timestamp}.bak`);
  try {
    fs.mkdirSync(ENV_BACKUP_DIR, { recursive: true, mode: 0o700 });
    if (exists(envPath)) {
      fs.copyFileSync(envPath, backupPath);
      fs.chmodSync(backupPath, 0o600);
      return { backed: true, backupPath };
    }
  } catch {
    // backup failed silently
  }
  return { backed: false, backupPath };
}

export function getEnvKeySummary(repoPath: string): Array<{ key: string; redacted: boolean }> {
  const envPath = path.join(repoPath, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    return content.split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes('=');
      })
      .map((line) => {
        const key = line.split('=')[0].trim();
        const redacted = REDACTED_KEY_PATTERNS.some((pattern) => pattern.test(key));
        return { key, redacted };
      });
  } catch {
    return [];
  }
}

function repoCandidatePaths(options: DiscoverReposOptions = {}): string[] {
  const cwdRoot = path.resolve(process.cwd(), '..');
  const developerRoot = path.join(os.homedir(), 'Desktop', 'developer');
  const envRoots = String(process.env.OPSEEQ_REPO_ROOTS || '').split(path.delimiter);
  const configuredRepos = [
    process.env.OPSEEQ_ROOT,
    process.env.MERMATE_REPO,
    process.env.LUCIDITY_REPO,
    // NOTE: GENERAL_CLAWD_ROOT bridge eliminated — execution runtime absorbed into Opseeq
    process.env.SYNTH_REPO,
    process.env.SYNTHESIS_TRADE_REPO,
    process.env.SYNTHESIS_TRADE_ROOT,
  ];
  const roots = uniqueStrings([...(options.rootPaths || []), ...envRoots, developerRoot, cwdRoot]);
  const explicit = uniqueStrings([...(options.repoPaths || []), ...configuredRepos]);
  const discovered: string[] = [];
  for (const repoPath of explicit) {
    if (isDirectory(repoPath)) discovered.push(normalizePath(repoPath));
  }
  for (const rootPath of roots) {
    if (!isDirectory(rootPath)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(rootPath, entry.name);
      const normalizedName = entry.name.toLowerCase();
      const looksLikeRepo = KNOWN_REPO_NAMES.includes(normalizedName)
        || exists(path.join(entryPath, '.git'))
        || exists(path.join(entryPath, 'package.json'))
        || exists(path.join(entryPath, 'pyproject.toml'))
        || exists(path.join(entryPath, 'Cargo.toml'));
      if (looksLikeRepo) discovered.push(normalizePath(entryPath));
    }
  }
  return uniqueStrings(discovered);
}

export function discoverConnectedRepos(options: DiscoverReposOptions = {}): ConnectedRepoRecord[] {
  return repoCandidatePaths(options)
    .map((repoPath) => {
      const base = path.basename(repoPath);
      const id = stableId(['repo', base]);
      const priority = isPriorityRepo(base);
      return {
        id,
        label: humanizeRepoLabel(base),
        path: repoPath,
        status: isDirectory(repoPath) ? 'connected' : 'missing',
        color: repoColor(base),
        priority,
        indexedFileCount: 0,
        contributionCount: 0,
        lastIndexedAt: null,
        envHealth: priority ? probeEnvHealth(repoPath, id) : null,
      } satisfies ConnectedRepoRecord;
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority ? -1 : 1;
      return left.label.localeCompare(right.label);
    });
}

function shouldScanFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return base === 'readme' || base === 'readme.md' || base === 'readme.txt';
}

function normalizeStepCandidate(line: string): string {
  return line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(?:\/\/+|#|\/\*+|\*+|<!--)\s*/, '')
    .replace(/\s*(?:\*\/|-->)\s*$/, '')
    .trim();
}

function buildFileHref(filePath: string, startLine: number, endLine: number): string {
  const base = pathToFileURL(filePath).toString();
  return `${base}#L${startLine}${endLine > startLine ? `-L${endLine}` : ''}`;
}

function extractLogicalStepMatches(repo: ConnectedRepoRecord, filePath: string): CrossRepoLogicalStepMatch[] {
  let content = '';
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) return [];
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const relativePath = path.relative(repo.path, filePath) || path.basename(filePath);
  const lines = content.split(/\r?\n/);
  const matches: CrossRepoLogicalStepMatch[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const candidate = normalizeStepCandidate(lines[index]);
    const match = candidate.match(STEP_PATTERN);
    if (!match) continue;
    const kind = match[1].toLowerCase() as CrossRepoLogicalStepKind;
    const rawLabel = match[2]?.trim() || `${humanizeRepoLabel(kind)} in ${relativePath}`;
    const descriptionLines: string[] = [];
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
      const next = normalizeStepCandidate(lines[cursor]);
      if (!next) {
        if (descriptionLines.length > 0) break;
        continue;
      }
      if (STEP_PATTERN.test(next)) break;
      descriptionLines.push(next);
    }
    const endLine = index + Math.max(1, descriptionLines.length + 1);
    const href = buildFileHref(filePath, index + 1, endLine);
    matches.push({
      id: stableId([repo.id, relativePath, kind, rawLabel, String(index + 1)]),
      repoId: repo.id,
      repoPath: repo.path,
      kind,
      label: rawLabel,
      description: descriptionLines.join(' ') || `${humanizeRepoLabel(kind)} declared in ${relativePath}`,
      tags: uniqueStrings([repo.label.toLowerCase(), repo.id, kind, relativePath.split(path.sep)[0]]),
      filePath,
      relativePath,
      startLine: index + 1,
      endLine,
      hyperlinks: [{
        label: `${repo.label} · ${relativePath}`,
        href,
        repoId: repo.id,
        repoPath: repo.path,
        filePath,
        relativePath,
        startLine: index + 1,
        endLine,
        direction: 'source',
      }],
    });
  }

  return matches;
}

function walkRepoFiles(repoPath: string, maxFiles: number): string[] {
  const queue = [repoPath];
  const files: string[] = [];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldScanFile(entryPath)) files.push(entryPath);
    }
  }

  return files;
}

export function scanRepoLogicalSteps(repo: ConnectedRepoRecord, options: ScanRepoLogicalStepsOptions = {}): { repo: ConnectedRepoRecord; steps: CrossRepoLogicalStepMatch[]; indexedFiles: number } {
  if (!isDirectory(repo.path)) {
    return {
      repo: { ...repo, status: 'missing', indexedFileCount: 0, contributionCount: 0, lastIndexedAt: new Date().toISOString() },
      steps: [],
      indexedFiles: 0,
    };
  }

  const files = walkRepoFiles(repo.path, options.maxFiles ?? DEFAULT_MAX_FILES);
  const steps = files.flatMap((filePath) => extractLogicalStepMatches(repo, filePath));
  return {
    repo: {
      ...repo,
      status: steps.length === 0 ? 'partial' : 'connected',
      indexedFileCount: files.length,
      contributionCount: steps.length,
      lastIndexedAt: new Date().toISOString(),
    },
    steps,
    indexedFiles: files.length,
  };
}

export function buildCrossRepoIndexSnapshot(options: DiscoverReposOptions & ScanRepoLogicalStepsOptions = {}): CrossRepoIndexSnapshot {
  const repos = discoverConnectedRepos(options);
  let indexedFiles = 0;
  const priorityFirst = [...repos].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  const indexed = priorityFirst.map((repo) => scanRepoLogicalSteps(repo, {
    ...options,
    maxFiles: repo.priority ? Math.max(options.maxFiles ?? DEFAULT_MAX_FILES, 500) : (options.maxFiles ?? DEFAULT_MAX_FILES),
  }));
  const steps = indexed.flatMap((entry) => entry.steps);
  indexedFiles = indexed.reduce((total, entry) => total + entry.indexedFiles, 0);
  const finalRepos = indexed.map((entry) => entry.repo);
  return {
    repos: finalRepos,
    steps,
    indexedFiles,
    discoveredAt: new Date().toISOString(),
    priorityRepos: finalRepos.filter((repo) => repo.priority),
  };
}

export function searchCrossRepoSteps(
  snapshot: CrossRepoIndexSnapshot,
  query: string,
  options: { repoId?: string; kind?: CrossRepoLogicalStepKind; limit?: number } = {},
): CrossRepoLogicalStepMatch[] {
  const normalized = query.toLowerCase().trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const limit = Math.min(options.limit ?? 50, 200);
  return snapshot.steps
    .filter((step) => {
      if (options.repoId && step.repoId !== options.repoId) return false;
      if (options.kind && step.kind !== options.kind) return false;
      if (words.length === 0) return true;
      const haystack = `${step.label} ${step.description} ${step.tags.join(' ')}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .slice(0, limit);
}
