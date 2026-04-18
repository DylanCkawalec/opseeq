// @service/src/living-architecture-graph.ts
/**
 * @module living-architecture-graph
 *
 * ## Role
 * Persists and queries the **Living Architecture Graph**: typed nodes and edges plus cross-repo index
 * integration. The JSON file under `~/.opseeq-superior/` is the on-disk source of truth for this
 * process; `syncLivingArchitectureGraph` and `refreshLivingArchitectureGraphIndex` read-modify-write
 * that file atomically at the **file** level (single `writeFileSync` per save).
 *
 * ## Alignment (Opseeq-wide)
 * - **Precision Orchestration**: `syncLivingArchitectureGraph` materializes intent, plan artifacts,
 *   critique, extensions, and stage results into the graph and emits an immutable trace artifact.
 * - **Mermate / Lucidity**: Service nodes and `routes_to` edges encode default routing; real HTTP work
 *   stays in those services—this module only records structure.
 * - **General-Clawd / Windsurf**: Execution surfaces appear as `service-general-clawd` and repo/stage
 *   nodes; no sandbox calls occur here.
 *
 * -------------------------------------------------------------------------------------------------
 * ### Operational vocabulary
 *
 * **Axiom A5 — Provenance store**
 * For a given Opseeq runtime, the serialized graph is authoritative for what was last recorded;
 * concurrent writers are not coordinated—callers should serialize high-level sync operations.
 *
 * **Postulate P3 — Node kinds**
 * Every node has a `LivingNodeKind`; unknown kinds from disk normalize to `'artifact'`.
 *
 * **Postulate P4 — Edges**
 * Edges carry `LivingEdgeRelation` and free-text `rationale`; duplicate edges (same from/to/relation/rationale)
 * are collapsed by `addEdge`.
 *
 * **Corollary C3 — Version rows**
 * Each `buildVersion` appends a `LivingArchitectureVersion` with a content hash over a payload subset;
 * history is append-only in memory until trimmed elsewhere (this module never prunes versions).
 *
 * **Lemma L2 — Cross-repo backlinks**
 * Pairs of index steps with `scoreCrossRepoLink >= BACKLINK_PAIR_MIN_SCORE` exchange up to
 * `MAX_BACKLINKS_PER_STEP` references per step id; Lucidity/Mermate priority is implicit in index order,
 * not re-sorted here.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCrossRepoIndexSnapshot, type ConnectedRepoRecord, type CrossRepoLogicalStepMatch, type LivingReference } from './cross-repo-index.js';
import { computePayloadHash, writeImmutableArtifact } from './trace-sink.js';

// ── Paths & lexical constants ───────────────────────────────────────────────────────────────────

const PRECISION_ROOT = path.join(os.homedir(), '.opseeq-superior');
const GRAPH_FILE = path.join(PRECISION_ROOT, 'living-architecture-graph.json');

/** Stop words excluded from keyword overlap scoring (length ≥ 4 tokens only participate). */
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'over', 'under', 'that', 'this', 'task', 'plan', 'graph', 'repo', 'step', 'stage', 'local', 'first', 'mode']);

/** Minimum `scoreCrossRepoLink` to create a mutual backlink pair. */
const BACKLINK_PAIR_MIN_SCORE = 3;

/** Cap on stored opposing-step backlinks per step id during `buildBacklinks`. */
const MAX_BACKLINKS_PER_STEP = 6;

/**
 * **Corollary C5 — Pairwise phase bound** — Inverted-index + label-bucket backlink scoring runs on at
 * most this many steps (deterministic prefix of `snapshot.steps`) so pathological repos cannot block
 * the event loop. Steps beyond the cap still sync as graph nodes; only mutual backlink *inference*
 * among excluded pairs is skipped.
 */
const BACKLINK_PAIRWISE_STEP_CAP = 500;

const QUERY_DEFAULT_LIMIT = 24;
const QUERY_MAX_LIMIT = 100;

const DASHBOARD_FOCUS_NODE_LIMIT = 10;
const DASHBOARD_VERSION_SLICE = 8;
const DASHBOARD_BACKLINK_SLICE = 16;
const DIAGRAM_REPO_SLICE = 8;
const DIAGRAM_BACKLINK_SLICE = 8;
const DIAGRAM_INTENT_EDGE_SLICE = 12;

/**
 * **Lemma L3 — Disk↔RAM coherence** — `graphDiskCache` holds `{ mtimeMs, graph }` so repeated
 * `loadGraph()` calls avoid `JSON.parse` when the file is unchanged.
 * **Lemma L4 — Index coherence** — `graphIndexes` maps each live `LivingArchitectureGraph` object
 * to O(1) node/edge dedupe structures; invalidated when `rebuildIndexesFromGraph` runs.
 */
let graphDiskCache: { mtimeMs: number; graph: LivingArchitectureGraph } | null = null;

const graphIndexes = new WeakMap<
  LivingArchitectureGraph,
  {
    nodesById: Map<string, LivingArchitectureNode>;
    edgeKeyToEdge: Map<string, LivingArchitectureEdge>;
  }
