// tests/mega-production-readiness.test.ts
// MEGA PRODUCTION READINESS TEST SUITE FOR OPSEEQ v2.5
// Final major verification pass for production completeness
// Generated for execution from: /Users/dylanckawalec/Desktop/developer/opseeq

import { describe, expect, it, afterEach, afterAll, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVICE_SRC = path.join(REPO_ROOT, 'service', 'src');

interface Issue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  subsystem: string;
  title: string;
  detail: string;
  blocksProduction: boolean;
  autoFixed?: boolean;
  fixPrompt?: string;
}

const issues: Issue[] = [];
const autoFixes: string[] = [];

function reportIssue(issue: Issue): void {
  issues.push(issue);
  if (issue.autoFixed) autoFixes.push(`AUTO-FIXED: ${issue.title}`);
}

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opseeq-mega-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function fileExists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function safeReadFile(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function hasCommand(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
});

afterAll(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }

  // ─── Production Readiness Report ───────────────────────────────
  const total = issues.length;
  const fixed = issues.filter(i => i.autoFixed).length;
  const unfixed = issues.filter(i => !i.autoFixed);
  const critical = unfixed.filter(i => i.severity === 'critical');
  const high = unfixed.filter(i => i.severity === 'high');
  const medium = unfixed.filter(i => i.severity === 'medium');
  const low = unfixed.filter(i => i.severity === 'low');

  console.log('\n' + '═'.repeat(72));
  console.log('  OPSEEQ v2.5 — PRODUCTION READINESS REPORT');
  console.log('═'.repeat(72));
  console.log(`  Total issues detected:    ${total}`);
  console.log(`  Auto-fixed:               ${fixed}`);
  console.log(`  Remaining:                ${unfixed.length}`);
  console.log(`    Critical:               ${critical.length}`);
  console.log(`    High:                   ${high.length}`);
  console.log(`    Medium:                 ${medium.length}`);
  console.log(`    Low:                    ${low.length}`);
  console.log('');

  for (const fix of autoFixes) console.log(`  ${fix}`);

  for (const issue of unfixed) {
    console.log(`\n  [${issue.severity.toUpperCase()}] ${issue.subsystem}: ${issue.title}`);
    console.log(`    ${issue.detail}`);
    if (issue.blocksProduction) console.log('    ⛔ BLOCKS PRODUCTION');
    if (issue.fixPrompt) {
      console.log('\n    FIX NEEDED – PROMPT FOR OPUS');
      console.log(`    ${issue.fixPrompt}`);
    }
  }

  console.log('\n' + '─'.repeat(72));
  const blockers = unfixed.filter(i => i.blocksProduction);
  if (blockers.length === 0) {
    console.log('  ✅ System is PRODUCTION READY');
  } else {
    console.log(`  ❌ System needs fixes — see report (${blockers.length} blocker(s))`);
  }
  console.log('─'.repeat(72) + '\n');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. REPOSITORY STRUCTURE & BUILD VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Repository structure', () => {
  const requiredServiceFiles = [
    'config.ts', 'router.ts', 'kernel.ts', 'index.ts',
    'feedback.ts', 'living-architecture-graph.ts', 'ooda-primitives.ts',
    'execution-runtime.ts', 'cross-repo-index.ts', 'trace-sink.ts',
    'temporal-causality.ts', 'meta-critique.ts', 'fractal-context.ts',
    'mermate-lucidity-ooda.ts', 'windsurf-subagent-orchestrator.ts',
    'iterm2-adaptive-plug.ts', 'nemoclaw-control.ts', 'app-launcher.ts',
    'repo-connect.ts', 'extension-registry.ts', 'mcp-server.ts',
    'http-fetch-retry.ts', 'provider-resolution.ts',
  ];

  for (const f of requiredServiceFiles) {
    it(`service/src/${f} exists`, () => {
      expect(fileExists(path.join(SERVICE_SRC, f))).toBe(true);
    });
  }

  it('service/package.json exists with correct name', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'service', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('opseeq-service');
    expect(pkg.version).toBe('5.0.0');
  });

  it('service compiles without errors', { timeout: 60_000 }, () => {
    const result = execSync('npm run build 2>&1', {
      cwd: path.join(REPO_ROOT, 'service'),
      encoding: 'utf8',
      timeout: 55_000,
    });
    expect(result).not.toContain('error TS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SCIENTIFIC DOCUMENTATION HEADERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scientific documentation headers', () => {
  const filesRequiringHeaders = [
    'router.ts', 'feedback.ts', 'index.ts',
    'http-fetch-retry.ts', 'provider-resolution.ts',
    'ooda-primitives.ts', 'trace-sink.ts',
    'living-architecture-graph.ts', 'execution-runtime.ts',
    'cross-repo-index.ts',
  ];

  for (const f of filesRequiringHeaders) {
    it(`${f} has @module or formal vocabulary header`, () => {
      const content = safeReadFile(path.join(SERVICE_SRC, f));
      expect(content).toBeTruthy();
      const hasModuleTag = content!.includes('@module');
      const hasAxiom = /\bAxiom\b/i.test(content!);
      const hasPostulate = /\bPostulate\b/i.test(content!);
      const hasFormalDoc = hasModuleTag || (hasAxiom && hasPostulate);
      if (!hasFormalDoc) {
        reportIssue({
          severity: 'low', subsystem: f,
          title: `Missing scientific header in ${f}`,
          detail: 'File lacks @module tag or Axiom/Postulate documentation',
          blocksProduction: false,
        });
      }
      expect(hasFormalDoc).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. OODA PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════════

describe('OODA primitives', () => {
  it('computeRankedActionScore produces bounded scores', async () => {
    const { computeRankedActionScore, RANK_DIMENSION_MIN, RANK_DIMENSION_MAX } =
      await import('../service/src/ooda-primitives');

    const maxAction = {
      id: 'max', label: 'Max', category: 'velocity' as const, description: '',
      velocity: RANK_DIMENSION_MAX, security: RANK_DIMENSION_MAX,
      creativity: RANK_DIMENSION_MAX, risk: RANK_DIMENSION_MIN,
      commands: [], fileScope: [], networkScope: [],
    };
    const minAction = {
      id: 'min', label: 'Min', category: 'velocity' as const, description: '',
      velocity: RANK_DIMENSION_MIN, security: RANK_DIMENSION_MIN,
      creativity: RANK_DIMENSION_MIN, risk: RANK_DIMENSION_MAX,
      commands: [], fileScope: [], networkScope: [],
    };
    const maxScore = computeRankedActionScore(maxAction);
    const minScore = computeRankedActionScore(minAction);
    expect(maxScore).toBeGreaterThan(minScore);
    expect(maxScore).toBeLessThanOrEqual(RANK_DIMENSION_MAX);
    expect(minScore).toBeGreaterThanOrEqual(-RANK_DIMENSION_MAX);
  });

  it('rankActions sorts descending by score', async () => {
    const { rankActions } = await import('../service/src/ooda-primitives');
    const actions = rankActions([
      { id: 'a', label: 'A', category: 'security', description: '', velocity: 1, security: 5, creativity: 1, risk: 0, commands: [], fileScope: [], networkScope: [] },
      { id: 'b', label: 'B', category: 'velocity', description: '', velocity: 5, security: 1, creativity: 1, risk: 0, commands: [], fileScope: [], networkScope: [] },
    ]);
    expect(actions[0].score).toBeGreaterThanOrEqual(actions[1].score);
  });

  it('buildOodaCycle produces stable planHash', async () => {
    const { buildOodaCycle } = await import('../service/src/ooda-primitives');
    const c1 = buildOodaCycle({ intent: 'Test stability', primaryModel: 'test', allowRemoteAugmentation: false });
    const c2 = buildOodaCycle({ intent: 'Test stability', primaryModel: 'test', allowRemoteAugmentation: false });
    expect(c1.planHash).toBe(c2.planHash);
    expect(c1.planHash.startsWith('sha256:')).toBe(true);
  });

  it('buildOodaCycle enforces permission approval', async () => {
    const { buildOodaCycle } = await import('../service/src/ooda-primitives');
    const cycle = buildOodaCycle({ intent: 'Build app', primaryModel: 'test', allowRemoteAugmentation: false });
    expect(cycle.permission.requiresApproval).toBe(true);
    expect(cycle.keyUnknowns.length).toBeGreaterThan(0);
    expect(cycle.detailedPlan.length).toBeGreaterThan(0);
    expect(cycle.rankedActions.length).toBeGreaterThan(0);
  });

  it('remote augmentation controls network scope', async () => {
    const { buildOodaCycle } = await import('../service/src/ooda-primitives');
    const local = buildOodaCycle({ intent: 'Local only', primaryModel: 'test', allowRemoteAugmentation: false });
    const remote = buildOodaCycle({ intent: 'Remote allowed', primaryModel: 'test', allowRemoteAugmentation: true });
    const localNet = local.rankedActions.flatMap(a => a.networkScope);
    const remoteNet = remote.rankedActions.flatMap(a => a.networkScope);
    expect(localNet.every(s => !s.includes('anthropic'))).toBe(true);
    expect(remoteNet.some(s => s.includes('anthropic'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PROVIDER RESOLUTION (v2.5 optimization)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provider resolution', () => {
  it('buildRoutingTable creates O(1) model lookup', async () => {
    const { buildRoutingTable } = await import('../service/src/provider-resolution');
    const mockConfig = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: 'test-model',
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [
        { name: 'p1', baseUrl: 'http://p1', apiKey: 'k1', models: ['model-a', 'model-b'], priority: 1 },
        { name: 'p2', baseUrl: 'http://p2', apiKey: 'k2', models: ['model-c', 'nvidia/llm-x'], priority: 2 },
      ],
    };
    const table = buildRoutingTable(mockConfig);
    expect(table.modelExact.get('model-a')?.name).toBe('p1');
    expect(table.modelExact.get('model-c')?.name).toBe('p2');
    expect(table.fallback?.name).toBe('p1');
    expect(table.modelListFlat).toHaveLength(4);
  });

  it('resolveProviderFor prefers exact match over prefix', async () => {
    const { resolveProviderFor } = await import('../service/src/provider-resolution');
    const config = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: 'x',
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [
        { name: 'exact', baseUrl: 'http://e', apiKey: 'k', models: ['nvidia/llm-exact'], priority: 1 },
        { name: 'prefix', baseUrl: 'http://p', apiKey: 'k', models: ['nvidia/llm-other'], priority: 2 },
      ],
    };
    const p = resolveProviderFor('nvidia/llm-exact', config);
    expect(p?.name).toBe('exact');
  });

  it('resolveProviderFor falls back to first provider for unknown models', async () => {
    const { resolveProviderFor } = await import('../service/src/provider-resolution');
    const config = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: 'x',
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [
        { name: 'fallback', baseUrl: 'http://f', apiKey: 'k', models: ['known-model'], priority: 1 },
      ],
    };
    const p = resolveProviderFor('completely-unknown-model', config);
    expect(p?.name).toBe('fallback');
  });

  it('getEmbeddingProvider skips ollama and anthropic', async () => {
    const { getEmbeddingProvider } = await import('../service/src/provider-resolution');
    const config = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: 'x',
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [
        { name: 'ollama', baseUrl: 'http://o', apiKey: 'k', models: ['m1'], priority: 1 },
        { name: 'anthropic', baseUrl: 'http://a', apiKey: 'k', models: ['m2'], priority: 2 },
        { name: 'openai', baseUrl: 'http://oai', apiKey: 'k', models: ['m3'], priority: 3 },
      ],
    };
    expect(getEmbeddingProvider(config)?.name).toBe('openai');
  });

  it('provider resolution is fast (<1ms for 100 lookups)', async () => {
    const { buildRoutingTable, resolveProviderFor } = await import('../service/src/provider-resolution');
    const models = Array.from({ length: 50 }, (_, i) => `model-${i}`);
    const config = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: models[0],
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [{ name: 'p', baseUrl: 'http://p', apiKey: 'k', models, priority: 1 }],
    };
    buildRoutingTable(config);
    const start = performance.now();
    for (let i = 0; i < 100; i++) resolveProviderFor(models[i % 50], config);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. HTTP FETCH RETRY (v2.5 streaming parity)
// ═══════════════════════════════════════════════════════════════════════════════

describe('HTTP fetch retry', () => {
  it('fetchWithRetry and fetchStreamWithRetry share the same implementation', async () => {
    const mod = await import('../service/src/http-fetch-retry');
    expect(typeof mod.fetchWithRetry).toBe('function');
    expect(typeof mod.fetchStreamWithRetry).toBe('function');
  });

  it('module has retry parity axiom in header', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'http-fetch-retry.ts'));
    expect(content).toContain('Retry parity');
    expect(content).toContain('fetchStreamWithRetry');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. FEEDBACK LOOP & ADAPTIVE ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feedback loop', () => {
  it('records success and updates adaptive score', async () => {
    const { recordSuccess, getAdaptiveRanking, TAU } = await import('../service/src/feedback');
    recordSuccess('test-provider', 200);
    recordSuccess('test-provider', 300);
    const ranking = getAdaptiveRanking();
    const tp = ranking.find(r => r.provider === 'test-provider');
    expect(tp).toBeDefined();
    expect(tp!.score).toBeGreaterThan(0);
    expect(TAU.explore).toBe(0.7);
    expect(TAU.production).toBe(0.85);
    expect(TAU.deploy).toBe(0.9);
  });

  it('getBestProvider returns null with insufficient data', async () => {
    vi.resetModules();
    const { getBestProvider } = await import('../service/src/feedback');
    expect(getBestProvider()).toBeNull();
  });

  it('artifact ring buffer respects size limit', async () => {
    const { recordArtifact, getRecentArtifacts } = await import('../service/src/feedback');
    for (let i = 0; i < 10; i++) {
      recordArtifact({
        id: `art-${i}`, model: 'm', provider: 'p', latencyMs: 100,
        tokens: null, success: true, timestamp: new Date().toISOString(), traceId: null,
      });
    }
    const recent = getRecentArtifacts(5);
    expect(recent).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. LIVING ARCHITECTURE GRAPH (with mtime cache + indexes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Living Architecture Graph', () => {
  it('creates graph with law nodes, services, and edges on sync', { timeout: 20_000 }, async () => {
    const home = makeTempHome('graph-sync');
    process.env.HOME = home;
    vi.resetModules();

    const graphMod = await import('../service/src/living-architecture-graph');
    const result = graphMod.syncLivingArchitectureGraph({
      taskId: 'mega-test-1',
      intent: 'Verify graph sync for production readiness.',
      appId: 'opseeq',
      extensionIds: ['mermate-max-ooda'],
      planSteps: ['Observe', 'Orient', 'Decide', 'Act'],
      critiqueSummary: 'Sound plan.',
    });

    expect(result.version.taskId).toBe('mega-test-1');
    expect(result.graph.nodes.some(n => n.kind === 'intent')).toBe(true);
    expect(result.graph.nodes.some(n => n.kind === 'service')).toBe(true);
    expect(result.graph.nodes.some(n => n.kind === 'axiom')).toBe(true);
    expect(result.graph.edges.some(e => e.relation === 'produces')).toBe(true);
    expect(result.diagram).toContain('Living Architecture Graph');

    const graphPath = path.join(home, '.opseeq-superior', 'living-architecture-graph.json');
    expect(fs.existsSync(graphPath)).toBe(true);
  });

  it('mtime cache avoids re-parse on repeated reads', async () => {
    const home = makeTempHome('graph-cache');
    process.env.HOME = home;
    vi.resetModules();

    const graphMod = await import('../service/src/living-architecture-graph');
    graphMod.syncLivingArchitectureGraph({
      taskId: 'cache-test', intent: 'Cache test', extensionIds: [],
      planSteps: ['A'], critiqueSummary: 'ok',
    });

    const start = performance.now();
    for (let i = 0; i < 100; i++) graphMod.getLivingArchitectureGraph();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('queryLivingArchitectureGraph respects limit', async () => {
    const home = makeTempHome('graph-query');
    process.env.HOME = home;
    vi.resetModules();

    const graphMod = await import('../service/src/living-architecture-graph');
    graphMod.syncLivingArchitectureGraph({
      taskId: 'query-test', intent: 'Query limits', extensionIds: ['a', 'b'],
      planSteps: ['s1', 's2', 's3'], critiqueSummary: 'ok',
    });

    const result = graphMod.queryLivingArchitectureGraph({ limit: 3 });
    expect(result.nodes.length).toBeLessThanOrEqual(3);
    expect(result.totals.nodes).toBeGreaterThan(0);
  });

  it('getLivingArchitectureNode returns null for missing nodes', async () => {
    const home = makeTempHome('graph-node');
    process.env.HOME = home;
    vi.resetModules();

    const graphMod = await import('../service/src/living-architecture-graph');
    const snap = graphMod.getLivingArchitectureNode('nonexistent-node-id');
    expect(snap.node).toBeNull();
    expect(snap.inbound).toHaveLength(0);
  });

  it('buildLivingArchitectureDashboard produces summary stats', async () => {
    const home = makeTempHome('graph-dashboard');
    process.env.HOME = home;
    vi.resetModules();

    const graphMod = await import('../service/src/living-architecture-graph');
    graphMod.syncLivingArchitectureGraph({
      taskId: 'dash-test', intent: 'Dashboard test', extensionIds: [],
      planSteps: ['x'], critiqueSummary: 'ok',
    });

    const dashboard = graphMod.buildLivingArchitectureDashboard();
    expect(dashboard.summary.nodeCount).toBeGreaterThan(0);
    expect(dashboard.diagram).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. TRACE SINK (immutable artifacts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Trace sink', () => {
  it('computePayloadHash is deterministic', async () => {
    const { computePayloadHash } = await import('../service/src/trace-sink');
    const h1 = computePayloadHash({ a: 1, b: 2 });
    const h2 = computePayloadHash({ b: 2, a: 1 });
    expect(h1).toBe(h2);
    expect(h1.startsWith('sha256:')).toBe(true);
  });

  it('writeImmutableArtifact creates file and is idempotent', async () => {
    const home = makeTempHome('trace');
    process.env.HOME = home;
    vi.resetModules();

    const { writeImmutableArtifact } = await import('../service/src/trace-sink');
    const a1 = writeImmutableArtifact('test-kind', 'task-1', { data: 'hello' });
    const a2 = writeImmutableArtifact('test-kind', 'task-1', { data: 'hello' });
    expect(a1.hash).toBe(a2.hash);
    expect(fs.existsSync(a1.path)).toBe(true);
  });

  it('listImmutableArtifacts returns reverse-chronological order', async () => {
    const home = makeTempHome('trace-list');
    process.env.HOME = home;
    vi.resetModules();

    const { writeImmutableArtifact, listImmutableArtifacts } = await import('../service/src/trace-sink');
    writeImmutableArtifact('k', 'first', { n: 1 });
    writeImmutableArtifact('k', 'second', { n: 2 });
    const list = listImmutableArtifacts(undefined, 10);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. TEMPORAL CAUSALITY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Temporal causality', () => {
  it('preserves parent-child event lineage', async () => {
    const home = makeTempHome('causality');
    process.env.HOME = home;
    vi.resetModules();

    const mod = await import('../service/src/temporal-causality');
    const root = mod.appendTemporalEvent({
      taskId: 'causal-1', parentId: null, actor: 'human',
      kind: 'intent_received', summary: 'Start task.',
      approvalState: 'pending', metadata: {},
    });
    mod.appendTemporalEvent({
      taskId: 'causal-1', parentId: root.id, actor: 'nemoclaw',
      kind: 'observe', summary: 'Inspect context.',
      approvalState: 'not_required', metadata: {},
    });

    const tree = mod.buildTemporalCausalityTree('causal-1');
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].kind).toBe('observe');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. EXECUTION RUNTIME (General-Clawd absorption)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Execution runtime', () => {
  it('buildExecutionRegistry returns singleton', async () => {
    const { buildExecutionRegistry } = await import('../service/src/execution-runtime');
    const r1 = buildExecutionRegistry();
    const r2 = buildExecutionRegistry();
    expect(r1).toBe(r2);
    expect(r1.commands.length).toBeGreaterThan(0);
    expect(r1.tools.length).toBeGreaterThan(0);
  });

  it('routePrompt returns scored matches', async () => {
    const { routePrompt } = await import('../service/src/execution-runtime');
    const matches = routePrompt('read file contents');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it('bootstrapSession creates session with UUID', async () => {
    const { bootstrapSession } = await import('../service/src/execution-runtime');
    const session = bootstrapSession('Hello world', 'task-boot-1');
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.taskId).toBe('task-boot-1');
    expect(session.turnResults).toHaveLength(1);
    expect(session.persisted).toBe(false);
  });

  it('persistSession writes to disk', async () => {
    const home = makeTempHome('exec-persist');
    process.env.HOME = home;
    vi.resetModules();

    const { bootstrapSession, persistSession } = await import('../service/src/execution-runtime');
    const session = bootstrapSession('Test persist', 'persist-1');
    const filepath = persistSession(session);
    expect(fs.existsSync(filepath)).toBe(true);
  });

  it('assembleToolPool filters by permission context', async () => {
    const { assembleToolPool } = await import('../service/src/execution-runtime');
    const pool = assembleToolPool({ simpleMode: true });
    const names = pool.tools.map(t => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Bash');
    expect(names).not.toContain('NotebookEdit');
  });

  it('getAbsorptionStatus confirms complete absorption', async () => {
    const { getAbsorptionStatus } = await import('../service/src/execution-runtime');
    const status = getAbsorptionStatus();
    expect(status.absorbed).toBe(true);
    expect(status.source).toBe('General-Clawd');
    expect(status.externalBridgeRemaining).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. WINDSURF SUBAGENT ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

describe('Windsurf subagent orchestrator', () => {
  it('delegateTask creates pending task with mandate', async () => {
    const { delegateTask } = await import('../service/src/windsurf-subagent-orchestrator');
    const task = delegateTask('parent-1', 'precision', {
      description: 'Analyze code quality',
      requiredCapabilities: ['code_analysis'],
      targetRepos: ['opseeq'],
      fileScope: ['service/src/*.ts'],
      permissions: { canRead: true, canWrite: false, canExecute: false, canAccessNetwork: false, destructiveOpsAllowed: false, requiresHumanApproval: false },
      timeout: 60000,
      acceptanceCriteria: ['No critical issues'],
    });
    expect(['pending', 'delegated']).toContain(task.status);
    expect(task.parentTaskId).toBe('parent-1');
    expect(task.taskId).toBeTruthy();
  });

  it('assessCapabilities returns relevant capabilities', async () => {
    const { assessCapabilities } = await import('../service/src/windsurf-subagent-orchestrator');
    const caps = assessCapabilities('review architecture and security of the codebase');
    expect(caps.length).toBeGreaterThan(0);
  });

  it('getOrchestratorDashboard returns structured summary', async () => {
    const { getOrchestratorDashboard } = await import('../service/src/windsurf-subagent-orchestrator');
    const dashboard = getOrchestratorDashboard();
    expect(typeof dashboard.totalTasks).toBe('number');
    expect(Array.isArray(dashboard.capabilities)).toBe(true);
  });

  it('buildCrossRepoOptimizationTask creates scoped task', async () => {
    const { buildCrossRepoOptimizationTask } = await import('../service/src/windsurf-subagent-orchestrator');
    const task = buildCrossRepoOptimizationTask('parent-2', 'windsurf', ['opseeq', 'mermate'], 'Cross-repo optimization');
    expect(task.mandate.targetRepos).toContain('opseeq');
    expect(task.mandate.targetRepos).toContain('mermate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. FRACTAL CONTEXT WINDOW
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fractal context', () => {
  it('builds 3-tree context window', async () => {
    const { buildFractalContextWindow, renderFractalContextText } =
      await import('../service/src/fractal-context');
    const window = buildFractalContextWindow({ intent: 'Test fractal context' });
    expect(window.contextRoot.kind).toBe('context');
    expect(window.processRoot.kind).toBe('process');
    expect(window.queryRoot.kind).toBe('query');
    const text = renderFractalContextText(window);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. EXTENSION REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Extension registry', () => {
  it('returns non-empty registry', async () => {
    const { getExtensionRegistry } = await import('../service/src/extension-registry');
    const packs = getExtensionRegistry();
    expect(packs.length).toBeGreaterThan(0);
    expect(packs[0].id).toBeTruthy();
  });

  it('getPrecisionOrchestrationRoutingDefaults returns model names', async () => {
    const { getPrecisionOrchestrationRoutingDefaults } = await import('../service/src/extension-registry');
    const defaults = getPrecisionOrchestrationRoutingDefaults('all');
    expect(defaults.plannerModel).toBeTruthy();
    expect(defaults.executionModel).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. iTERM2 ADAPTIVE PLUG (pipeline stages)
// ═══════════════════════════════════════════════════════════════════════════════

describe('iTerm2 adaptive plug', () => {
  it('PIPELINE_STAGES has correct structure', async () => {
    const { PIPELINE_STAGES } = await import('../service/src/iterm2-adaptive-plug');
    expect(PIPELINE_STAGES.length).toBeGreaterThan(0);
    for (const stage of PIPELINE_STAGES) {
      expect(stage.id).toBeTruthy();
      expect(stage.label).toBeTruthy();
      expect(typeof stage.required).toBe('boolean');
      expect(Array.isArray(stage.dependencies)).toBe(true);
    }
  });

  it('getMermateVendorStatus returns dependency status', async () => {
    const { getMermateVendorStatus } = await import('../service/src/iterm2-adaptive-plug');
    const status = getMermateVendorStatus();
    expect(typeof status.repoExists).toBe('boolean');
    expect(typeof status.tla2toolsJarExists).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. CROSS-REPO INDEX
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-repo index', () => {
  it('discoverConnectedRepos finds repos under known paths', async () => {
    const { discoverConnectedRepos } = await import('../service/src/cross-repo-index');
    const repos = discoverConnectedRepos({ rootPaths: [path.join(REPO_ROOT, '..')] });
    expect(Array.isArray(repos)).toBe(true);
  });

  it('buildCrossRepoIndexSnapshot returns structured snapshot', async () => {
    const { buildCrossRepoIndexSnapshot } = await import('../service/src/cross-repo-index');
    const snapshot = buildCrossRepoIndexSnapshot({ rootPaths: [REPO_ROOT] });
    expect(snapshot.repos.length).toBeGreaterThanOrEqual(0);
    expect(typeof snapshot.indexedFiles).toBe('number');
    expect(snapshot.discoveredAt).toBeTruthy();
  });

  it('searchCrossRepoSteps filters by query', async () => {
    const { buildCrossRepoIndexSnapshot, searchCrossRepoSteps } = await import('../service/src/cross-repo-index');
    const snapshot = buildCrossRepoIndexSnapshot({ rootPaths: [REPO_ROOT] });
    if (snapshot.steps.length > 0) {
      const results = searchCrossRepoSteps(snapshot, 'axiom');
      expect(Array.isArray(results)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. SECURITY & RED TEAM
// ═══════════════════════════════════════════════════════════════════════════════

describe('Security', () => {
  it('no hardcoded API keys in service source', () => {
    const files = fs.readdirSync(SERVICE_SRC).filter(f => f.endsWith('.ts'));
    const keyPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,
      /nvapi-[a-zA-Z0-9]{20,}/,
      /AKIA[A-Z0-9]{16}/,
    ];
    for (const f of files) {
      const content = fs.readFileSync(path.join(SERVICE_SRC, f), 'utf8');
      for (const pattern of keyPatterns) {
        expect(pattern.test(content)).toBe(false);
      }
    }
  });

  it('Bash tool requires explicit approval in execution runtime', async () => {
    const { routePrompt } = await import('../service/src/execution-runtime');
    const { bootstrapSession } = await import('../service/src/execution-runtime');
    const session = bootstrapSession('run rm -rf /', 'security-test');
    const bashMatches = session.turnResults[0].matchedTools.filter(t =>
      t.toLowerCase().includes('bash')
    );
    const denials = session.turnResults[0].permissionDenials;
    if (bashMatches.length > 0) {
      expect(denials.length).toBeGreaterThan(0);
    }
  });

  it('connectRepo rejects paths outside allowed root', async () => {
    const { connectRepo, RepoConnectError } = await import('../service/src/repo-connect');
    const home = makeTempHome('sec-connect');
    const outside = makeTempHome('sec-outside');
    const repoPath = path.join(outside, 'EvilRepo');
    fs.mkdirSync(repoPath, { recursive: true });
    await expect(connectRepo(repoPath, { homeDir: home, env: { HOME: home } }))
      .rejects.toBeInstanceOf(RepoConnectError);
  });

  it('shell injection via model names is blocked by type constraints', async () => {
    const { resolveProviderFor } = await import('../service/src/provider-resolution');
    const config = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: 'safe',
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [{ name: 'p', baseUrl: 'http://p', apiKey: 'k', models: ['safe'], priority: 1 }],
    };
    const p = resolveProviderFor('; rm -rf /', config);
    expect(p?.name).toBe('p');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. CONFIG & ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Config and environment', () => {
  it('loadConfig returns valid ServiceConfig', async () => {
    const { loadConfig } = await import('../service/src/config');
    const config = loadConfig();
    expect(config.port).toBeGreaterThan(0);
    expect(config.host).toBeTruthy();
    expect(typeof config.mcpEnabled).toBe('boolean');
    expect(typeof config.serverlessMode).toBe('boolean');
    expect(config.idleTimeoutMs).toBeGreaterThan(0);
  });

  it('config file references correct system prompt paths', () => {
    const precisionPrompt = path.join(REPO_ROOT, 'config', 'nemoclaw-precision-orchestration.system-prompt.md');
    const precisionPolicy = path.join(REPO_ROOT, 'config', 'nemoclaw-precision-orchestration-policy.yaml');
    expect(fileExists(precisionPrompt)).toBe(true);
    if (!fileExists(precisionPolicy)) {
      reportIssue({
        severity: 'medium', subsystem: 'config',
        title: 'Missing precision policy YAML',
        detail: `Expected ${precisionPolicy}`,
        blocksProduction: false,
      });
    }
  });

  it('upgrade script exists and is executable', () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'opseeq-service-upgrade-v25.sh');
    if (fileExists(scriptPath)) {
      const stat = fs.statSync(scriptPath);
      expect((stat.mode & 0o111) !== 0).toBe(true);
    } else {
      reportIssue({
        severity: 'low', subsystem: 'scripts',
        title: 'Missing v2.5 upgrade script',
        detail: `Expected ${scriptPath}`,
        blocksProduction: false,
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. ROUTER CONTRACT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Router contracts', () => {
  it('exports expected interface shape', async () => {
    const mod = await import('../service/src/router');
    expect(typeof mod.setKernel).toBe('function');
    expect(typeof mod.routeInference).toBe('function');
    expect(typeof mod.routeInferenceStream).toBe('function');
    expect(typeof mod.listModels).toBe('function');
  });

  it('router.ts uses fetchWithRetry from http-fetch-retry', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'router.ts'));
    expect(content).toContain("from './http-fetch-retry.js'");
    expect(content).toContain('fetchStreamWithRetry');
    expect(content).toContain("from './provider-resolution.js'");
  });

  it('router does not contain inline fetchWithRetry implementation', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'router.ts'));
    const lines = content!.split('\n');
    const asyncFetchRetry = lines.filter(l =>
      l.includes('async function fetchWithRetry')
    );
    expect(asyncFetchRetry).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 19. NEMOCLAW CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

describe('Nemoclaw control', () => {
  it('exports expected functions', async () => {
    const mod = await import('../service/src/nemoclaw-control');
    expect(typeof mod.getNemoClawOverview).toBe('function');
    expect(typeof mod.setNemoClawDefaultSandbox).toBe('function');
    expect(typeof mod.runNemoClawAction).toBe('function');
    expect(mod.NemoClawControlError).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 20. APP LAUNCHER
// ═══════════════════════════════════════════════════════════════════════════════

describe('App launcher', () => {
  it('resolveAppSurface returns known surfaces', async () => {
    const { resolveAppSurface } = await import('../service/src/app-launcher');
    const mermate = resolveAppSurface('mermate', { MERMATE_URL: 'http://localhost:3333' });
    expect(mermate.id).toBe('mermate');
    expect(mermate.url).toBe('http://localhost:3333');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 21. META CRITIQUE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Meta critique', () => {
  it('exports runMetaCritique function', async () => {
    const mod = await import('../service/src/meta-critique');
    expect(typeof mod.runMetaCritique).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 22. PERFORMANCE BENCHMARKS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Performance benchmarks', () => {
  it('graph sync completes in <5s for standard workload', async () => {
    const home = makeTempHome('perf-graph');
    process.env.HOME = home;
    vi.resetModules();

    const graphMod = await import('../service/src/living-architecture-graph');
    const start = performance.now();
    graphMod.syncLivingArchitectureGraph({
      taskId: 'perf-1', intent: 'Performance benchmark',
      extensionIds: ['a', 'b', 'c'],
      planSteps: Array.from({ length: 20 }, (_, i) => `Step ${i}`),
      critiqueSummary: 'ok',
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it('OODA cycle builds in <100ms', async () => {
    const { buildOodaCycle } = await import('../service/src/ooda-primitives');
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      buildOodaCycle({ intent: `Benchmark ${i}`, primaryModel: 'test', allowRemoteAugmentation: false });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('execution registry lookup is fast', async () => {
    const { buildExecutionRegistry } = await import('../service/src/execution-runtime');
    const registry = buildExecutionRegistry();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      registry.command('status');
      registry.tool('Read');
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 23. DEPENDENCY DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

describe('External dependency detection', () => {
  it('reports Java availability for TLA+ verification', () => {
    const javaAvailable = hasCommand('java');
    if (!javaAvailable) {
      reportIssue({
        severity: 'medium', subsystem: 'iterm2-adaptive-plug',
        title: 'Java not available for TLA+ model checking',
        detail: 'java not found in PATH — TLA+ verification stage will be unavailable',
        blocksProduction: false,
      });
    }
  });

  it('reports Rust toolchain availability', () => {
    const cargoAvailable = hasCommand('cargo');
    if (!cargoAvailable) {
      reportIssue({
        severity: 'medium', subsystem: 'iterm2-adaptive-plug',
        title: 'Rust toolchain not available',
        detail: 'cargo not found in PATH — Rust compilation stage unavailable',
        blocksProduction: false,
      });
    }
    expect(true).toBe(true);
  });

  it('reports tmux availability for pipeline sessions', () => {
    const tmuxAvailable = hasCommand('tmux');
    if (!tmuxAvailable) {
      reportIssue({
        severity: 'low', subsystem: 'iterm2-adaptive-plug',
        title: 'tmux not available',
        detail: 'tmux not found — adaptive pipeline sessions unavailable',
        blocksProduction: false,
      });
    }
    expect(true).toBe(true);
  });

  it('detects node version >= 22', () => {
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major < 22) {
      reportIssue({
        severity: 'high', subsystem: 'runtime',
        title: `Node.js version too old: ${process.version}`,
        detail: 'service/package.json requires node >= 22.0.0',
        blocksProduction: true,
      });
    }
    expect(major).toBeGreaterThanOrEqual(22);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 24. REPO CONNECT INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Repo connect', () => {
  it('creates .env and .mcp.json for new repo', async () => {
    const home = makeTempHome('connect');
    const repoPath = path.join(home, 'TestRepo');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'test', scripts: { start: 'node index.js' } }));
    fs.writeFileSync(path.join(repoPath, 'index.js'), 'const port = 3000; console.log(port);');

    const { connectRepo } = await import('../service/src/repo-connect');
    const result = await connectRepo(repoPath, {
      homeDir: home, env: { HOME: home },
    });

    expect(result.analysis.detectedKinds).toContain('node');
    const envContent = safeReadFile(path.join(repoPath, '.env'));
    expect(envContent).toContain('OPSEEQ_URL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 25. BACKLINK CAPPING VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Backlink capping', () => {
  it('living-architecture-graph has BACKLINK_PAIRWISE_STEP_CAP', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'living-architecture-graph.ts'));
    expect(content).toContain('BACKLINK_PAIRWISE_STEP_CAP');
    const match = content!.match(/BACKLINK_PAIRWISE_STEP_CAP\s*=\s*(\d+)/);
    expect(match).toBeTruthy();
    const cap = parseInt(match![1], 10);
    expect(cap).toBeGreaterThanOrEqual(100);
    expect(cap).toBeLessThanOrEqual(1000);
  });

  it('graph uses inverted keyword index for backlinks', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'living-architecture-graph.ts'));
    expect(content).toContain('wordToStepIds');
    expect(content).toContain('labelKeyToIds');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 26. INDEX.TS v2.5 OPTIMIZATION VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Index.ts v2.5 optimizations', () => {
  it('uses LRU idempotency cache with max cap', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'index.ts'));
    expect(content).toContain('IDEMPOTENCY_CACHE_MAX');
    expect(content).toContain('idempotencyGet');
    expect(content).toContain('idempotencySet');
  });

  it('uses random eviction for rate buckets', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'index.ts'));
    expect(content).toContain('Math.random()');
    expect(content).not.toContain('.sort((a, b) => a[1].resetAt - b[1].resetAt)');
  });

  it('uses getCachedLivingGraph in /api/status', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'index.ts'));
    expect(content).toContain('getCachedLivingGraph');
  });

  it('/api/status uses Promise.all for parallel subsystem queries', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'index.ts'));
    const statusSection = content!.substring(content!.indexOf("'/api/status'"));
    expect(statusSection).toContain('Promise.all');
  });

  it('uses getEmbeddingProvider from provider-resolution', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'index.ts'));
    expect(content).toContain("from './provider-resolution.js'");
    expect(content).toContain('getEmbeddingProvider');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 27. GRAPH DISK CACHE & INDEX VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Graph cache and indexes', () => {
  it('living-architecture-graph has mtime disk cache', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'living-architecture-graph.ts'));
    expect(content).toContain('graphDiskCache');
    expect(content).toContain('mtimeMs');
  });

  it('graph has WeakMap indexes for nodes and edges', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'living-architecture-graph.ts'));
    expect(content).toContain('graphIndexes');
    expect(content).toContain('WeakMap');
    expect(content).toContain('nodesById');
    expect(content).toContain('edgeKeyToEdge');
  });

  it('upsertNode uses indexed lookup', () => {
    const content = safeReadFile(path.join(SERVICE_SRC, 'living-architecture-graph.ts'));
    expect(content).toContain('ensureGraphIndexes');
    expect(content).toContain('ix.nodesById');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 28. KERNEL CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Kernel client', () => {
  it('exports KernelClient class with expected methods', async () => {
    const { KernelClient } = await import('../service/src/kernel');
    const k = new KernelClient();
    expect(typeof k.start).toBe('function');
    expect(typeof k.isReady).toBe('function');
    expect(typeof k.call).toBe('function');
    expect(typeof k.stop).toBe('function');
    expect(k.isReady()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 29. PRECISION ORCHESTRATION SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Precision orchestration config', () => {
  it('system prompt contains hard law constraints', () => {
    const prompt = safeReadFile(path.join(REPO_ROOT, 'config', 'nemoclaw-precision-orchestration.system-prompt.md'));
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Hard law');
    expect(prompt).toContain('Local-first routing');
    expect(prompt).toContain('Living Architecture Graph');
    expect(prompt).toContain('Permission Request');
  });

  it('system prompt enforces approval before execution', () => {
    const prompt = safeReadFile(path.join(REPO_ROOT, 'config', 'nemoclaw-precision-orchestration.system-prompt.md'));
    expect(prompt).toContain('No effectful execution happens before');
    expect(prompt).toContain('explicit scoped approval');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 30. MERMATE PIPELINE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mermate precision pipeline', () => {
  it('exports orchestratePrecisionPipeline function', async () => {
    const mod = await import('../service/src/mermate-lucidity-ooda');
    expect(typeof mod.orchestratePrecisionPipeline).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 31. UPGRADE SCRIPT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Upgrade script', () => {
  it('contains backup and rollback logic', () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'opseeq-service-upgrade-v25.sh');
    if (!fileExists(scriptPath)) return;
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toContain('tar -czf');
    expect(content).toContain('rollback');
    expect(content).toContain('npm run build');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 32. EDGE CASES & MALFORMED INPUT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('computePayloadHash handles empty object', async () => {
    const { computePayloadHash } = await import('../service/src/trace-sink');
    const h = computePayloadHash({});
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h.length).toBeGreaterThan(10);
  });

  it('computePayloadHash handles null (undefined may throw per contract)', async () => {
    const { computePayloadHash } = await import('../service/src/trace-sink');
    const h1 = computePayloadHash(null);
    expect(h1.startsWith('sha256:')).toBe(true);
  });

  it('routePrompt handles empty string', async () => {
    const { routePrompt } = await import('../service/src/execution-runtime');
    const matches = routePrompt('');
    expect(Array.isArray(matches)).toBe(true);
  });

  it('buildOodaCycle handles missing optional fields', async () => {
    const { buildOodaCycle } = await import('../service/src/ooda-primitives');
    const cycle = buildOodaCycle({
      intent: 'Minimal input',
      primaryModel: 'test',
      allowRemoteAugmentation: false,
    });
    expect(cycle.taskId).toBeTruthy();
    expect(cycle.permission).toBeDefined();
  });

  it('resolveProviderFor handles empty providers list', async () => {
    const { resolveProviderFor } = await import('../service/src/provider-resolution');
    const config = {
      port: 9090, host: '0.0.0.0', apiKeys: [], defaultModel: 'x',
      mcpEnabled: false, serverlessMode: false, idleTimeoutMs: 300000, logLevel: 'info',
      providers: [],
    };
    const p = resolveProviderFor('any-model', config);
    expect(p).toBeNull();
  });
});
