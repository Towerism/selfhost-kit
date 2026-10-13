import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidSecretError,
  aes256Key,
  resolveSecret,
  sessionPassword,
} from '../../src/core/secrets/index.js';
import { type TempSecretsDir, existingInstallSecrets, tempSecretsDir } from '../../src/testing/secrets.js';
import { syntheticKey } from '../helpers/factories.js';

const TOKEN_KEY = aes256Key({
  env: 'NUXT_TOKEN_VAULT_KEY',
  file: 'token-vault.key',
  label: 'Token vault key',
});
const TDF_KEY = aes256Key({ env: 'NUXT_TDF_VAULT_KEY', file: 'tdf-vault.key', label: 'TDF vault key' });

const mode = (path: string) => statSync(path).mode & 0o777;
const snapshot = (path: string) => {
  const s = statSync(path);
  return { content: readFileSync(path, 'utf8'), mode: s.mode & 0o777, mtimeMs: s.mtimeMs };
};

let data: TempSecretsDir;
let dir: string;
let savedUmask: number;
beforeEach(() => {
  savedUmask = process.umask(0o022);
  data = tempSecretsDir();
  dir = data.secretsDir;
});
afterEach(() => {
  process.umask(savedUmask);
  data.cleanup();
});

/** Writes one file into the secrets dir the way an operator or an older install might have. */
function plant(file: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
  return join(dir, file);
}

