// Checks the two Gitea npm registry tokens against the real server (ADR-0009, NFR-4). The owner runs it
// with both tokens in the environment, before the first release and after each rotation:
//
//   GITEA_PACKAGE_TOKEN=... NPM_READ_TOKEN=... pnpm check:registry-tokens
//
// Each token gets one PUT with an empty body to the package's route, so nothing can be created. Gitea
// checks the token's scope before it reads the body: a token with write:package gets 400 (no package in
// the body), and a token that can only read gets 401 or 403. The release job runs the same request for the
// publish token before semantic-release pushes a tag.
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://vcs.martinfrackerjr.com';
export const PROBE_PATH = '/api/packages/towerism/npm/@towerism%2fselfhost-kit';

const CHECKS = [
  { label: 'publish token', variable: 'GITEA_PACKAGE_TOKEN', accept: [400], expected: '400' },
  { label: 'read token', variable: 'NPM_READ_TOKEN', accept: [401, 403], expected: '401 or 403' },
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
 * Runs both checks, prints one line for each, and returns the exit code: 0 when every token behaves as
 * expected, 1 otherwise. A token is never printed.
 * @param {{
 *   env: Record<string, string | undefined>,
 *   origin?: string,
 *   stdout: { write(text: string): unknown },
 *   stderr: { write(text: string): unknown },
 * }} io
 * @returns {Promise<number>}
 */
export async function main({ env, origin = ORIGIN, stdout, stderr }) {
  let failed = false;
  for (const { label, variable, accept, expected } of CHECKS) {
    const token = env[variable];
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
      stdout.write(`${label}: ${code}, expected ${expected}: ok\n`);
    } else {
      stderr.write(`${label}: ${code}, expected ${expected}: FAILED\n`);
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
