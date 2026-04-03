import crypto from 'node:crypto';

export type FractalTreeKind = 'context' | 'process' | 'query';

export interface FractalContextNode {
  id: string;
  kind: FractalTreeKind;
  title: string;
  summary: string;
  depth: number;
  children: FractalContextNode[];
}

export interface FractalContextLink {
  relation: 'informs' | 'constrains' | 'validates';
  fromTree: FractalTreeKind;
  fromId: string;
  toTree: FractalTreeKind;
  toId: string;
}

export interface FractalContextWindow {
  contextRoot: FractalContextNode;
  processRoot: FractalContextNode;
  queryRoot: FractalContextNode;
  links: FractalContextLink[];
}

interface BuildFractalContextInput {
  intent: string;
  repoPath?: string | null;
  appId?: string | null;
  extensions?: string[];
}

function makeNode(kind: FractalTreeKind, depth: number, title: string, summary: string, children: FractalContextNode[] = []): FractalContextNode {
  return {
    id: `${kind}-${depth}-${crypto.createHash('sha1').update(`${title}:${summary}`).digest('hex').slice(0, 10)}`,
    kind,
    title,
    summary,
    depth,
    children,
  };
}

function splitIntent(intent: string): string[] {
  return intent
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function buildFractalContextWindow(input: BuildFractalContextInput): FractalContextWindow {
  const intentParts = splitIntent(input.intent);
  const extensionSummary = (input.extensions || []).join(', ') || 'none';

  const contextRoot = makeNode('context', 0, 'Context Root', 'Human intent, repo scope, and architectural constraints.', [
    makeNode('context', 1, 'Intent', input.intent, intentParts.map((part) => makeNode('context', 2, 'Intent Detail', part))),
    makeNode('context', 1, 'Repo Scope', input.repoPath || 'Repo path not specified.'),
    makeNode('context', 1, 'App Target', input.appId || 'No app explicitly selected.'),
    makeNode('context', 1, 'Extension Packs', extensionSummary),
  ]);

  const processRoot = makeNode('process', 0, 'Process Root', 'Repeatable Mermate -> Lucidity -> approval -> TLA+/TS/Rust pipeline.', [
    makeNode('process', 1, 'Observe', 'Capture intent, constraints, and current runtime posture.'),
    makeNode('process', 1, 'Orient', 'Use gpt-oss:20b and Mermate assessment to structure the task.'),
    makeNode('process', 1, 'Decide', 'Rank actions by velocity, security, and creativity.'),
    makeNode('process', 1, 'Act', 'Execute only inside an approved envelope.'),
    makeNode('process', 1, 'Artifact Flow', 'Mermate -> Lucidity -> Approval -> TLA+ -> TypeScript -> Rust -> macOS app.'),
  ]);

  const queryRoot = makeNode('query', 0, 'Query Root', 'Open questions, validation prompts, and proof obligations.', [
    makeNode('query', 1, 'Unknowns', 'What is missing to safely produce the architecture and binary?'),
    makeNode('query', 1, 'Validation', 'How will Mermaid, TLA+, TS, Rust, and app packaging be validated?'),
    makeNode('query', 1, 'Critique', 'What should gpt-oss:20b challenge before handoff?'),
    makeNode('query', 1, 'Rollback', 'What artifacts and patches are required to revert safely?'),
  ]);

  const links: FractalContextLink[] = [
    { relation: 'informs', fromTree: 'context', fromId: contextRoot.children[0].id, toTree: 'process', toId: processRoot.children[0].id },
    { relation: 'constrains', fromTree: 'context', fromId: contextRoot.children[1].id, toTree: 'process', toId: processRoot.children[4].id },
    { relation: 'validates', fromTree: 'query', fromId: queryRoot.children[1].id, toTree: 'process', toId: processRoot.children[4].id },
    { relation: 'validates', fromTree: 'query', fromId: queryRoot.children[3].id, toTree: 'process', toId: processRoot.children[3].id },
  ];

  return { contextRoot, processRoot, queryRoot, links };
}

export function renderFractalContextText(window: FractalContextWindow): string {
  const lines: string[] = [];
  const walk = (node: FractalContextNode, prefix = ''): void => {
    lines.push(`${prefix}${node.title}: ${node.summary}`);
    for (const child of node.children) walk(child, `${prefix}  `);
  };
  walk(window.contextRoot);
  walk(window.processRoot);
  walk(window.queryRoot);
  lines.push('Links:');
  for (const link of window.links) {
    lines.push(`- ${link.fromTree}.${link.fromId} ${link.relation} ${link.toTree}.${link.toId}`);
  }
  return lines.join('\n');
}
