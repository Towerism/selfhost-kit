import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeConsumer, packKit, type Consumer, type PackedKit } from './kit-tarball.js';

let kit: PackedKit;
let consumer: Consumer;
let tester: Consumer;

beforeAll(async () => {
  kit = await packKit();
  consumer = await makeConsumer(kit, 'consumer');
  tester = await makeConsumer(kit, 'tester', ['vitest', 'h3', '@types/node']);
});

afterAll(async () => {
  await kit.cleanup();
});

describe('exports, as a consumer sees them', () => {
  it('imports the root entry point under Node', async () => {
    const out = await consumer.node(
      `const m = await import('@towerism/selfhost-kit'); console.log(typeof m);`,
    );
    expect(out.trim()).toBe('object');
  });

  it('uses the core with only its declared dependencies, and no h3 or vitest', async () => {
    const out = await consumer.node(`
      import { createRequire } from 'node:module';
      import { createLogger, createVault, prepareRuntimeEnv, stringVault } from '@towerism/selfhost-kit';
      const require = createRequire(import.meta.url);
      const absent = ['h3', 'vitest'].filter((p) => { try { require.resolve(p); return false; } catch { return true; } });
      const vault = stringVault(createVault({ key: Buffer.alloc(32, 7).toString('base64'), label: 'consumer' }));
      const lines = [];
      createLogger({ scope: 'consumer', format: 'json', destination: { write: (l) => lines.push(l) } })
        .info('hello', { token: 'secret-value' });
      const { env } = prepareRuntimeEnv({ NUXT_PUBLIC_SITE_URL: 'https://example.com' }, { secrets: [] });
      console.log(JSON.stringify({
        absent,
        roundTrip: vault.decrypt(vault.encrypt('ok', 'row:1'), 'row:1'),
        logged: JSON.parse(lines[0]).token,
        secure: env.NUXT_SESSION_COOKIE_SECURE,
      }));
    `);
    expect(JSON.parse(out)).toEqual({
      absent: ['h3', 'vitest'],
      roundTrip: 'ok',
      logged: '[REDACTED]',
      secure: 'true',
    });
  });

  it('refuses /testing without its vitest and h3 peers', async () => {
    await expect(consumer.node(`await import('@towerism/selfhost-kit/testing');`)).rejects.toThrow(/vitest/);
  });

  it('imports /testing once vitest is installed', async () => {
    const out = await tester.node(
      `const t = await import('@towerism/selfhost-kit/testing'); console.log(Object.keys(t).sort().join(','));`,
    );
    expect(out.trim()).toBe(
      'VAULT_V1_VECTORS,describeBodySize,describeJsonOnly,describeRedactionContract,describeSecurityHeaders,' +
        'describeVaultContract,existingInstallSecrets,fakeClock,h3TestApp,tempSecretsDir',
    );
  });

  it('refuses /nitro without its h3 peer', async () => {
    await expect(consumer.node(`await import('@towerism/selfhost-kit/nitro');`)).rejects.toThrow(/'h3'/);
  });

  it('imports /nitro once h3 is installed', async () => {
    const out = await tester.node(
      `const n = await import('@towerism/selfhost-kit/nitro'); console.log(Object.keys(n).sort().join(','));`,
    );
    expect(out.trim()).toBe(
      'bodySizeLimit,enforceRateLimit,jsonErrorHandler,jsonOnly,requestLogPlugin,securityHeadersPlugin',
    );
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
        join(tester.dir, 'consumer.ts'),
        [
          "import * as core from '@towerism/selfhost-kit';",
          "import * as nitro from '@towerism/selfhost-kit/nitro';",
          "import * as testing from '@towerism/selfhost-kit/testing';",
          'export const entryPoints = [core, nitro, testing];',
        ].join('\n'),
      );
      await expect(tester.tsc(resolution)).resolves.toBeUndefined();
    },
  );
});
