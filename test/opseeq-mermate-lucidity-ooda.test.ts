import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('orchestrateGodModePipeline', () => {
  it('builds a non-executing God-mode plan with graph, causality, and immutable artifacts', async () => {
    const home = makeTempHome('opseeq-godmode-home-');
    process.env.HOME = home;
    vi.resetModules();

    const { orchestrateGodModePipeline } = await import('../service/src/mermate-lucidity-ooda');

    const result = await orchestrateGodModePipeline({
      intent: 'Simple idea to formal architecture and desktop app.',
      repoPath: '/Users/dylanckawalec/Desktop/developer/opseeq',
      appId: 'mermate',
      inputMode: 'idea',
      approved: false,
      execute: false,
      includeTla: true,
      includeTs: true,
      includeRust: true,
      allowModelCritique: false,
    }, {
      port: 9090,
      host: '127.0.0.1',
      apiKeys: [],
      providers: [],
      defaultModel: 'gpt-oss:20b',
      mcpEnabled: true,
      serverlessMode: false,
      idleTimeoutMs: 300000,
      logLevel: 'info',
    });

    expect(result.primaryModel).toBe('gpt-oss:20b');
    expect(result.extensionPacks.some((pack) => pack.id === 'mermate-max-ooda')).toBe(true);
    expect(result.stageResults.some((stage) => stage.stage === 'mermate_max_render' && stage.status === 'pending_approval')).toBe(true);
    expect(result.executionEnvelope.approved).toBe(false);
    expect(result.critique.source).toBe('heuristic');
    expect(result.livingArchitectureGraph.versionId.length).toBeGreaterThan(0);
    expect(result.temporalCausality.length).toBeGreaterThan(0);
    expect(result.artifacts.length).toBeGreaterThanOrEqual(4);

    const artifactRoot = path.join(home, '.opseeq-superior', 'artifacts');
    expect(fs.existsSync(artifactRoot)).toBe(true);
  });
});
