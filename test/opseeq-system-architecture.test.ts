import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../service/src/config';

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): ServiceConfig {
  return {
    port: 9090,
    host: '127.0.0.1',
    apiKeys: [],
    providers: [
      { name: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: 'ollama', models: ['gpt-oss:20b'], priority: -10 },
    ],
    defaultModel: 'gpt-oss:20b',
    mcpEnabled: true,
    serverlessMode: false,
    idleTimeoutMs: 300000,
    logLevel: 'info',
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('system architecture contract', () => {
  it('builds a unified architecture snapshot from existing ledgers and role contracts', async () => {
    const home = makeTempHome('opseeq-system-home-');
    process.env.HOME = home;
    vi.resetModules();

    const trace = await import('../service/src/trace-sink');
    const temporal = await import('../service/src/temporal-causality');
    const system = await import('../service/src/system-architecture');

    trace.writeImmutableArtifact('system-test', 'sys-task-1', { ok: true });
    temporal.appendTemporalEvent({
      taskId: 'sys-task-1',
      parentId: null,
      actor: 'opseeq',
      kind: 'observe',
      summary: 'System contract observed existing ledgers.',
      approvalState: 'not_required',
      metadata: {},
    });

    const snapshot = system.buildSystemArchitectureSnapshot(testConfig(), {
      taskId: 'sys-task-1',
      artifactLimit: 10,
      eventLimit: 10,
      sessionLimit: 5,
    });

    expect(snapshot.components.some((component) => component.id === 'supervisor-runtime')).toBe(true);
    expect(snapshot.apiGroups.some((group) => group.routes.some((route) => route.path === '/api/system/architecture'))).toBe(true);
    expect(snapshot.roles.some((role) => role.id === 'guardrail')).toBe(true);
    expect(snapshot.guardrails.some((rule) => rule.id === 'credentials' && rule.default === 'deny')).toBe(true);
    expect(snapshot.modelRouting.defaultModel).toBe('gpt-oss:20b');
    expect(snapshot.observability.counts.immutableArtifacts).toBeGreaterThanOrEqual(2);
    expect(snapshot.observability.counts.temporalEvents).toBe(1);
    expect(snapshot.observability.recentTemporalEvents[0].summary).toContain('observed existing ledgers');
  });

  it('builds a read-only supervisor plan with hard blocks before execution', async () => {
    const home = makeTempHome('opseeq-supervisor-home-');
    process.env.HOME = home;
    vi.resetModules();

    const { buildSupervisorPlan } = await import('../service/src/system-architecture');
    const plan = buildSupervisorPlan({
      intent: 'Update dashboard files and remove generated artifacts.',
      repoPath: '/tmp/opseeq',
      appId: 'opseeq',
      approved: true,
      requestedCommands: ['rm -rf /tmp/opseeq/generated'],
      fileScope: ['/tmp/opseeq/dashboard/**'],
      expectedArtifacts: ['validation'],
    }, testConfig());

    expect(plan.whitePane.keyQuestions.length).toBeGreaterThan(0);
    expect(plan.whitePane.detailedPlan.some((step) => step.startsWith('Observe:'))).toBe(true);
    expect(plan.whitePane.permissionRequest.commands).toContain('rm -rf /tmp/opseeq/generated');
    expect(plan.approval.granted).toBe(false);
    expect(plan.approval.hardBlocks.some((block) => block.includes('rollback artifact'))).toBe(true);
    expect(plan.executionEnvelope.approvedCommands).toHaveLength(0);
    expect(plan.executionEnvelope.planHash).toMatch(/^sha256:/);
  });
});

describe('dashboard system architecture UI', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  it('renders system contract structure in the v2.5 Systems panel', () => {
    const html = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');

    expect(html).toContain('System Architecture Contract');
    expect(html).toContain('system-component-list');
    expect(html).toContain('system-role-list');
    expect(html).toContain('system-guardrail-list');
    expect(html).toContain('system-api-list');
    expect(html).toContain('btn-system-refresh');
  });

  it('fetches system architecture endpoints from dashboard JavaScript', () => {
    const js = fs.readFileSync(path.join(root, 'dashboard', 'public', 'js', 'app.js'), 'utf8');

    expect(js).toContain('/api/system/architecture');
    expect(js).toContain('/api/system/api');
    expect(js).toContain('/api/system/roles');
    expect(js).toContain('/api/system/observability');
    expect(js).toContain('/api/system/guardrails');
    expect(js).toContain('renderSystemArchitecture');
  });

  it('includes system contract dashboard styles', () => {
    const css = fs.readFileSync(path.join(root, 'dashboard', 'public', 'css', 'opseeq.css'), 'utf8');

    expect(css).toContain('.system-contract-list');
    expect(css).toContain('.system-contract-item');
    expect(css).toContain('.system-contract-tags');
  });
});
