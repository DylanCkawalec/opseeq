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

describe('Temporal Causality Tree', () => {
  it('preserves parent-child event lineage', async () => {
    const home = makeTempHome('opseeq-causality-home-');
    process.env.HOME = home;
    vi.resetModules();

    const module = await import('../service/src/temporal-causality');
    const root = module.appendTemporalEvent({
      taskId: 'causality-task-1',
      parentId: null,
      actor: 'human',
      kind: 'intent_received',
      summary: 'Start the task.',
      approvalState: 'pending',
      metadata: {},
    });
    module.appendTemporalEvent({
      taskId: 'causality-task-1',
      parentId: root.id,
      actor: 'nemoclaw',
      kind: 'observe',
      summary: 'Inspect the context.',
      approvalState: 'not_required',
      metadata: { scope: 'repo' },
    });

    const tree = module.buildTemporalCausalityTree('causality-task-1');
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].kind).toBe('observe');

    const logPath = path.join(home, '.opseeq-superior', 'logs', 'temporal-causality.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
  });
});
