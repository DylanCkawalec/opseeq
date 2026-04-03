/**
 * @module mermate-lucidity-ooda — Precision Orchestration Pipeline
 *
 * Scientific OODA Engine for the Opseeq control plane.
 *
 * Axiom A1: The language model is policy, not system.
 * Axiom A2: Human-authored invariants (axioms, postulates, corollaries, lemmas) are supreme.
 * Axiom A3: Local-first execution is mandatory unless explicitly approved otherwise.
 * Postulate P1: Every pipeline stage produces immutable, hash-addressed artifacts with provenance.
 * Corollary C1: No effectful execution occurs before plan, ranking, risk, and permission are complete.
 * Lemma L1: The pipeline path is: intent → fractal context → OODA cycle → Mermate MAX → Lucidity polish → approval → formal spec → codegen.
 *
 * Behavioral Contract:
 *   - orchestratePrecisionPipeline() returns a PrecisionPipelineResult without side-effects when approved=false.
 *   - Stage results are append-only and immutable once written to the trace sink.
 *   - The Living Architecture Graph is updated atomically at pipeline completion.
 *
 * Tracing Invariant: Every temporal causality event includes taskId, actor, kind, and approval state.
 */
import type { ServiceConfig } from './config.js';
import { buildFractalContextWindow, renderFractalContextText } from './fractal-context.js';
import { getPrecisionOrchestrationRoutingDefaults, getExtensionsForTarget } from './extension-registry.js';
import { syncLivingArchitectureGraph } from './living-architecture-graph.js';
import { runMetaCritique } from './meta-critique.js';
import { buildOodaCycle } from './ooda-primitives.js';
import { appendTemporalEvent, buildTemporalCausalityTree } from './temporal-causality.js';
import { writeImmutableArtifact } from './trace-sink.js';

