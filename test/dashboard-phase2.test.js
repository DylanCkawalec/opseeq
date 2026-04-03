import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── HTML structure tests ─────────────────────────
describe('Dashboard HTML Phase 2', () => {
  let html;
  beforeEach(() => {
    html = fs.readFileSync(path.resolve(__dirname, '..', 'dashboard', 'public', 'index.html'), 'utf8');
  });

  it('includes Precision Orchestration tab button', () => {
    expect(html).toContain('data-view-target="precision"');
    expect(html).toContain('Precision Orchestration');
  });

  it('includes Living Graph tab button', () => {
    expect(html).toContain('data-view-target="graph"');
    expect(html).toContain('Living Graph');
  });

  it('includes precision view panel', () => {
    expect(html).toContain('data-view="precision"');
  });

  it('includes graph view panel', () => {
    expect(html).toContain('data-view="graph"');
  });

  it('includes OODA ring SVG', () => {
    expect(html).toContain('ooda-ring');
    expect(html).toContain('ooda-progress');
    expect(html).toContain('ooda-stage-label');
  });

  it('includes precision split panes (white and black)', () => {
    expect(html).toContain('precision-white');
    expect(html).toContain('precision-black');
    expect(html).toContain('White Pane');
    expect(html).toContain('Black Pane');
  });

  it('includes cross-repo search', () => {
    expect(html).toContain('crossrepo-search-input');
    expect(html).toContain('btn-crossrepo-search');
    expect(html).toContain('crossrepo-results');
  });

  it('includes sidebar repos section', () => {
    expect(html).toContain('sidebar-repos');
    expect(html).toContain('Connected Repos');
  });

  it('includes graph stats elements', () => {
    expect(html).toContain('graph-nodes');
    expect(html).toContain('graph-edges');
    expect(html).toContain('graph-repos');
    expect(html).toContain('graph-versions');
    expect(html).toContain('graph-backlinks');
  });

  it('includes priority repos section in graph tab', () => {
    expect(html).toContain('graph-priority-repos');
    expect(html).toContain('Priority Repos');
  });

  it('includes graph viewer and version list', () => {
    expect(html).toContain('graph-viewer');
    expect(html).toContain('graph-version-list');
  });

  it('includes precision-orchestration.js script tag', () => {
    expect(html).toContain('precision-orchestration.js');
  });

  it('preserves original tabs (Overview, NemoClaw, Models)', () => {
    expect(html).toContain('data-view-target="overview"');
    expect(html).toContain('data-view-target="nemoclaw"');
    expect(html).toContain('data-view-target="models"');
  });
});

// ── CSS structure tests ──────────────────────────
describe('Dashboard CSS Phase 2', () => {
  let css;
  beforeEach(() => {
    css = fs.readFileSync(path.resolve(__dirname, '..', 'dashboard', 'public', 'css', 'opseeq.css'), 'utf8');
  });

  it('includes Precision Orchestration styles', () => {
    expect(css).toContain('.precision-hero');
    expect(css).toContain('.btn-precision');
    expect(css).toContain('.precision-split');
    expect(css).toContain('.precision-white');
    expect(css).toContain('.precision-black');
  });

  it('includes OODA ring styles', () => {
    expect(css).toContain('.ooda-ring');
    expect(css).toContain('.ooda-progress');
    expect(css).toContain('.ooda-step.active');
    expect(css).toContain('.ooda-step.completed');
  });

  it('includes cross-repo search styles', () => {
    expect(css).toContain('.crossrepo-results');
    expect(css).toContain('.crossrepo-result-item');
    expect(css).toContain('.crossrepo-result-repo.priority');
  });

  it('includes graph viewer styles', () => {
    expect(css).toContain('.graph-viewer');
  });

  it('includes sidebar repo styles', () => {
    expect(css).toContain('.sidebar-repo-item');
    expect(css).toContain('.sidebar-repo-item.priority');
    expect(css).toContain('.env-health-badge');
  });

  it('includes precision pulse animation', () => {
    expect(css).toContain('precision-pulse');
  });

  it('includes responsive breakpoints for precision split', () => {
    expect(css).toContain('.precision-split { grid-template-columns: 1fr; }');
  });

  it('includes fade-in animation', () => {
    expect(css).toContain('@keyframes fade-in');
  });

  it('includes priority gold color', () => {
    expect(css).toContain('#FFD700');
  });
});

