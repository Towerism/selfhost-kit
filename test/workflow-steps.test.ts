import { describe, expect, it } from 'vitest';
import { runStep } from './helpers/workflow-step.js';

// The shell inside the reusable workflows, run as the runner runs it (bash -eo pipefail) against stub
// docker/gh. The YAML around it is covered by workflows.test.ts.
const IMAGE = 'app-image:smoke-test';
const calls = (run: Awaited<ReturnType<typeof runStep>>) => run.calls.map((c) => [c.tool, ...c.argv]);

describe('app-image.yml smoke tests', () => {
  const smoke = (scripts: string, files: Record<string, { content: string }> = {}) =>
    runStep('app-image.yml', 'Smoke tests', {
      env: { SMOKE_SCRIPTS: scripts, IMAGE },
      stubs: { ran: [] },
      files,
    });
  const script = (body: string) => ({ content: `#!/bin/sh\n${body}\n` });

  it('runs every script, even after one that reads stdin', async () => {
    const run = await smoke('  reads.sh  \n./after.sh\n', {
      'reads.sh': script('cat >/dev/null\nran reads "$@"'),
      'after.sh': script('ran after "$@"'),
    });
    expect(run.code).toBe(0);
    expect(calls(run)).toEqual([
      ['ran', 'reads', IMAGE],
      ['ran', 'after', IMAGE],
    ]);
    expect(run.stdout).not.toContain('::warning');
  });

  it('stops at the first failing script and fails the step', async () => {
    const run = await smoke('fail.sh\nafter.sh\n', {
      'fail.sh': script('ran fail\nexit 3'),
      'after.sh': script('ran after'),
    });
    expect(run.code).toBe(3);
    expect(calls(run)).toEqual([['ran', 'fail']]);
  });

  it.each(['', '\n', '  \n\t\n'])('warns, and succeeds, when no script is given: %j', async (scripts) => {
    const run = await smoke(scripts);
    expect(run.code).toBe(0);
    const warnings = run.stdout.split('\n').filter((line) => line.startsWith('::warning'));
    expect(warnings).toEqual([
      '::warning title=No smoke tests::No smoke-scripts were given, so the image was not smoke-tested.',
    ]);
  });
});

describe('app-image.yml publish', () => {
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  const ID = `sha256:${'1'.repeat(64)}`;
  const publish = (tags: string, push: { stdout?: string; status?: number }) =>
    runStep('app-image.yml', 'Publish to GHCR', {
      env: { IMAGE_ID: ID, IMAGE_NAME: 'ghcr.io/x/app', TAGS: tags },
      stubs: { docker: [{ argv: ['push'], ...push }] },
    });

  it('pushes the tested image once, under its sha tag, and adds the others by digest', async () => {
    const run = await publish('ghcr.io/x/app:edge\nghcr.io/x/app:sha-abc1234\n', {
      stdout: `The push refers to repository [ghcr.io/x/app]\nsha-abc1234: digest: ${DIGEST} size: 1234\n`,
    });
    expect(run.code).toBe(0);
    expect(calls(run)).toEqual([
      ['docker', 'tag', ID, 'ghcr.io/x/app:sha-abc1234'],
      ['docker', 'push', 'ghcr.io/x/app:sha-abc1234'],
      // Without --prefer-index=false, buildx >= 0.13 wraps the pushed manifest in a new index, so `edge`
      // would name another digest than the one this job outputs (#30).
      [
        'docker',
        'buildx',
        'imagetools',
        'create',
        '--prefer-index=false',
        '--tag',
        'ghcr.io/x/app:edge',
        `ghcr.io/x/app@${DIGEST}`,
      ],
    ]);
    expect(run.outputs).toEqual({ digest: DIGEST });
  });

  it('pushes a pull request image under its one tag', async () => {
    const run = await publish('ghcr.io/x/app:pr-7', { stdout: `pr-7: digest: ${DIGEST} size: 99\n` });
    expect(run.code).toBe(0);
    expect(calls(run)).toEqual([
      ['docker', 'tag', ID, 'ghcr.io/x/app:pr-7'],
      ['docker', 'push', 'ghcr.io/x/app:pr-7'],
    ]);
    expect(run.outputs).toEqual({ digest: DIGEST });
  });

  it.each([
    ['a push that reports no digest', 'ghcr.io/x/app:pr-7', { stdout: 'pr-7: pushed\n' }, 2],
    [
      'a push that reports a short digest',
      'ghcr.io/x/app:pr-7',
      { stdout: 'digest: sha256:abc size: 1\n' },
      2,
    ],
    ['a failing push', 'ghcr.io/x/app:pr-7', { stdout: `digest: ${DIGEST} size: 1\n`, status: 1 }, 2],
    ['no tags at all', '\n', { stdout: `digest: ${DIGEST} size: 1\n` }, 0],
  ])('fails, publishing no digest, on %s', async (_, tags, push, dockerCalls) => {
    const run = await publish(tags, push);
    expect(run.code).not.toBe(0);
    expect(run.outputs).toEqual({});
    expect(run.calls).toHaveLength(dockerCalls);
    expect(run.stdout).toMatch(/^::error::/m);
  });
});

