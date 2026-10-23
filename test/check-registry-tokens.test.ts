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

// With GITEA_ADMIN_PASSWORD set, the script mints one short-lived token for each user, probes with it and
// deletes it. This fake Gitea serves the token API and the package route, and records every call.
describe('check-registry-tokens minting its own tokens', () => {
  const ADMIN = { GITEA_ADMIN_USER: 'admin', GITEA_ADMIN_PASSWORD: 'admin-password-value' };
  const basic = `Basic ${Buffer.from('admin:admin-password-value').toString('base64')}`;

  type Call = {
    method: string;
    url: string;
    auth: string | undefined;
    sudo: string | undefined;
    otp: string | undefined;
    body: string;
  };

  async function gitea(opts: { mint?: number; del?: number; publishStatus?: number; message?: string } = {}) {
    const calls: Call[] = [];
    const live = new Map<string, string>();
    let next = 1;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const { method = '', url = '' } = req;
        const sudo = req.headers.sudo as string | undefined;
        calls.push({
          method,
          url,
          auth: req.headers.authorization,
          sudo,
          otp: req.headers['x-gitea-otp'] as string | undefined,
          body,
        });
        const mint = /^\/api\/v1\/users\/([^/]+)\/tokens$/.exec(url);
        const del = /^\/api\/v1\/users\/([^/]+)\/tokens\/(\d+)$/.exec(url);
        if (method === 'POST' && mint) {
          res.statusCode = opts.mint ?? 201;
          if (res.statusCode !== 201)
            return void res.end(opts.message === undefined ? '' : JSON.stringify({ message: opts.message }));
          const id = String(next++);
          const value = `minted-${mint[1]!}-${id}`;
          live.set(id, value);
          res.setHeader('content-type', 'application/json');
          return void res.end(JSON.stringify({ id: Number(id), sha1: value }));
        }
        if (method === 'DELETE' && del) {
          if (opts.del === 0) return void req.socket.destroy();
          res.statusCode = opts.del ?? 204;
          if (res.statusCode === 204) live.delete(del[2]!);
          return void res.end();
        }
        const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
        res.statusCode = token.startsWith('minted-ci-publisher')
          ? (opts.publishStatus ?? 400)
          : token.startsWith('minted-pull')
            ? 403
            : 401;
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return { origin, calls, live };
  }

  async function run(
    env: Record<string, string>,
    opts: Parameters<typeof gitea>[0] = {},
    io: { runOtp?: () => Promise<string>; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    const fake = await gitea(opts);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
      env,
      origin: fake.origin,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      ...io,
    });
    return { ...fake, code, out: out.join(''), err: err.join('') };
  }

  it('mints a write:package token for ci-publisher and a read:package token for pull, probes, and deletes both', async () => {
    const r = await run(ADMIN);
    expect(r.code).toBe(0);
    expect(r.out).toContain('publish token: 400, expected 400: ok');
    expect(r.out).toContain('read token: 403, expected 401 or 403: ok');
    const mints = r.calls.filter((c) => c.method === 'POST');
    expect(mints.map((c) => [c.url, c.auth, c.sudo])).toEqual([
      ['/api/v1/users/ci-publisher/tokens', basic, 'ci-publisher'],
      ['/api/v1/users/pull/tokens', basic, 'pull'],
    ]);
    expect(mints.map((c) => (JSON.parse(c.body) as { scopes: string[] }).scopes)).toEqual([
      ['write:package'],
      ['read:package'],
    ]);
    expect(r.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/api/v1/users/ci-publisher/tokens/1',
      '/api/v1/users/pull/tokens/2',
    ]);
    expect(r.live.size).toBe(0);
  });

  it('probes with the minted tokens, not with tokens from the environment', async () => {
    const r = await run({ ...ADMIN, GITEA_PACKAGE_TOKEN: PUBLISH, NPM_READ_TOKEN: READ });
    const probes = r.calls.filter((c) => c.method === 'PUT').map((c) => c.auth);
    expect(probes).toEqual(['Bearer minted-ci-publisher-1', 'Bearer minted-pull-2']);
  });

  it('deletes the minted tokens even when a probe fails', async () => {
    const r = await run(ADMIN, { publishStatus: 403 });
    expect(r.code).toBe(1);
    expect(r.err).toContain('publish token: 403, expected 400: FAILED');
    expect(r.live.size).toBe(0);
  });

  it('fails, and mints nothing else, when the admin user is not set', async () => {
    const r = await run({ GITEA_ADMIN_PASSWORD: 'admin-password-value' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('GITEA_ADMIN_USER is not set');
    expect(r.calls).toHaveLength(0);
  });

  it('fails when Gitea refuses to mint a token', async () => {
    const r = await run(ADMIN, { mint: 401 });
    expect(r.code).toBe(1);
    expect(r.err).toContain('publish token: Gitea answered 401 to the token request: FAILED');
    expect(r.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it("repeats Gitea's reason when it refuses to mint, so a wrong login can be told from a blocked one", async () => {
    const r = await run(ADMIN, { mint: 401, message: 'user does not exist [uid: 0, name: admin]' });
    expect(r.err).toContain(
      'publish token: Gitea answered 401 to the token request (user does not exist [uid: 0, name: admin]): FAILED',
    );
    expect(r.err).not.toContain('admin-password-value');
  });

  it('fails and names the token when a delete is refused', async () => {
    const r = await run(ADMIN, { del: 500 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/publish token: could not delete test token \S+ of ci-publisher.*FAILED/);
    expect(r.err).toMatch(/read token: could not delete test token \S+ of pull.*FAILED/);
  });

  it('fails and names the token when the connection drops during the delete', async () => {
    const r = await run(ADMIN, { del: 0 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/publish token: could not delete test token \S+ of ci-publisher.*FAILED/);
  });

  it('fails when Gitea cannot be reached for the token request', async () => {
    const err: string[] = [];
    const code = await main({
      env: ADMIN,
      origin: 'http://127.0.0.1:1',
      stdout: { write: () => true },
      stderr: { write: (s: string) => err.push(s) },
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('could not reach Gitea');
  });

  it('never prints the admin password or a minted token', async () => {
    const r = await run(ADMIN, { publishStatus: 401 });
    const all = r.out + r.err;
    expect(all).not.toContain('admin-password-value');
    expect(all).not.toMatch(/minted-/);
  });

  describe('with a two-factor account', () => {
    const OTP = { ...ADMIN, GITEA_ADMIN_OTP_COMMAND: 'print-the-code' };
    const feed = (codes: string[]) => {
      const left = [...codes];
      return { runOtp: () => Promise.resolve(left.shift() ?? ''), left };
    };

    it('sends no code header when no command is set', async () => {
      const r = await run(ADMIN);
      expect(r.calls.filter((c) => c.url.startsWith('/api/v1')).map((c) => c.otp)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('sends a new code with each of the four admin calls, waiting while the code has not changed', async () => {
      const { runOtp } = feed(['111111', '111111', '222222', '333333', '333333', '444444']);
      const waits: number[] = [];
      const r = await run(OTP, {}, { runOtp, sleep: (ms) => Promise.resolve(void waits.push(ms)) });
      expect(r.code).toBe(0);
      expect(r.calls.filter((c) => c.url.startsWith('/api/v1')).map((c) => c.otp)).toEqual([
        '111111',
        '222222',
        '333333',
        '444444',
      ]);
      expect(waits).toHaveLength(2);
    });

    it('names the token left behind when the code never changes, and stops minting', async () => {
      const r = await run(
        OTP,
        {},
        { runOtp: () => Promise.resolve('111111'), sleep: () => Promise.resolve() },
      );
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/publish token: could not delete test token \S+ of ci-publisher/);
      expect(r.err).toContain('read token: GITEA_ADMIN_OTP_COMMAND gave no new code: FAILED');
      expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('fails when the command prints nothing', async () => {
      const r = await run(OTP, {}, { runOtp: () => Promise.resolve('  \n'), sleep: () => Promise.resolve() });
      expect(r.code).toBe(1);
      expect(r.err).toContain('GITEA_ADMIN_OTP_COMMAND gave no new code');
    });

    it('fails when the command itself fails', async () => {
      const r = await run(OTP, {}, { runOtp: () => Promise.reject(new Error('boom')) });
      expect(r.code).toBe(1);
      expect(r.err).toContain('GITEA_ADMIN_OTP_COMMAND gave no new code');
    });

    it('names the token left behind when no code is available for the delete', async () => {
      const { runOtp } = feed(['111111']);
      const r = await run(
        OTP,
        {},
        { runOtp: () => runOtp().then((c) => c || Promise.reject(new Error('x'))) },
      );
      expect(r.err).toMatch(/publish token: could not delete test token \S+ of ci-publisher/);
    });

    it('never prints a code', async () => {
      const { runOtp } = feed(['123456', '234567', '345678', '456789']);
      const r = await run({ ...OTP }, { publishStatus: 401 }, { runOtp });
      expect(r.out + r.err).not.toMatch(/\d{6}/);
    });

    it('runs the command through the shell by default', async () => {
      const r = await run({ ...ADMIN, GITEA_ADMIN_OTP_COMMAND: 'date +%s' });
      expect(r.code).toBe(0);
      const codes = r.calls.filter((c) => c.url.startsWith('/api/v1')).map((c) => c.otp);
      expect(new Set(codes).size).toBe(4);
    }, 15_000);
  });
});
