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

describe('Living Architecture Graph', () => {
  it('versions graph nodes and edges for a task', { timeout: 30_000 }, async () => {
    const home = makeTempHome('opseeq-graph-home-');
    process.env.HOME = home;
    vi.resetModules();

    const graphModule = await import('../service/src/living-architecture-graph');
    const result = graphModule.syncLivingArchitectureGraph({
      taskId: 'graph-task-1',
      intent: 'Create a local-first architecture pipeline.',
      appId: 'mermate',
      extensionIds: ['mermate-max-ooda', 'living-architecture-graph'],
      planSteps: ['Observe', 'Orient', 'Decide', 'Act'],
      critiqueSummary: 'The plan is structurally sound.',
    });

    expect(result.version.taskId).toBe('graph-task-1');
    expect(result.graph.nodes.some((node) => node.id === 'service-mermate')).toBe(true);
    expect(result.graph.edges.some((edge) => edge.relation === 'produces')).toBe(true);
    expect(result.diagram).toContain('Living Architecture Graph');

    const graphPath = path.join(home, '.opseeq-superior', 'living-architecture-graph.json');
    expect(fs.existsSync(graphPath)).toBe(true);

    const loaded = graphModule.getLivingArchitectureGraph();
    expect(loaded.versions.length).toBe(1);
  });
});
