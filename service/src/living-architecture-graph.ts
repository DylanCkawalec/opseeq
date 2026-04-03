import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePayloadHash, writeImmutableArtifact } from './trace-sink.js';

const GODMODE_ROOT = path.join(os.homedir(), '.opseeq-superior');
const GRAPH_FILE = path.join(GODMODE_ROOT, 'living-architecture-graph.json');

export type LivingNodeKind = 'intent' | 'axiom' | 'postulate' | 'lemma' | 'corollary' | 'service' | 'artifact' | 'decision' | 'approval' | 'validation' | 'extension';
export type LivingEdgeRelation = 'informs' | 'constrains' | 'derives' | 'produces' | 'validates' | 'approves' | 'criticizes' | 'routes_to';

export interface LivingArchitectureNode {
  id: string;
  kind: LivingNodeKind;
  label: string;
  description: string;
  version: number;
  tags: string[];
  updatedAt: string;
}

export interface LivingArchitectureEdge {
  id: string;
  from: string;
  to: string;
  relation: LivingEdgeRelation;
  rationale: string;
  createdAt: string;
}

export interface LivingArchitectureVersion {
  id: string;
  taskId: string;
  createdAt: string;
  summary: string;
  nodeCount: number;
  edgeCount: number;
  hash: string;
}

export interface LivingArchitectureGraph {
  generatedAt: string;
  nodes: LivingArchitectureNode[];
  edges: LivingArchitectureEdge[];
  versions: LivingArchitectureVersion[];
}

interface SyncGraphInput {
  taskId: string;
  intent: string;
  appId?: string | null;
  extensionIds: string[];
  planSteps: string[];
  critiqueSummary: string;
}

function ensureGraphDir(): void {
  fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true, mode: 0o700 });
}

