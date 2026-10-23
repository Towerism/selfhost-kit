// Checks the Gitea npm registry's token scopes against the real server (ADR-0009, NFR-4). The owner runs
// it before the first release and after each rotation:
//
//   GITEA_SSH='ssh -p 2222 root@192.168.0.39' pnpm check:registry-tokens
//
// Gitea keeps only hashes and GitHub secrets can't be read back, so the script can't fetch the stored
// tokens. Instead it creates a short-lived token for each user on the Gitea VM (write:package for
// ci-publisher, read:package for pull) with `gitea admin user generate-access-token`, probes with it, and
// deletes its row from the database. That command ignores two-factor authentication, which Gitea's token
// API does not. This proves the scopes and the route, not the secret values. To test the stored values
// instead, leave GITEA_SSH unset and set GITEA_PACKAGE_TOKEN and NPM_READ_TOKEN.
//
// Each token gets one PUT with an empty body to the package's route, so nothing can be created. Gitea
// checks the token's scope before it reads the body: a token with write:package gets 400 (no package in
// the body), and a token that can only read gets 401 or 403. The release job runs the same request for the
// publish token before semantic-release pushes a tag.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ORIGIN = 'https://vcs.martinfrackerjr.com';
export const PROBE_PATH = '/api/packages/towerism/npm/@towerism%2fselfhost-kit';

const AS_GITEA = 'runuser -u gitea --';
const GITEA = `${AS_GITEA} /usr/local/bin/gitea admin user generate-access-token --config /etc/gitea/app.ini`;
const SQLITE = `${AS_GITEA} sqlite3 -cmd '.timeout 10000' /var/lib/gitea/data/gitea.db`;

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
 * Returns a function that runs a command on the Gitea VM and gives back what it printed. `ssh` is the
 * program and its leading arguments, such as `ssh -p 2222 root@192.168.0.39`; the command goes last.
 * @param {string} ssh
 * @returns {(command: string) => Promise<string>}
 */
function overSsh(ssh) {
  const [program = '', ...args] = ssh.trim().split(/\s+/);
  return async (command) => (await promisify(execFile)(program, [...args, command])).stdout;
}

/**
 * Creates a token for `user` on the VM. Returns its value, or `undefined` when the command fails or
 * prints nothing.
 * @param {(command: string) => Promise<string>} remote
 * @param {string} user
 * @param {string} name
 * @param {string} scope
 */
async function create(remote, user, name, scope) {
  const out = await remote(`${GITEA} --username ${user} --token-name ${name} --scopes ${scope} --raw`).catch(
    () => '',
  );
  return out.trim() || undefined;
}

/**
 * Deletes the token row called `name`, and reports whether the database no longer holds it.
 * @param {(command: string) => Promise<string>} remote
 * @param {string} name
 */
async function remove(remote, name) {
  const where = `FROM access_token WHERE name='${name}'`;
  const out = await remote(`${SQLITE} "DELETE ${where}; SELECT count(*) ${where};"`).catch(() => '');
  return out.trim() === '0';
}

/**
 * Runs both checks, prints one line for each, and returns the exit code: 0 when every token behaves as
 * expected, 1 otherwise. A token is never printed. `remote` runs a command on the Gitea VM; by default it
 * goes through the program in GITEA_SSH.
 * @param {{
 *   env: Record<string, string | undefined>,
 *   origin?: string,
 *   stdout: { write(text: string): unknown },
 *   stderr: { write(text: string): unknown },
 *   remote?: (command: string) => Promise<string>,
 * }} io
 * @returns {Promise<number>}
 */
export async function main({ env, origin = ORIGIN, stdout, stderr, remote }) {
  const run = remote ?? (env.GITEA_SSH ? overSsh(env.GITEA_SSH) : undefined);
  let failed = false;
  for (const { label, variable, user, scope, accept, expected } of CHECKS) {
    const name = `registry-check-${randomUUID().slice(0, 8)}`;
    let token = env[variable];
    if (run) {
      token = await create(run, user, name, scope);
      if (!token) {
        stderr.write(`${label}: could not create a test token over SSH: FAILED\n`);
        failed = true;
        continue;
      }
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
    if (run && !(await remove(run, name))) {
      stderr.write(
        `${label}: could not delete test token ${name} of ${user}; delete it in Gitea under Settings > Applications: FAILED\n`,
      );
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// Covered by the test that runs this file as a script; coverage only sees in-process code.
/* v8 ignore next 3 */
if (argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main({ env: process.env, stdout: process.stdout, stderr: process.stderr });
}
