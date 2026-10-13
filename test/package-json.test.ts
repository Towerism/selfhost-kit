import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;

describe('package.json', () => {
  it('names the exact repository URL npm checks provenance against', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Towerism/selfhost-kit.git',
    });
  });

  it('publishes publicly with provenance', () => {
    expect(manifest.publishConfig).toEqual({ access: 'public', provenance: true });
  });

  it('is an ESM-only, side-effect-free package for Node 24.11+', () => {
    expect(manifest.type).toBe('module');
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.engines).toEqual({ node: '>=24.11' });
  });

  it('builds and releases on the Node major its engines floor names', () => {
    const nodeVersion = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
    const floor = (manifest.engines as { node: string }).node;
    expect(nodeVersion).toBe('24');
    expect(floor.startsWith(`>=${nodeVersion}.`)).toBe(true);
  });

  it('depends at runtime on pino and pino-pretty only, each on a caret range (ADR-0003)', () => {
    const dependencies = manifest.dependencies as Record<string, string>;
    expect(Object.keys(dependencies).sort()).toEqual(['pino', 'pino-pretty']);
    for (const range of Object.values(dependencies)) expect(range).toMatch(/^\^[1-9]\d*\.\d+\.\d+$/);
  });

  it('declares h3 and vitest as optional peers only', () => {
    expect(Object.keys(manifest.peerDependencies as object).sort()).toEqual(['h3', 'vitest']);
    expect((manifest.peerDependencies as Record<string, string>).h3).toBe('^1.15');
    expect(manifest.peerDependenciesMeta).toEqual({
      h3: { optional: true },
      vitest: { optional: true },
    });
  });

  it('exports exactly the three entry points and package.json, types first', () => {
    expect(manifest.exports).toEqual({
      '.': { types: './dist/core/index.d.ts', default: './dist/core/index.js' },
      './nitro': { types: './dist/nitro/index.d.ts', default: './dist/nitro/index.js' },
      './testing': { types: './dist/testing/index.d.ts', default: './dist/testing/index.js' },
      './package.json': './package.json',
    });
    for (const entry of ['.', './nitro', './testing']) {
      const conditions = Object.keys((manifest.exports as Record<string, object>)[entry]!);
      expect(conditions[0]).toBe('types');
    }
  });

  it('pins pnpm exactly', () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});
