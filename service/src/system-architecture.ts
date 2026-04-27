/**
 * @module system-architecture — Opseeq System Contract
 *
 * Axiom S1: The system architecture contract is descriptive and read-only unless an explicit
 * supervisor planning request asks for an approval envelope.
 * Axiom S2: Existing ledgers remain the source of truth; this module aggregates rather than
 * duplicating artifact, causality, execution, extension, or role state.
 * Postulate S1: Every public API group has an explicit auth and side-effect contract.
 * Postulate S2: Every agent role has a stable responsibility, model policy, inputs, outputs,
 * and observability hooks.
 * Corollary S1: The supervisor plan always renders white-pane blocks before any black-pane
 * execution envelope can become approved.
 * Tracing Invariant: Observability snapshots reference artifact hashes and event IDs, never
 * inline secret values.
 */
import crypto from 'node:crypto';
import type { ServiceConfig } from './config.js';
import { getExtensionRegistry, getPrecisionOrchestrationRoutingDefaults } from './extension-registry.js';
import { getAbsorptionStatus, listSessions } from './execution-runtime.js';
import { listImmutableArtifacts, computePayloadHash } from './trace-sink.js';
import { listTemporalEvents } from './temporal-causality.js';

export type ComponentLayer = 'ui' | 'gateway' | 'runtime' | 'policy' | 'observability' | 'integration' | 'copilot';
export type ComponentStatus = 'implemented' | 'implemented-via-existing-module' | 'external-or-optional' | 'planned';
export type ApiSideEffect = 'none' | 'read-local-state' | 'writes-artifacts' | 'launches-process' | 'executes-approved-envelope';
export type RoleKind = 'supervisor' | 'planner' | 'verifier' | 'executor' | 'observer' | 'coder' | 'guardrail' | 'model-router';
export type GuardrailDefault = 'allow' | 'ask' | 'deny' | 'deny-and-ask';
export type GuardrailLayer = 'preventive' | 'live-observability' | 'anomaly-defense';

export interface ArchitectureComponent {
  id: string;
  label: string;
  layer: ComponentLayer;
  status: ComponentStatus;
  implementation: string[];
  responsibilities: string[];
  observability: string[];
  dependencies: string[];
}

export interface ApiRouteContract {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'GET/POST';
  path: string;
  auth: 'public' | 'protected' | 'local-dashboard' | 'mixed';
  sideEffect: ApiSideEffect;
  description: string;
}

export interface ApiGroupContract {
  id: string;
  label: string;
  purpose: string;
  routes: ApiRouteContract[];
}

export interface AgentRoleContract {
  id: RoleKind;
  label: string;
  source: string;
  modelAlias: string;
  responsibilities: string[];
  inputs: string[];
  outputs: string[];
  requiredArtifacts: string[];
  observabilityHooks: string[];
  hardLimits: string[];
}

export interface GuardrailRule {
  id: string;
  layer: GuardrailLayer;
  operation: string;
  default: GuardrailDefault;
  requiresApproval: boolean;
  blockConditions: string[];
  observabilityEvents: string[];
}

export interface SystemObservabilitySnapshot {
  generatedAt: string;
  taskId: string | null;
  durableStores: Array<{
    id: string;
    label: string;
    implementation: string;
    durability: 'memory' | 'disk' | 'external';
    summary: string;
  }>;
  counts: {
    immutableArtifacts: number;
    temporalEvents: number;
    executionSessions: number;
    extensionPacks: number;
  };
  recentArtifacts: Array<{
    id: string;
    taskId: string;
    kind: string;
    createdAt: string;
    hash: string;
    path: string;
  }>;
  recentTemporalEvents: Array<{
    id: string;
    taskId: string;
    actor: string;
    kind: string;
    timestamp: string;
    approvalState: string;
    summary: string;
  }>;
  recentExecutionSessions: Array<{
    sessionId: string;
    createdAt: string;
    prompt: string;
  }>;
  traceRankContract: {
    role: string;
    notPolicyEngine: true;
    promotionSignals: string[];
    rollbackSignals: string[];
  };
}

export interface SupervisorPlanInput {
  intent: string;
  repoPath?: string;
  appId?: string;
  operator?: string;
  approved?: boolean;
  requestedCommands?: string[];
  fileScope?: string[];
  networkScope?: string[];
  processScope?: string[];
  modelPolicy?: {
    supervisorModel?: string;
    executionModel?: string;
    allowRemoteAugmentation?: boolean;
  };
  expectedArtifacts?: string[];
  stopConditions?: string[];
}