// ── JS structure tests ───────────────────────────
describe('Dashboard JS Phase 2 (precision-orchestration.js)', () => {
  let js;
  beforeEach(() => {
    js = fs.readFileSync(path.resolve(__dirname, '..', 'dashboard', 'public', 'js', 'precision-orchestration.js'), 'utf8');
  });

  it('uses correct API endpoint for graph dashboard', () => {
    expect(js).toContain('/api/ooda/dashboard');
  });

  it('uses correct API endpoint for graph search', () => {
    expect(js).toContain('/api/ooda/graph/search');
  });

  it('uses correct API endpoint for precision pipeline', () => {
    expect(js).toContain('/api/ooda/precision');
  });

  it('implements OODA progress ring', () => {
    expect(js).toContain('setOodaProgress');
    expect(js).toContain('CIRCUMFERENCE');
  });

  it('implements cross-repo search', () => {
    expect(js).toContain('runCrossRepoSearch');
  });

  it('implements drag and drop for idea box', () => {
    expect(js).toContain('dragover');
    expect(js).toContain('FileReader');
  });

  it('implements keyboard shortcut Ctrl+G', () => {
    expect(js).toContain("e.key === 'g'");
  });

  it('renders sidebar repos', () => {
    expect(js).toContain('renderSidebarRepos');
  });

  it('renders env health badges for priority repos', () => {
    expect(js).toContain('env-health-badge');
    expect(js).toContain('envHealth');
  });
});

// ── Precision Orchestration Prompt tests ────────
describe('Precision Orchestration Prompt Phase 2', () => {
  let prompt;
  beforeEach(() => {
    prompt = fs.readFileSync(path.resolve(__dirname, '..', 'config', 'nemoclaw-precision-orchestration.system-prompt.md'), 'utf8');
  });

  it('includes cross-repo intelligence section', () => {
    expect(prompt).toContain('Cross-repository intelligence (Phase 2)');
  });

  it('mentions Lucidity and Mermate as priority', () => {
    expect(prompt).toContain('Lucidity');
    expect(prompt).toContain('Mermate (mermaid)');
    expect(prompt).toContain('priority repositories');
  });

  it('includes .env file duties section', () => {
    expect(prompt).toContain('.env file duties');
    expect(prompt).toContain('Never expose .env values');
  });

  it('includes unified dashboard integration section', () => {
    expect(prompt).toContain('Unified dashboard integration');
    expect(prompt).toContain('Precision Orchestration tab');
    expect(prompt).toContain('Living Graph tab');
  });

  it('includes style rule for .env display', () => {
    expect(prompt).toContain('show key count but never key values');
  });
});

// ── Precision Orchestration Policy tests ────────
describe('Precision Orchestration Policy Phase 2', () => {
  let policy;
  beforeEach(() => {
    policy = fs.readFileSync(path.resolve(__dirname, '..', 'config', 'nemoclaw-precision-orchestration-policy.yaml'), 'utf8');
  });

  it('includes cross_repo_intelligence section', () => {
    expect(policy).toContain('cross_repo_intelligence:');
    expect(policy).toContain('enabled: true');
  });

  it('lists lucidity and mermaid as priority repos', () => {
    expect(policy).toContain('name: lucidity');
    expect(policy).toContain('name: mermaid');
  });

  it('includes env_never_expose_values', () => {
    expect(policy).toContain('env_never_expose_values: true');
  });

  it('includes expanded redact_env_keys', () => {
    expect(policy).toContain('CLAUDE_API_KEY_1');
    expect(policy).toContain('CLAUDE_API_KEY_2');
    expect(policy).toContain('MERMATE_AI_API_KEY');
    expect(policy).toContain('DALLE_API_KEY');
  });

  it('includes env redact patterns', () => {
    expect(policy).toContain('API_KEY');
    expect(policy).toContain('SECRET');
    expect(policy).toContain('TOKEN');
    expect(policy).toContain('PASSWORD');
    expect(policy).toContain('CREDENTIAL');
  });
});