>();

function edgeDedupeKey(e: { from: string; to: string; relation: string; rationale: string }): string {
  return `${e.from}\0${e.to}\0${e.relation}\0${e.rationale}`;
}

function rebuildIndexesFromGraph(graph: LivingArchitectureGraph): void {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeKeyToEdge = new Map<string, LivingArchitectureEdge>();
  for (const e of graph.edges) edgeKeyToEdge.set(edgeDedupeKey(e), e);
  graphIndexes.set(graph, { nodesById, edgeKeyToEdge });
}

function ensureGraphIndexes(graph: LivingArchitectureGraph): {
  nodesById: Map<string, LivingArchitectureNode>;
  edgeKeyToEdge: Map<string, LivingArchitectureEdge>;
} {
  let ix = graphIndexes.get(graph);
  if (!ix) {
    rebuildIndexesFromGraph(graph);
    ix = graphIndexes.get(graph)!;
  }
  return ix;
}

// ── Public domain types ─────────────────────────────────────────────────────────────────────────

export type LivingNodeKind = 'intent' | 'axiom' | 'postulate' | 'lemma' | 'corollary' | 'service' | 'artifact' | 'decision' | 'approval' | 'validation' | 'extension' | 'repo' | 'stage';
export type LivingEdgeRelation = 'informs' | 'constrains' | 'derives' | 'produces' | 'validates' | 'approves' | 'criticizes' | 'routes_to' | 'references' | 'belongs_to' | 'executes';

export interface LivingArchitectureNode {
  id: string;
  kind: LivingNodeKind;
  label: string;
  description: string;
  version: number;
  tags: string[];
  updatedAt: string;
  repoId?: string | null;
  repoPath?: string | null;
  sourcePath?: string | null;
  sourceStartLine?: number | null;
  sourceEndLine?: number | null;
  hyperlinks?: LivingReference[];
  metadata?: Record<string, unknown>;
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
  repoCount: number;
  stepCount: number;
}

export interface LivingArchitectureGraph {
  generatedAt: string;
  nodes: LivingArchitectureNode[];
  edges: LivingArchitectureEdge[];
  versions: LivingArchitectureVersion[];
  repos: ConnectedRepoRecord[];
  backlinks: LivingReference[];
}

/** Input to `syncLivingArchitectureGraph` (not exported—callers use the function). */
interface SyncGraphInput {
  taskId: string;
  intent: string;
  appId?: string | null;
  repoPath?: string | null;
  extensionIds: string[];
  planSteps: string[];
  critiqueSummary: string;
  stageResults?: Array<{
    stage: string;
    service: string;
    status: string;
    summary: string;
    details?: Record<string, unknown>;
  }>;
}

export interface LivingArchitectureQueryOptions {
  query?: string;
  repoId?: string;
  taskId?: string;
  kind?: LivingNodeKind | 'all';
  limit?: number;
  includeBacklinks?: boolean;
}

export interface LivingArchitectureQueryResult {
  generatedAt: string;
  totals: {
    nodes: number;
    edges: number;
    repos: number;
    versions: number;
    backlinks: number;
  };
  repos: ConnectedRepoRecord[];
  nodes: LivingArchitectureNode[];
  edges: LivingArchitectureEdge[];
  backlinks: LivingReference[];
}

export interface LivingArchitectureNodeSnapshot {
  node: LivingArchitectureNode | null;
  inbound: LivingArchitectureEdge[];
  outbound: LivingArchitectureEdge[];
  relatedNodes: LivingArchitectureNode[];
}

export interface LivingArchitectureDashboard {
  generatedAt: string;
  summary: {
    repoCount: number;
    nodeCount: number;
    edgeCount: number;
    versionCount: number;
    backlinkCount: number;
    taskCount: number;
    stageCount: number;
  };
  repos: ConnectedRepoRecord[];
  focusNodes: LivingArchitectureNode[];
  recentVersions: LivingArchitectureVersion[];
  backlinks: LivingReference[];
  diagram: string;
}

export interface LivingArchitectureRefreshResult {
  graph: LivingArchitectureGraph;
  version: LivingArchitectureVersion | null;
  diagram: string;
}

// ── Empty graph & persistence helpers ───────────────────────────────────────────────────────────

function emptyGraph(): LivingArchitectureGraph {
  return {
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    versions: [],
    repos: [],
    backlinks: [],
  };
}

function ensureGraphDir(): void {
  fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true, mode: 0o700 });
}