function loadGraph(): LivingArchitectureGraph {
  ensureGraphDir();
  if (!fs.existsSync(GRAPH_FILE)) {
    return { generatedAt: new Date().toISOString(), nodes: [], edges: [], versions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')) as LivingArchitectureGraph;
  } catch {
    return { generatedAt: new Date().toISOString(), nodes: [], edges: [], versions: [] };
  }
}

function saveGraph(graph: LivingArchitectureGraph): void {
  ensureGraphDir();
  fs.writeFileSync(GRAPH_FILE, `${JSON.stringify(graph, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function stableId(parts: string[]): string {
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function upsertNode(graph: LivingArchitectureGraph, input: Omit<LivingArchitectureNode, 'version' | 'updatedAt'>): LivingArchitectureNode {
  const now = new Date().toISOString();
  const existing = graph.nodes.find((node) => node.id === input.id);
  if (existing) {
    existing.label = input.label;
    existing.description = input.description;
    existing.tags = [...new Set(input.tags)].sort();
    existing.updatedAt = now;
    existing.version += 1;
    return existing;
  }
  const node: LivingArchitectureNode = { ...input, version: 1, updatedAt: now, tags: [...new Set(input.tags)].sort() };
  graph.nodes.push(node);
  return node;
}

function addEdge(graph: LivingArchitectureGraph, input: Omit<LivingArchitectureEdge, 'id' | 'createdAt'>): LivingArchitectureEdge {
  const existing = graph.edges.find((edge) => edge.from === input.from && edge.to === input.to && edge.relation === input.relation && edge.rationale === input.rationale);
  if (existing) return existing;
  const edge: LivingArchitectureEdge = {
    ...input,
    id: stableId([input.from, input.relation, input.to, String(graph.edges.length + 1)]),
    createdAt: new Date().toISOString(),
  };
  graph.edges.push(edge);
  return edge;
}

function ensureLawNodes(graph: LivingArchitectureGraph): void {
  const laws = [
    ['axiom-language-model-policy', 'axiom', 'Language model is policy layer', 'Opseeq law: the model is the policy layer, not the system.'],
    ['axiom-human-invariants', 'axiom', 'Human invariants are supreme', 'Human-authored axioms, postulates, corollaries, and lemmas are immutable foundations.'],
    ['axiom-local-first', 'axiom', 'Local-first execution', 'In-trust planning and control remain local by default.'],
    ['corollary-explicit-approval', 'corollary', 'Explicit approval before effectful execution', 'Permission escalation is explicit and auditable.'],
  ] as const;
  for (const [id, kind, label, description] of laws) {
    upsertNode(graph, { id, kind, label, description, tags: ['whitepaper-law', 'godmode'] });
  }
}

export function getLivingArchitectureGraph(): LivingArchitectureGraph {
  return loadGraph();
}

export function syncLivingArchitectureGraph(input: SyncGraphInput): { graph: LivingArchitectureGraph; version: LivingArchitectureVersion; diagram: string } {
  const graph = loadGraph();
  ensureLawNodes(graph);

  const intentNode = upsertNode(graph, {
    id: stableId(['intent', input.taskId]),
    kind: 'intent',
    label: `Intent ${input.taskId}`,
    description: input.intent,
    tags: ['task', input.taskId, input.appId || 'generic'],
  });

  const services = [
    { id: 'service-nemoclaw', label: 'Nemoclaw', description: 'Ultimate OODA orchestrator.' },
    { id: 'service-mermate', label: 'Mermate', description: 'Canonical god-level architecture generator.' },
    { id: 'service-lucidity', label: 'Lucidity', description: 'Visual and semantic cleanup layer.' },
    { id: 'service-general-clawd', label: 'General-Clawd', description: 'Execution worker inside approved envelopes.' },
  ] as const;

  for (const service of services) {
    upsertNode(graph, { id: service.id, kind: 'service', label: service.label, description: service.description, tags: ['service', 'godmode'] });
    addEdge(graph, { from: intentNode.id, to: service.id, relation: 'informs', rationale: 'The task routes through the God-mode pipeline.' });
  }

  const planNode = upsertNode(graph, {
    id: stableId(['artifact', input.taskId, 'plan']),
    kind: 'artifact',
    label: `Plan ${input.taskId}`,
    description: input.planSteps.join(' '),
    tags: ['artifact', 'plan', input.taskId],
  });
  addEdge(graph, { from: intentNode.id, to: planNode.id, relation: 'produces', rationale: 'Nemoclaw materializes the intent into a plan artifact.' });
  addEdge(graph, { from: 'service-nemoclaw', to: planNode.id, relation: 'produces', rationale: 'Nemoclaw authors the approved planning artifact.' });

  const critiqueNode = upsertNode(graph, {
    id: stableId(['artifact', input.taskId, 'meta-critique']),
    kind: 'artifact',
    label: `Meta-Critique ${input.taskId}`,
    description: input.critiqueSummary,
    tags: ['artifact', 'critique', input.taskId],
  });
  addEdge(graph, { from: planNode.id, to: critiqueNode.id, relation: 'criticizes', rationale: 'The self-reflective loop critiques the plan before handoff.' });

  for (const extensionId of input.extensionIds) {
    const extensionNode = upsertNode(graph, {
      id: stableId(['extension', extensionId]),
      kind: 'extension',
      label: extensionId,
      description: `Extension pack ${extensionId}`,
      tags: ['extension'],
    });
    addEdge(graph, { from: extensionNode.id, to: 'service-mermate', relation: 'routes_to', rationale: 'Extension pack influences stage routing.' });
    addEdge(graph, { from: extensionNode.id, to: 'service-lucidity', relation: 'routes_to', rationale: 'Extension pack influences cleanup and comparison.' });
  }

  const graphPayload = { nodes: graph.nodes, edges: graph.edges };
  const version: LivingArchitectureVersion = {
    id: stableId(['version', input.taskId, String(graph.versions.length + 1)]),
    taskId: input.taskId,
    createdAt: new Date().toISOString(),
    summary: `Living Architecture Graph updated for ${input.taskId}`,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    hash: computePayloadHash(graphPayload),
  };
  graph.versions.push(version);
  graph.generatedAt = new Date().toISOString();
  saveGraph(graph);
  writeImmutableArtifact('living-architecture-graph', input.taskId, { version, graph });

  return { graph, version, diagram: renderLivingArchitectureGraphText(graph, input.taskId) };
}

export function renderLivingArchitectureGraphText(graph: LivingArchitectureGraph, taskId?: string): string {
  const lines = ['Living Architecture Graph'];
  const scopedIntent = taskId ? graph.nodes.find((node) => node.id === stableId(['intent', taskId])) : null;
  if (scopedIntent) {
    lines.push(`- ${scopedIntent.label}`);
    const scopedEdges = graph.edges.filter((edge) => edge.from === scopedIntent.id);
    for (const edge of scopedEdges) {
      const target = graph.nodes.find((node) => node.id === edge.to);
      lines.push(`  -> [${edge.relation}] ${target?.label || edge.to}`);
    }
  } else {
    for (const node of graph.nodes.filter((entry) => entry.kind === 'service')) {
      lines.push(`- ${node.label}`);
    }
  }
  lines.push('Law Spine:');
  for (const node of graph.nodes.filter((entry) => entry.kind === 'axiom' || entry.kind === 'corollary')) {
    lines.push(`- ${node.label}`);
  }
  return lines.join('\n');
}
