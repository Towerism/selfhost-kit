import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeConsumer, packKit, type Consumer, type PackedKit } from './kit-tarball.js';

let kit: PackedKit;
let consumer: Consumer;

beforeAll(async () => {
  kit = await packKit();
  consumer = await makeConsumer(kit, 'consumer');
});

afterAll(async () => {
  await kit.cleanup();
});

describe('exports, as a consumer sees them', () => {
  it.each(['@towerism/selfhost-kit', '@towerism/selfhost-kit/nitro', '@towerism/selfhost-kit/testing'])(
    'imports %s under Node',
    async (specifier) => {
      const out = await consumer.node(`const m = await import('${specifier}'); console.log(typeof m);`);
      expect(out.trim()).toBe('object');
    },
  );

  it('imports the nitro entry without h3 installed', async () => {
    const out = await consumer.node(`
      import { createRequire } from 'node:module';
      let h3 = 'installed';
      try { createRequire(import.meta.url).resolve('h3'); } catch { h3 = 'absent'; }
      await import('@towerism/selfhost-kit/nitro');
      console.log(h3);
    `);
    expect(out.trim()).toBe('absent');
  });

  it('exposes package.json as JSON', async () => {
    const out = await consumer.node(
      `const { default: pkg } = await import('@towerism/selfhost-kit/package.json', { with: { type: 'json' } });
       console.log(pkg.name);`,
    );
    expect(out.trim()).toBe('@towerism/selfhost-kit');
  });

  it('refuses a deep import of a file that is not exported', async () => {
    await expect(consumer.node(`await import('@towerism/selfhost-kit/dist/core/index.js');`)).rejects.toThrow(
      /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    );
  });

  it.each(['NodeNext', 'Bundler'] as const)(
    'type-checks all three entry points under %s',
    async (resolution) => {
      await writeFile(
        join(consumer.dir, 'consumer.ts'),
        [
          "import * as core from '@towerism/selfhost-kit';",
          "import * as nitro from '@towerism/selfhost-kit/nitro';",
          "import * as testing from '@towerism/selfhost-kit/testing';",
          'export const entryPoints = [core, nitro, testing];',
        ].join('\n'),
      );
      await expect(consumer.tsc(resolution)).resolves.toBeUndefined();
    },
  );
});