function stableId(parts: string[]): string {
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function dedupeReferences(references: LivingReference[] = []): LivingReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.direction}:${reference.repoId}:${reference.filePath}:${reference.startLine}:${reference.endLine}:${reference.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function keywordSet(values: string[]): Set<string> {
  const words = values
    .flatMap((value) => normalizeSearchText(value).split(/\s+/))
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return new Set(words);
}

function normalizeRepoRecord(repo: Partial<ConnectedRepoRecord>): ConnectedRepoRecord {
  return {
    id: String(repo.id || stableId(['repo', repo.label || repo.path || 'unknown'])),
    label: String(repo.label || path.basename(String(repo.path || 'repo'))),
    path: String(repo.path || ''),
    status: repo.status === 'missing' || repo.status === 'partial' ? repo.status : 'connected',
    color: String(repo.color || '#f5f7ff'),
    priority: Boolean(repo.priority),
    indexedFileCount: Number(repo.indexedFileCount || 0),
    contributionCount: Number(repo.contributionCount || 0),
    lastIndexedAt: typeof repo.lastIndexedAt === 'string' ? repo.lastIndexedAt : null,
    envHealth: repo.envHealth ?? null,
  };
}

function normalizeNode(node: Partial<LivingArchitectureNode>): LivingArchitectureNode {
  const now = new Date().toISOString();
  return {
    id: String(node.id || stableId(['node', node.label || 'unknown'])),
    kind: (node.kind as LivingNodeKind) || 'artifact',
    label: String(node.label || node.id || 'Untitled node'),
    description: String(node.description || ''),
    version: Number(node.version || 1),
    tags: uniqueStrings(Array.isArray(node.tags) ? node.tags.map((tag) => String(tag)) : []),
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : now,
    repoId: typeof node.repoId === 'string' ? node.repoId : null,
    repoPath: typeof node.repoPath === 'string' ? node.repoPath : null,
    sourcePath: typeof node.sourcePath === 'string' ? node.sourcePath : null,
    sourceStartLine: typeof node.sourceStartLine === 'number' ? node.sourceStartLine : null,
    sourceEndLine: typeof node.sourceEndLine === 'number' ? node.sourceEndLine : null,
    hyperlinks: dedupeReferences(Array.isArray(node.hyperlinks) ? node.hyperlinks : []),
    metadata: typeof node.metadata === 'object' && node.metadata !== null ? node.metadata as Record<string, unknown> : {},
  };
}

function normalizeEdge(edge: Partial<LivingArchitectureEdge>, index: number): LivingArchitectureEdge {
  return {
    id: String(edge.id || stableId([String(edge.from || 'node'), String(edge.relation || 'references'), String(edge.to || 'node'), String(index + 1)])),
    from: String(edge.from || ''),
    to: String(edge.to || ''),
    relation: (edge.relation as LivingEdgeRelation) || 'references',
    rationale: String(edge.rationale || ''),
    createdAt: typeof edge.createdAt === 'string' ? edge.createdAt : new Date().toISOString(),
  };
}

function normalizeVersion(version: Partial<LivingArchitectureVersion>): LivingArchitectureVersion {
  return {
    id: String(version.id || stableId(['version', version.taskId || 'graph', String(Date.now())])),
    taskId: String(version.taskId || 'graph-refresh'),
    createdAt: typeof version.createdAt === 'string' ? version.createdAt : new Date().toISOString(),
    summary: String(version.summary || 'Living Architecture Graph updated'),
    nodeCount: Number(version.nodeCount || 0),
    edgeCount: Number(version.edgeCount || 0),
    hash: String(version.hash || 'sha256:unknown'),
    repoCount: Number(version.repoCount || 0),
    stepCount: Number(version.stepCount || 0),
  };
}

/**
 * Loads and normalizes the graph from disk, or returns an empty graph if missing/invalid.
 *
 * **Failure mode:** Parse errors yield `emptyGraph()` (no throw).
 */
function loadGraph(): LivingArchitectureGraph {
  ensureGraphDir();
  if (!fs.existsSync(GRAPH_FILE)) {
    graphDiskCache = null;
    return emptyGraph();
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(GRAPH_FILE);
  } catch {
    graphDiskCache = null;
    return emptyGraph();
  }
  if (graphDiskCache && graphDiskCache.mtimeMs === st.mtimeMs) {
    return graphDiskCache.graph;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')) as Partial<LivingArchitectureGraph>;
    const graph: LivingArchitectureGraph = {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.map((node) => normalizeNode(node)) : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges.map((edge, index) => normalizeEdge(edge, index)) : [],
      versions: Array.isArray(parsed.versions) ? parsed.versions.map((version) => normalizeVersion(version)) : [],
      repos: Array.isArray(parsed.repos) ? parsed.repos.map((repo) => normalizeRepoRecord(repo)) : [],
      backlinks: dedupeReferences(Array.isArray(parsed.backlinks) ? parsed.backlinks : []),
    };
    rebuildIndexesFromGraph(graph);
    graphDiskCache = { mtimeMs: st.mtimeMs, graph };
    return graph;
  } catch {
    graphDiskCache = null;
    return emptyGraph();
  }
}

/** Writes the full graph JSON with mode `0o600`. */
function saveGraph(graph: LivingArchitectureGraph): void {
  ensureGraphDir();
  fs.writeFileSync(GRAPH_FILE, `${JSON.stringify(graph, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  rebuildIndexesFromGraph(graph);
  try {
    const st = fs.statSync(GRAPH_FILE);
    graphDiskCache = { mtimeMs: st.mtimeMs, graph };
  } catch {
    graphDiskCache = null;
  }
}

function upsertNode(graph: LivingArchitectureGraph, input: Omit<LivingArchitectureNode, 'version' | 'updatedAt'>): LivingArchitectureNode {
  const ix = ensureGraphIndexes(graph);
  const now = new Date().toISOString();
  const existing = ix.nodesById.get(input.id);
  if (existing) {
    existing.kind = input.kind;
    existing.label = input.label;
    existing.description = input.description;
    existing.tags = uniqueStrings([...(existing.tags || []), ...(input.tags || [])]).sort();
    existing.updatedAt = now;
    existing.version += 1;
    existing.repoId = input.repoId ?? existing.repoId ?? null;
    existing.repoPath = input.repoPath ?? existing.repoPath ?? null;
    existing.sourcePath = input.sourcePath ?? existing.sourcePath ?? null;
    existing.sourceStartLine = input.sourceStartLine ?? existing.sourceStartLine ?? null;
    existing.sourceEndLine = input.sourceEndLine ?? existing.sourceEndLine ?? null;
    existing.hyperlinks = dedupeReferences([...(existing.hyperlinks || []), ...(input.hyperlinks || [])]);
    existing.metadata = { ...(existing.metadata || {}), ...(input.metadata || {}) };
    return existing;
  }
  const node: LivingArchitectureNode = {
    ...input,
    version: 1,
    updatedAt: now,
    tags: uniqueStrings(input.tags).sort(),
    repoId: input.repoId ?? null,
    repoPath: input.repoPath ?? null,
    sourcePath: input.sourcePath ?? null,
    sourceStartLine: input.sourceStartLine ?? null,
    sourceEndLine: input.sourceEndLine ?? null,
    hyperlinks: dedupeReferences(input.hyperlinks || []),
    metadata: { ...(input.metadata || {}) },
  };
  graph.nodes.push(node);
  ix.nodesById.set(node.id, node);
  return node;
}

function addEdge(graph: LivingArchitectureGraph, input: Omit<LivingArchitectureEdge, 'id' | 'createdAt'>): LivingArchitectureEdge {
  const ix = ensureGraphIndexes(graph);
  const k = edgeDedupeKey(input);
  const existing = ix.edgeKeyToEdge.get(k);
  if (existing) return existing;
  const edge: LivingArchitectureEdge = {
    ...input,
    id: stableId([input.from, input.relation, input.to, String(graph.edges.length + 1)]),
    createdAt: new Date().toISOString(),
  };
  graph.edges.push(edge);
  ix.edgeKeyToEdge.set(k, edge);
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
    upsertNode(graph, { id, kind, label, description, tags: ['whitepaper-law', 'precision-orchestration'], metadata: {} });
  }
}

function scoreCrossRepoLink(left: CrossRepoLogicalStepMatch, right: CrossRepoLogicalStepMatch): number {
  if (left.repoId === right.repoId) return 0;
  const leftLabel = normalizeSearchText(left.label);
  const rightLabel = normalizeSearchText(right.label);
  const leftWords = keywordSet([left.label, left.description, ...left.tags]);
  const rightWords = keywordSet([right.label, right.description, ...right.tags]);
  const overlap = [...leftWords].filter((word) => rightWords.has(word));
  let score = overlap.length;
  if (leftLabel === rightLabel) score += 5;
  if (left.kind === right.kind) score += 1;
  return score;
}

function backlinkFromStep(step: CrossRepoLogicalStepMatch): LivingReference {
  const source = step.hyperlinks[0];
  return {
    ...(source || {
      label: `${path.basename(step.repoPath)} · ${step.relativePath}`,
      href: `file://${step.filePath}`,
      repoId: step.repoId,
      repoPath: step.repoPath,
      filePath: step.filePath,
      relativePath: step.relativePath,
      startLine: step.startLine,
      endLine: step.endLine,
      direction: 'backlink' as const,
    }),
    label: `${path.basename(step.repoPath)} · ${step.relativePath}`,
    direction: 'backlink',
  };
}