export interface SupervisorPlan {
  taskId: string;
  generatedAt: string;
  mode: 'planning_only' | 'approved_execution';
  whitePane: {
    taskHeader: {
      taskId: string;
      appId: string;
      repoPath: string | null;
      supervisorModel: string;
      executionModel: string;
      policyBadge: string;
    };
    keyQuestions: string[];
    detailedPlan: string[];
    rankedActions: Array<{
      id: string;
      label: string;
      score: number;
      rationale: string;
    }>;
    riskAssessment: Array<{
      risk: string;
      level: 'low' | 'medium' | 'high';
      rationale: string;
    }>;
    permissionRequest: {
      commands: string[];
      files: string[];
      network: string[];
      processes: string[];
      modelRouting: {
        supervisorModel: string;
        executionModel: string;
        allowRemoteAugmentation: boolean;
      };
      expectedArtifacts: string[];
    };
    liveObservability: string[];
  };
  approval: {
    required: true;
    granted: boolean;
    state: 'pending' | 'approved';
    hardBlocks: string[];
  };
  executionEnvelope: {
    taskId: string;
    mode: 'approved_execution';
    operator: string;
    repoPath: string | null;
    approved: boolean;
    planHash: string;
    approvedCommands: string[];
    fileScope: string[];
    networkScope: string[];
    processScope: string[];
    modelPolicy: {
      supervisorModel: string;
      executionModel: string;
      allowRemoteAugmentation: boolean;
    };
    stopConditions: string[];
    rollback: string[];
  };
}

export interface SystemArchitectureSnapshot {
  generatedAt: string;
  version: string;
  productIntent: string;
  components: ArchitectureComponent[];
  apiGroups: ApiGroupContract[];
  roles: AgentRoleContract[];
  guardrails: GuardrailRule[];
  modelRouting: ReturnType<typeof getPrecisionOrchestrationRoutingDefaults> & {
    providerOrder: string[];
    defaultModel: string;
  };
  observability: SystemObservabilitySnapshot;
  invariants: string[];
}

export const SYSTEM_COMPONENTS: ArchitectureComponent[] = [
  {
    id: 'dashboard-ui',
    label: 'Dashboard UI',
    layer: 'ui',
    status: 'implemented',
    implementation: ['dashboard/server.js', 'dashboard/public/index.html', 'dashboard/public/js/app.js'],
    responsibilities: ['Render operator status', 'Proxy gateway routes', 'Host terminal profile WebSocket clients'],
    observability: ['Gateway status cards', 'Recent event lines', 'v2.5 system contract cards'],
    dependencies: ['opseeq-gateway'],
  },
  {
    id: 'opseeq-gateway',
    label: 'Opseeq gateway',
    layer: 'gateway',
    status: 'implemented',
    implementation: ['service/src/index.ts', 'service/src/router.ts', 'service/src/mcp-server.ts'],
    responsibilities: ['HTTP API', 'OpenAI-compatible routing', 'MCP SSE transport', 'Status aggregation'],
    observability: ['x-request-id logs', 'GET /api/status', 'MCP opseeq_status'],
    dependencies: ['configured-providers', 'living-architecture-graph', 'artifact-ledger'],
  },
  {
    id: 'supervisor-runtime',
    label: 'Supervisor runtime',
    layer: 'runtime',
    status: 'implemented-via-existing-module',
    implementation: ['service/src/system-architecture.ts', 'service/src/mermate-lucidity-ooda.ts'],
    responsibilities: ['Plan before execution', 'Rank actions', 'Build permission envelope', 'Keep execution gated'],
    observability: ['Supervisor plan hash', 'Temporal approval events', 'Immutable execution-envelope artifacts'],
    dependencies: ['guardrail-engine', 'model-router', 'artifact-ledger'],
  },
  {
    id: 'guardrail-engine',
    label: 'Guardrail engine',
    layer: 'policy',
    status: 'implemented-via-existing-module',
    implementation: ['service/src/system-architecture.ts', 'service/src/execution-runtime.ts', 'config/nemoclaw-superior-policy.yaml'],
    responsibilities: ['Deny destructive actions by default', 'Require scope for writes/network/processes', 'Preserve audit logs'],
    observability: ['Guardrail rules endpoint', 'Permission denials in execution sessions', 'Temporal approval state'],
    dependencies: ['supervisor-runtime'],
  },
  {
    id: 'model-router',
    label: 'Model router',
    layer: 'gateway',
    status: 'implemented',
    implementation: ['service/src/provider-resolution.ts', 'service/src/router.ts', 'service/src/extension-registry.ts'],
    responsibilities: ['Resolve provider priority', 'Resolve nemotron aliases', 'Resolve role aliases', 'Attach extension defaults'],
    observability: ['GET /api/nemotron/aliases', 'GET /api/seeq/roles', 'system model routing snapshot'],
    dependencies: ['configured-providers'],
  },
  {
    id: 'execution-runtime',
    label: 'Native execution runtime',
    layer: 'runtime',
    status: 'implemented',
    implementation: ['service/src/execution-runtime.ts'],
    responsibilities: ['Absorb General-Clawd command/tool/session concepts', 'Route prompts to commands/tools', 'Persist sessions'],
    observability: ['GET /api/absorption/status', 'GET /api/execution/sessions', '~/.opseeq-superior/sessions'],
    dependencies: ['guardrail-engine'],
  },
  {
    id: 'terminal-bridge',
    label: 'Terminal bridge',
    layer: 'runtime',
    status: 'implemented-via-existing-module',
    implementation: ['dashboard/server.js', 'dashboard/scripts/pty_bridge.py', 'service/src/iterm2-adaptive-plug.ts'],
    responsibilities: ['Provide browser terminal profiles', 'Mirror adaptive pipeline shell behavior', 'Support tmux/iTerm2 pipeline sessions'],
    observability: ['WebSocket terminal events', 'Adaptive pipeline transcripts', 'Pipeline stage status'],
    dependencies: ['execution-runtime'],
  },
  {
    id: 'artifact-ledger',
    label: 'Artifact ledger',
    layer: 'observability',
    status: 'implemented',
    implementation: ['service/src/trace-sink.ts'],
    responsibilities: ['Write immutable content-addressed artifacts', 'List recent artifacts', 'Expose artifact hashes'],
    observability: ['~/.opseeq-superior/artifacts/<task-id>/*.json'],
    dependencies: [],
  },
  {
    id: 'temporal-causality',
    label: 'Temporal causality ledger',
    layer: 'observability',
    status: 'implemented',
    implementation: ['service/src/temporal-causality.ts'],
    responsibilities: ['Append causal JSONL events', 'Build per-task causality tree', 'Mirror events as artifacts'],
    observability: ['~/.opseeq-superior/logs/temporal-causality.jsonl'],
    dependencies: ['artifact-ledger'],
  },
  {
    id: 'copilot-qgot',
    label: 'QGoT-backed Copilot',
    layer: 'copilot',
    status: 'implemented',
    implementation: ['copilot/api/*.go', 'copilot/agents/*.ts', 'copilot/obs/*.ts'],
    responsibilities: ['Plan/verify/execute/observe workflows', 'Expose REST/GraphQL/SSE', 'Call QGoT MCP production command'],
    observability: ['copilot/runs/<run-id>', 'QGOT_RUN_DIR', 'Copilot metrics routes'],
    dependencies: ['QGOT_MCP_CMD'],
  },
];

