import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PROBE_PATH, main } from '../scripts/check-registry-tokens.mjs';

// The owner runs this check with the real tokens, so the tests run the real fetch against a local HTTP
// server that answers like Gitea's npm route: 400 to an empty write from a write-scoped token, 401 or 403
// to a token that cannot write. No network, no clock, no mocked fetch.
const PUBLISH = 'publish-token-value';
const READ = 'read-token-value';

type Seen = {
  method: string | undefined;
  url: string | undefined;
  auth: string | undefined;
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
      seen.push({ method: req.method, url: req.url, auth, body });
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

  it('sends an empty PUT to the package route with a bearer token, so nothing can be created', async () => {
    const run = await check(both, { [PUBLISH]: 400, [READ]: 403 });
    expect(run.seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['PUT', PROBE_PATH, ''],
      ['PUT', PROBE_PATH, ''],
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
