import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCalls, runShell, stubBin, toolbox } from '../helpers/shell.js';

// The entrypoint's non-root path, on the host with stub gosu and litestream (ADR-0008). The root path
// (chown, gosu) and real Litestream are covered by the container tests in test/entrypoint/run.sh.
const ENTRYPOINT = fileURLToPath(new URL('../../docker/entrypoint.sh', import.meta.url));

let dir: string;
let bin: string;
let log: string;
let db: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'selfhost-kit-entrypoint-'));
  bin = await toolbox(join(dir, 'bin'), ['id', 'mkdir', 'find', 'chown', 'sed', 'tr']);
  await stubBin(bin, 'gosu', 'exec-rest');
  await stubBin(bin, 'litestream', 'litestream');
  await stubBin(bin, 'app');
  log = join(dir, 'calls.jsonl');
  db = join(dir, 'data', 'app.db');
  await mkdir(join(dir, 'data'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}, args: string[] = ['app', 'serve', 'two words']) {
  return runShell(ENTRYPOINT, args, {
    PATH: bin,
    STUB_LOG: log,
    NUXT_DATABASE_PATH: db,
    LITESTREAM_CONFIG: '/etc/litestream.yml',
    ...env,
  });
}

const tools = async () => (await readCalls(log)).map((c) => c.tool);
const entrypointLines = (stdout: string, stderr: string) =>
  `${stdout}\n${stderr}`.split('\n').filter((line) => line.startsWith('[entrypoint]'));

describe('entrypoint refusals', () => {
  it.each([
    [{ PUID: 'abc' }, 'PUID=abc PGID=100'],
    [{ PGID: '1x' }, 'PUID=99 PGID=1x'],
    [{ PUID: '-1' }, 'PUID=-1 PGID=100'],
    [{ PUID: '', PGID: '' }, null],
  ])('refuses a non-numeric PUID or PGID before running anything: %o', async (env, got) => {
    const result = await run(env);
    if (got === null) {
      // Empty values fall back to the defaults (99/100), as attendance's ${VAR:-default} does.
      expect(result.code).toBe(0);
      return;
    }
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`[entrypoint] PUID and PGID must be numeric (got ${got})\n`);
    expect(await tools()).toEqual([]);
  });

  it('accepts PUID=0 as a number', async () => {
    expect((await run({ PUID: '0', PGID: '0' })).code).toBe(0);
  });
});

describe('entrypoint without a replica URL', () => {
  it('runs the command directly as the current user, with its arguments intact', async () => {
    const result = await run({}, ['app', 'serve', 'two words', "it's", '']);
    expect(result.code).toBe(0);
    const calls = await readCalls(log);
    expect(calls.map((c) => [c.tool, c.argv])).toEqual([['app', ['serve', 'two words', "it's", '']]]);
    expect(result.stdout + result.stderr).toBe('');
    expect(userInfo().uid).not.toBe(0);
  });

  it.each(['', '   ', ' \t\n '])('treats a blank replica URL %j as no URL', async (url) => {
    await run({ LITESTREAM_REPLICA_URL: url });
    expect(await tools()).toEqual(['app']);
  });

  it.each(['LITESTREAM_ACCESS_KEY_ID', 'LITESTREAM_SECRET_ACCESS_KEY'])(
    'warns that backups are off when %s is set without a URL',
    async (name) => {
      const result = await run({ [name]: 'synthetic-credential' });
      expect(result.stderr).toBe(
        '[entrypoint] litestream: LITESTREAM_ACCESS_KEY_ID/SECRET set but LITESTREAM_REPLICA_URL is empty; backups are off\n',
      );
      expect(result.stderr).not.toContain('synthetic-credential');
      expect(await tools()).toEqual(['app']);
    },
  );

  it('creates nothing under the data directory when not root', async () => {
    await run({ DATA_DIR: join(dir, 'never') });
    expect(existsSync(join(dir, 'never'))).toBe(false);
  });
});