function stepIdentityFromReference(reference: LivingReference): string {
  return `${reference.repoId}:${reference.filePath}:${reference.startLine}:${reference.endLine}`;
}

function stepIdentity(step: CrossRepoLogicalStepMatch): string {
  return `${step.repoId}:${step.filePath}:${step.startLine}:${step.endLine}`;
}

/**
 * **Corollary C4 — Candidate pruning** — Inverted keyword index + normalized-label buckets enumerate
 * candidate pairs that can score ≥ `BACKLINK_PAIR_MIN_SCORE`; preserves legacy `scoreCrossRepoLink`
 * semantics for every pair considered (same repo still yields 0).
 * **Lemma L5 — Step cap** — Only `BACKLINK_PAIRWISE_STEP_CAP` steps participate in pairwise scoring
 * (see `BACKLINK_PAIRWISE_STEP_CAP`).
 */
function buildBacklinks(steps: CrossRepoLogicalStepMatch[]): Map<string, LivingReference[]> {
  const backlinks = new Map<string, LivingReference[]>();
  if (steps.length === 0) return backlinks;

  const pairwiseSteps = steps.length <= BACKLINK_PAIRWISE_STEP_CAP ? steps : steps.slice(0, BACKLINK_PAIRWISE_STEP_CAP);

  const wordToStepIds = new Map<string, Set<string>>();
  const labelKeyToIds = new Map<string, string[]>();
  for (const step of pairwiseSteps) {
    const lk = normalizeSearchText(step.label);
    if (!labelKeyToIds.has(lk)) labelKeyToIds.set(lk, []);
    labelKeyToIds.get(lk)!.push(step.id);
    const words = keywordSet([step.label, step.description, ...step.tags]);
    for (const w of words) {
      if (!wordToStepIds.has(w)) wordToStepIds.set(w, new Set());
      wordToStepIds.get(w)!.add(step.id);
    }
  }

  const idToIndex = new Map(pairwiseSteps.map((s, i) => [s.id, i]));

  for (let leftIndex = 0; leftIndex < pairwiseSteps.length; leftIndex += 1) {
    const left = pairwiseSteps[leftIndex];
    const candidateIds = new Set<string>();
    for (const w of keywordSet([left.label, left.description, ...left.tags])) {
      for (const sid of wordToStepIds.get(w) || []) {
        if (sid !== left.id) candidateIds.add(sid);
      }
    }
    for (const sid of labelKeyToIds.get(normalizeSearchText(left.label)) || []) {
      if (sid !== left.id) candidateIds.add(sid);
    }

    const seenRight = new Set<string>();
    for (const rightId of candidateIds) {
      const rightIndex = idToIndex.get(rightId);
      if (rightIndex === undefined || rightIndex <= leftIndex) continue;
      if (seenRight.has(rightId)) continue;
      seenRight.add(rightId);
      const right = pairwiseSteps[rightIndex];
      if (scoreCrossRepoLink(left, right) < BACKLINK_PAIR_MIN_SCORE) continue;
      const leftList = backlinks.get(left.id) || [];
      const rightList = backlinks.get(right.id) || [];
      if (leftList.length < MAX_BACKLINKS_PER_STEP) leftList.push(backlinkFromStep(right));
      if (rightList.length < MAX_BACKLINKS_PER_STEP) rightList.push(backlinkFromStep(left));
      backlinks.set(left.id, dedupeReferences(leftList));
      backlinks.set(right.id, dedupeReferences(rightList));
    }
  }
  return backlinks;
}

