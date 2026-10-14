import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { verifyRelease } from '@semantic-release/exec';
import { generateNotes } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';
import config from '../release-config/index.js';

// The apps' shared config (@towerism/selfhost-kit/release-config), run through semantic-release's own plugins.

type PluginEntry = string | [string, Record<string, unknown>];

function pluginOptions(name: string): Record<string, unknown> {
  const entry = (config.plugins as PluginEntry[]).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  if (!entry) throw new Error(`${name} is not configured`);
  return Array.isArray(entry) ? entry[1] : {};
}

let hash = 0;
function commit(message: string) {
  hash += 1;
  return { hash: hash.toString(16).padStart(40, '0'), message };
}

const logger = { log: () => undefined, error: () => undefined, warn: () => undefined };
const cwd = process.cwd();

const bump = (message: string) =>
  analyzeCommits(pluginOptions('@semantic-release/commit-analyzer'), {
    commits: [commit(message)],
    logger,
    cwd,
  });

describe('shared release config', () => {
  it('releases from main with v-prefixed tags', () => {
    expect(config.branches).toEqual(['main']);
    expect(config.tagFormat).toBe('v${version}');
  });

  it('runs the analyzer, notes, the version file and the GitHub Release, and never publishes to npm', () => {
    expect((config.plugins as PluginEntry[]).map((p) => (Array.isArray(p) ? p[0] : p))).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/exec',
      '@semantic-release/github',
    ]);
    expect(pluginOptions('@semantic-release/github')).toEqual({
      successComment: false,
      failComment: false,
      releasedLabels: false,
    });
  });

  it.each([
    ['fix: correct the header', 'patch'],
    ['perf: cache the key', 'patch'],
    ['fix(deps): update dependency @towerism/selfhost-kit to v0.4.1', 'patch'],
    ['fix(security): reject empty AAD', 'patch'],
    ['feat: add exports', 'minor'],
    ['feat!: rename the export folder', 'major'],
    ['fix: drop the old flag\n\nBREAKING CHANGE: the flag is gone', 'major'],
  ])('releases %j as a %s', async (message, release) => {
    expect(await bump(message)).toBe(release);
  });

  it.each([
    'docs: reword',
    'chore: tidy',
    'ci: pin an action',
    'test: add a case',
    'chore(deps): update vitest',
  ])('releases nothing for %j', async (message) => {
    expect(await bump(message)).toBeNull();
  });

  it('lists security fixes first, under Security, with their advisory', async () => {
    const markdown = await generateNotes(pluginOptions('@semantic-release/release-notes-generator'), {
      commits: [
        'feat: add x',
        'fix: correct y',
        'fix(security): reject empty AAD\n\nAdvisory: GHSA-abcd-efgh-ijkl',
      ].map(commit),
      logger,
      cwd,
      options: { repositoryUrl: 'https://github.com/Towerism/example-app.git' },
      lastRelease: { gitTag: 'v1.3.0', version: '1.3.0' },
      nextRelease: { gitTag: 'v1.4.0', version: '1.4.0' },
    });
    expect(markdown.match(/^### .+$/gm)).toEqual(['### Security', '### Features', '### Bug Fixes']);
    const security = markdown.slice(markdown.indexOf('### Security'), markdown.indexOf('### Features'));
    expect(security).toContain(
      'reject empty AAD ([GHSA-abcd-efgh-ijkl](https://github.com/advisories/GHSA-abcd-efgh-ijkl))',
    );
  });

  it('writes the next version to $RUNNER_TEMP/release-version for the image-tagging step', async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), 'selfhost-kit-runner-'));
    try {
      await verifyRelease(pluginOptions('@semantic-release/exec'), {
        cwd,
        env: { ...process.env, RUNNER_TEMP: runnerTemp },
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        logger,
        nextRelease: { version: '1.4.0', gitTag: 'v1.4.0' },
      });
      expect(await readFile(join(runnerTemp, 'release-version'), 'utf8')).toBe('1.4.0\n');
    } finally {
      await rm(runnerTemp, { recursive: true, force: true });
    }
  });
});
