import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { findToolPins, findWorkflowViolations } from './helpers/workflow-policy.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflows = join(repoRoot, '.github/workflows');
const fixtures = fileURLToPath(new URL('fixtures/workflows/', import.meta.url));

interface Step {
  uses?: string;
  run?: string;
  name?: string;
}
interface Job {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, Record<string, unknown>>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

async function load(name: string): Promise<Workflow> {
  return parse(await readFile(join(workflows, name), 'utf8')) as Workflow;
}

describe('workflow policy', () => {
  it('holds for every committed workflow', async () => {
    expect(await findWorkflowViolations(workflows)).toEqual([]);
  });

  it('flags tag-pinned actions and SHA pins without a version comment, but not local actions', async () => {
    expect(await findWorkflowViolations(`${fixtures}unpinned`)).toEqual([
      { file: 'build.yml', line: 9, rule: 'unpinned-action' },
      { file: 'build.yml', line: 10, rule: 'unpinned-action' },
    ]);
  });

  it('flags a workflow without top-level permissions', async () => {
    expect(await findWorkflowViolations(`${fixtures}no-permissions`)).toEqual([
      { file: 'build.yml', line: 1, rule: 'missing-permissions' },
    ]);
  });
});

describe('tool pins', () => {
  // Renovate's own regex manager, so a pin it can't see fails here instead of going stale.
  async function matchStrings(): Promise<string[]> {
    const renovate = JSON.parse(await readFile(join(repoRoot, 'renovate.json'), 'utf8')) as {
      customManagers: { matchStrings: string[] }[];
    };
    return renovate.customManagers.flatMap((manager) => manager.matchStrings);
  }

  it('are all tracked by Renovate in the committed workflows', async () => {
    const { pins, violations } = await findToolPins(workflows, await matchStrings());
    expect(violations).toEqual([]);
    expect(pins.map((p) => [p.file, p.datasource, p.depName])).toEqual([
      ['ci.yml', 'github-release-attachments', 'rhysd/actionlint'],
      ['ci.yml', 'github-release-attachments', 'gitleaks/gitleaks'],
    ]);
    for (const pin of pins) {
      expect(pin.currentValue).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(pin.currentDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('flags a pin without an annotation, with a bare version or without a checksum', async () => {
    const { pins, violations } = await findToolPins(`${fixtures}tool-pins`, await matchStrings());
    expect(pins).toEqual([
      {
        file: 'tracked.yml',
        datasource: 'github-release-attachments',
        depName: 'koalaman/shellcheck',
        currentValue: 'v0.11.0',
        currentDigest: '0000000000000000000000000000000000000000000000000000000000000001',
      },
    ]);
    expect(violations).toEqual([
      { file: 'untracked.yml', line: 11, rule: 'untracked-tool-pin' },
      { file: 'untracked.yml', line: 17, rule: 'untracked-tool-pin' },
      { file: 'untracked.yml', line: 23, rule: 'untracked-tool-pin' },
    ]);
  });
});

describe('ci.yml', () => {
  it('runs on pull requests to main and pushes to main', async () => {
    const ci = await load('ci.yml');
    expect(ci.on).toEqual({ pull_request: { branches: ['main'] }, push: { branches: ['main'] } });
  });

  it('runs the gates in order and uploads the tested build last', async () => {
    const { check } = (await load('ci.yml')).jobs;
    const gates = check!.steps.map((s) => s.name ?? s.run?.trim() ?? s.uses?.split('@')[0]);
    expect(gates).toEqual([
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'actionlint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm check:package',
      'pnpm test:package',
      'actions/upload-artifact',
    ]);
  });

  it('scans the full history for secrets in its own job', async () => {
    const scan = (await load('ci.yml')).jobs['secret-scan']!;
    expect(JSON.stringify(scan.steps)).toContain('"fetch-depth":0');
    expect(scan.steps.at(-1)!.run).toMatch(/gitleaks" git --redact .*--exit-code 1/);
  });
});

describe('release.yml', () => {
  it('runs only after CI completes on main', async () => {
    const release = await load('release.yml');
    expect(release.on).toEqual({
      workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] },
    });
  });

  it('releases only a successful push run from this repository', async () => {
    const condition = (await load('release.yml')).jobs.release!.if!;
    expect(condition).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(condition).toContain("github.event.workflow_run.event == 'push'");
    expect(condition).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  });

  it('publishes from the npm environment with exactly the permissions it needs', async () => {
    const job = (await load('release.yml')).jobs.release!;
    expect(job.environment).toBe('npm');
    expect(job.permissions).toEqual({ contents: 'write', 'id-token': 'write', actions: 'read' });
  });

  it('publishes the artifact CI tested instead of rebuilding', async () => {
    const steps = (await load('release.yml')).jobs.release!.steps;
    expect(steps.some((s) => s.run?.includes('pnpm build'))).toBe(false);
    expect(steps.some((s) => s.uses?.startsWith('actions/download-artifact@'))).toBe(true);
    expect(steps.at(-1)!.run).toBe('pnpm exec semantic-release');
  });

  it('checks npm can publish with OIDC right before semantic-release, which pushes the tag', async () => {
    const steps = (await load('release.yml')).jobs.release!.steps as (Step & { if?: string })[];
    const check = steps.at(-2)!;
    expect(check.run).toBe('node scripts/check-npm-trusted-publishing.mjs');
    expect(check.if).toBe("steps.head.outputs.current == 'true'");
    const setupNode = steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setupNode).toBeGreaterThanOrEqual(0);
    expect(setupNode).toBeLessThan(steps.length - 2);
  });
});

describe('npm credentials', () => {
  // Markdown is prose (the ADRs and runbook say the token must not exist), so it's left out.
  it('are referenced by no workflow, config or code', async () => {
    // Spelled in parts so this file doesn't match itself.
    const names = ['NPM' + '_TOKEN', 'NODE_AUTH' + '_TOKEN'];
    const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
    const entries = await readdir(repoRoot, { recursive: true, withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name);
      if (!entry.isFile() || entry.name.endsWith('.md')) continue;
      if (
        path
          .slice(repoRoot.length)
          .split('/')
          .some((part) => skip.has(part))
      )
        continue;
      const text = await readFile(path, 'utf8');
      if (names.some((name) => text.includes(name))) offenders.push(path.slice(repoRoot.length));
    }
    expect(offenders).toEqual([]);
  });
});
