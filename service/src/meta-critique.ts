import type { ServiceConfig } from './config.js';
import { listModels, routeInference } from './router.js';

export interface MetaCritiqueFinding {
  severity: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
}

export interface MetaCritiqueResult {
  source: 'model' | 'heuristic';
  model: string;
  score: number;
  summary: string;
  findings: MetaCritiqueFinding[];
  suggestedRepairs: string[];
  raw?: string;
}

interface RunMetaCritiqueInput {
  objective: string;
  artifactText: string;
  preferredModel: string;
  config: ServiceConfig;
  allowModelCall?: boolean;
}

function heuristicCritique(input: RunMetaCritiqueInput): MetaCritiqueResult {
  const findings: MetaCritiqueFinding[] = [];
  const lower = input.artifactText.toLowerCase();
  if (!lower.includes('approval')) {
    findings.push({ severity: 'warn', title: 'Missing approval gate', detail: 'The artifact does not explicitly describe the human approval gate.' });
  }
  if (!lower.includes('rollback')) {
    findings.push({ severity: 'warn', title: 'Missing rollback detail', detail: 'The artifact should include rollback or recovery guidance.' });
  }
  if (!lower.includes('lucidity')) {
    findings.push({ severity: 'warn', title: 'Missing Lucidity polish stage', detail: 'The artifact should preserve the Lucidity cleanup and comparison stage.' });
  }
  if (!lower.includes('tla')) {
    findings.push({ severity: 'warn', title: 'Missing formal-spec stage', detail: 'The artifact should explicitly mention TLA+ generation or verification.' });
  }
  const score = Math.max(1, 5 - findings.length * 0.8);
  return {
    source: 'heuristic',
    model: input.preferredModel,
    score: Math.round(score * 100) / 100,
    summary: findings.length === 0
      ? 'The artifact preserves the required approval, Lucidity, and formal-spec stages.'
      : 'The artifact is promising but still has structural gaps that should be fixed before handoff.',
    findings,
    suggestedRepairs: findings.map((finding) => finding.detail),
  };
}

function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function runMetaCritique(input: RunMetaCritiqueInput): Promise<MetaCritiqueResult> {
  const allowModelCall = input.allowModelCall !== false;
  const models = (await listModels(input.config)).map((entry) => entry.id);
  if (!allowModelCall || !models.includes(input.preferredModel)) {
    return heuristicCritique(input);
  }

  try {
    const prompt = [
      'Critique the following architecture artifact as Nemoclaw white-pane self-reflection.',
      'Return strict JSON with keys: summary, score, findings, suggestedRepairs.',
      'Each finding must have severity, title, detail.',
      '',
      `OBJECTIVE:\n${input.objective}`,
      '',
      `ARTIFACT:\n${input.artifactText}`,
    ].join('\n');

    const response = await routeInference({
      model: input.preferredModel,
      temperature: 0,
      max_tokens: 900,
      messages: [
        {
          role: 'system',
          content: 'You are a local self-critique engine. Return valid JSON only. Never include markdown fences.',
        },
        { role: 'user', content: prompt },
      ],
    }, input.config);

    const raw = response.choices?.[0]?.message?.content || '';
    const parsed = tryParseJson<MetaCritiqueResult & { findings?: MetaCritiqueFinding[] }>(raw);
    if (!parsed || !Array.isArray(parsed.findings)) {
      const fallback = heuristicCritique(input);
      return { ...fallback, source: 'heuristic', raw };
    }
    return {
      source: 'model',
      model: input.preferredModel,
      score: typeof parsed.score === 'number' ? parsed.score : 3.5,
      summary: parsed.summary || 'Model critique completed.',
      findings: parsed.findings,
      suggestedRepairs: Array.isArray(parsed.suggestedRepairs) ? parsed.suggestedRepairs : [],
      raw,
    };
  } catch {
    return heuristicCritique(input);
  }
}
