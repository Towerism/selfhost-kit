import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** The report that lists each entry point's exports (scripts/api-report.mjs). */
const REPORT: Record<string, string> = {
  '@towerism/selfhost-kit': 'api/core.api.md',
  '@towerism/selfhost-kit/nitro': 'api/nitro.api.md',
  '@towerism/selfhost-kit/testing': 'api/testing.api.md',
  '@towerism/selfhost-kit/release-config': 'api/release-config.api.md',
};

/** Named imports from the kit in the doc's `ts` blocks, as [specifier, name] pairs. */
function kitImports(markdown: string): [string, string][] {
  const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const pairs: [string, string][] = [];
  for (const block of blocks) {
    for (const [, names, specifier] of block.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(@towerism\/selfhost-kit[^']*)'/g,
    )) {
      for (const raw of names!.split(',')) {
        const name = raw
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim();
        if (name) pairs.push([specifier!, name]);
      }
    }
  }
  return pairs;
}

/** The names a report lists as exports: its `## \`name\`` headings before "Referenced, not exported". */
async function exportsOf(specifier: string): Promise<Set<string>> {
  const report = REPORT[specifier];
  if (!report) throw new Error(`${specifier} is not an entry point`);
  const text = (await read(report)).split('## Referenced, not exported')[0]!;
  return new Set([...text.matchAll(/^## `([^`]+)`/gm)].map((m) => m[1]!));
}

describe('docs/adopting.md', () => {
  it('walks an app through adoption in order', async () => {
    const headings = [...(await read('docs/adopting.md')).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'Requirements',
      'Install and pin',
      'Secrets and the launcher',
      'Logging',
      'Security headers and CSP',
      'Nitro middleware, plugins and error handler',
      'The vault',
      'Contract suites',
      'Docker assets, workflows and releases',
      'Upgrading from 0.4.x',
      'What the public API is',
    ]);
  });

  it('imports only what each entry point exports', async () => {
    const pairs = kitImports(await read('docs/adopting.md'));
    expect(pairs.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const [specifier, name] of pairs) {
      if (!(await exportsOf(specifier)).has(name)) missing.push(`${name} from ${specifier}`);
    }
    expect(missing).toEqual([]);
  });

  it('notices an import the entry point does not export', async () => {
    const pairs = kitImports("```ts\nimport { createVault, nope } from '@towerism/selfhost-kit';\n```\n");
    expect(pairs).toEqual([
      ['@towerism/selfhost-kit', 'createVault'],
      ['@towerism/selfhost-kit', 'nope'],
    ]);
    expect((await exportsOf('@towerism/selfhost-kit')).has('nope')).toBe(false);
  });

  it('lists one upgrade step per breaking change of 1.0', async () => {
    const doc = await read('docs/adopting.md');
    const upgrade = doc.slice(
      doc.indexOf('## Upgrading from 0.4.x'),
      doc.indexOf('## What the public API is'),
    );
    for (const needle of [
      '9007199254740991',
      'peer dependencies',
      'redactor',
      'logger',
      'LogLevel',
      'NitroAppLike',
    ]) {
      expect(upgrade).toContain(needle);
    }
  });
});

describe('the 1.0 docs', () => {
  it("README says what each entry point needs in the app, and which installers can't resolve it", async () => {
    const readme = await read('README.md');
    const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('## Security'));
    for (const needle of [
      'h3',
      'vitest',
      'semantic-release',
      '@semantic-release/exec',
      'conventional-changelog-conventionalcommits',
      'enable-global-virtual-store',
      'Yarn PnP',
      'docs/adopting.md',
    ]) {
      expect(install).toContain(needle);
    }
    expect(install).not.toMatch(/0\.x/);
  });

  it('SECURITY.md has no 0.x rule left', async () => {
    expect(await read('SECURITY.md')).not.toMatch(/0\.x/);
  });

  it('the releasing guide says a breaking change is a major', async () => {
    const row = (await read('docs/releasing.md'))
      .split('\n')
      .find((line) => line.includes('BREAKING CHANGE'));
    expect(row).toMatch(/\|\s*major\s*\|\s*$/);
  });
});