function syncCrossRepoIndex(graph: LivingArchitectureGraph): { repos: ConnectedRepoRecord[]; steps: CrossRepoLogicalStepMatch[] } {
  const snapshot = buildCrossRepoIndexSnapshot();
  const backlinksByStep = buildBacklinks(snapshot.steps);
  const stepByIdentity = new Map(snapshot.steps.map((step) => [stepIdentity(step), step]));
  const collectedBacklinks: LivingReference[] = [];

  graph.repos = snapshot.repos.map((repo) => normalizeRepoRecord(repo));

  for (const repo of graph.repos) {
    upsertNode(graph, {
      id: repo.id,
      kind: 'repo',
      label: repo.label,
      description: `${repo.label} repository at ${repo.path}`,
      tags: ['repo', repo.status, repo.label.toLowerCase()],
      repoId: repo.id,
      repoPath: repo.path,
      metadata: {
        indexedFileCount: repo.indexedFileCount,
        contributionCount: repo.contributionCount,
        lastIndexedAt: repo.lastIndexedAt,
        color: repo.color,
      },
      hyperlinks: [],
    });
  }

  for (const step of snapshot.steps) {
    const references = dedupeReferences([...(step.hyperlinks || []), ...(backlinksByStep.get(step.id) || [])]);
    collectedBacklinks.push(...references.filter((reference) => reference.direction === 'backlink'));
    upsertNode(graph, {
      id: step.id,
      kind: step.kind,
      label: step.label,
      description: step.description,
      tags: uniqueStrings([...step.tags, 'cross-repo', step.kind]),
      repoId: step.repoId,
      repoPath: step.repoPath,
      sourcePath: step.filePath,
      sourceStartLine: step.startLine,
      sourceEndLine: step.endLine,
      hyperlinks: references,
      metadata: {
        relativePath: step.relativePath,
      },
    });
    addEdge(graph, { from: step.id, to: step.repoId, relation: 'belongs_to', rationale: 'Logical step belongs to this repository.' });
  }

  for (const step of snapshot.steps) {
    const backlinks = backlinksByStep.get(step.id) || [];
    for (const reference of backlinks) {
      const target = stepByIdentity.get(stepIdentityFromReference(reference));
      if (!target) continue;
      addEdge(graph, { from: step.id, to: target.id, relation: 'references', rationale: 'Cross-repo backlink inferred from shared logical language and artifacts.' });
    }
  }

  graph.backlinks = dedupeReferences(collectedBacklinks);
  return snapshot;
}