export const SYSTEM_API_GROUPS: ApiGroupContract[] = [
  {
    id: 'health-openai',
    label: 'Health and OpenAI compatibility',
    purpose: 'Expose gateway health and OpenAI-compatible inference routes.',
    routes: [
      { method: 'GET', path: '/health', auth: 'public', sideEffect: 'none', description: 'Gateway liveness and provider summary.' },
      { method: 'GET', path: '/v1/models', auth: 'protected', sideEffect: 'read-local-state', description: 'Configured model list.' },
      { method: 'POST', path: '/v1/chat/completions', auth: 'protected', sideEffect: 'writes-artifacts', description: 'OpenAI-compatible chat completion with optional stream.' },
      { method: 'POST', path: '/v1/embeddings', auth: 'protected', sideEffect: 'none', description: 'Embedding provider proxy.' },
    ],
  },
  {
    id: 'system-architecture',
    label: 'System architecture contract',
    purpose: 'Expose component topology, API design, roles, guardrails, observability, and read-only supervisor plans.',
    routes: [
      { method: 'GET', path: '/api/system/architecture', auth: 'protected', sideEffect: 'read-local-state', description: 'Full system contract snapshot.' },
      { method: 'GET', path: '/api/system/api', auth: 'protected', sideEffect: 'none', description: 'API group and route contracts.' },
      { method: 'GET', path: '/api/system/roles', auth: 'protected', sideEffect: 'none', description: 'Agent role contracts.' },
      { method: 'GET', path: '/api/system/observability', auth: 'protected', sideEffect: 'read-local-state', description: 'Unified observability snapshot.' },
      { method: 'GET', path: '/api/system/guardrails', auth: 'protected', sideEffect: 'none', description: 'Guardrail rule matrix.' },
      { method: 'POST', path: '/api/system/supervisor/plan', auth: 'protected', sideEffect: 'none', description: 'White-pane plan and approval envelope.' },
    ],
  },
  {
    id: 'status-control',
    label: 'Gateway status and local controls',
    purpose: 'Report readiness and operate connected local app/repo surfaces.',
    routes: [
      { method: 'GET', path: '/api/status', auth: 'protected', sideEffect: 'read-local-state', description: 'Aggregated gateway status.' },
      { method: 'POST', path: '/api/repos/connect', auth: 'protected', sideEffect: 'writes-artifacts', description: 'Analyze and wire a local repo.' },
      { method: 'POST', path: '/api/apps/open', auth: 'protected', sideEffect: 'launches-process', description: 'Open or launch a managed local app.' },
      { method: 'GET/POST', path: '/api/nemoclaw/*', auth: 'protected', sideEffect: 'launches-process', description: 'NemoClaw sandbox controls.' },
    ],
  },
  {
    id: 'precision-graph',
    label: 'Precision OODA and Living Architecture Graph',
    purpose: 'Plan precision workflows, write immutable artifacts, and version graph state.',
    routes: [
      { method: 'GET', path: '/api/ooda/extensions', auth: 'protected', sideEffect: 'none', description: 'Extension registry and routing defaults.' },
      { method: 'GET', path: '/api/ooda/dashboard', auth: 'protected', sideEffect: 'read-local-state', description: 'Graph dashboard summary.' },
      { method: 'GET', path: '/api/ooda/graph', auth: 'protected', sideEffect: 'read-local-state', description: 'Graph snapshot and query.' },
      { method: 'POST', path: '/api/ooda/graph/refresh', auth: 'protected', sideEffect: 'writes-artifacts', description: 'Refresh graph and optionally write a version artifact.' },
      { method: 'POST', path: '/api/ooda/precision', auth: 'protected', sideEffect: 'writes-artifacts', description: 'Precision plan or approved execution pipeline.' },
    ],
  },
  {
    id: 'execution-pipeline',
    label: 'Execution runtime and adaptive pipeline',
    purpose: 'Expose absorbed execution runtime, terminal pipeline stages, subagents, AgentOS, and model residency helpers.',
    routes: [
      { method: 'GET', path: '/api/absorption/status', auth: 'public', sideEffect: 'none', description: 'General-Clawd absorption status.' },
      { method: 'GET/POST', path: '/api/execution/*', auth: 'mixed', sideEffect: 'read-local-state', description: 'Execution tools, sessions, bootstrap, and routing.' },
      { method: 'GET/POST', path: '/api/pipeline/*', auth: 'mixed', sideEffect: 'executes-approved-envelope', description: 'Adaptive pipeline session and stage execution.' },
      { method: 'GET/POST', path: '/api/subagents/*', auth: 'mixed', sideEffect: 'writes-artifacts', description: 'Delegated subagent task surfaces.' },
      { method: 'GET/POST', path: '/api/agent-os/*', auth: 'mixed', sideEffect: 'launches-process', description: 'AgentOS VM/session operations.' },
      { method: 'GET/POST', path: '/api/nemotron/*, /api/seeq/*', auth: 'mixed', sideEffect: 'read-local-state', description: 'Alias resolution and model residency.' },
    ],
  },
  {
    id: 'mcp',
    label: 'Gateway MCP',
    purpose: 'Provide agentic access to gateway, precision, graph, browser-use, and system-contract tools.',
    routes: [
      { method: 'GET', path: '/mcp', auth: 'protected', sideEffect: 'read-local-state', description: 'MCP SSE session creation.' },
      { method: 'POST', path: '/mcp/messages', auth: 'protected', sideEffect: 'read-local-state', description: 'MCP session message handler.' },
    ],
  },
];