// ── Extension Registry tests ─────────────────────
describe('Extension Registry Phase 2', () => {
  let registry;
  beforeEach(() => {
    registry = fs.readFileSync(path.resolve(__dirname, '..', 'service', 'src', 'extension-registry.ts'), 'utf8');
  });

  it('includes lucidity-cross-repo extension', () => {
    expect(registry).toContain("id: 'lucidity-cross-repo'");
    expect(registry).toContain('Lucidity Cross-Repo Awareness');
  });

  it('includes mermate-cross-repo extension', () => {
    expect(registry).toContain("id: 'mermate-cross-repo'");
    expect(registry).toContain('Mermate Cross-Repo Awareness');
  });

  it('includes cross-repo-env-monitor extension', () => {
    expect(registry).toContain("id: 'cross-repo-env-monitor'");
    expect(registry).toContain('Cross-Repo .env Monitor');
  });

  it('all new extensions have outOfTrust: false', () => {
    const matches = registry.match(/id: '(lucidity|mermate)-cross-repo'[\s\S]*?outOfTrust: (true|false)/g);
    if (matches) {
      matches.forEach((m) => expect(m).toContain('outOfTrust: false'));
    }
  });
});

// ── Cross-Repo Index tests ───────────────────────
describe('Cross-Repo Index Phase 2', () => {
  let crossRepo;
  beforeEach(() => {
    crossRepo = fs.readFileSync(path.resolve(__dirname, '..', 'service', 'src', 'cross-repo-index.ts'), 'utf8');
  });

  it('exports EnvHealthRecord interface', () => {
    expect(crossRepo).toContain('export interface EnvHealthRecord');
  });

  it('includes priority field in ConnectedRepoRecord', () => {
    expect(crossRepo).toContain('priority: boolean;');
  });

  it('includes envHealth field in ConnectedRepoRecord', () => {
    expect(crossRepo).toContain('envHealth: EnvHealthRecord | null;');
  });

  it('includes priorityRepos in CrossRepoIndexSnapshot', () => {
    expect(crossRepo).toContain('priorityRepos: ConnectedRepoRecord[];');
  });

  it('exports backupEnvFile function', () => {
    expect(crossRepo).toContain('export function backupEnvFile');
  });

  it('exports getEnvKeySummary function', () => {
    expect(crossRepo).toContain('export function getEnvKeySummary');
  });

  it('exports searchCrossRepoSteps function', () => {
    expect(crossRepo).toContain('export function searchCrossRepoSteps');
  });

  it('includes mermaid in KNOWN_REPO_NAMES', () => {
    expect(crossRepo).toContain("'mermaid'");
  });

  it('includes PRIORITY_REPO_NAMES with lucidity and mermaid', () => {
    expect(crossRepo).toContain("PRIORITY_REPO_NAMES");
    expect(crossRepo).toContain("'lucidity'");
  });

  it('includes PRIORITY_COLOR gold', () => {
    expect(crossRepo).toContain("#FFD700");
  });

  it('never exposes .env values (redacts sensitive keys)', () => {
    expect(crossRepo).toContain('REDACTED_KEY_PATTERNS');
    expect(crossRepo).toContain('API_KEY');
    expect(crossRepo).toContain('SECRET');
    expect(crossRepo).toContain('TOKEN');
    expect(crossRepo).toContain('PASSWORD');
  });
});