function buildVersion(graph: LivingArchitectureGraph, taskId: string, summary: string): LivingArchitectureVersion {
  const graphPayload = {
    nodes: graph.nodes,
    edges: graph.edges,
    repos: graph.repos,
    backlinks: graph.backlinks,
  };
  return {
    id: stableId(['version', taskId, String(graph.versions.length + 1)]),
    taskId,
    createdAt: new Date().toISOString(),
    summary,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    hash: computePayloadHash(graphPayload),
    repoCount: graph.repos.length,
    stepCount: graph.nodes.filter((node) => node.repoId && node.sourcePath).length,
  };
}

function resolveTargetRepo(graph: LivingArchitectureGraph, repoPath?: string | null, appId?: string | null): ConnectedRepoRecord | null {
  const safeRepoPath = repoPath ? path.resolve(repoPath) : null;
  if (safeRepoPath) {
    const repoByPath = graph.repos.find((repo) => path.resolve(repo.path) === safeRepoPath);
    if (repoByPath) return repoByPath;
  }
  const safeAppId = String(appId || '').trim().toLowerCase();
  if (!safeAppId) return null;
  return graph.repos.find((repo) => repo.id === stableId(['repo', safeAppId]) || path.basename(repo.path).toLowerCase() === safeAppId || repo.label.toLowerCase() === safeAppId) || null;
}

function serviceNodeDefinitions(): Array<{ id: string; label: string; description: string }> {
  return [
    { id: 'service-opseeq', label: 'Opseeq', description: 'Human-first coordination plane and gateway.' },
    { id: 'service-nemoclaw', label: 'Nemoclaw', description: 'Ultimate OODA orchestrator.' },
    { id: 'service-mermate', label: 'Mermate', description: 'Canonical maximal-precision architecture generator.' },
    { id: 'service-lucidity', label: 'Lucidity', description: 'Visual and semantic cleanup layer.' },
    { id: 'service-general-clawd', label: 'General-Clawd', description: 'Execution worker inside approved envelopes.' },
    { id: 'service-synth', label: 'Synth', description: 'Prediction and decision surface.' },
  ];
}

function serviceNodeId(service: string): string {
  return stableId(['service', service]);
}

function matchesQuery(node: LivingArchitectureNode, options: LivingArchitectureQueryOptions): boolean {
  if (options.kind && options.kind !== 'all' && node.kind !== options.kind) return false;
  if (options.repoId && node.repoId !== options.repoId && node.id !== options.repoId) return false;
  if (options.taskId && node.id !== stableId(['intent', options.taskId]) && !node.tags.includes(options.taskId)) return false;
  if (!options.query) return true;
  const haystack = normalizeSearchText([
    node.id,
    node.label,
    node.description,
    node.repoId || '',
    node.repoPath || '',
    ...(node.tags || []),
    ...((node.hyperlinks || []).map((link) => `${link.label} ${link.relativePath}`)),
  ].join(' '));
  return haystack.includes(normalizeSearchText(options.query));
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────────

/** Returns the current persisted graph (loads from disk each call). */
export function getLivingArchitectureGraph(): LivingArchitectureGraph {
  return loadGraph();
}

/**
 * Full re-index: law nodes, cross-repo snapshot merge, optional version row + trace artifact, persist.
 *
 * **Postcondition:** When `recordVersion !== false`, appends a version and calls `writeImmutableArtifact` for
 * `living-architecture-graph-index`.
 */
export function refreshLivingArchitectureGraphIndex(options: { taskId?: string; recordVersion?: boolean } = {}): LivingArchitectureRefreshResult {
  const graph = loadGraph();
  ensureLawNodes(graph);
  syncCrossRepoIndex(graph);
  let version: LivingArchitectureVersion | null = null;
  if (options.recordVersion !== false) {
    version = buildVersion(graph, options.taskId || `graph-refresh-${Date.now().toString(36)}`, `Living Architecture Graph refreshed across ${graph.repos.length} repositories`);
    graph.versions.push(version);
    writeImmutableArtifact('living-architecture-graph-index', version.taskId, { version, graph });
  }
  graph.generatedAt = new Date().toISOString();
  saveGraph(graph);
  return { graph, version, diagram: renderLivingArchitectureGraphText(graph, options.taskId) };
}

/**
 * Filter/sort query over nodes with optional repo/task/kind/text filters; includes incident edges.
 *
 * **Semantics:** `limit` clamps to `[1, QUERY_MAX_LIMIT]` with default `QUERY_DEFAULT_LIMIT`. When
 * `includeBacklinks === false`, result `backlinks` is empty (graph totals unchanged).
 */
export function queryLivingArchitectureGraph(options: LivingArchitectureQueryOptions = {}): LivingArchitectureQueryResult {
  const graph = loadGraph();
  const limit = Math.max(1, Math.min(options.limit || QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT));
  const nodes = graph.nodes
    .filter((node) => matchesQuery(node, options))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => nodeIds.has(edge.from) || nodeIds.has(edge.to));
  const repoIds = new Set(nodes.map((node) => node.repoId).filter(Boolean) as string[]);
  const repos = graph.repos.filter((repo) => repoIds.size === 0 || repoIds.has(repo.id));
  const backlinks = options.includeBacklinks === false
    ? []
    : dedupeReferences(nodes.flatMap((node) => (node.hyperlinks || []).filter((reference) => reference.direction === 'backlink')));
  return {
    generatedAt: graph.generatedAt,
    totals: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      repos: graph.repos.length,
      versions: graph.versions.length,
      backlinks: graph.backlinks.length,
    },
    repos,
    nodes,
    edges,
    backlinks,
  };
}

