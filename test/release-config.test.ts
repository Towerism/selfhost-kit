import { readFile } from 'node:fs/promises';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';
import config from '../release.config.mjs';

type PluginEntry = string | [string, Record<string, unknown>];

function pluginOptions(name: string): Record<string, unknown> {
  const entry = (config.plugins as PluginEntry[]).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  if (!entry) throw new Error(`${name} is not configured`);
  return Array.isArray(entry) ? entry[1] : {};
}

let hash = 0;
/** A synthetic commit as semantic-release hands it to its plugins. */
function commit(message: string) {
  hash += 1;
  return { hash: hash.toString(16).padStart(40, '0'), message };
}

const logger = { log: () => undefined, error: () => undefined, warn: () => undefined };
const cwd = process.cwd();

function bump(message: string): Promise<string | null> {
  return analyzeCommits(pluginOptions('@semantic-release/commit-analyzer'), {
    commits: [commit(message)],
    logger,
    cwd,
  });
}

function notes(messages: string[]): Promise<string> {
  return generateNotes(pluginOptions('@semantic-release/release-notes-generator'), {
    commits: messages.map(commit),
    logger,
    cwd,
    options: { repositoryUrl: 'https://github.com/Towerism/selfhost-kit.git' },
    lastRelease: { gitTag: 'v0.1.0', version: '0.1.0' },
    nextRelease: { gitTag: 'v0.1.1', version: '0.1.1' },
  });
}

describe('release config', () => {
  it('releases from main only', () => {
    expect(config.branches).toEqual(['main']);
  });

  it.each([
    ['fix: correct the header', 'patch'],
    ['perf: cache the key', 'patch'],
    ['feat: add the vault', 'minor'],
  ])('releases %s as a %s', async (message, release) => {
    expect(await bump(message)).toBe(release);
  });

  it.each([
    'feat!: rename the vault option',
    'fix: drop the old option\n\nBREAKING CHANGE: the option is gone',
  ])('releases a breaking change as a minor while in 0.x: %s', async (message) => {
    expect(await bump(message)).toBe('minor');
  });

  it.each(['docs', 'test', 'chore', 'ci', 'refactor', 'build', 'style'])(
    'releases nothing for %s commits',
    async (type) => {
      expect(await bump(`${type}: tidy up`)).toBeNull();
    },
  );

  it("releases nothing for Renovate's tooling updates, security ones included", async () => {
    const renovate = JSON.parse(await readFile(new URL('../renovate.json', import.meta.url), 'utf8')) as {
      packageRules: { semanticCommitType?: string }[];
    };
    // `chore` is what config:recommended gives devDependencies; the rules add the rest.
    const types = new Set(['chore', ...renovate.packageRules.flatMap((r) => r.semanticCommitType ?? [])]);
    for (const type of types) {
      expect(await bump(`${type}(deps): update dependency foo to v1.2.3`)).toBeNull();
      expect(await bump(`${type}(deps): update dependency foo to v1.2.3 [security]`)).toBeNull();
    }
    expect([...types].sort()).toEqual(['chore', 'ci']);
  });

  it('lists security fixes first, under Security, with their advisory', async () => {
    const markdown = await notes([
      'feat: add x',
      'fix: correct y',
      'fix(security): reject empty AAD\n\nAdvisory: GHSA-abcd-efgh-ijkl',
    ]);

    const headings = markdown.match(/^### .+$/gm);
    expect(headings).toEqual(['### Security', '### Features', '### Bug Fixes']);

    const security = markdown.slice(markdown.indexOf('### Security'), markdown.indexOf('### Features'));
    expect(security).toContain('reject empty AAD');
    expect(security).toContain('GHSA-abcd-efgh-ijkl');

    const bugFixes = markdown.slice(markdown.indexOf('### Bug Fixes'));
    expect(bugFixes).toContain('correct y');
    expect(bugFixes).not.toContain('reject empty AAD');
  });

  it('still lists a security fix without an advisory footer', async () => {
    const markdown = await notes(['fix(security): tighten the default']);
    expect(markdown).toMatch(/### Security[\s\S]*tighten the default/);
  });

  it('needs no issue or pull-request permissions from the GitHub plugin', () => {
    expect(pluginOptions('@semantic-release/github')).toEqual({
      successComment: false,
      failComment: false,
      releasedLabels: false,
    });
  });
});
