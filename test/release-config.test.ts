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

  // From 1.0 (K5) a breaking change is a major. The custom rules shadow the preset's own breaking → major
  // (commit-analyzer falls back to its defaults only when no custom rule matches), so the rule is explicit;
  // without it `feat!:` would release a minor and `refactor!:` nothing.
  it.each([
    'feat!: rename the vault option',
    'fix: drop the old option\n\nBREAKING CHANGE: the option is gone',
    'refactor!: stop exporting an internal type',
    'ci!: rename a reusable workflow input',
  ])('releases a breaking change as a major: %s', async (message) => {
    expect(await bump(message)).toBe('major');
  });

  it.each(['docs', 'test', 'chore', 'ci', 'refactor', 'build', 'style'])(
    'releases nothing for %s commits',
    async (type) => {
      expect(await bump(`${type}: tidy up`)).toBeNull();
    },
  );

  async function renovateRules() {
    const renovate = JSON.parse(await readFile(new URL('../renovate.json', import.meta.url), 'utf8')) as {
      packageRules: { semanticCommitType?: string; matchDepNames?: string[] }[];
    };
    return renovate.packageRules;
  }
  // What the kit ships, as opposed to the tooling that builds and checks it.
  const SHIPPED = ['benbjohnson/litestream'];

  it("releases nothing for Renovate's tooling updates, security ones included", async () => {
    const tooling = (await renovateRules()).filter((r) => !r.matchDepNames?.some((d) => SHIPPED.includes(d)));
    // `chore` is what config:recommended gives devDependencies; the rules add the rest.
    const types = new Set(['chore', ...tooling.flatMap((r) => r.semanticCommitType ?? [])]);
    for (const type of types) {
      expect(await bump(`${type}(deps): update dependency foo to v1.2.3`)).toBeNull();
      expect(await bump(`${type}(deps): update dependency foo to v1.2.3 [security]`)).toBeNull();
    }
    expect([...types].sort()).toEqual(['chore', 'ci']);
  });

  it('releases a Litestream update as a patch, because the Docker assets install it', async () => {
    const rules = (await renovateRules()).filter((r) => r.matchDepNames?.some((d) => SHIPPED.includes(d)));
    expect(rules.map((r) => r.semanticCommitType)).toEqual(['fix']);
    expect(await bump('fix(deps): update dependency benbjohnson/litestream to v0.5.18')).toBe('patch');
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

  // A major's BREAKING CHANGES section is its migration guide (ADR-0005 rule 5). The commit's trailers come
  // after the footer, so the parser would append them to the note.
  it('keeps co-author trailers out of the breaking-change notes, keeping the note whole', async () => {
    const markdown = await notes([
      "feat(logging)!: require a redactor\n\nWhy.\n\nBREAKING CHANGE: pass the app's redactor.\nSecond line of the step.\n\nCo-Authored-By: Someone <someone@example.com>\nCo-authored-by: Other <other@example.com>",
    ]);
    const breaking = markdown.slice(markdown.indexOf('BREAKING CHANGES'), markdown.indexOf('### Features'));
    expect(breaking).toContain("pass the app's redactor.\nSecond line of the step.");
    expect(breaking).not.toMatch(/co-authored-by/i);
  });

  it('needs no issue or pull-request permissions from the GitHub plugin', () => {
    expect(pluginOptions('@semantic-release/github')).toEqual({
      successComment: false,
      failComment: false,
      releasedLabels: false,
    });
  });
});