describe('secret specs', () => {
  it('sessionPassword is NUXT_SESSION_PASSWORD / session-password, at least 32 characters of base64url', () => {
    const spec = sessionPassword();
    expect(spec).toMatchObject({
      env: 'NUXT_SESSION_PASSWORD',
      file: 'session-password',
      label: 'Session password',
    });
    expect(spec.generate()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(spec.generate()).not.toBe(spec.generate());
    expect(spec.problem('x'.repeat(32))).toBeNull();
    expect(spec.problem('x'.repeat(31))).toBe('must be at least 32 characters');
  });

  it('aes256Key keeps the env, file and label it was given, and generates 32-byte base64 keys', () => {
    expect(TOKEN_KEY).toMatchObject({
      env: 'NUXT_TOKEN_VAULT_KEY',
      file: 'token-vault.key',
      label: 'Token vault key',
    });
    const key = TOKEN_KEY.generate();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(TOKEN_KEY.problem(key)).toBeNull();
    expect(TOKEN_KEY.problem('!'.repeat(44))).toBe('must be 32 bytes, base64-encoded');
  });
});

describe('resolveSecret', () => {
  it('generates a missing secret once into the secrets dir, readable only by the owner', () => {
    const result = resolveSecret(sessionPassword(), { env: {}, dir });

    expect(result.source).toBe('generated');
    const file = join(dir, 'session-password');
    expect(readFileSync(file, 'utf8')).toBe(`${result.value}\n`);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  it('reuses the generated secret on the next boot', () => {
    const first = resolveSecret(sessionPassword(), { env: {}, dir });
    const second = resolveSecret(sessionPassword(), { env: {}, dir });

    expect(second).toEqual({ value: first.value, source: 'file' });
  });

  it('prefers the env var over the file and leaves the dir alone', () => {
    const fromEnv = 'x'.repeat(40);
    const result = resolveSecret(sessionPassword(), { env: { NUXT_SESSION_PASSWORD: fromEnv }, dir });

    expect(result).toEqual({ value: fromEnv, source: 'env' });
    expect(existsSync(dir)).toBe(false);
  });

  it('prefers the env var over an existing file and does not touch the file', () => {
    const file = plant('token-vault.key', `${syntheticKey(1)}\n`);
    const before = snapshot(file);
    const result = resolveSecret(TOKEN_KEY, { env: { NUXT_TOKEN_VAULT_KEY: syntheticKey(2) }, dir });

    expect(result).toEqual({ value: syntheticKey(2), source: 'env' });
    expect(snapshot(file)).toEqual(before);
  });

  it('treats an empty env var as unset', () => {
    expect(resolveSecret(sessionPassword(), { env: { NUXT_SESSION_PASSWORD: '' }, dir }).source).toBe(
      'generated',
    );
  });

  it('trims CRLF and trailing spaces from a file', () => {
    plant('token-vault.key', `  ${syntheticKey(3)} \r\n`);
    expect(resolveSecret(TOKEN_KEY, { env: {}, dir })).toEqual({ value: syntheticKey(3), source: 'file' });
  });

  it('keeps separate files for separate specs', () => {
    const tdf = resolveSecret(TDF_KEY, { env: {}, dir });
    const token = resolveSecret(TOKEN_KEY, { env: {}, dir });
    expect(mode(join(dir, 'tdf-vault.key'))).toBe(0o600);
    expect(tdf.value).not.toBe(token.value);
  });

  it('leaves the mode of an existing, looser secrets dir alone', () => {
    mkdirSync(dir, { mode: 0o755 });
    resolveSecret(TOKEN_KEY, { env: {}, dir });
    expect(mode(dir)).toBe(0o755);
  });
});

describe('malformed secrets fail startup and are never regenerated', () => {
  it('rejects a too-short session password from env, naming the variable but not the value', () => {
    const run = () =>
      resolveSecret(sessionPassword(), { env: { NUXT_SESSION_PASSWORD: 'hunter2-short' }, dir });

    expect(run).toThrow(InvalidSecretError);
    expect(run).toThrow(
      'Invalid secret in env var NUXT_SESSION_PASSWORD: must be at least 32 characters. Fix or remove it; it is never regenerated automatically.',
    );
    expect(run).not.toThrow(/hunter2/);
  });

  it.each([
    ['corrupt', 'not-a-key\n'],
    ['empty', ''],
    ['whitespace only', '  \n'],
  ])('rejects a %s key file, names its path, and leaves it exactly as it was', (_label, content) => {
    const file = plant('token-vault.key', content);
    const before = snapshot(file);

    expect(() => resolveSecret(TOKEN_KEY, { env: {}, dir })).toThrow(
      `Invalid secret in file ${file}: must be 32 bytes, base64-encoded. Fix or remove it; it is never regenerated automatically.`,
    );
    expect(snapshot(file)).toEqual(before);
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(33).toString('base64')],
    ['not base64', '!'.repeat(44)],
  ])('rejects a vault key from env that is %s, without echoing it', (_label, key) => {
    const run = () => resolveSecret(TOKEN_KEY, { env: { NUXT_TOKEN_VAULT_KEY: key }, dir });
    expect(run).toThrow(/NUXT_TOKEN_VAULT_KEY/);
    expect(run).not.toThrow(key);
  });

  it.skipIf(process.getuid?.() === 0)('lets an unreadable file’s own error through, untouched', () => {
    const file = plant('token-vault.key', `${syntheticKey(4)}\n`);
    chmodSync(file, 0o000);
    try {
      expect(() => resolveSecret(TOKEN_KEY, { env: {}, dir })).toThrow(
        expect.objectContaining({ code: 'EACCES' }),
      );
      expect(mode(file)).toBe(0o000);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('has an InvalidSecretError that names itself', () => {
    expect(new InvalidSecretError('x').name).toBe('InvalidSecretError');
  });
});

describe('secret-dir fixtures', () => {
  it('tempSecretsDir lays out a fresh data folder without creating secrets/', () => {
    const fresh = tempSecretsDir();
    try {
      expect(fresh.databasePath).toBe(join(fresh.root, 'app.db'));
      expect(fresh.secretsDir).toBe(join(fresh.root, 'secrets'));
      expect(existsSync(fresh.root)).toBe(true);
      expect(existsSync(fresh.secretsDir)).toBe(false);
    } finally {
      fresh.cleanup();
    }
    expect(existsSync(fresh.root)).toBe(false);
  });

  it('existingInstallSecrets writes value + newline at 0600 in a 0700 dir, whatever the umask', () => {
    process.umask(0o077);
    const install = existingInstallSecrets({ a: 'x', 'token-vault.key': syntheticKey(5) });
    try {
      expect(mode(install.secretsDir)).toBe(0o700);
      expect(readFileSync(join(install.secretsDir, 'a'), 'utf8')).toBe('x\n');
      expect(mode(join(install.secretsDir, 'a'))).toBe(0o600);
      expect(resolveSecret(TOKEN_KEY, { env: {}, dir: install.secretsDir })).toEqual({
        value: syntheticKey(5),
        source: 'file',
      });
    } finally {
      install.cleanup();
    }
  });
});
