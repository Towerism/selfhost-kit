import type { SecretSpec } from '../secrets/index.js';

/**
 * Log redaction: no credential value may reach the log. It runs before either log format, so pretty and
 * JSON output are equally safe.
 *
 * Keys match an exact list after normalizing (lowercase, `_` and `-` removed), so `refresh_token` and
 * `refreshToken` are hidden but `tokenCount` is not.
 */

export const REDACTED = '[REDACTED]';

/** The credentials every app hides, in readable form. Redaction only grows (ADR-0005 rule 1). */
export const BASE_KEY_NAMES: readonly string[] = [
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'authorization',
  'proxyAuthorization',
  'cookie',
  'setCookie',
  'password',
  'sessionPassword',
  'nuxtSessionPassword',
  'secret',
  'clientSecret',
  'secretAccessKey',
  'litestreamSecretAccessKey',
  'codeVerifier',
  'authorizationCode',
];

/** Lowercase with `_` and `-` removed: the form keys are compared in. */
export const normalizeKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '');

/** The base list, normalized. A redactor always hides these; no option can remove one. */
export const BASE_SENSITIVE_KEYS: ReadonlySet<string> = new Set(BASE_KEY_NAMES.map(normalizeKey));

export interface Redactor {
  /** A deep, redacted copy of `value`. Never throws and never mutates the input. */
  redact: (value: unknown) => unknown;
  /** Hides credential-looking substrings: `Bearer …`, `name=…` and `"name":"…"`. */
  scrub: (text: string) => string;
  isSensitiveKey: (key: string) => boolean;
}

const MAX_DEPTH = 8;
// A value runs to whitespace, `&`, `,`, `;`, `"` or the end of the string.
const BEARER = /\b(bearer\s+)[^\s&,;"]+/gi;
const NAME_VALUE = /([A-Za-z_-]+)(=|":")([^\s&,;"]*)/g;

/**
 * @param opts.extraKeys the app's own sensitive keys, added to {@link BASE_SENSITIVE_KEYS} (for example
 * `birthdate`, `content`, and `...secretKeyNames(SECRETS)`).
 */
export function createRedactor(opts: { extraKeys?: readonly string[] } = {}): Redactor {
  const keys = new Set([...BASE_SENSITIVE_KEYS, ...(opts.extraKeys ?? []).map(normalizeKey)]);
  const isSensitiveKey = (key: string) => keys.has(normalizeKey(key));

  const scrub = (text: string) =>
    text
      .replace(BEARER, `$1${REDACTED}`)
      .replace(NAME_VALUE, (whole, name: string, sep: string, value: string) =>
        value && isSensitiveKey(name) ? `${name}${sep}${REDACTED}` : whole,
      );

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[Truncated]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
      const out: Record<string, unknown> = {};
      if (value instanceof Error) {
        out.type = value.name;
        out.message = scrub(value.message);
        if (value.stack) out.stack = scrub(value.stack);
        if (value.cause !== undefined) out.cause = walk(value.cause, depth + 1, seen);
      }
      for (const key of Object.keys(value)) {
        out[key] = field(value as Record<string, unknown>, key, depth, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  const field = (
    obj: Record<string, unknown>,
    key: string,
    depth: number,
    seen: WeakSet<object>,
  ): unknown => {
    let raw: unknown;
    try {
      raw = obj[key];
    } catch {
      return '[Unserializable]';
    }
    if (raw !== null && raw !== undefined && isSensitiveKey(key)) return REDACTED;
    return walk(raw, depth + 1, seen);
  };

  return { redact: (value) => walk(value, 0, new WeakSet()), scrub, isSensitiveKey };
}

/**
 * The env names of an app's secrets, for `extraKeys`: each spec's `env`, and the same name without a
 * leading `NUXT_`, so a config object logged with a `tokenVaultKey` field stays hidden too.
 */
export function secretKeyNames(specs: readonly SecretSpec[]): string[] {
  return specs.flatMap((spec) => (spec.env.startsWith('NUXT_') ? [spec.env, spec.env.slice(5)] : [spec.env]));
}