export const AGENT_ROLE_CONTRACTS: AgentRoleContract[] = [
  {
    id: 'supervisor',
    label: 'Supervisor Runtime',
    source: 'service/src/system-architecture.ts',
    modelAlias: 'role:reason',
    responsibilities: ['Receive human intent', 'Render white-pane plan', 'Enforce approval envelope', 'Coordinate roles'],
    inputs: ['intent', 'repoPath', 'appId', 'requestedCommands', 'fileScope', 'networkScope'],
    outputs: ['keyQuestions', 'detailedPlan', 'rankedActions', 'riskAssessment', 'permissionRequest', 'executionEnvelope'],
    requiredArtifacts: ['supervisor-plan', 'execution-envelope', 'validation'],
    observabilityHooks: ['planHash', 'approval.state', 'temporal approve events'],
    hardLimits: ['No effectful action before approval', 'No external model output can override local policy'],
  },
  {
    id: 'planner',
    label: 'Expert Planner',
    source: 'copilot/agents/planner.ts and service/src/mermate-lucidity-ooda.ts',
    modelAlias: 'role:reason',
    responsibilities: ['Decompose objective', 'Build OODA plan', 'Choose extension packs', 'Produce formal action graph'],
    inputs: ['human intent', 'fractal context', 'extension registry', 'model routing defaults'],
    outputs: ['ranked plan', 'plan hash', 'stage proposals'],
    requiredArtifacts: ['fractal-context', 'ooda-cycle'],
    observabilityHooks: ['temporal observe/orient/decide', 'living graph plan nodes'],
    hardLimits: ['Plan must remain read-only until approval is present'],
  },
  {
    id: 'verifier',
    label: 'Expert Verifier',
    source: 'copilot/agents/verifier.ts',
    modelAlias: 'role:reference',
    responsibilities: ['Review plan/result', 'Detect drift', 'Return structured verdict', 'Request corrections'],
    inputs: ['plan', 'artifacts', 'execution trace', 'policy constraints'],
    outputs: ['verdict', 'risk findings', 'validation summary'],
    requiredArtifacts: ['verification', 'validation'],
    observabilityHooks: ['verifier verdict events', 'DriftDetected events'],
    hardLimits: ['Unstructured approval cannot bypass hard policy failures'],
  },
  {
    id: 'executor',
    label: 'Expert Executor',
    source: 'copilot/agents/executor.ts and service/src/execution-runtime.ts',
    modelAlias: 'role:code',
    responsibilities: ['Order approved tasks', 'Call runtime tools', 'Persist execution sessions', 'Emit result events'],
    inputs: ['approved execution envelope', 'tool registry', 'task graph'],
    outputs: ['turn results', 'session transcript', 'execution artifacts'],
    requiredArtifacts: ['execution-envelope', 'session transcript', 'rollback patch when needed'],
    observabilityHooks: ['execution sessions', 'pipeline stage status', 'copilot exec.jsonl'],
    hardLimits: ['Destructive tools require explicit approval and rollback artifact'],
  },
  {
    id: 'observer',
    label: 'Expert Observer',
    source: 'copilot/agents/observer.ts and service/src/temporal-causality.ts',
    modelAlias: 'role:utility',
    responsibilities: ['Track lifecycle events', 'Score drift', 'Pause/resume runs', 'Maintain causal event lineage'],
    inputs: ['run events', 'temporal events', 'artifact metadata'],
    outputs: ['event timeline', 'drift signal', 'causality tree'],
    requiredArtifacts: ['temporal-causality-event'],
    observabilityHooks: ['trace.ndjson', 'temporal-causality.jsonl', 'artifact mirror'],
    hardLimits: ['No suppression of audit logs'],
  },
  {
    id: 'coder',
    label: 'Expert Coder',
    source: 'copilot/agents/coder.ts',
    modelAlias: 'role:code',
    responsibilities: ['Generate scoped code changes', 'Honor repository conventions', 'Prepare validation commands'],
    inputs: ['approved plan', 'file scope', 'coding task'],
    outputs: ['patch proposal', 'validation notes'],
    requiredArtifacts: ['codegen artifact', 'validation artifact'],
    observabilityHooks: ['artifact ledger', 'copilot coder events'],
    hardLimits: ['No writes outside approved file scope'],
  },
  {
    id: 'guardrail',
    label: 'Guardrail Engine',
    source: 'service/src/system-architecture.ts and config/nemoclaw-superior-policy.yaml',
    modelAlias: 'local-policy',
    responsibilities: ['Classify operations', 'Require approvals', 'Block hard-policy failures', 'Redact secrets'],
    inputs: ['commands', 'file scope', 'network scope', 'process scope', 'model policy'],
    outputs: ['policy badge', 'hard blocks', 'approval requirements'],
    requiredArtifacts: ['policy decision', 'audit manifest'],
    observabilityHooks: ['policy events', 'approval state', 'guardrail endpoint'],
    hardLimits: ['No credential readback', 'No hidden persistence', 'No unapproved remote API calls'],
  },
  {
    id: 'model-router',
    label: 'Model Router',
    source: 'service/src/provider-resolution.ts and service/src/extension-registry.ts',
    modelAlias: 'dynamic',
    responsibilities: ['Resolve role aliases', 'Keep local-first routing explicit', 'Gate remote augmentation', 'Attach extension defaults'],
    inputs: ['requested model', 'role alias', 'target app', 'provider config'],
    outputs: ['resolved provider', 'resolved model', 'extension pack IDs'],
    requiredArtifacts: ['model routing decision when part of a plan'],
    observabilityHooks: ['model aliases routes', 'system architecture modelRouting'],
    hardLimits: ['No remote escalation without explicit approval'],
  },
];

