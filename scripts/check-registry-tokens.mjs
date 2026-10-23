// Checks the Gitea npm registry's token scopes against the real server (ADR-0009, NFR-4). The owner runs
// it before the first release and after each rotation, with a Gitea admin account in the environment:
//
//   GITEA_ADMIN_USER=... GITEA_ADMIN_PASSWORD=... pnpm check:registry-tokens
//
// The script mints a short-lived token for each user (write:package for ci-publisher, read:package for
// pull) as that admin with a Sudo header, probes with it, and deletes it. Gitea stores only hashes, so
// the stored tokens can't be fetched; this proves the scopes and the route, not the secret values. To
// test the stored values instead, leave GITEA_ADMIN_PASSWORD unset and set GITEA_PACKAGE_TOKEN and
// NPM_READ_TOKEN.
//
// Each token gets one PUT with an empty body to the package's route, so nothing can be created. Gitea
// checks the token's scope before it reads the body: a token with write:package gets 400 (no package in
// the body), and a token that can only read gets 401 or 403. The release job runs the same request for the
// publish token before semantic-release pushes a tag.
import { randomUUID } from 'node:crypto';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://vcs.martinfrackerjr.com';
export const PROBE_PATH = '/api/packages/towerism/npm/@towerism%2fselfhost-kit';

const CHECKS = [
  {
    label: 'publish token',
    variable: 'GITEA_PACKAGE_TOKEN',
    user: 'ci-publisher',
    scope: 'write:package',
    accept: [400],
    expected: '400',
  },
  {
    label: 'read token',
    variable: 'NPM_READ_TOKEN',
    user: 'pull',
    scope: 'read:package',
    accept: [401, 403],
    expected: '401 or 403',
  },
];

/**
 * Sends the probe with one token and returns the status, or `undefined` when the request fails.
 * A redirect is not followed: it would resend the token to whatever host the answer names.
 * @param {string} origin
 * @param {string} token
 * @returns {Promise<number | undefined>}
 */
async function status(origin, token) {
  try {
    const response = await fetch(`${origin}${PROBE_PATH}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: '',
      redirect: 'manual',
    });
    return response.status;
  } catch {
    return undefined;
  }
}

/**
 * Calls Gitea's API as the admin, acting as `user`. Gitea accepts basic authentication only on its
 * token routes. Throws when Gitea can't be reached.
 * @param {string} origin
 * @param {string} admin
 * @param {string} password
 * @param {string} user
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
function api(origin, admin, password, user, method, path, body) {
  return fetch(`${origin}/api/v1/users/${user}/tokens${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${admin}:${password}`).toString('base64')}`,
      sudo: user,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
}

/**
 * Runs both checks, prints one line for each, and returns the exit code: 0 when every token behaves as
 * expected, 1 otherwise. Neither a token nor the admin password is printed.
 * @param {{
 *   env: Record<string, string | undefined>,
 *   origin?: string,
 *   stdout: { write(text: string): unknown },
 *   stderr: { write(text: string): unknown },
 * }} io
 * @returns {Promise<number>}
 */
export async function main({ env, origin = ORIGIN, stdout, stderr }) {
  const password = env.GITEA_ADMIN_PASSWORD;
  const admin = env.GITEA_ADMIN_USER;
  if (password && !admin) {
    stderr.write('GITEA_ADMIN_USER is not set: FAILED\n');
    return 1;
  }
  let failed = false;
  for (const { label, variable, user, scope, accept, expected } of CHECKS) {
    let token = env[variable];
    let minted;
    if (password && admin) {
      const name = `registry-check-${randomUUID().slice(0, 8)}`;
      const response = await api(origin, admin, password, user, 'POST', '', { name, scopes: [scope] }).catch(
        () => undefined,
      );
      if (!response) {
        stderr.write(`${label}: could not reach Gitea at ${origin}: FAILED\n`);
        failed = true;
        continue;
      }
      if (response.status !== 201) {
        stderr.write(`${label}: Gitea answered ${String(response.status)} to the token request: FAILED\n`);
        failed = true;
        continue;
      }
      const made = /** @type {{ id: number, sha1: string }} */ (await response.json());
      token = made.sha1;
      minted = { name, id: made.id };
    }
    if (!token) {
      stderr.write(`${label}: ${variable} is not set: FAILED\n`);
      failed = true;
      continue;
    }
    const code = await status(origin, token);
    if (code === undefined) {
      stderr.write(`${label}: could not reach the registry at ${origin}: FAILED\n`);
      failed = true;
    } else if (accept.includes(code)) {
      stdout.write(`${label}: ${String(code)}, expected ${expected}: ok\n`);
    } else {
      stderr.write(`${label}: ${String(code)}, expected ${expected}: FAILED\n`);
      failed = true;
    }
    if (minted && password && admin) {
      const gone = await api(origin, admin, password, user, 'DELETE', `/${String(minted.id)}`).catch(
        () => undefined,
      );
      if (gone?.status !== 204) {
        stderr.write(
          `${label}: could not delete test token ${minted.name} of ${user}; delete it in Gitea under Settings > Applications: FAILED\n`,
        );
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}

// Covered by the test that runs this file as a script; coverage only sees in-process code.
/* v8 ignore next 3 */
if (argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main({ env: process.env, stdout: process.stdout, stderr: process.stderr });
}