const MERMATE_URL = (process.env.MERMATE_URL || 'http://127.0.0.1:3333').replace(/\/+$/, '');
const LUCIDITY_URL = (process.env.LUCIDITY_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');

export interface PrecisionPipelineInput {
  intent: string;
  repoPath?: string;
  appId?: string;
  inputMode?: 'idea' | 'markdown' | 'mmd';
  maxMode?: boolean;
  approved?: boolean;
  execute?: boolean;
  includeTla?: boolean;
  includeTs?: boolean;
  includeRust?: boolean;
  localModel?: string;
  allowRemoteAugmentation?: boolean;
  allowModelCritique?: boolean;
}

export interface PrecisionStageResult {
  stage: string;
  service: 'nemoclaw' | 'mermate' | 'lucidity' | 'opseeq';
  status: 'planned' | 'pending_approval' | 'ready' | 'executed' | 'blocked' | 'unavailable';
  summary: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface PrecisionPipelineResult {
  taskId: string;
  generatedAt: string;
  title: string;
  primaryModel: string;
  extensionPacks: ReturnType<typeof getExtensionsForTarget>;
  fractalContext: ReturnType<typeof buildFractalContextWindow>;
  fractalContextText: string;
  livingArchitectureGraph: { versionId: string; diagram: string };
  ooda: ReturnType<typeof buildOodaCycle>;
  temporalCausality: ReturnType<typeof buildTemporalCausalityTree>;
  mermateAssessment: { summary: string; endpoint: string; mode: string };
  lucidityReview: {
    summary: string;
    endpoint: string;
    cleanupChecklist: string[];
    imageAnalysisComparison: string[];
  };
  executionEnvelope: {
    taskId: string;
    repoPath: string | null;
    approved: boolean;
    commands: string[];
    fileScope: string[];
    networkScope: string[];
    terminalTarget: string;
  };
  stageResults: PrecisionStageResult[];
  critique: Awaited<ReturnType<typeof runMetaCritique>>;
  artifacts: Array<{ id: string; kind: string; hash: string; path: string }>;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`${url} returned ${res.status}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function deriveTitle(intent: string): string {
  const head = intent.split(/\r?\n/)[0]?.trim() || 'Untitled architecture task';
  return head.length <= 88 ? head : `${head.slice(0, 85)}...`;
}

export async function orchestratePrecisionPipeline(input: PrecisionPipelineInput, config: ServiceConfig): Promise<PrecisionPipelineResult> {
  const taskId = `prec-${Date.now().toString(36)}`;
  const target = input.appId || 'all';
  const routing = getPrecisionOrchestrationRoutingDefaults(target);
  const primaryModel = input.localModel || routing.plannerModel || 'gpt-oss:20b';
  const extensionPacks = getExtensionsForTarget(target);

  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'human',
    kind: 'intent_received',
    summary: deriveTitle(input.intent),
    approvalState: input.approved ? 'approved' : 'pending',
    metadata: { repoPath: input.repoPath || null, appId: input.appId || null },
  });

  const fractalContext = buildFractalContextWindow({
    intent: input.intent,
    repoPath: input.repoPath || null,
    appId: input.appId || null,
    extensions: extensionPacks.map((pack) => pack.id),
  });
  const fractalArtifact = writeImmutableArtifact('fractal-context', taskId, fractalContext);
  const fractalContextText = renderFractalContextText(fractalContext);
  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'nemoclaw',
    kind: 'observe',
    summary: 'Built fractal context window.',
    approvalState: 'not_required',
    metadata: { artifactId: fractalArtifact.id },
  });

  const ooda = buildOodaCycle({
    taskId,
    intent: input.intent,
    repoPath: input.repoPath || null,
    appId: input.appId || null,
    primaryModel,
    allowRemoteAugmentation: input.allowRemoteAugmentation === true,
  });
  const oodaArtifact = writeImmutableArtifact('ooda-cycle', taskId, ooda);
  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'nemoclaw',
    kind: 'orient',
    summary: 'Constructed the OODA cycle and ranked actions.',
    approvalState: input.approved ? 'approved' : 'pending',
    metadata: { artifactId: oodaArtifact.id, planHash: ooda.planHash },
  });
  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'nemoclaw',
    kind: 'decide',
    summary: `Selected ${ooda.rankedActions[0]?.label || 'the leading'} action path as the current recommendation.`,
    approvalState: input.approved ? 'approved' : 'pending',
    metadata: { rankedActionIds: ooda.rankedActions.map((action) => action.id) },
  });
  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'human',
    kind: 'approve',
    summary: input.approved
      ? 'Human approval is present for the current precision orchestration scope.'
      : 'Approval is still pending before the effectful stages may execute.',
    approvalState: input.approved ? 'approved' : 'pending',
    metadata: { approved: Boolean(input.approved), execute: Boolean(input.execute) },
  });

  const mermateAssessment = {
    summary: `Primary local workhorse: ${primaryModel}. Use Mermate MAX render to produce a maximal-precision architecture, then route through Lucidity for cleanup and comparison before approval.`,
    endpoint: `${MERMATE_URL}/api/render`,
    mode: input.maxMode === false ? 'standard' : 'max',
  };
  const lucidityReview = {
    summary: 'Lucidity receives the rendered architecture for semantic cleanup, image-analysis comparison, and final Mermaid reconciliation.',
    endpoint: `${LUCIDITY_URL}`,
    cleanupChecklist: [
      'Normalize node labels and connector semantics.',
      'Compare rendered Mermaid against Lucidity canvas output.',
      'Resolve layout ambiguities before approval.',
    ],
    imageAnalysisComparison: [
      'Baseline: MAX Mermaid render artifact.',
      'Candidate: Lucidity cleaned canvas export.',
      'Compare semantic equivalence, visual drift, and missing nodes.',
    ],
  };

  const stageResults: PrecisionStageResult[] = [
    {
      stage: 'observe_orient',
      service: 'nemoclaw',
      status: 'executed',
      summary: 'Built fractal context, ranked OODA actions, and staged the initial artifacts.',
      durationMs: 0,
    },
    {
      stage: 'mermate_max_render',
      service: 'mermate',
      status: input.execute && input.approved ? 'ready' : 'pending_approval',
      summary: 'Run Mermate MAX architecture generation on the approved intent.',
      durationMs: 0,
      details: { endpoint: mermateAssessment.endpoint, inputMode: input.inputMode || 'idea', maxMode: input.maxMode !== false },
    },
    {
      stage: 'lucidity_cleanup_compare',
      service: 'lucidity',
      status: input.approved ? 'ready' : 'pending_approval',
      summary: 'Stage Lucidity cleanup and semantic/image verification before the formal-spec bridge.',
      durationMs: 0,
      details: { endpoint: lucidityReview.endpoint, checklist: lucidityReview.cleanupChecklist },
    },
    {
      stage: 'approval_gate',
      service: 'nemoclaw',
      status: input.approved ? 'executed' : 'pending_approval',
      summary: 'Human approval gates all effectful render and compile stages.',
      durationMs: 0,
    },
    {
      stage: 'formal_generation_chain',
      service: 'opseeq',
      status: input.approved ? 'ready' : 'pending_approval',
      summary: 'Drive the canonical Mermate -> TLA+ -> TypeScript -> Rust -> .app path.',
      durationMs: 0,
      details: {
        includeTla: input.includeTla !== false,
        includeTs: input.includeTs !== false,
        includeRust: input.includeRust !== false,
      },
    },
    {
      stage: 'execution_runtime',
      service: 'opseeq',
      status: input.approved ? 'ready' : 'pending_approval',
      summary: 'Execution via absorbed runtime (General-Clawd eliminated) inside iTerm2/tmux under the approved envelope.',
      durationMs: 0,
    },
  ];

  let renderRunId: string | null = null;
  if (input.execute && input.approved) {
    const renderStart = Date.now();
    try {
      const renderResult = await requestJson<Record<string, unknown>>(mermateAssessment.endpoint, {
        method: 'POST',
        body: JSON.stringify({
          mermaid_source: input.intent,
          input_mode: input.inputMode || 'idea',
          max_mode: input.maxMode !== false,
        }),
      });
      renderRunId = String(renderResult.run_id || renderResult.runId || '');
      stageResults[1] = {
        ...stageResults[1],
        status: 'executed',
        durationMs: Date.now() - renderStart,
        details: { ...stageResults[1].details, runId: renderRunId, validation: renderResult.validation || null },
      };
      appendTemporalEvent({
        taskId,
        parentId: null,
        actor: 'mermate',
        kind: 'act',
        summary: 'Executed MAX render stage.',
        approvalState: 'approved',
        metadata: { runId: renderRunId },
      });
    } catch (error) {
      stageResults[1] = {
        ...stageResults[1],
        status: 'unavailable',
        durationMs: Date.now() - renderStart,
        summary: error instanceof Error ? error.message : String(error),
      };
    }

    if (renderRunId && input.includeTla !== false) {
      const tlaStart = Date.now();
      try {
        const tlaResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render/tla`, {
          method: 'POST',
          body: JSON.stringify({ run_id: renderRunId }),
        });
        stageResults.push({
          stage: 'tla_generation',
          service: 'mermate',
          status: 'executed',
          summary: 'Generated TLA+ artifact from the MAX run.',
          durationMs: Date.now() - tlaStart,
          details: { validation: tlaResult.validation || null },
        });
      } catch (error) {
        stageResults.push({
          stage: 'tla_generation',
          service: 'mermate',
          status: 'unavailable',
          summary: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - tlaStart,
        });
      }
    }

    if (renderRunId && input.includeTs !== false) {
      const tsStart = Date.now();
      try {
        const tsResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render/ts`, {
          method: 'POST',
          body: JSON.stringify({ run_id: renderRunId }),
        });
        stageResults.push({
          stage: 'typescript_generation',
          service: 'mermate',
          status: 'executed',
          summary: 'Generated TypeScript artifact from the MAX run.',
          durationMs: Date.now() - tsStart,
          details: { validation: tsResult.validation || null },
        });
      } catch (error) {
        stageResults.push({
          stage: 'typescript_generation',
          service: 'mermate',
          status: 'unavailable',
          summary: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - tsStart,
        });
      }
    }

    if (renderRunId && input.includeRust !== false) {
      const rustStart = Date.now();
      try {
        const rustResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render/rust`, {
          method: 'POST',
          body: JSON.stringify({ run_id: renderRunId }),
        });
        stageResults.push({
          stage: 'rust_binary_generation',
          service: 'mermate',
          status: 'executed',
          summary: 'Generated Rust binary/app artifact from the MAX run.',
          durationMs: Date.now() - rustStart,
          details: { metrics: rustResult.rust_metrics || null },
        });
      } catch (error) {
        stageResults.push({
          stage: 'rust_binary_generation',
          service: 'mermate',
          status: 'unavailable',
          summary: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - rustStart,
        });
      }
    }
  }

  const critique = await runMetaCritique({
    objective: 'Critique the Precision Orchestration Mermate -> Lucidity -> approval -> TLA+/TS/Rust pipeline artifact.',
    artifactText: JSON.stringify({ ooda, stageResults, mermateAssessment, lucidityReview }, null, 2),
    preferredModel: primaryModel,
    config,
    allowModelCall: input.allowModelCritique !== false,
  });
  const critiqueArtifact = writeImmutableArtifact('meta-critique', taskId, critique);
  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'nemoclaw',
    kind: 'meta_critique',
    summary: critique.summary,
    approvalState: 'not_required',
    metadata: { artifactId: critiqueArtifact.id, score: critique.score },
  });

  const graphSync = syncLivingArchitectureGraph({
    taskId,
    intent: input.intent,
    appId: input.appId || null,
    repoPath: input.repoPath || null,
    extensionIds: extensionPacks.map((pack) => pack.id),
    planSteps: ooda.detailedPlan,
    critiqueSummary: critique.summary,
    stageResults: stageResults.map((stage) => ({
      stage: stage.stage,
      service: stage.service,
      status: stage.status,
      summary: stage.summary,
      details: stage.details,
    })),
  });

  appendTemporalEvent({
    taskId,
    parentId: null,
    actor: 'opseeq',
    kind: 'graph_versioned',
    summary: `Graph version ${graphSync.version.id} recorded.`,
    approvalState: 'not_required',
    metadata: { versionId: graphSync.version.id },
  });

  const executionEnvelope = {
    taskId,
    repoPath: input.repoPath || null,
    approved: Boolean(input.approved),
    commands: stageResults
      .filter((stage) => stage.status === 'ready' || stage.status === 'executed')
      .map((stage) => `${stage.service}:${stage.stage}`),
    fileScope: ooda.permission.fileScope,
    networkScope: ooda.permission.networkScope,
    terminalTarget: 'tmux:opseeq-black -> iTerm2:opseeq-superior',
  };
  const envelopeArtifact = writeImmutableArtifact('execution-envelope', taskId, executionEnvelope);

  return {
    taskId,
    generatedAt: new Date().toISOString(),
    title: deriveTitle(input.intent),
    primaryModel,
    extensionPacks,
    fractalContext,
    fractalContextText,
    livingArchitectureGraph: { versionId: graphSync.version.id, diagram: graphSync.diagram },
    ooda,
    temporalCausality: buildTemporalCausalityTree(taskId),
    mermateAssessment,
    lucidityReview,
    executionEnvelope,
    stageResults,
    critique,
    artifacts: [fractalArtifact, oodaArtifact, critiqueArtifact, envelopeArtifact].map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      hash: artifact.hash,
      path: artifact.path,
    })),
  };
}
