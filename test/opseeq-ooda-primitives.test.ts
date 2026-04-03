import { describe, expect, it } from 'vitest';

import { buildOodaCycle } from '../service/src/ooda-primitives';

describe('buildOodaCycle', () => {
  it('produces ranked actions and a scoped permission envelope', () => {
    const cycle = buildOodaCycle({
      taskId: 'task-ooda-1',
      intent: 'Turn an idea into a formalized local-first desktop application.',
      repoPath: '/tmp/example-repo',
      appId: 'mermate',
      primaryModel: 'gpt-oss:20b',
      allowRemoteAugmentation: false,
    });

    expect(cycle.taskId).toBe('task-ooda-1');
    expect(cycle.keyUnknowns.length).toBeGreaterThanOrEqual(3);
    expect(cycle.detailedPlan[1]).toContain('Mermate -> Lucidity');
    expect(cycle.rankedActions[0].score).toBeGreaterThanOrEqual(cycle.rankedActions[1].score);
    expect(cycle.permission.requiresApproval).toBe(true);
    expect(cycle.permission.processScope).toContain('tmux');
    expect(cycle.planHash.startsWith('sha256:')).toBe(true);
  });

  it('only exposes remote network scope when remote augmentation is allowed', () => {
    const localOnly = buildOodaCycle({
      intent: 'Stay local.',
      primaryModel: 'gpt-oss:20b',
      allowRemoteAugmentation: false,
    });
    const remoteEnabled = buildOodaCycle({
      intent: 'Allow optional remote critique.',
      primaryModel: 'gpt-oss:20b',
      allowRemoteAugmentation: true,
    });

    expect(localOnly.rankedActions.find((action) => action.id === 'creativity-full-godmode')?.networkScope).toEqual([]);
    expect(remoteEnabled.rankedActions.find((action) => action.id === 'creativity-full-godmode')?.networkScope).toContain('https://api.anthropic.com/*');
  });
});
