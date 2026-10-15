import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigError, prepareRuntimeEnv, secretsDirFor } from '../../src/core/runtime/env.js';
import { aes256Key, InvalidSecretError } from '../../src/core/secrets/index.js';
import { createFixedWindowLimiter } from '../../src/core/security/rate-limit.js';
import { type TempSecretsDir, existingInstallSecrets, tempSecretsDir } from '../../src/testing/secrets.js';
import { attendanceSpecs, syntheticKey, syntheticPassword } from '../helpers/factories.js';

const RATE_LIMIT_VARS = [
  'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
  'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
  'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
  'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
  'NUXT_INTEGRATION_RATE_LIMIT_MAX',
  'NUXT_INTEGRATION_RATE_LIMIT_WINDOW_MS',
];

const snapshot = (path: string) => {
  const s = statSync(path);
  return { content: readFileSync(path, 'utf8'), mode: s.mode & 0o777, mtimeMs: s.mtimeMs };
};

let data: TempSecretsDir;
beforeEach(() => {
  data = tempSecretsDir();
});
afterEach(() => {
  data.cleanup();
});

const base = () => ({ NUXT_DATABASE_PATH: data.databasePath });
const prepare = (
  input: Record<string, string | undefined>,
  more: Partial<Parameters<typeof prepareRuntimeEnv>[1]> = {},
) => prepareRuntimeEnv(input, { secrets: attendanceSpecs(), positiveIntegerVars: RATE_LIMIT_VARS, ...more });

