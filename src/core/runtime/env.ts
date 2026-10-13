import { dirname, join } from 'node:path';
import { type Env, type SecretSpec, resolveSecret } from '../secrets/index.js';
import { InvalidTrustedProxiesError, parseTrustedProxies } from '../security/client-address.js';
import { isHttpsSite } from '../security/headers.js';

/** The app's configuration can't work. The message is for the operator reading the container log. */
export class InvalidConfigError extends Error {
  override name = 'InvalidConfigError';
}

/** The env for the server, and the startup lines to log (where each secret came from, never its value). */
export interface PreparedEnv {
  env: Env;
  log: string[];
}

/** Same default as an app's `runtimeConfig.databasePath`; the image sets `/data/app.db`. */
const DEFAULT_DATABASE_PATH = join('.data', 'app.db');

/** `dirname(NUXT_DATABASE_PATH)/secrets`, so everything persistent sits under one volume (ADR-0006). */
export function secretsDirFor(env: Env): string {
  return join(dirname(env.NUXT_DATABASE_PATH || DEFAULT_DATABASE_PATH), 'secrets');
}

/**
 * Works out the env for the Nitro server before it loads (Nitro reads runtime config from env once, at
 * import). Returns a new env; `input` is never changed. In order:
 *
 * 1. resolves each secret (env, else its file in the secrets dir, else generated) into `env[spec.env]`;
 * 2. sets `NUXT_SESSION_COOKIE_SECURE` from `NUXT_PUBLIC_SITE_URL` when it is empty or unset;
 * 3. removes blank `positiveIntegerVars` and refuses any that aren't a whole number ≥ 1;
 * 4. validates `NUXT_TRUSTED_PROXIES`;
 * 5. runs the app's own `validate(env)`.
 *
 * @throws InvalidSecretError for a malformed secret, InvalidConfigError for everything else (including
 * two specs sharing an env var or file name, checked before anything is read or written).
 */
export function prepareRuntimeEnv(
  input: Env,
  opts: {
    secrets: readonly SecretSpec[];
    positiveIntegerVars?: readonly string[];
    validate?: (env: Env) => void;
  },
): PreparedEnv {
  refuseDuplicates(opts.secrets);
  const env: Env = { ...input };
  const log: string[] = [];
  const dir = secretsDirFor(env);

  for (const spec of opts.secrets) {
    const { value, source } = resolveSecret(spec, { env, dir });
    env[spec.env] = value;
    const where = join(dir, spec.file);
    if (source === 'env') log.push(`${spec.label}: from ${spec.env}`);
    else log.push(`${spec.label}: ${source === 'generated' ? 'generated into' : 'loaded from'} ${where}`);
  }

  if (!env.NUXT_SESSION_COOKIE_SECURE) {
    env.NUXT_SESSION_COOKIE_SECURE = String(isHttpsSite(env.NUXT_PUBLIC_SITE_URL));
  }

  for (const name of opts.positiveIntegerVars ?? []) {
    const value = env[name]?.trim();
    if (!value) Reflect.deleteProperty(env, name);
    else if (!/^[1-9]\d*$/.test(value)) {
      throw new InvalidConfigError(`${name} must be a whole number of at least 1 (got "${value}").`);
    }
  }

  try {
    parseTrustedProxies(env.NUXT_TRUSTED_PROXIES ?? '');
  } catch (err) {
    throw new InvalidConfigError((err as InvalidTrustedProxiesError).message, { cause: err });
  }

  opts.validate?.(env);
  return { env, log };
}

function refuseDuplicates(specs: readonly SecretSpec[]) {
  for (const key of ['env', 'file'] as const) {
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec[key])) {
        throw new InvalidConfigError(
          `Two secrets share the ${key === 'env' ? 'env var' : 'file'} ${spec[key]}.`,
        );
      }
      seen.add(spec[key]);
    }
  }
}