/** Single-node view with inbound/outbound edges and adjacent nodes. */
export function getLivingArchitectureNode(nodeId: string): LivingArchitectureNodeSnapshot {
  const graph = loadGraph();
  const ix = ensureGraphIndexes(graph);
  const node = ix.nodesById.get(nodeId) || null;
  if (!node) {
    return { node: null, inbound: [], outbound: [], relatedNodes: [] };
  }
  const inbound = graph.edges.filter((edge) => edge.to === nodeId);
  const outbound = graph.edges.filter((edge) => edge.from === nodeId);
  const relatedIds = uniqueStrings([...inbound.map((edge) => edge.from), ...outbound.map((edge) => edge.to)]);
  return {
    node,
    inbound,
    outbound,
    relatedNodes: relatedIds.map((id) => ix.nodesById.get(id)).filter(Boolean) as LivingArchitectureNode[],
  };
}

/**
 * Summary dashboard; if the graph has no repos yet, triggers a non-versioned refresh to populate index data.
 */
export function buildLivingArchitectureDashboard(): LivingArchitectureDashboard {
  let graph = loadGraph();
  if (graph.repos.length === 0) {
    graph = refreshLivingArchitectureGraphIndex({ recordVersion: false }).graph;
  }
  const focusNodes = graph.nodes
    .filter((node) => node.kind === 'intent' || node.kind === 'stage' || node.kind === 'repo' || node.kind === 'decision')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, DASHBOARD_FOCUS_NODE_LIMIT);
  return {
    generatedAt: graph.generatedAt,
    summary: {
      repoCount: graph.repos.length,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      versionCount: graph.versions.length,
      backlinkCount: graph.backlinks.length,
      taskCount: graph.nodes.filter((node) => node.kind === 'intent').length,
      stageCount: graph.nodes.filter((node) => node.kind === 'stage').length,
    },
    repos: [...graph.repos].sort((left, right) => right.contributionCount - left.contributionCount),
    focusNodes,
    recentVersions: [...graph.versions].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, DASHBOARD_VERSION_SLICE),
    backlinks: graph.backlinks.slice(0, DASHBOARD_BACKLINK_SLICE),
    diagram: renderLivingArchitectureGraphText(graph),
  };
}

/**
 * Records a precision pipeline sync: intent, services, plan, critique, extensions, optional stages.
 *
 * **Postcondition:** Persists graph, appends version, writes `writeImmutableArtifact('living-architecture-graph', ...)`.
 */
