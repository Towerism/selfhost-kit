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
  id?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  'timeout-minutes'?: number;
  uses?: string;
  with?: Record<string, unknown>;
  needs?: string | string[];
  steps: Step[];
}
interface Workflow {
  on: Record<string, Record<string, unknown>>;
  permissions?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
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

describe('expressions in shell', () => {
  // An input or event field expanded into `run:` is shell injection; it must arrive through `env:`.
  it('never appear inside a run block, in any workflow', async () => {
    const offenders: string[] = [];
    for (const file of (await readdir(workflows)).filter((f) => /\.ya?ml$/.test(f))) {
      for (const [jobName, job] of Object.entries((await load(file)).jobs)) {
        // A job that calls a reusable workflow has no steps of its own.
        for (const step of (job as Partial<Job>).steps ?? []) {
          if (step.run?.includes('${{')) offenders.push(`${file}:${jobName}:${step.name ?? step.run}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
      ['ci.yml', 'github-release-attachments', 'koalaman/shellcheck'],
      ['ci.yml', 'github-release-attachments', 'hadolint/hadolint'],
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
      'shellcheck',
      'hadolint',
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

describe('ci.yml sample caller', () => {
  it('runs the reusable image workflow from this commit on the fixture image, publishing nothing', async () => {
    const job = (await load('ci.yml')).jobs['sample-caller']!;
    expect(job.uses).toBe('./.github/workflows/app-image.yml');
    expect(job.with).toEqual({
      'image-name': 'ghcr.io/towerism/selfhost-kit-fixture',
      file: 'test/entrypoint/Dockerfile',
      target: 'fixture',
      publish: false,
      'smoke-scripts': 'test/entrypoint/run.sh\n',
    });
  });

  it('grants exactly what the image job asks for, and runs alongside check', async () => {
    const job = (await load('ci.yml')).jobs['sample-caller']!;
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job.needs).toBeUndefined();
  });
});

type CallInput = { type: string; required?: boolean; default?: unknown; description?: string };
async function callInputs(name: string) {
  const on = (await load(name)).on as {
    workflow_call: { inputs: Record<string, CallInput>; outputs?: object };
  };
  return on.workflow_call;
}
const stepNames = (job: Job) => job.steps.map((s) => s.name ?? s.uses?.split('@')[0] ?? s.run?.trim());

describe('app-image.yml', () => {
  it('is called with an image name, optional target, file, context, smoke scripts and publish switch', async () => {
    const call = await callInputs('app-image.yml');
    const inputs = Object.fromEntries(
      Object.entries(call.inputs).map(([k, v]) => [k, [v.type, v.required ?? false, v.default]]),
    );
    expect(inputs).toEqual({
      'image-name': ['string', true, undefined],
      target: ['string', false, 'app'],
      file: ['string', false, 'Dockerfile'],
      context: ['string', false, '.'],
      'smoke-scripts': ['string', false, ''],
      publish: ['boolean', false, true],
    });
    expect(Object.keys(call.outputs ?? {})).toEqual(['digest']);
  });

  it('runs its shell steps with bash -eo pipefail', async () => {
    expect((await load('app-image.yml')).defaults).toEqual({ run: { shell: 'bash' } });
  });

  it('reads only its repository, writes only packages, and has a timeout', async () => {
    const workflow = await load('app-image.yml');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.image!;
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job['timeout-minutes']).toBe(30);
    expect(job.outputs).toEqual({ digest: '${{ steps.push.outputs.digest }}' });
  });

  it('builds once, labelled, smoke-tests, and only then decides whether to publish', async () => {
    const job = (await load('app-image.yml')).jobs.image!;
    expect(stepNames(job)).toEqual([
      'actions/checkout',
      'docker/setup-buildx-action',
      'Image tags',
      'Build',
      'Smoke tests',
      'Decide whether to publish',
      'docker/login-action',
      'Publish to GHCR',
    ]);
    const meta = job.steps[2]!;
    expect(meta.if).toBeUndefined();
    expect(meta.with?.tags).toBe(
      "type=edge,branch=main\ntype=ref,event=pr\ntype=sha,enable=${{ github.event_name == 'push' }}\n",
    );
    const builds = job.steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'));
    expect(builds).toEqual([job.steps[3]]);
    expect(builds[0]!.id).toBe('build');
    expect(builds[0]!.with).toEqual({
      context: '${{ inputs.context }}',
      file: '${{ inputs.file }}',
      target: '${{ inputs.target }}',
      platforms: 'linux/amd64',
      load: true,
      tags: 'app-image:smoke-test',
      labels: '${{ steps.meta.outputs.labels }}',
      'cache-from': 'type=gha',
      'cache-to': 'type=gha,mode=max',
    });
    expect(JSON.stringify(job.steps[0]!.with)).toContain('"persist-credentials":false');
  });

  it('publishes only when asked to, only for pushes and same-repository pull requests, and never rebuilds', async () => {
    const job = (await load('app-image.yml')).jobs.image!;
    const decide = job.steps.find((s) => s.name === 'Decide whether to publish')!;
    expect(decide.env).toEqual({
      PUBLISH: '${{ inputs.publish }}',
      EVENT: '${{ github.event_name }}',
      HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
      REPO: '${{ github.repository }}',
    });
    const afterDecide = job.steps.slice(job.steps.indexOf(decide) + 1);
    expect(afterDecide).toHaveLength(2);
    for (const step of afterDecide) {
      expect(step.if).toBe("steps.publish.outputs.enabled == 'true'");
      expect(step.uses ?? '').not.toMatch(/^docker\/build-push-action@/);
    }
    const push = job.steps.at(-1)!;
    expect(push.id).toBe('push');
    expect(push.env).toEqual({
      IMAGE_ID: '${{ steps.build.outputs.imageid }}',
      IMAGE_NAME: '${{ inputs.image-name }}',
      TAGS: '${{ steps.meta.outputs.tags }}',
    });
  });

  it('logs in to GHCR with the job token only', async () => {
    const job = (await load('app-image.yml')).jobs.image!;
    const login = job.steps.find((s) => s.uses?.startsWith('docker/login-action@'))!;
    expect(login.with).toEqual({
      registry: 'ghcr.io',
      username: '${{ github.actor }}',
      password: '${{ github.token }}',
    });
  });
});

describe('app-release.yml', () => {
  it('is called with the image name and the digest the image job published', async () => {
    const call = await callInputs('app-release.yml');
    expect(
      Object.fromEntries(Object.entries(call.inputs).map(([k, v]) => [k, [v.type, v.required]])),
    ).toEqual({
      'image-name': ['string', true],
      digest: ['string', true],
    });
  });

  it('writes tags, releases and packages, and nothing else', async () => {
    const workflow = await load('app-release.yml');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.release!;
    expect(job.permissions).toEqual({ contents: 'write', packages: 'write' });
    expect(job['timeout-minutes']).toBe(15);
  });

  it('tags the tested image before it pushes the git tag and the GitHub Release, then checks the tag', async () => {
    const job = (await load('app-release.yml')).jobs.release!;
    expect(stepNames(job)).toEqual([
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'pnpm install --frozen-lockfile',
      'Next version (dry run)',
      'Decide whether to release',
      "Check that main hasn't moved on",
      'docker/login-action',
      'Tag the image X.Y.Z, X.Y, latest',
      'Git tag and GitHub Release',
      'Check the git tag',
    ]);
    expect(job.steps[4]!.run).toBe('pnpm exec semantic-release --dry-run');
    expect(job.steps.at(-2)!.run).toBe('pnpm exec semantic-release');
    expect(job.steps[6]!.if).toBe("steps.next.outputs.version != ''");
    for (const step of job.steps.slice(7)) {
      expect(step.if).toBe("steps.next.outputs.version != '' && steps.head.outputs.current == 'true'");
    }
  });

  it('reads main and the tag through the API with the job token, so private callers work', async () => {
    const job = (await load('app-release.yml')).jobs.release!;
    for (const name of ["Check that main hasn't moved on", 'Check the git tag']) {
      const step = job.steps.find((s) => s.name === name)!;
      expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
      expect(step.run).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/');
    }
    expect(JSON.stringify(job.steps)).not.toContain('ls-remote');
  });

  it('runs its shell steps with bash -eo pipefail', async () => {
    expect((await load('app-release.yml')).defaults).toEqual({ run: { shell: 'bash' } });
  });

  it('refuses to release when the image job published no digest', async () => {
    const job = (await load('app-release.yml')).jobs.release!;
    const tag = job.steps.find((s) => s.name === 'Tag the image X.Y.Z, X.Y, latest')!;
    expect(tag.env).toEqual({
      IMAGE_NAME: '${{ inputs.image-name }}',
      VERSION: '${{ steps.next.outputs.version }}',
      DIGEST: '${{ inputs.digest }}',
    });
    const refusal = tag.run!.indexOf('if [ -z "$DIGEST" ]');
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeLessThan(tag.run!.indexOf('imagetools create'));
    expect(tag.run).toContain('exit 1');
  });

  it('checks out the full history without keeping the token in git config', async () => {
    const job = (await load('app-release.yml')).jobs.release!;
    expect(job.steps[0]!.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
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
