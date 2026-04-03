import crypto from 'node:crypto';

export interface KeyUnknown {
  question: string;
  assumption: string;
  blocking: boolean;
}

export interface RankedAction {
  id: string;
  label: string;
  category: 'velocity' | 'security' | 'creativity';
  description: string;
  velocity: number;
  security: number;
  creativity: number;
  risk: number;
  score: number;
  commands: string[];
  fileScope: string[];
  networkScope: string[];
}

export interface PermissionEnvelope {
  requiresApproval: boolean;
  summary: string;
  commands: string[];
  fileScope: string[];
  networkScope: string[];
  processScope: string[];
  destructive: boolean;
}

export interface OodaCycle {
  taskId: string;
  keyUnknowns: KeyUnknown[];
  detailedPlan: string[];
  rankedActions: RankedAction[];
  riskAssessment: Record<string, string>;
  permission: PermissionEnvelope;
  planHash: string;
}

export interface BuildOodaCycleInput {
  taskId?: string;
  intent: string;
  repoPath?: string | null;
  appId?: string | null;
  primaryModel: string;
  allowRemoteAugmentation: boolean;
}

function hashPlan(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(5, value));
}

function finalScore(action: Omit<RankedAction, 'score'>): number {
  const raw = 0.40 * action.security + 0.35 * action.velocity + 0.25 * action.creativity - 0.50 * action.risk;
  return Math.round(raw * 100) / 100;
}

export function rankActions(actions: Array<Omit<RankedAction, 'score'>>): RankedAction[] {
  return actions
    .map((action) => ({ ...action, score: finalScore(action) }))
    .sort((left, right) => right.score - left.score);
}

export function buildOodaCycle(input: BuildOodaCycleInput): OodaCycle {
  const taskId = input.taskId || `task-${Date.now().toString(36)}`;
  const keyUnknowns: KeyUnknown[] = [
    {
      question: 'Is the runnable Mermate service online and able to execute MAX-mode render and downstream TLA+/TS/Rust stages?',
      assumption: 'If unavailable, Opseeq will still produce a full plan and execution envelope without live render output.',
      blocking: false,
    },
    {
      question: 'Does Lucidity have the exact artifacts needed for semantic/image cleanup, or must Opseeq stage them first?',
      assumption: 'Lucidity review artifacts will be staged by Opseeq when not already present.',
      blocking: false,
    },
    {
      question: 'Has the human approved the full compile chain through Rust binary and macOS app packaging?',
      assumption: 'Execution stays at planning and artifact generation until the approval gate is explicitly satisfied.',
      blocking: true,
    },
  ];

  const detailedPlan = [
    `Observe the repo scope${input.repoPath ? ` at ${input.repoPath}` : ''}, selected app${input.appId ? ` (${input.appId})` : ''}, and current local model posture (${input.primaryModel}).`,
    'Orient with a local gpt-oss:20b-first assessment and map the intent into the repeatable Mermate -> Lucidity -> Approval -> TLA+ -> TypeScript -> Rust -> .app pipeline.',
    'Generate ranked action paths and a scoped permission envelope before any effectful operation.',
    'If approved, run the stage chain under full temporal causality and immutable artifact logging.',
    'Conclude with self-reflective meta-critique, graph versioning, and rollback artifacts.',
  ];

  const rankedActions = rankActions([
    {
      id: 'velocity-local-assessment',
      label: 'Velocity-first local assessment',
      category: 'velocity',
      description: 'Use gpt-oss:20b locally to assess the idea, produce the Living Graph, and defer compile stages until approval.',
      velocity: clampScore(4.8),
      security: clampScore(4.4),
      creativity: clampScore(3.8),
      risk: clampScore(1.2),
      commands: [],
      fileScope: input.repoPath ? [input.repoPath] : [],
      networkScope: [],
    },
    {
      id: 'security-review-first',
      label: 'Security-first gated architecture review',
      category: 'security',
      description: 'Keep the flow read-only through Mermate/Lucidity planning, request approval, then compile only after explicit confirmation.',
      velocity: clampScore(3.4),
      security: clampScore(5),
      creativity: clampScore(4.1),
      risk: clampScore(0.8),
      commands: [],
      fileScope: input.repoPath ? [input.repoPath] : [],
      networkScope: [],
    },
    {
      id: 'creativity-full-godmode',
      label: 'Creativity-first full God-mode chain',
      category: 'creativity',
      description: 'Drive MAX-mode Mermate architecture generation, Lucidity cleanup, and the full TLA+/TS/Rust path in one orchestrated cycle.',
      velocity: clampScore(3.9),
      security: clampScore(3.6),
      creativity: clampScore(5),
      risk: clampScore(input.allowRemoteAugmentation ? 2.4 : 1.8),
      commands: ['mermate render', 'mermate tla', 'mermate ts', 'mermate rust'],
      fileScope: input.repoPath ? [input.repoPath] : [],
      networkScope: input.allowRemoteAugmentation ? ['https://api.anthropic.com/*'] : [],
    },
  ]);

  const recommended = rankedActions[0];
  const permission: PermissionEnvelope = {
    requiresApproval: true,
    summary: 'Approval required before render, code generation, or packaging stages begin.',
    commands: recommended.commands,
    fileScope: recommended.fileScope,
    networkScope: recommended.networkScope,
    processScope: ['tmux', 'iTerm2', 'general-clawd'],
    destructive: false,
  };

  const riskAssessment = {
    malware: 'Deny-and-ask stays active. Persistence vectors and unauthorized egress remain blocked.',
    dataDeletion: 'No destructive operations are included in the recommended path. Rollback artifacts are mandatory before writes.',
    privacy: input.allowRemoteAugmentation ? 'Remote augmentation is possible but out-of-trust and must be explicitly approved.' : 'All planning and critique remain local by default.',
    credentialExposure: 'Secrets are redacted in logs and never surfaced as plain-text approval context.',
    runtimeInstability: 'The MAX render and full compile chain can fail if Mermate is offline; the flow degrades to planning artifacts.',
    rollback: 'Every effectful stage requires an immutable artifact and rollback manifest.',
  };

  return {
    taskId,
    keyUnknowns,
    detailedPlan,
    rankedActions,
    riskAssessment,
    permission,
    planHash: hashPlan({ keyUnknowns, detailedPlan, rankedActions, riskAssessment, permission }),
  };
}