export function syncLivingArchitectureGraph(input: SyncGraphInput): { graph: LivingArchitectureGraph; version: LivingArchitectureVersion; diagram: string } {
  const graph = loadGraph();
  ensureLawNodes(graph);
  syncCrossRepoIndex(graph);

  const intentNode = upsertNode(graph, {
    id: stableId(['intent', input.taskId]),
    kind: 'intent',
    label: `Intent ${input.taskId}`,
    description: input.intent,
    tags: ['task', input.taskId, input.appId || 'generic'],
    metadata: { repoPath: input.repoPath || null },
    hyperlinks: [],
  });

  const targetRepo = resolveTargetRepo(graph, input.repoPath, input.appId);
  if (targetRepo) {
    addEdge(graph, { from: intentNode.id, to: targetRepo.id, relation: 'informs', rationale: 'Human intent targets this connected repository.' });
    const repoContextNodes = graph.nodes
      .filter((node) => node.repoId === targetRepo.id && (node.kind === 'service' || node.kind === 'decision' || node.kind === 'artifact' || node.kind === 'lemma' || node.kind === 'validation'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 6);
    for (const repoNode of repoContextNodes) {
      addEdge(graph, { from: intentNode.id, to: repoNode.id, relation: 'references', rationale: 'Intent inherits grounding context from the active repository graph.' });
    }
  }

  for (const service of serviceNodeDefinitions()) {
    upsertNode(graph, { id: service.id, kind: 'service', label: service.label, description: service.description, tags: ['service', 'precision-orchestration'], hyperlinks: [], metadata: {} });
    addEdge(graph, { from: intentNode.id, to: service.id, relation: 'informs', rationale: 'The task routes through the Precision Orchestration pipeline.' });
  }

  const planNode = upsertNode(graph, {
    id: stableId(['artifact', input.taskId, 'plan']),
    kind: 'artifact',
    label: `Plan ${input.taskId}`,
    description: input.planSteps.join(' '),
    tags: ['artifact', 'plan', input.taskId],
    hyperlinks: [],
    metadata: { steps: input.planSteps },
  });
  addEdge(graph, { from: intentNode.id, to: planNode.id, relation: 'produces', rationale: 'Nemoclaw materializes the intent into a plan artifact.' });
  addEdge(graph, { from: 'service-nemoclaw', to: planNode.id, relation: 'produces', rationale: 'Nemoclaw authors the approved planning artifact.' });

  const critiqueNode = upsertNode(graph, {
    id: stableId(['artifact', input.taskId, 'meta-critique']),
    kind: 'artifact',
    label: `Meta-Critique ${input.taskId}`,
    description: input.critiqueSummary,
    tags: ['artifact', 'critique', input.taskId],
    hyperlinks: [],
    metadata: {},
  });
  addEdge(graph, { from: planNode.id, to: critiqueNode.id, relation: 'criticizes', rationale: 'The self-reflective loop critiques the plan before handoff.' });

  for (const extensionId of input.extensionIds) {
    const extensionNode = upsertNode(graph, {
      id: stableId(['extension', extensionId]),
      kind: 'extension',
      label: extensionId,
      description: `Extension pack ${extensionId}`,
      tags: ['extension'],
      hyperlinks: [],
      metadata: {},
    });
    addEdge(graph, { from: extensionNode.id, to: 'service-mermate', relation: 'routes_to', rationale: 'Extension pack influences stage routing.' });
    addEdge(graph, { from: extensionNode.id, to: 'service-lucidity', relation: 'routes_to', rationale: 'Extension pack influences cleanup and comparison.' });
    addEdge(graph, { from: extensionNode.id, to: 'service-opseeq', relation: 'routes_to', rationale: 'Extension pack influences dashboard presentation and graph traceability.' });
  }

  for (const stageResult of input.stageResults || []) {
    const stageNode = upsertNode(graph, {
      id: stableId(['stage', input.taskId, stageResult.stage]),
      kind: 'stage',
      label: `${stageResult.service} · ${stageResult.stage}`,
      description: stageResult.summary,
      tags: ['stage', stageResult.stage, stageResult.status, stageResult.service, input.taskId],
      hyperlinks: [],
      metadata: {
        status: stageResult.status,
        details: stageResult.details || {},
      },
    });
    addEdge(graph, { from: intentNode.id, to: stageNode.id, relation: 'derives', rationale: 'Intent expands into explicit precision orchestration stages.' });
    addEdge(graph, { from: serviceNodeId(stageResult.service), to: stageNode.id, relation: 'executes', rationale: 'Service participates in the requested stage.' });
    addEdge(graph, { from: stageNode.id, to: planNode.id, relation: 'produces', rationale: 'Each stage contributes evidence or artifacts back into the plan trace.' });
  }

  const version = buildVersion(graph, input.taskId, `Living Architecture Graph updated for ${input.taskId}`);
  graph.versions.push(version);
  graph.generatedAt = new Date().toISOString();
  saveGraph(graph);
  writeImmutableArtifact('living-architecture-graph', input.taskId, { version, graph });
  return { graph, version, diagram: renderLivingArchitectureGraphText(graph, input.taskId) };
}

/** Renders a plain-text diagram summary for logs and consoles. */
export function renderLivingArchitectureGraphText(graph: LivingArchitectureGraph, taskId?: string): string {
  const lines = [
    'Living Architecture Graph',
    `- Generated: ${graph.generatedAt}`,
    `- Repositories: ${graph.repos.length}`,
    `- Nodes: ${graph.nodes.length}`,
    `- Edges: ${graph.edges.length}`,
  ];
  const ix = ensureGraphIndexes(graph);
  const scopedIntent = taskId ? ix.nodesById.get(stableId(['intent', taskId])) : null;
  if (scopedIntent) {
    lines.push('Intent Trace:');
    lines.push(`- ${scopedIntent.label}`);
    const scopedEdges = graph.edges.filter((edge) => edge.from === scopedIntent.id).slice(0, DIAGRAM_INTENT_EDGE_SLICE);
    for (const edge of scopedEdges) {
      const target = ix.nodesById.get(edge.to);
      lines.push(`  -> [${edge.relation}] ${target?.label || edge.to}`);
    }
  }
  lines.push('Connected Repositories:');
  for (const repo of graph.repos.slice(0, DIAGRAM_REPO_SLICE)) {
    lines.push(`- ${repo.label}: ${repo.contributionCount} logical steps · ${repo.indexedFileCount} indexed files · ${repo.status}`);
  }
  if (graph.backlinks.length > 0) {
    lines.push('Cross-Repo Backlinks:');
    for (const backlink of graph.backlinks.slice(0, DIAGRAM_BACKLINK_SLICE)) {
      lines.push(`- ${backlink.label} (${backlink.relativePath}:${backlink.startLine})`);
    }
  }
  lines.push('Law Spine:');
  for (const node of graph.nodes.filter((entry) => entry.kind === 'axiom' || entry.kind === 'corollary')) {
    lines.push(`- ${node.label}`);
  }
  return lines.join('\n');
}
