import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAes256Key } from '../vault/index.js';

/**
 * Secrets come from env, else from a file generated once in the secrets dir (ADR-0006). Env always wins.
 * A malformed value fails startup loudly and is never silently regenerated: regenerating would log
 * everyone out or orphan everything a vault key sealed.
 */
export interface SecretSpec {
  /** Env var that overrides the file. */
  env: string;
  /** File name inside the secrets dir. Part of the app's install contract: never rename it. */
  file: string;
  /** Names the secret in the startup log line. */
  label: string;
  generate(): string;
  /** Returns why the value is unusable, or `null` when it is fine. Never echoes the value. */
  problem(value: string): string | null;
}

export type SecretSource = 'env' | 'file' | 'generated';

/** A secret from env or file is malformed. The message names where it came from, never the value. */
export class InvalidSecretError extends Error {
  override name = 'InvalidSecretError';
}

/** The variables a process sees, as `process.env` holds them. */
export type Env = Record<string, string | undefined>;

/** `NUXT_SESSION_PASSWORD` / `session-password`: 32 random bytes as base64url (nuxt-auth-utils needs ≥ 32 characters). */
export function sessionPassword(): SecretSpec {
  return {
    env: 'NUXT_SESSION_PASSWORD',
    file: 'session-password',
    label: 'Session password',
    generate: () => randomBytes(32).toString('base64url'),
    problem: (v) => (v.length >= 32 ? null : 'must be at least 32 characters'),
  };
}

/** An AES-256-GCM key for `createVault`, under the env var and file name the app has always used. */
export function aes256Key(opts: { env: string; file: string; label: string }): SecretSpec {
  return {
    env: opts.env,
    file: opts.file,
    label: opts.label,
    generate: () => randomBytes(32).toString('base64'),
    problem: (v) => (isAes256Key(v) ? null : 'must be 32 bytes, base64-encoded'),
  };
}

/**
 * Env (when non-empty), else `dir/file` (trimmed), else a newly generated value written to `dir/file`
 * (`value + "\n"`, mode `0600`, exclusive create, `dir` created at `0700`). Existing files and directories
 * are never deleted, renamed, rewritten or re-moded.
 *
 * @throws InvalidSecretError for a malformed value from env or file. Other read errors (`EACCES`, …)
 * propagate unchanged.
 */
export function resolveSecret(
  spec: SecretSpec,
  opts: { env: Env; dir: string },
): { value: string; source: SecretSource } {
  const fromEnv = opts.env[spec.env];
  if (fromEnv) return { value: check(spec, fromEnv, `env var ${spec.env}`), source: 'env' };

  const path = join(opts.dir, spec.file);
  const fromFile = readIfExists(path);
  if (fromFile !== undefined) return { value: check(spec, fromFile, `file ${path}`), source: 'file' };

  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const value = spec.generate();
  writeFileSync(path, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return { value, source: 'generated' };
}

function check(spec: SecretSpec, value: string, where: string): string {
  const problem = spec.problem(value);
  if (problem) {
    throw new InvalidSecretError(
      `Invalid secret in ${where}: ${problem}. Fix or remove it; it is never regenerated automatically.`,
    );
  }
  return value;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
