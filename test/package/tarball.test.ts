import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packKit, type PackedKit } from './kit-tarball.js';

let kit: PackedKit;

beforeAll(async () => {
  kit = await packKit();
});

afterAll(async () => {
  await kit.cleanup();
});

describe('published tarball', () => {
  it('contains only the manifest, docs and compiled JS with its declarations', () => {
    const allowed = /^(package\.json|README\.md|LICENSE|SECURITY\.md|dist\/.+\.(js|d\.ts))$/;
    expect(kit.files.filter((path) => !allowed.test(path))).toEqual([]);
  });

  it('ships every entry point with its types', () => {
    expect(kit.files).toEqual(
      expect.arrayContaining(
        ['core', 'nitro', 'testing'].flatMap((entry) => [
          `dist/${entry}/index.js`,
          `dist/${entry}/index.d.ts`,
        ]),
      ),
    );
  });

  it('ships the security policy', () => {
    expect(kit.files).toContain('SECURITY.md');
  });

  it('ships no TypeScript sources, tests or workflows', () => {
    expect(
      kit.files.filter(
        (path) => (path.endsWith('.ts') && !path.endsWith('.d.ts')) || /^(src|test|\.github)\//.test(path),
      ),
    ).toEqual([]);
  });
});
