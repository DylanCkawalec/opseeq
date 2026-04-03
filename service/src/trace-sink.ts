import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GODMODE_ROOT = path.join(os.homedir(), '.opseeq-superior');
const ARTIFACT_ROOT = path.join(GODMODE_ROOT, 'artifacts');

export interface ImmutableArtifact<T = unknown> {
  id: string;
  taskId: string;
  kind: string;
  createdAt: string;
  hash: string;
  path: string;
  payload: T;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeValue(entry)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value), null, 2);
}

export function computePayloadHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function writeImmutableArtifact<T>(kind: string, taskId: string, payload: T): ImmutableArtifact<T> {
  ensureDir(ARTIFACT_ROOT);
  const createdAt = new Date().toISOString();
  const safeKind = kind.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'artifact';
  const safeTaskId = taskId.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'task';
  const id = `${safeKind}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const dirPath = path.join(ARTIFACT_ROOT, safeTaskId);
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `${id}.json`);
  const hash = computePayloadHash(payload);
  const artifact: ImmutableArtifact<T> = {
    id,
    taskId,
    kind,
    createdAt,
    hash,
    path: filePath,
    payload,
  };
  fs.writeFileSync(filePath, `${stableStringify(artifact)}\n`, { encoding: 'utf8', mode: 0o600 });
  return artifact;
}

export function listImmutableArtifacts(taskId?: string, limit = 20): ImmutableArtifact[] {
  ensureDir(ARTIFACT_ROOT);
  const roots = taskId
    ? [path.join(ARTIFACT_ROOT, taskId.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'task')]
    : fs.readdirSync(ARTIFACT_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(ARTIFACT_ROOT, entry.name));

  const artifacts: ImmutableArtifact[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(root, entry);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ImmutableArtifact;
        artifacts.push(parsed);
      } catch {
        continue;
      }
    }
  }

  return artifacts
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(0, limit));
}
