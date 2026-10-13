import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findCoreBoundaryViolations } from './helpers/core-boundary.js';

const fixtures = fileURLToPath(new URL('fixtures/core-boundary/', import.meta.url));
const realCore = fileURLToPath(new URL('../src/core/', import.meta.url));

describe('core boundary scanner', () => {
  it('reports every framework specifier, in every import form, with file and line', async () => {
    const violations = await findCoreBoundaryViolations(`${fixtures}forbidden`);

    expect(violations.map((v) => `${v.file}:${String(v.line)} ${v.specifier}`).sort()).toEqual([
      'dynamic.ts:2 #imports',
      'nested/deep.ts:1 nuxt',
      're-export.ts:1 nitropack/runtime',
      'static.ts:1 h3',
      'subpath.ts:1 h3/dist/index.mjs',
      'type-only.ts:1 nuxt/schema',
    ]);
  });

  it('ignores lookalike names and relative paths', async () => {
    expect(await findCoreBoundaryViolations(`${fixtures}allowed`)).toEqual([]);
  });

  it('finds nothing in the real src/core', async () => {
    expect(await findCoreBoundaryViolations(realCore)).toEqual([]);
  });
});