export const GUARDRAIL_RULES: GuardrailRule[] = [
  {
    id: 'read-approved-repo',
    layer: 'preventive',
    operation: 'Read files inside approved repo scope',
    default: 'allow',
    requiresApproval: false,
    blockConditions: ['Path is outside declared repo or file scope', 'Path targets credential material without task relevance'],
    observabilityEvents: ['filesRead'],
  },
  {
    id: 'write-approved-repo',
    layer: 'preventive',
    operation: 'Write files inside approved repo scope',
    default: 'ask',
    requiresApproval: true,
    blockConditions: ['Hidden/system path', 'No file scope', 'No rollback instruction for broad writes'],
    observabilityEvents: ['filesWritten', 'rollbackArtifact'],
  },
  {
    id: 'delete-files',
    layer: 'preventive',
    operation: 'Delete files or directories',
    default: 'deny-and-ask',
    requiresApproval: true,
    blockConditions: ['No rollback artifact', 'Path outside scope', 'Recursive delete without exact path'],
    observabilityEvents: ['policyEvents', 'rollbackArtifact'],
  },
  {
    id: 'local-process',
    layer: 'live-observability',
    operation: 'Start local process',
    default: 'ask',
    requiresApproval: true,
    blockConditions: ['Persistence/autostart side effect', 'Detached daemon without operator request'],
    observabilityEvents: ['processSpawned', 'commandLifecycle'],
  },
  {
    id: 'remote-api',
    layer: 'preventive',
    operation: 'Outbound remote API call or remote model escalation',
    default: 'deny-and-ask',
    requiresApproval: true,
    blockConditions: ['Host is not allowlisted', 'Remote augmentation not approved', 'Credential exposure risk'],
    observabilityEvents: ['networkDestinations', 'modelsUsed', 'remoteAugmentation'],
  },
  {
    id: 'credentials',
    layer: 'preventive',
    operation: 'Keychain, token, secret, or credential access',
    default: 'deny',
    requiresApproval: true,
    blockConditions: ['Reason is not task-relevant', 'Output would reveal secret plaintext'],
    observabilityEvents: ['redacted_secret', 'blocked_credential_access'],
  },
  {
    id: 'persistence',
    layer: 'anomaly-defense',
    operation: 'Launch agents, shell startup files, crontabs, or login hooks',
    default: 'deny',
    requiresApproval: true,
    blockConditions: ['No explicit maintenance task', 'No rollback path', 'Attempts to suppress audit logs'],
    observabilityEvents: ['blocked_persistence_attempt', 'policyEvents'],
  },
  {
    id: 'privilege-escalation',
    layer: 'anomaly-defense',
    operation: 'sudo/root/admin escalation',
    default: 'deny-and-ask',
    requiresApproval: true,
    blockConditions: ['No scoped justification', 'No exact command review', 'No stop condition'],
    observabilityEvents: ['blocked_privilege_escalation', 'approvalState'],
  },
];

