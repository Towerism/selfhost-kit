// Run by release.yml right before semantic-release, which pushes the release tag before it publishes.
// An npm older than 11.5.1 can't do the trusted-publishing OIDC exchange, so `npm publish` would fail
// with ENEEDAUTH and leave a tag with nothing on npm. Failing here stops the release before the tag.
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

export const MINIMUM_NPM_VERSION = '11.5.1';

/**
 * True only for a plain `MAJOR.MINOR.PATCH` at or above 11.5.1. A prerelease sorts below its release,
 * so it is rejected along with anything that doesn't parse.
 * @param {string} version
 */
export function supportsTrustedPublishing(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const found = match.slice(1).map(Number);
  const minimum = MINIMUM_NPM_VERSION.split('.').map(Number);
  for (const [i, part] of found.entries()) {
    if (part !== minimum[i]) return part > /** @type {number} */ (minimum[i]);
  }
  return true;
}

/**
 * Reads `npm --version` from the given environment's PATH and says whether it can publish with OIDC.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean; message: string }}
 */
export function checkNpm(env) {
  let version;
  try {
    version = execFileSync('npm', ['--version'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return { ok: false, message: `couldn't read the npm version: ${/** @type {Error} */ (error).message}` };
  }
  return supportsTrustedPublishing(version)
    ? { ok: true, message: `npm ${version} supports trusted publishing` }
    : {
        ok: false,
        message: `npm ${version} can't publish with OIDC: trusted publishing needs npm >= ${MINIMUM_NPM_VERSION}`,
      };
}

// Covered by the tests that run this file as a script; coverage only sees in-process code.
/* v8 ignore next 5 */
if (argv[1] === fileURLToPath(import.meta.url)) {
  const { ok, message } = checkNpm(process.env);
  (ok ? process.stdout : process.stderr).write(`${message}\n`);
  process.exitCode = ok ? 0 : 1;
}
