/**
 * @module extension-registry — Precision Orchestration Extension Packs
 *
 * Axiom A4: Extension packs are declarative, stateless capability descriptors.
 * Postulate P2: Each extension targets a specific service or 'all' and declares trust boundary.
 * Corollary C2: outOfTrust extensions require explicit human approval before activation.
 * Behavioral Contract: getPrecisionOrchestrationRoutingDefaults() returns deterministic routing for any target.
 */
export interface ExtensionPack {
  id: string;
  label: string;
  targets: string[];
  defaultModel: string;
  purpose: string;
  capabilities: string[];
  outOfTrust: boolean;
}

const EXTENSION_PACKS: ExtensionPack[] = [
  {
    id: 'mermaid-enhancer',
    label: 'Mermaid Enhancer',
    targets: ['mermate'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Enhance Mermaid generation and architectural depth for Mermate.',
    capabilities: ['diagram-polish', 'mermaid-normalization', 'max-render-hints'],
    outOfTrust: false,
  },
  {
    id: 'mermate-max-ooda',
    label: 'Mermate MAX OODA',
    targets: ['mermate', 'all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Make the Mermate -> Lucidity -> approval -> formal-spec pipeline first-class.',
    capabilities: ['idea-assessment', 'precision-architecture', 'tla-bridge', 'ts-bridge', 'rust-bridge'],
    outOfTrust: false,
  },
  {
    id: 'lucidity-semantic-polish',
    label: 'Lucidity Semantic Polish',
    targets: ['lucidity', 'all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Semantic cleanup, image-analysis comparison, and final Mermaid/Lucidity reconciliation.',
    capabilities: ['visual-compare', 'diagram-cleanup', 'image-review-contract'],
    outOfTrust: false,
  },
  {
    id: 'living-architecture-graph',
    label: 'Living Architecture Graph',
    targets: ['all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Version graph nodes, relationships, axioms, corollaries, and provenance edges in real time.',
    capabilities: ['graph-versioning', 'causality-provenance', 'fractal-context-linking'],
    outOfTrust: false,
  },
  {
    id: 'opseeq-docs-wp',
    label: 'Opseeq Whitepaper Corpus',
    targets: ['all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Ground planning and generation in the local whitepaper law set.',
    capabilities: ['whitepaper-law', 'ooda-constraints', 'formal-reference'],
    outOfTrust: false,
  },
  {
    id: 'lucidity-cross-repo',
    label: 'Lucidity Cross-Repo Awareness',
    targets: ['lucidity', 'all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Deep indexing and cross-referencing of the Lucidity repository including .env health, service endpoints, and logical step discovery.',
    capabilities: ['lucidity-index', 'env-health-probe', 'cross-repo-search', 'endpoint-map'],
    outOfTrust: false,
  },
  {
    id: 'mermate-cross-repo',
    label: 'Mermate Cross-Repo Awareness',
    targets: ['mermate', 'all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Deep indexing and cross-referencing of the Mermate/mermaid repository including HPC-GoT config, agent ensemble, and .env health.',
    capabilities: ['mermate-index', 'env-health-probe', 'got-config-parse', 'agent-ensemble-map', 'cross-repo-search'],
    outOfTrust: false,
  },
  {
    id: 'cross-repo-env-monitor',
    label: 'Cross-Repo .env Monitor',
    targets: ['all'],
    defaultModel: 'gpt-oss:20b',
    purpose: 'Continuous monitoring, backup, and health reporting for .env files across all connected repositories.',
    capabilities: ['env-discovery', 'env-backup', 'env-health-dashboard', 'key-redaction'],
    outOfTrust: false,
  },
];

export function getExtensionRegistry(): ExtensionPack[] {
  return EXTENSION_PACKS.map((pack) => ({ ...pack, capabilities: [...pack.capabilities], targets: [...pack.targets] }));
}

export function getExtensionsForTarget(target: string): ExtensionPack[] {
  const safeTarget = target.trim().toLowerCase();
  return getExtensionRegistry().filter((pack) => pack.targets.includes('all') || pack.targets.includes(safeTarget));
}

export function getPrecisionOrchestrationRoutingDefaults(target?: string): { plannerModel: string; executionModel: string; extensionIds: string[] } {
  const targetExtensions = target ? getExtensionsForTarget(target) : getExtensionsForTarget('all');
  return {
    plannerModel: 'gpt-oss:20b',
    executionModel: 'gpt-oss:20b',
    extensionIds: targetExtensions.map((pack) => pack.id),
  };
}
