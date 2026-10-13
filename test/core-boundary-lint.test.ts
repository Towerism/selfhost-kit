import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// The repository's own config, narrowed to the boundary rules. Virtual paths have no type information,
// so the type-aware rules are filtered out and the project service is turned off.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: [{ languageOptions: { parserOptions: { projectService: false } } }],
  ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports' || ruleId === 'no-restricted-syntax',
});

const forbidden = [
  "import { createApp } from 'h3';",
  "export * from 'nitropack/runtime';",
  "import type { NuxtConfig } from 'nuxt/schema';",
  "export async function load() { return import('#imports'); }",
  "export { defineEventHandler } from 'h3';",
];

async function boundaryMessages(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.message.includes('ADR-0006'));
}

describe('core boundary lint rule', () => {
  it.each(forbidden)('rejects %s in src/core', async (code) => {
    const messages = await boundaryMessages(code, 'src/core/example.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.severity).toBe(2);
  });

  it.each(forbidden)('allows %s in src/nitro', async (code) => {
    expect(await boundaryMessages(code, 'src/nitro/example.ts')).toEqual([]);
  });

  it.each(["import { x } from 'h3-utils';", "import { y } from './h3.js';", "import { z } from 'nuxtlike';"])(
    'does not flag the lookalike %s',
    async (code) => {
      expect(await boundaryMessages(code, 'src/core/example.ts')).toEqual([]);
    },
  );
});