describe('prepareRuntimeEnv', () => {
  it('puts generated secrets in a secrets dir next to the database and exports them', () => {
    const { env, log } = prepare(base());

    expect(env.NUXT_SESSION_PASSWORD).toHaveLength(43);
    expect(Buffer.from(env.NUXT_TOKEN_VAULT_KEY!, 'base64')).toHaveLength(32);
    expect(Buffer.from(env.NUXT_TDF_VAULT_KEY!, 'base64')).toHaveLength(32);
    expect(log).toEqual([
      `Session password: generated into ${join(data.secretsDir, 'session-password')}`,
      `Token vault key: generated into ${join(data.secretsDir, 'token-vault.key')}`,
      `TDF vault key: generated into ${join(data.secretsDir, 'tdf-vault.key')}`,
    ]);
  });

  it('keeps the secrets stable across restarts, and says they were loaded', () => {
    const first = prepare(base());
    const second = prepare(base());

    expect(second.env.NUXT_SESSION_PASSWORD).toBe(first.env.NUXT_SESSION_PASSWORD);
    expect(second.env.NUXT_TOKEN_VAULT_KEY).toBe(first.env.NUXT_TOKEN_VAULT_KEY);
    expect(second.env.NUXT_TDF_VAULT_KEY).toBe(first.env.NUXT_TDF_VAULT_KEY);
    expect(second.log[0]).toBe(`Session password: loaded from ${join(data.secretsDir, 'session-password')}`);
  });

  it('says a secret came from its env var', () => {
    const { log } = prepare({ ...base(), NUXT_TOKEN_VAULT_KEY: syntheticKey(9) });
    expect(log[1]).toBe('Token vault key: from NUXT_TOKEN_VAULT_KEY');
  });

  it('never logs a value', () => {
    const { env, log } = prepare(base());
    for (const line of log) {
      expect(line).not.toContain(env.NUXT_SESSION_PASSWORD);
      expect(line).not.toContain(env.NUXT_TOKEN_VAULT_KEY);
      expect(line).not.toContain(env.NUXT_TDF_VAULT_KEY);
    }
  });

  it('does not mutate the input env', () => {
    const input = { ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: ' ' };
    prepare(input);
    expect(input).toEqual({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: ' ' });
  });

  it('puts secrets next to the database, defaulting to .data/app.db when the path is unset or empty', () => {
    expect(secretsDirFor({ NUXT_DATABASE_PATH: '/data/app.db' })).toBe('/data/secrets');
    expect(secretsDirFor({ NUXT_DATABASE_PATH: undefined })).toBe(join('.data', 'secrets'));
    expect(secretsDirFor({ NUXT_DATABASE_PATH: '' })).toBe(join('.data', 'secrets'));
  });

  it('resolves nothing for an app with no secrets', () => {
    expect(prepareRuntimeEnv({}, { secrets: [] }).log).toEqual([]);
  });

  describe('an existing install', () => {
    it('loads its three secrets unchanged, regenerating and touching nothing', () => {
      const values = {
        'session-password': syntheticPassword(1),
        'token-vault.key': syntheticKey(2),
        'tdf-vault.key': syntheticKey(3),
      };
      const install = existingInstallSecrets(values);
      try {
        const files = Object.keys(values).map((f) => join(install.secretsDir, f));
        const before = files.map(snapshot);

        const { env, log } = prepare({ NUXT_DATABASE_PATH: install.databasePath });

        expect(env).toMatchObject({
          NUXT_SESSION_PASSWORD: values['session-password'],
          NUXT_TOKEN_VAULT_KEY: values['token-vault.key'],
          NUXT_TDF_VAULT_KEY: values['tdf-vault.key'],
        });
        expect(log).toEqual([
          `Session password: loaded from ${files[0]!}`,
          `Token vault key: loaded from ${files[1]!}`,
          `TDF vault key: loaded from ${files[2]!}`,
        ]);
        expect(files.map(snapshot)).toEqual(before);
      } finally {
        install.cleanup();
      }
    });

    it('fails on a corrupt key file rather than replacing it', () => {
      const install = existingInstallSecrets({ 'token-vault.key': 'not-a-key' });
      try {
        expect(() => prepare({ NUXT_DATABASE_PATH: install.databasePath })).toThrow(InvalidSecretError);
        expect(readFileSync(join(install.secretsDir, 'token-vault.key'), 'utf8')).toBe('not-a-key\n');
      } finally {
        install.cleanup();
      }
    });
  });

  describe('session cookie Secure flag (plain HTTP on the LAN works)', () => {
    it.each([
      [undefined, 'false'],
      ['', 'false'],
      ['http://tower:3000', 'false'],
      ['https:', 'false'],
      ['https://attendance.example.com', 'true'],
      ['HTTPS://ATTENDANCE.EXAMPLE.COM', 'true'],
    ])('site url %j → secure=%s', (siteUrl, secure) => {
      const { env } = prepare({ ...base(), NUXT_PUBLIC_SITE_URL: siteUrl });
      expect(env.NUXT_SESSION_COOKIE_SECURE).toBe(secure);
    });

    it.each([
      ['true', 'http://tower:3000'],
      ['false', 'https://attendance.example.com'],
    ])('keeps an explicit %s whatever the site url', (value, siteUrl) => {
      const { env } = prepare({
        ...base(),
        NUXT_SESSION_COOKIE_SECURE: value,
        NUXT_PUBLIC_SITE_URL: siteUrl,
      });
      expect(env.NUXT_SESSION_COOKIE_SECURE).toBe(value);
    });

    it('derives it again when it is set but empty', () => {
      const { env } = prepare({
        ...base(),
        NUXT_SESSION_COOKIE_SECURE: '',
        NUXT_PUBLIC_SITE_URL: 'https://attendance.example.com',
      });
      expect(env.NUXT_SESSION_COOKIE_SECURE).toBe('true');
    });
  });

  describe('positive-integer variables', () => {
    // 2^53 and up: Number() loses precision (or gives Infinity), and the rate limiter refuses the value.
    const TOO_BIG = ['9007199254740992', '9'.repeat(400)];
    it.each(
      RATE_LIMIT_VARS.flatMap((name) =>
        ['0', '-1', 'abc', '1.5', '10x', '05', '007', ...TOO_BIG].map((value) => [name, value]),
      ),
    )('fails startup for %s=%j, naming the variable, the range and the value', (name, value) => {
      expect(() => prepare({ ...base(), [name]: value })).toThrow(InvalidConfigError);
      expect(() => prepare({ ...base(), [name]: value })).toThrow(
        `${name} must be a whole number from 1 to 9007199254740991 (got "${value}").`,
      );
    });

    it('names the trimmed value when it refuses one', () => {
      expect(() => prepare({ ...base(), NUXT_INTEGRATION_RATE_LIMIT_MAX: ' 0 ' })).toThrow(
        'NUXT_INTEGRATION_RATE_LIMIT_MAX must be a whole number from 1 to 9007199254740991 (got "0").',
      );
    });

    it('accepts whole numbers from 1 to 2^53 - 1, keeping them trimmed', () => {
      const { env } = prepare({
        ...base(),
        NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1',
        NUXT_AUTH_RATE_LIMIT_SETUP_MAX: '9007199254740991',
        NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS: ' 1000 ',
      });
      expect(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX).toBe('1');
      expect(env.NUXT_AUTH_RATE_LIMIT_SETUP_MAX).toBe('9007199254740991');
      expect(env.NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS).toBe('1000');
    });

    // Startup and the limiter must agree: whatever startup accepts, the limiter builds with (#22).
    it.each(['1', '9007199254740991'])('passes %s on to a limiter that accepts it as its max', (value) => {
      const { env } = prepare({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: value });
      expect(() =>
        createFixedWindowLimiter({ max: Number(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX), windowMs: 1000 }),
      ).not.toThrow();
    });

    it.each([' ', ''])('treats %j as unset, so the default applies', (value) => {
      const { env } = prepare({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: value });
      expect(env).not.toHaveProperty('NUXT_AUTH_RATE_LIMIT_LOGIN_MAX');
    });

    it('checks nothing when the app lists no variables', () => {
      const { env } = prepareRuntimeEnv(
        { ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: 'abc' },
        { secrets: attendanceSpecs() },
      );
      expect(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX).toBe('abc');
    });
  });

  describe('trusted proxies', () => {
    it.each(['10.0.0.0/33', 'not-an-ip'])(
      'fails startup for NUXT_TRUSTED_PROXIES=%j, naming the variable and the entry',
      (value) => {
        expect(() => prepare({ ...base(), NUXT_TRUSTED_PROXIES: value })).toThrow(InvalidConfigError);
        expect(() => prepare({ ...base(), NUXT_TRUSTED_PROXIES: value })).toThrow(
          `NUXT_TRUSTED_PROXIES has an invalid entry "${value}".`,
        );
      },
    );

    it.each(['none', '10.0.0.5, 2001:db8::/32', '', '   ', undefined])('accepts %j', (value) => {
      expect(() => prepare({ ...base(), NUXT_TRUSTED_PROXIES: value })).not.toThrow();
    });
  });

  describe("the app's own validation", () => {
    it('runs last, on the prepared env, and its InvalidConfigError stops startup as is', () => {
      let seen: Record<string, string | undefined> | undefined;
      const error = new InvalidConfigError('NUXT_DISCORD_CLIENT_ID is required.');
      const run = () =>
        prepare(base(), {
          validate: (env) => {
            seen = env;
            throw error;
          },
        });

      expect(run).toThrow(error);
      expect(seen?.NUXT_SESSION_COOKIE_SECURE).toBe('false');
      expect(seen?.NUXT_TOKEN_VAULT_KEY).toBeDefined();
    });

    it('lets the env through when validation passes', () => {
      expect(() => prepare(base(), { validate: () => undefined })).not.toThrow();
    });
  });

  describe('duplicate secret specs', () => {
    it.each([
      [
        'env',
        aes256Key({ env: 'NUXT_TOKEN_VAULT_KEY', file: 'other.key', label: 'Other' }),
        'NUXT_TOKEN_VAULT_KEY',
      ],
      [
        'file',
        aes256Key({ env: 'NUXT_OTHER_KEY', file: 'token-vault.key', label: 'Other' }),
        'token-vault.key',
      ],
    ])('refuses two specs with the same %s before touching the disk', (_label, duplicate, name) => {
      const run = () => prepareRuntimeEnv(base(), { secrets: [...attendanceSpecs(), duplicate] });
      expect(run).toThrow(InvalidConfigError);
      expect(run).toThrow(name);
      expect(existsSync(data.secretsDir)).toBe(false);
    });
  });

  it('has an InvalidConfigError that names itself', () => {
    expect(new InvalidConfigError('x').name).toBe('InvalidConfigError');
  });
});