function cloneComponents(): ArchitectureComponent[] {
  return SYSTEM_COMPONENTS.map((component) => ({
    ...component,
    implementation: [...component.implementation],
    responsibilities: [...component.responsibilities],
    observability: [...component.observability],
    dependencies: [...component.dependencies],
  }));
}

export function getSystemApiDesign(): ApiGroupContract[] {
  return SYSTEM_API_GROUPS.map((group) => ({
    ...group,
    routes: group.routes.map((route) => ({ ...route })),
  }));
}

export function getAgentRoleContracts(): AgentRoleContract[] {
  return AGENT_ROLE_CONTRACTS.map((role) => ({
    ...role,
    responsibilities: [...role.responsibilities],
    inputs: [...role.inputs],
    outputs: [...role.outputs],
    requiredArtifacts: [...role.requiredArtifacts],
    observabilityHooks: [...role.observabilityHooks],
    hardLimits: [...role.hardLimits],
  }));
}

export function getGuardrailRules(): GuardrailRule[] {
  return GUARDRAIL_RULES.map((rule) => ({
    ...rule,
    blockConditions: [...rule.blockConditions],
    observabilityEvents: [...rule.observabilityEvents],
  }));
}

export function buildSystemObservabilitySnapshot(options: {
  taskId?: string;
  artifactLimit?: number;
  eventLimit?: number;
  sessionLimit?: number;
} = {}): SystemObservabilitySnapshot {
  const taskId = options.taskId || undefined;
  const artifacts = listImmutableArtifacts(taskId, options.artifactLimit ?? 20);
  const temporalEvents = listTemporalEvents(taskId, options.eventLimit ?? 50);
  const sessions = listSessions(options.sessionLimit ?? 10);

  return {
    generatedAt: new Date().toISOString(),
    taskId: taskId || null,
    durableStores: [
      {
        id: 'feedback-ring',
        label: 'Gateway inference feedback ring',
        implementation: 'service/src/feedback.ts',
        durability: 'memory',
        summary: 'Bounded process-local inference artifacts exposed by GET /api/artifacts.',
      },
      {
        id: 'artifact-ledger',
        label: 'Immutable artifact ledger',
        implementation: 'service/src/trace-sink.ts',
        durability: 'disk',
        summary: 'Content-addressed JSON artifacts under ~/.opseeq-superior/artifacts/<task-id>/.',
      },
      {
        id: 'temporal-causality',
        label: 'Temporal causality ledger',
        implementation: 'service/src/temporal-causality.ts',
        durability: 'disk',
        summary: 'Append-only JSONL event log mirrored into immutable artifacts.',
      },
      {
        id: 'execution-sessions',
        label: 'Execution runtime sessions',
        implementation: 'service/src/execution-runtime.ts',
        durability: 'disk',
        summary: 'Session transcripts under ~/.opseeq-superior/sessions/.',
      },
      {
        id: 'copilot-runs',
        label: 'Copilot/QGoT run artifacts',
        implementation: 'copilot/obs/writer.ts and copilot/api/*.go',
        durability: 'disk',
        summary: 'Run state and event timelines under copilot/runs/<run-id>/ or QGOT_RUN_DIR.',
      },
    ],
    counts: {
      immutableArtifacts: artifacts.length,
      temporalEvents: temporalEvents.length,
      executionSessions: sessions.length,
      extensionPacks: getExtensionRegistry().length,
    },
    recentArtifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      taskId: artifact.taskId,
      kind: artifact.kind,
      createdAt: artifact.createdAt,
      hash: artifact.hash,
      path: artifact.path,
    })),
    recentTemporalEvents: temporalEvents.slice(-Math.max(0, options.eventLimit ?? 50)).reverse().map((event) => ({
      id: event.id,
      taskId: event.taskId,
      actor: event.actor,
      kind: event.kind,
      timestamp: event.timestamp,
      approvalState: event.approvalState,
      summary: event.summary,
    })),
    recentExecutionSessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      prompt: session.prompt,
    })),
    traceRankContract: {
      role: 'Observe model and artifact quality signals; do not override hard policy.',
      notPolicyEngine: true,
      promotionSignals: ['low drift', 'successful validation', 'operator approval', 'artifact reuse'],
      rollbackSignals: ['drift detected', 'verification failure', 'policy block', 'operator rejection'],
    },
  };
}

function splitIntent(intent: string): string[] {
  const sentences = intent
    .split(/(?:\r?\n|[.!?]\s+)/)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences.slice(0, 4) : ['Clarify the task objective.'];
}

function hasAnyPattern(values: string[], pattern: RegExp): boolean {
  return values.some((value) => pattern.test(value));
}

