import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableArtifact } from './trace-sink.js';

const GODMODE_ROOT = path.join(os.homedir(), '.opseeq-superior');
const LOG_DIR = path.join(GODMODE_ROOT, 'logs');
const CAUSALITY_LOG = path.join(LOG_DIR, 'temporal-causality.jsonl');

export type TemporalActor = 'human' | 'nemoclaw' | 'mermate' | 'lucidity' | 'general-clawd' | 'opseeq';
export type TemporalKind = 'intent_received' | 'observe' | 'orient' | 'decide' | 'approve' | 'act' | 'validate' | 'meta_critique' | 'artifact_written' | 'graph_versioned';

export interface TemporalCausalityEvent {
  id: string;
  taskId: string;
  parentId: string | null;
  actor: TemporalActor;
  kind: TemporalKind;
  summary: string;
  timestamp: string;
  approvalState: 'not_required' | 'pending' | 'approved' | 'rejected';
  metadata: Record<string, unknown>;
}

export interface TemporalCausalityNode extends TemporalCausalityEvent {
  children: TemporalCausalityNode[];
}

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

export function appendTemporalEvent(input: Omit<TemporalCausalityEvent, 'id' | 'timestamp'>): TemporalCausalityEvent {
  ensureLogDir();
  const event: TemporalCausalityEvent = {
    ...input,
    id: `${input.kind}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(CAUSALITY_LOG, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  writeImmutableArtifact('temporal-causality-event', input.taskId, event);
  return event;
}

export function listTemporalEvents(taskId?: string, limit = 200): TemporalCausalityEvent[] {
  ensureLogDir();
  if (!fs.existsSync(CAUSALITY_LOG)) return [];
  const lines = fs.readFileSync(CAUSALITY_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
  const parsed: TemporalCausalityEvent[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as TemporalCausalityEvent;
      if (!taskId || event.taskId === taskId) parsed.push(event);
    } catch {
      continue;
    }
  }
  return parsed.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-Math.max(0, limit));
}

export function buildTemporalCausalityTree(taskId: string): TemporalCausalityNode[] {
  const events = listTemporalEvents(taskId, 1000);
  const byId = new Map<string, TemporalCausalityNode>();
  for (const event of events) {
    byId.set(event.id, { ...event, children: [] });
  }
  const roots: TemporalCausalityNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortTree = (nodes: TemporalCausalityNode[]): void => {
    nodes.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    for (const node of nodes) sortTree(node.children);
  };
  sortTree(roots);
  return roots;
}
