import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeConsumer, packKit, type Consumer, type PackedKit } from './kit-tarball.js';

let kit: PackedKit;
let consumer: Consumer;
let tester: Consumer;
let releaser: Consumer;

beforeAll(async () => {
  kit = await packKit();
  consumer = await makeConsumer(kit, 'consumer');
  tester = await makeConsumer(kit, 'tester', ['vitest', 'h3', '@types/node']);
  releaser = await makeConsumer(kit, 'releaser', [
    'conventional-changelog-conventionalcommits',
    '@types/node',
  ]);
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
      import { createLogger, createRedactor, createVault, prepareRuntimeEnv, stringVault } from '@towerism/selfhost-kit';
      const require = createRequire(import.meta.url);
      const absent = ['h3', 'vitest'].filter((p) => { try { require.resolve(p); return false; } catch { return true; } });
      const vault = stringVault(createVault({ key: Buffer.alloc(32, 7).toString('base64'), label: 'consumer' }));
      const lines = [];
      createLogger({ redactor: createRedactor(), scope: 'consumer', format: 'json', destination: { write: (l) => lines.push(l) } })
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

  it('copies the Docker assets out of the package with its bin, as real files', async () => {
    const out = await consumer.node(`
      import { execFileSync } from 'node:child_process';
      import { lstatSync, readdirSync } from 'node:fs';
      const bin = 'node_modules/@towerism/selfhost-kit/bin/selfhost-kit.mjs';
      const printed = execFileSync(process.execPath, [bin, 'docker-assets', '.output/selfhost-kit'], { encoding: 'utf8' });
      const files = readdirSync('.output/selfhost-kit').sort().map((name) => {
        const info = lstatSync('.output/selfhost-kit/' + name);
        return [name, info.isFile(), (info.mode & 0o777).toString(8)];
      });
      console.log(JSON.stringify({ printed, files }));
    `);
    expect(JSON.parse(out)).toEqual({
      printed: 'copied entrypoint.sh\ncopied fetch-litestream.sh\ncopied litestream.yml\n',
      files: [
        ['entrypoint.sh', true, '755'],
        ['fetch-litestream.sh', true, '755'],
        ['litestream.yml', true, '644'],
      ],
    });
  });

  it('resolves the raw Docker assets through ./docker/*', async () => {
    const out = await consumer.node(
      `console.log(import.meta.resolve('@towerism/selfhost-kit/docker/entrypoint.sh'));`,
    );
    expect(out.trim()).toMatch(/\/node_modules\/@towerism\/selfhost-kit\/docker\/entrypoint\.sh$/);
  });

  it('refuses ./release-config without its conventional-changelog peer', async () => {
    await expect(consumer.node(`await import('@towerism/selfhost-kit/release-config');`)).rejects.toThrow(
      /conventional-changelog-conventionalcommits/,
    );
  });

  it('imports ./release-config once its peers are installed', async () => {
    const out = await releaser.node(`
      const { default: config } = await import('@towerism/selfhost-kit/release-config');
      console.log(JSON.stringify(config.plugins.map((p) => (Array.isArray(p) ? p[0] : p))));
    `);
    expect(JSON.parse(out)).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/exec',
      '@semantic-release/github',
    ]);
  });

  it.each(['NodeNext', 'Bundler'] as const)('type-checks ./release-config under %s', async (resolution) => {
    await writeFile(
      join(releaser.dir, 'consumer.ts'),
      [
        "import config from '@towerism/selfhost-kit/release-config';",
        'export const branches: string[] = config.branches;',
      ].join('\n'),
    );
    await expect(releaser.tsc(resolution)).resolves.toBeUndefined();
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
