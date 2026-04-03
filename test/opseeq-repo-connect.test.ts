import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { connectRepo, RepoConnectError } from '../service/src/repo-connect';
import { resolveAppSurface } from '../service/src/app-launcher';

const tempDirs: string[] = [];

function makeTempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('connectRepo', () => {
  it('creates .env and .mcp.json with Opseeq and Anthropic passthrough settings', async () => {
    const home = makeTempHome('opseeq-connect-home-');
    const repoPath = path.join(home, 'Lucidity');
    fs.mkdirSync(repoPath, { recursive: true });
    writeJson(path.join(repoPath, 'package.json'), {
      name: 'lucidity',
      scripts: { start: 'node server.mjs' },
    });
    fs.writeFileSync(
      path.join(repoPath, 'server.mjs'),
      "const port = Number(process.env.PORT || 4173);\nconsole.log(port);\n",
    );
    fs.writeFileSync(path.join(repoPath, 'index.html'), '<!doctype html><title>Lucidity</title>');

    const result = await connectRepo(repoPath, {
      homeDir: home,
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
        ANTHROPIC_MODELS: 'claude-test-1,claude-test-2',
      },
    });

    expect(result.analysis.detectedKinds).toContain('node');
    expect(result.analysis.runtime.startCommand).toBe('npm start');
    expect(result.analysis.runtime.inferredPort).toBe(4173);
    expect(result.analysis.runtime.openUrl).toBe('http://127.0.0.1:4173');

    const envContent = fs.readFileSync(path.join(repoPath, '.env'), 'utf8');
    expect(envContent).toContain('OPENAI_BASE_URL=http://localhost:9090/v1');
    expect(envContent).toContain('OPSEEQ_URL=http://localhost:9090');
    expect(envContent).toContain('MERMATE_URL=http://host.docker.internal:3333');
    expect(envContent).toContain('SYNTHESIS_TRADE_URL=http://host.docker.internal:8420');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-test');
    expect(envContent).toContain('ANTHROPIC_MODELS=claude-test-1,claude-test-2');

    const mcp = JSON.parse(fs.readFileSync(path.join(repoPath, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.opseeq.url).toBe('http://localhost:9090/mcp');
  });

  it('appends missing keys and preserves existing mcp servers', async () => {
    const home = makeTempHome('opseeq-connect-existing-');
    const repoPath = path.join(home, 'Lucidity');
    fs.mkdirSync(repoPath, { recursive: true });
    writeJson(path.join(repoPath, 'package.json'), {
      name: 'lucidity',
      scripts: { start: 'node server.mjs' },
    });
    fs.writeFileSync(
      path.join(repoPath, 'server.mjs'),
      "const port = Number(process.env.PORT || 4173);\nconsole.log(port);\n",
    );
    fs.writeFileSync(
      path.join(repoPath, '.env'),
      'OPENAI_BASE_URL=http://localhost:9090/v1\nOPSEEQ_URL=http://localhost:9090\n',
    );
    writeJson(path.join(repoPath, '.mcp.json'), {
      mcpServers: {
        custom: { command: 'custom-mcp' },
      },
    });

    const result = await connectRepo(repoPath, {
      homeDir: home,
      env: { HOME: home, ANTHROPIC_API_KEY: 'sk-second' },
    });

    expect(result.checks.some((check) => check.item === '.env' && check.status === 'updated')).toBe(true);
    const envContent = fs.readFileSync(path.join(repoPath, '.env'), 'utf8');
    expect(envContent.match(/OPENAI_BASE_URL=/g)?.length).toBe(1);
    expect(envContent).toContain('MERMATE_URL=http://host.docker.internal:3333');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-second');

    const mcp = JSON.parse(fs.readFileSync(path.join(repoPath, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.custom.command).toBe('custom-mcp');
    expect(mcp.mcpServers.opseeq.url).toBe('http://localhost:9090/mcp');
  });

  it('rejects repo paths outside the allowed home root', async () => {
    const home = makeTempHome('opseeq-connect-safe-home-');
    const outside = makeTempHome('opseeq-connect-outside-');
    const repoPath = path.join(outside, 'Elsewhere');
    fs.mkdirSync(repoPath, { recursive: true });

    await expect(connectRepo(repoPath, { homeDir: home, env: { HOME: home } }))
      .rejects.toBeInstanceOf(RepoConnectError);
  });
});

describe('resolveAppSurface', () => {
  it('resolves built-in Mermate and Synth surfaces from env', () => {
    expect(resolveAppSurface('mermate', { MERMATE_URL: 'http://localhost:3333' }).url).toBe('http://localhost:3333');
    expect(resolveAppSurface('synth', { SYNTHESIS_TRADE_URL: 'http://localhost:8420' }).url).toBe('http://localhost:8420');
  });
});