describe('entrypoint with a replica URL', () => {
  it.each([
    [
      ' s3://user:hunter2@bucket.example.com/db?endpoint=http://minio.example.com#frag ',
      's3://bucket.example.com/db',
      's3://user:hunter2@bucket.example.com/db?endpoint=http://minio.example.com#frag',
    ],
    ['file:///replica', 'file:///replica', 'file:///replica'],
    ['abs://acct@container/db?sig=xyz', 'abs://container/db', 'abs://acct@container/db?sig=xyz'],
    ['s3://bucket.example.com/db#frag', 's3://bucket.example.com/db', 's3://bucket.example.com/db#frag'],
    // No scheme: the query is still dropped; userinfo is only recognised after a scheme.
    ['bucket/path?x=1', 'bucket/path', 'bucket/path?x=1'],
  ])('logs %j redacted as %j and exports it without whitespace', async (url, shown, exported) => {
    const result = await run({
      LITESTREAM_REPLICA_URL: url,
      LITESTREAM_ACCESS_KEY_ID: 'synthetic-key-id',
      LITESTREAM_SECRET_ACCESS_KEY: 'synthetic-secret',
    });
    expect(result.code).toBe(0);
    const lines = entrypointLines(result.stdout, result.stderr);
    expect(lines[0]).toBe(`[entrypoint] litestream: replicating ${db} to ${shown}`);
    for (const secret of ['hunter2', 'user:', 'endpoint', 'sig=', 'frag', 'x=1', 'synthetic-']) {
      expect(lines.join('\n')).not.toContain(secret);
    }
    const replicate = (await readCalls(log)).find((c) => c.argv[0] === 'replicate')!;
    expect(replicate.env.LITESTREAM_REPLICA_URL).toBe(exported);
    expect(replicate.env.NUXT_DATABASE_PATH).toBe(db);
  });

  it('restores a missing database once, then replicates', async () => {
    const result = await run({ LITESTREAM_REPLICA_URL: 'file:///replica', STUB_RESTORE: 'create' });
    expect(result.code).toBe(0);
    const calls = await readCalls(log);
    expect(calls.map((c) => c.argv[0])).toEqual(['restore', 'replicate']);
    expect(calls[0]!.argv).toEqual([
      'restore',
      '-config',
      '/etc/litestream.yml',
      '-if-db-not-exists',
      '-if-replica-exists',
      db,
    ]);
    expect(result.stdout).toContain(`[entrypoint] litestream: restored ${db} from replica\n`);
  });

  it('starts empty when the replica has nothing to restore', async () => {
    const result = await run({ LITESTREAM_REPLICA_URL: 'file:///replica', STUB_RESTORE: 'none' });
    expect(result.stdout).toContain(
      '[entrypoint] litestream: no replica found, starting with an empty database\n',
    );
    expect((await readCalls(log)).map((c) => c.argv[0])).toEqual(['restore', 'replicate']);
  });

  it('stops with a non-zero status when the restore fails, and never replicates', async () => {
    const result = await run({ LITESTREAM_REPLICA_URL: 'file:///replica', STUB_RESTORE: 'fail' });
    expect(result.code).not.toBe(0);
    expect((await readCalls(log)).map((c) => c.argv[0])).toEqual(['restore']);
  });

  it('never restores over an existing database', async () => {
    await writeFile(join(dir, 'app.db'), '');
    await run({ LITESTREAM_REPLICA_URL: 'file:///replica', NUXT_DATABASE_PATH: join(dir, 'app.db') });
    expect((await readCalls(log)).map((c) => c.argv[0])).toEqual(['replicate']);
  });

  it('defaults the database path to /data/app.db', async () => {
    const result = await runShell(ENTRYPOINT, ['app'], {
      PATH: bin,
      STUB_LOG: log,
      LITESTREAM_REPLICA_URL: 'file:///replica',
    });
    expect(result.stdout).toContain('[entrypoint] litestream: replicating /data/app.db to file:///replica\n');
    const calls = await readCalls(log);
    expect(calls[0]!.argv).toEqual([
      'restore',
      '-config',
      '/etc/litestream.yml',
      '-if-db-not-exists',
      '-if-replica-exists',
      '/data/app.db',
    ]);
  });

  it('passes every argument through replicate -exec exactly', async () => {
    const args = ['node', 'server.mjs', 'two words', "it's", '$HOME', '*', 'a"b', ''];
    await run(
      { LITESTREAM_REPLICA_URL: 'file:///replica', STUB_RESTORE: 'create', LITESTREAM_CONFIG: '/x y.yml' },
      args,
    );
    const replicate = (await readCalls(log)).find((c) => c.argv[0] === 'replicate')!;
    expect(replicate.argv.slice(0, 4)).toEqual(['replicate', '-config', '/x y.yml', '-exec']);
    expect(replicate.argv).toHaveLength(5);
    expect(replicate.execWords).toEqual(args);
  });
});