describe('app-release.yml', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const TAG_OBJECT = 'c'.repeat(40);
  const env = { GITHUB_REPOSITORY: 'o/app', GITHUB_SHA: SHA, GH_TOKEN: 'synthetic-token' };
  const refHeadsMain = ['api', 'repos/o/app/git/ref/heads/main'];
  const refTag = ['api', 'repos/o/app/git/ref/tags/v1.2.3'];

  describe('tagging the image X.Y.Z, X.Y and latest', () => {
    const DIGEST = `sha256:${'d'.repeat(64)}`;
    const WRAPPED = `sha256:${'e'.repeat(64)}`;
    const IMAGE = 'ghcr.io/x/app';
    const TAGS = [`${IMAGE}:1.2.3`, `${IMAGE}:1.2`, `${IMAGE}:latest`];
    // `imagetools inspect --format '{{json .Manifest}}'` as buildx prints it: indented, the descriptor's own
    // digest at the top level. An index lists more digests further in.
    const manifest = (digest: string) =>
      `{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.index.v1+json",\n  "digest": "${digest}",\n  "size": 402,\n  "manifests": [\n    {\n      "digest": "${DIGEST}",\n      "size": 734\n    }\n  ]\n}\n`;
    const inspect = (tag: string) => ['buildx', 'imagetools', 'inspect', tag];
    const tag = (answers: { argv: string[]; stdout?: string; status?: number }[], digest = DIGEST) =>
      runStep('app-release.yml', 'Tag the image X.Y.Z, X.Y, latest', {
        env: { IMAGE_NAME: IMAGE, VERSION: '1.2.3', DIGEST: digest },
        stubs: { docker: answers },
      });

    it('tags exactly the tested digest, then checks that each tag names it', async () => {
      const run = await tag(TAGS.map((t) => ({ argv: inspect(t), stdout: manifest(DIGEST) })));
      expect(run.code).toBe(0);
      expect(calls(run)).toEqual([
        [
          'docker',
          'buildx',
          'imagetools',
          'create',
          '--prefer-index=false',
          ...TAGS.flatMap((t) => ['--tag', t]),
          `${IMAGE}@${DIGEST}`,
        ],
        ...TAGS.map((t) => ['docker', ...inspect(t), '--format', '{{json .Manifest}}']),
      ]);
      expect(run.stdout).not.toContain('::error::');
    });

    it.each(TAGS)('fails before the git tag when %s names another digest', async (wrong) => {
      const run = await tag(
        TAGS.map((t) => ({ argv: inspect(t), stdout: manifest(t === wrong ? WRAPPED : DIGEST) })),
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toMatch(/^::error::/m);
      const error = run.stdout.split('\n').find((line) => line.startsWith('::error::'))!;
      expect(error).toContain(wrong);
      expect(error).toContain(WRAPPED);
      expect(error).toContain(DIGEST);
      // The tags were already moved: whoever is on call must know to re-pin the previous release.
      expect(error).toContain('already moved');
    });

    it('fails when a tag cannot be inspected', async () => {
      const run = await tag([
        { argv: inspect(TAGS[0]!), stdout: manifest(DIGEST) },
        { argv: inspect(TAGS[1]!), status: 1 },
      ]);
      expect(run.code).not.toBe(0);
    });

    it('refuses to tag anything without a digest', async () => {
      const run = await tag([], '');
      expect(run.code).toBe(1);
      expect(run.calls).toEqual([]);
      expect(run.stdout).toMatch(/^::error::The image job published no digest/m);
    });
  });

  describe("checking that main hasn't moved on", () => {
    const check = (answer: { stdout?: string; status?: number }) =>
      runStep('app-release.yml', "Check that main hasn't moved on", {
        env,
        stubs: { gh: [{ argv: refHeadsMain, ...answer }] },
      });

    it('is current when main is still the commit the dry run saw', async () => {
      const run = await check({ stdout: `${SHA}\n` });
      expect(run.code).toBe(0);
      expect(run.outputs).toEqual({ current: 'true' });
      expect(calls(run)).toEqual([['gh', ...refHeadsMain, '--jq', '.object.sha']]);
    });

    it("isn't current, and succeeds, when main has moved on", async () => {
      const run = await check({ stdout: `${OTHER}\n` });
      expect(run.code).toBe(0);
      expect(run.outputs).toEqual({ current: 'false' });
      expect(run.stdout).toContain(`main is at ${OTHER}, not ${SHA}: the newer commit's run releases.`);
    });

    it('fails when main cannot be read', async () => {
      const run = await check({ status: 1 });
      expect(run.code).not.toBe(0);
      expect(run.outputs).toEqual({});
    });
  });

  describe('checking the git tag after the release', () => {
    const verify = (answers: { argv: string[]; stdout?: string; status?: number }[]) =>
      runStep('app-release.yml', 'Check the git tag', {
        env: { ...env, VERSION: '1.2.3' },
        stubs: { gh: answers },
      });

    it('passes for a lightweight tag on the released commit', async () => {
      const run = await verify([{ argv: refTag, stdout: `commit ${SHA}\n` }]);
      expect(run.code).toBe(0);
      expect(calls(run)).toEqual([['gh', ...refTag, '--jq', '.object.type + " " + .object.sha']]);
    });

    it('follows an annotated tag to its commit', async () => {
      const run = await verify([
        { argv: refTag, stdout: `tag ${TAG_OBJECT}\n` },
        { argv: ['api', `repos/o/app/git/tags/${TAG_OBJECT}`], stdout: `${SHA}\n` },
      ]);
      expect(run.code).toBe(0);
      expect(calls(run)).toEqual([
        ['gh', ...refTag, '--jq', '.object.type + " " + .object.sha'],
        ['gh', 'api', `repos/o/app/git/tags/${TAG_OBJECT}`, '--jq', '.object.sha'],
      ]);
    });

    it.each([
      ['no tag', [{ argv: refTag, status: 1 }]],
      ['a tag on another commit', [{ argv: refTag, stdout: `commit ${OTHER}\n` }]],
    ])('fails loudly on %s', async (_, answers) => {
      const run = await verify(answers);
      expect(run.code).not.toBe(0);
      expect(run.stdout).toMatch(new RegExp(`^::error::.*v1\\.2\\.3.*${SHA}`, 'm'));
      expect(run.stdout).toContain('latest');
    });
  });
});
