import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PROBE_PATH, main } from '../scripts/check-registry-tokens.mjs';

// The owner runs this check with the real tokens, so the tests run the real fetch against a local HTTP
// server that answers like Gitea's npm route: 400 to an invalid package from a write-scoped token, 401 or 403
// to a token that cannot write. No network, no clock, no mocked fetch.
const PUBLISH = 'publish-token-value';
const READ = 'read-token-value';

type Seen = {
  method: string | undefined;
  url: string | undefined;
  auth: string | undefined;
  type: string | undefined;
  body: string;
};

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  servers = [];
});

/** A registry that answers each token with the status in `answers`, and 401 to any other token. */
async function registry(answers: Record<string, number>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const auth = req.headers.authorization;
      seen.push({ method: req.method, url: req.url, auth, type: req.headers['content-type'], body });
      res.statusCode = answers[auth?.replace('Bearer ', '') ?? ''] ?? 401;
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

async function check(env: Record<string, string>, answers: Record<string, number>) {
  const { origin, seen } = await registry(answers);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({
    env,
    origin,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
  });
  return { code, out: out.join(''), err: err.join(''), seen };
}

const both = { GITEA_PACKAGE_TOKEN: PUBLISH, NPM_READ_TOKEN: READ };

describe('check-registry-tokens', () => {
  it('passes when the publish token gets 400 and the read token gets 403', async () => {
    const run = await check(both, { [PUBLISH]: 400, [READ]: 403 });
    expect(run.code).toBe(0);
    expect(run.out).toContain('publish token: 400, expected 400: ok');
    expect(run.out).toContain('read token: 403, expected 401 or 403: ok');
  });

  it('accepts 401 for the read token too', async () => {
    const run = await check(both, { [PUBLISH]: 400, [READ]: 401 });
    expect(run.code).toBe(0);
  });

  // Gitea's npm upload handler parses the body as JSON before it checks anything else. An empty body
  // fails the parse with a 500 (seen on the live server, 2026-10-23); `{}` parses and is then refused as
  // an invalid package with a 400, so nothing is created.
  it('sends an empty JSON object by PUT to the package route with a bearer token, so nothing can be created', async () => {
    const run = await check(both, { [PUBLISH]: 400, [READ]: 403 });
    expect(run.seen.map((s) => [s.method, s.url, s.type, s.body])).toEqual([
      ['PUT', PROBE_PATH, 'application/json', '{}'],
      ['PUT', PROBE_PATH, 'application/json', '{}'],
    ]);
    expect(run.seen.map((s) => s.auth)).toEqual([`Bearer ${PUBLISH}`, `Bearer ${READ}`]);
  });

  it.each([
    ['401, a token the registry does not know', 401],
    ['403, a token without write:package', 403],
    ['201, a write that went through', 201],
  ])('fails when the publish token gets %s', async (_, status) => {
    const run = await check(both, { [PUBLISH]: status, [READ]: 403 });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`publish token: ${String(status)}, expected 400: FAILED`);
  });

  it.each([
    ['400, a read token that can write', 400],
    ['404, a route the token should not see', 404],
  ])('fails when the read token gets %s', async (_, status) => {
    const run = await check(both, { [PUBLISH]: 400, [READ]: status });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`read token: ${String(status)}, expected 401 or 403: FAILED`);
  });

  it('still reports the read token when the publish token fails', async () => {
    const run = await check(both, { [PUBLISH]: 401, [READ]: 403 });
    expect(run.err).toContain('publish token');
    expect(run.out).toContain('read token: 403');
  });

  it.each([['GITEA_PACKAGE_TOKEN'], ['NPM_READ_TOKEN']])(
    'fails and names %s when it is not set',
    async (name) => {
      const env = { ...both, [name]: '' };
      const run = await check(env, { [PUBLISH]: 400, [READ]: 403 });
      expect(run.code).toBe(1);
      expect(run.err).toContain(`${name} is not set`);
      expect(run.seen).toHaveLength(1);
    },
  );

  it('fails when the registry cannot be reached', async () => {
    const { origin } = await registry({});
    const dead = origin.replace(/:\d+$/, ':1');
    const err: string[] = [];
    const code = await main({
      env: both,
      origin: dead,
      stdout: { write: () => true },
      stderr: { write: (s: string) => err.push(s) },
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('could not reach the registry');
  });

  it('does not follow a redirect, which would resend the token elsewhere', async () => {
    const target = await registry({ [PUBLISH]: 400 });
    const bounce = createServer((_, res) => {
      res.statusCode = 307;
      res.setHeader('location', `${target.origin}${PROBE_PATH}`);
      res.end();
    });
    servers.push(bounce);
    await new Promise<void>((ready) => bounce.listen(0, '127.0.0.1', ready));
    const origin = `http://127.0.0.1:${String((bounce.address() as AddressInfo).port)}`;
    const code = await main({
      env: both,
      origin,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    expect(code).toBe(1);
    expect(target.seen).toHaveLength(0);
  });

  it('never prints a token', async () => {
    const run = await check(both, { [PUBLISH]: 401, [READ]: 400 });
    expect(run.out + run.err).not.toContain(PUBLISH);
    expect(run.out + run.err).not.toContain(READ);
  });

  it('runs as a script and exits 1 when the tokens are not set', async () => {
    const script = fileURLToPath(new URL('../scripts/check-registry-tokens.mjs', import.meta.url));
    const run = await promisify(execFile)(process.execPath, [script], { env: {} }).then(
      () => ({ code: 0, stderr: '' }),
      (e: unknown) => e as { code: number; stderr: string },
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('GITEA_PACKAGE_TOKEN is not set');
    expect(run.stderr).toContain('NPM_READ_TOKEN is not set');
  });
});

// With GITEA_SSH set, the script creates one short-lived token for each user on the Gitea VM with
// `gitea admin user generate-access-token` (which ignores two-factor authentication), probes with it, and
// deletes its row. The fake VM below answers those two commands and keeps the tokens that are still live.
describe('check-registry-tokens creating its own tokens over SSH', () => {
  const SSH = { GITEA_SSH: 'ssh -p 2222 root@vm' };

  /** A VM that answers the create and delete commands, and records every command it was sent. */
  function vm(opts: { create?: (command: string) => string; remove?: (command: string) => string } = {}) {
    const commands: string[] = [];
    const live = new Map<string, string>();
    let next = 1;
    const answer = (command: string): Promise<string> => {
      commands.push(command);
      if (command.includes('generate-access-token')) {
        const out = opts.create?.(command);
        if (out !== undefined) return Promise.resolve(out);
        const user = /--username (\S+)/.exec(command)![1]!;
        const name = /--token-name (\S+)/.exec(command)![1]!;
        const value = `minted-${user}-${String(next++)}`;
        live.set(name, value);
        return Promise.resolve(`${value}\n`);
      }
      const name = /name='([^']+)'/.exec(command)![1]!;
      const out = opts.remove?.(command);
      if (out !== undefined) return Promise.resolve(out);
      live.delete(name);
      return Promise.resolve('0\n');
    };
    const remote = (command: string): Promise<string> => {
      try {
        return answer(command);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    return { remote, commands, live };
  }

  async function run(
    env: Record<string, string>,
    opts: { virtual?: ReturnType<typeof vm>; answers?: Record<string, number> } = {},
  ) {
    const virtual = opts.virtual ?? vm();
    const { origin, seen } = await registry({
      'minted-ci-publisher-1': 400,
      'minted-pull-2': 403,
      ...opts.answers,
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
      env,
      origin,
      remote: virtual.remote,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    });
    return { code, out: out.join(''), err: err.join(''), seen, ...virtual };
  }

  it('creates a write:package token for ci-publisher and a read:package token for pull, probes, and deletes both', async () => {
    const r = await run(SSH);
    expect(r.code).toBe(0);
    expect(r.out).toContain('publish token: 400, expected 400: ok');
    expect(r.out).toContain('read token: 403, expected 401 or 403: ok');
    const creates = r.commands.filter((c) => c.includes('generate-access-token'));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatch(/--username ci-publisher .*--scopes write:package --raw$/);
    expect(creates[1]).toMatch(/--username pull .*--scopes read:package --raw$/);
    expect(creates[0]).toMatch(
      /^runuser -u gitea -- \/usr\/local\/bin\/gitea admin .*--config \/etc\/gitea\/app.ini /,
    );
    expect(r.commands.filter((c) => c.includes('DELETE FROM access_token'))).toHaveLength(2);
    expect(r.live.size).toBe(0);
  });

  it('deletes each token by the name this run created, in the Gitea database, as the gitea user', async () => {
    const r = await run(SSH);
    const names = r.commands
      .filter((c) => c.includes('generate-access-token'))
      .map((c) => /--token-name (registry-check-[0-9a-f]{8})/.exec(c)![1]);
    const deletes = r.commands.filter((c) => c.includes('DELETE FROM access_token'));
    expect(deletes[0]).toMatch(
      /^runuser -u gitea -- sqlite3 -cmd '\.timeout 10000' \/var\/lib\/gitea\/data\/gitea\.db /,
    );
    expect(deletes[0]).toContain(`DELETE FROM access_token WHERE name='${names[0]!}'`);
    expect(deletes[1]).toContain(`DELETE FROM access_token WHERE name='${names[1]!}'`);
    expect(names[0]).not.toBe(names[1]);
  });

  it('probes with the created tokens, not with tokens from the environment', async () => {
    const r = await run({ ...SSH, GITEA_PACKAGE_TOKEN: PUBLISH, NPM_READ_TOKEN: READ });
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer minted-ci-publisher-1', 'Bearer minted-pull-2']);
  });

  it('deletes the created tokens even when a probe fails', async () => {
    const r = await run(SSH, { answers: { 'minted-ci-publisher-1': 403 } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('publish token: 403, expected 400: FAILED');
    expect(r.live.size).toBe(0);
  });

  it.each([
    [
      'the command fails',
      () => {
        throw new Error('ssh: connection refused');
      },
    ],
    ['the command prints nothing', () => '  \n'],
  ])('fails, and does not probe, when %s', async (_, create) => {
    const r = await run(SSH, { virtual: vm({ create }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('publish token: could not create a test token over SSH: FAILED');
    expect(r.err).toContain('read token: could not create a test token over SSH: FAILED');
    expect(r.seen).toHaveLength(0);
  });

  it.each([
    ['the database still holds the row', () => '1\n'],
    [
      'the command fails',
      () => {
        throw new Error('database is locked');
      },
    ],
  ])('names the token left behind when %s', async (_, remove) => {
    const r = await run(SSH, { virtual: vm({ remove }) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /publish token: could not delete test token registry-check-[0-9a-f]{8} of ci-publisher.*FAILED/,
    );
    expect(r.err).toMatch(
      /read token: could not delete test token registry-check-[0-9a-f]{8} of pull.*FAILED/,
    );
  });

  it('never prints a created token', async () => {
    const r = await run(SSH, { answers: { 'minted-ci-publisher-1': 401, 'minted-pull-2': 400 } });
    expect(r.out + r.err).not.toContain('minted-');
  });

  describe('through a real ssh program', () => {
    let dir = '';
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('runs the given program with its arguments and the remote command last', async () => {
      dir = await mkdtemp(join(tmpdir(), 'fake-ssh-'));
      const fake = join(dir, 'fake-ssh');
      await writeFile(
        fake,
        '#!/bin/sh\ncase "$*" in\n  *generate-access-token*) echo "raw-$$-$RANDOM";;\n  *) echo 0;;\nesac\n',
      );
      await chmod(fake, 0o755);
      const { origin } = await registry({});
      const err: string[] = [];
      const code = await main({
        env: { GITEA_SSH: `${fake} -p 2222 root@vm` },
        origin,
        stdout: { write: () => true },
        stderr: { write: (s: string) => err.push(s) },
      });
      // The registry answers 401 to the fake tokens: the publish probe fails, the read probe passes.
      expect(code).toBe(1);
      expect(err.join('')).toContain('publish token: 401, expected 400: FAILED');
      expect(err.join('')).not.toContain('could not create');
      expect(err.join('')).not.toContain('could not delete');
    });
  });
});