function inferHardBlocks(input: SupervisorPlanInput): string[] {
  const commands = input.requestedCommands || [];
  const blocks: string[] = [];
  if (hasAnyPattern(commands, /\brm\s+-rf\b|\brm\s+-fr\b|\btrash\b/i) && !(input.expectedArtifacts || []).some((artifact) => /rollback/i.test(artifact))) {
    blocks.push('Recursive or destructive deletion requires an explicit rollback artifact.');
  }
  if (hasAnyPattern(commands, /\bsudo\b|\bsu\s+-\b|\bchmod\s+777\b/i)) {
    blocks.push('Privilege escalation requires exact command review and scoped justification.');
  }
  if (hasAnyPattern(commands, /\blaunchctl\b|LaunchAgents|crontab|\.zshrc|\.bashrc|\.profile/i)) {
    blocks.push('Persistence or shell-startup modifications are denied without an explicit maintenance task.');
  }
  if (hasAnyPattern(commands, /\bsecurity\s+find-|keychain|token|secret|API_KEY|PASSWORD/i)) {
    blocks.push('Credential access cannot reveal plaintext secrets to the UI or logs.');
  }
  if ((input.networkScope || []).some((scope) => /^https?:\/\//.test(scope) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(scope))
    && input.modelPolicy?.allowRemoteAugmentation !== true) {
    blocks.push('Remote network or model augmentation requires explicit approval.');
  }
  return blocks;
}

function inferRisks(input: SupervisorPlanInput): SupervisorPlan['whitePane']['riskAssessment'] {
  const commands = input.requestedCommands || [];
  const fileScope = input.fileScope || [];
  const networkScope = input.networkScope || [];
  const destructive = hasAnyPattern(commands, /\brm\b|\bmv\b|\bchmod\b|\bsudo\b/i);
  const broadFileScope = fileScope.length === 0 || fileScope.some((scope) => scope === '/' || scope.endsWith('/**'));
  const remoteNetwork = networkScope.some((scope) => /^https?:\/\//.test(scope) && !scope.includes('localhost') && !scope.includes('127.0.0.1'));

  return [
    {
      risk: 'malware',
      level: hasAnyPattern(commands, /\bcurl\b.*\|\s*(sh|bash)|\bchmod\s+\+x\b/i) ? 'high' : 'low',
      rationale: 'Blocks shell-piped installers and hidden persistence attempts.',
    },
    {
      risk: 'data deletion',
      level: destructive ? 'high' : 'low',
      rationale: destructive ? 'Requested commands include destructive or permission-changing operations.' : 'No destructive commands are requested.',
    },
    {
      risk: 'privacy',
      level: remoteNetwork ? 'medium' : 'low',
      rationale: remoteNetwork ? 'Remote network scope is present and must stay allowlisted.' : 'Network scope is local or empty.',
    },
    {
      risk: 'credential exposure',
      level: hasAnyPattern(commands, /keychain|security|token|secret|API_KEY|PASSWORD/i) ? 'high' : 'low',
      rationale: 'Credential material must be redacted and cannot be echoed into artifacts.',
    },
    {
      risk: 'rollback complexity',
      level: broadFileScope ? 'medium' : 'low',
      rationale: broadFileScope ? 'File scope is broad or absent; rollback must be explicit before writes.' : 'File scope is bounded.',
    },
  ];
}

function buildRankedActions(input: SupervisorPlanInput): SupervisorPlan['whitePane']['rankedActions'] {
  const hardBlocks = inferHardBlocks(input).length;
  const commandCount = input.requestedCommands?.length || 0;
  const scopeCount = (input.fileScope?.length || 0) + (input.networkScope?.length || 0);
  const securityScore = Math.max(0.1, 0.94 - hardBlocks * 0.22 - commandCount * 0.02);
  const velocityScore = Math.max(0.1, 0.82 - scopeCount * 0.03);
  const creativityScore = input.appId ? 0.74 : 0.66;

  return [
    {
      id: 'security-first',
      label: 'Security-first',
      score: Number(securityScore.toFixed(2)),
      rationale: 'Minimize file, process, network, and remote model scope before approval.',
    },
    {
      id: 'velocity-first',
      label: 'Velocity-first',
      score: Number(velocityScore.toFixed(2)),
      rationale: 'Use existing Opseeq execution and pipeline modules with the smallest viable plan.',
    },
    {
      id: 'creativity-first',
      label: 'Creativity-first',
      score: Number(creativityScore.toFixed(2)),
      rationale: 'Allow app-specific extensions and architecture synthesis while keeping policy local-first.',
    },
  ].sort((left, right) => right.score - left.score);
}

function defaultExpectedArtifacts(input: SupervisorPlanInput): string[] {
  return input.expectedArtifacts?.length ? input.expectedArtifacts : [
    'supervisor-plan',
    'execution-envelope',
    'temporal-causality-event',
    'validation',
    'rollback instructions if files change',
  ];
}

export function buildSupervisorPlan(input: SupervisorPlanInput, config: ServiceConfig): SupervisorPlan {
  const trimmedIntent = input.intent.trim();
  if (!trimmedIntent) throw new Error('intent is required');

  const taskId = `sys-${crypto.createHash('sha256').update(`${trimmedIntent}|${Date.now()}`).digest('hex').slice(0, 12)}`;
  const routing = getPrecisionOrchestrationRoutingDefaults(input.appId || 'all');
  const supervisorModel = input.modelPolicy?.supervisorModel || routing.plannerModel || config.defaultModel;
  const executionModel = input.modelPolicy?.executionModel || routing.executionModel || supervisorModel;
  const allowRemoteAugmentation = input.modelPolicy?.allowRemoteAugmentation === true;
  const hardBlocks = inferHardBlocks(input);
  const granted = input.approved === true && hardBlocks.length === 0;
  const planSeeds = splitIntent(trimmedIntent);
  const permissionRequest = {
    commands: input.requestedCommands?.length ? input.requestedCommands : ['No commands requested yet.'],
    files: input.fileScope?.length ? input.fileScope : [input.repoPath || 'No file scope requested yet.'],
    network: input.networkScope?.length ? input.networkScope : ['No network scope requested yet.'],
    processes: input.processScope?.length ? input.processScope : ['No process scope requested yet.'],
    modelRouting: { supervisorModel, executionModel, allowRemoteAugmentation },
    expectedArtifacts: defaultExpectedArtifacts(input),
  };
  const detailedPlan = [
    'Observe: collect repo, app, policy, model, and artifact context before execution.',
    ...planSeeds.map((seed, index) => `Plan ${index + 1}: ${seed}`),
    'Orient: rank security-first, velocity-first, and creativity-first paths against the guardrail matrix.',
    'Decide: request explicit human approval for every command, file, network, process, and model scope.',
    'Act: only execute through the approved envelope and record validation plus rollback instructions.',
  ];
  const planHash = computePayloadHash({
    intent: trimmedIntent,
    detailedPlan,
    permissionRequest,
    hardBlocks,
  });

  return {
    taskId,
    generatedAt: new Date().toISOString(),
    mode: granted ? 'approved_execution' : 'planning_only',
    whitePane: {
      taskHeader: {
        taskId,
        appId: input.appId || 'all',
        repoPath: input.repoPath || null,
        supervisorModel,
        executionModel,
        policyBadge: hardBlocks.length > 0 ? 'blocked-by-hard-policy' : granted ? 'approved' : 'approval-required',
      },
      keyQuestions: [
        'What exact file, process, network, and model scopes are necessary?',
        'What rollback artifact proves the operation is reversible?',
        'Which validation commands should run before completion?',
        'Does any step require remote augmentation or privileged access?',
      ],
      detailedPlan,
      rankedActions: buildRankedActions(input),
      riskAssessment: inferRisks(input),
      permissionRequest,
      liveObservability: [
        'Record supervisor plan hash and permission envelope.',
        'Append temporal causality events for approval and execution decisions.',
        'Write immutable artifacts for plans, envelopes, validation, and rollback data.',
        'Mirror execution sessions and pipeline transcripts for operator review.',
      ],
    },
    approval: {
      required: true,
      granted,
      state: granted ? 'approved' : 'pending',
      hardBlocks,
    },
    executionEnvelope: {
      taskId,
      mode: 'approved_execution',
      operator: input.operator || process.env.USER || 'operator',
      repoPath: input.repoPath || null,
      approved: granted,
      planHash,
      approvedCommands: granted ? (input.requestedCommands || []) : [],
      fileScope: input.fileScope || [],
      networkScope: input.networkScope || [],
      processScope: input.processScope || [],
      modelPolicy: { supervisorModel, executionModel, allowRemoteAugmentation },
      stopConditions: input.stopConditions?.length ? input.stopConditions : [
        'Stop on hard policy block.',
        'Stop on validation failure.',
        'Stop on operator rejection or drift detection.',
      ],
      rollback: granted ? [`git diff > ~/.opseeq-superior/rollback/${taskId}.patch`] : [],
    },
  };
}

export function buildSystemArchitectureSnapshot(config: ServiceConfig, options: {
  taskId?: string;
  artifactLimit?: number;
  eventLimit?: number;
  sessionLimit?: number;
} = {}): SystemArchitectureSnapshot {
  const routing = getPrecisionOrchestrationRoutingDefaults('all');
  return {
    generatedAt: new Date().toISOString(),
    version: '6.0.0',
    productIntent: 'Local-first Opseeq orchestration with explicit API contracts, agent roles, guardrails, and durable observability.',
    components: cloneComponents(),
    apiGroups: getSystemApiDesign(),
    roles: getAgentRoleContracts(),
    guardrails: getGuardrailRules(),
    modelRouting: {
      ...routing,
      providerOrder: config.providers.map((provider) => provider.name),
      defaultModel: config.defaultModel,
    },
    observability: buildSystemObservabilitySnapshot(options),
    invariants: [
      'Planning before effectful execution.',
      'Human approval before writes, destructive operations, remote augmentation, or privileged actions.',
      'Immutable artifacts for major decisions and validation outputs.',
      'Continuous observability across temporal events, artifacts, transcripts, and run ledgers.',
      'Local policy has authority over model output.',
      `General-Clawd absorbed: ${getAbsorptionStatus().absorbed}`,
    ],
  };
}
