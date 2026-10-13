import { describe, expect, it } from 'vitest';
import {
  BASE_SENSITIVE_KEYS,
  REDACTED,
  createRedactor,
  secretKeyNames,
} from '../../src/core/logging/redact.js';
import { describeRedactionContract } from '../../src/testing/redaction.js';
import { attendanceSpecs } from '../helpers/factories.js';

/** Attendance's SENSITIVE_KEYS at 41aab72, the list its extras plus the base must reproduce exactly. */
const ATTENDANCE_KEYS = [
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'sessionpassword',
  'nuxtsessionpassword',
  'secret',
  'clientsecret',
  'secretaccesskey',
  'litestreamsecretaccesskey',
  'tokenvaultkey',
  'nuxttokenvaultkey',
  'tdfvaultkey',
  'nuxttdfvaultkey',
  'codeverifier',
  'authorizationcode',
  'birthdate',
  'dateofbirth',
  'dob',
  'content',
  'payload',
];
const ATTENDANCE_EXTRAS = ['birthdate', 'dateOfBirth', 'dob', 'content', 'payload'];
const LOOK_ALIKES = [
  'tokenCount',
  'tokenExpiresAt',
  'tokenType',
  'passwordSetAt',
  'cookieName',
  'code',
  'state',
  'playerId',
  'contentType',
  'contentLength',
  'payloadSize',
];

const attendance = createRedactor({
  extraKeys: [...ATTENDANCE_EXTRAS, ...secretKeyNames(attendanceSpecs())],
});

describe('the base key list', () => {
  it('is exactly the credentials every app hides, normalized', () => {
    expect([...BASE_SENSITIVE_KEYS].sort()).toEqual(
      [
        'token',
        'accesstoken',
        'refreshtoken',
        'idtoken',
        'authorization',
        'proxyauthorization',
        'cookie',
        'setcookie',
        'password',
        'sessionpassword',
        'nuxtsessionpassword',
        'secret',
        'clientsecret',
        'secretaccesskey',
        'litestreamsecretaccesskey',
        'codeverifier',
        'authorizationcode',
      ].sort(),
    );
  });

  it("plus attendance's extras and secret names, hides exactly attendance's keys", () => {
    const hidden = ATTENDANCE_KEYS.filter((k) => attendance.isSensitiveKey(k));
    expect(hidden).toEqual(ATTENDANCE_KEYS);
    for (const k of LOOK_ALIKES) expect(attendance.isSensitiveKey(k), k).toBe(false);
  });

  it('cannot be shrunk: a redactor with no extras still hides every base key', () => {
    const plain = createRedactor();
    for (const k of BASE_SENSITIVE_KEYS) expect(plain.isSensitiveKey(k)).toBe(true);
    expect(plain.isSensitiveKey('birthdate')).toBe(false);
  });
});

describe('secretKeyNames', () => {
  it('names each secret by its env variable, with and without the NUXT_ prefix', () => {
    expect(secretKeyNames(attendanceSpecs())).toEqual([
      'NUXT_SESSION_PASSWORD',
      'SESSION_PASSWORD',
      'NUXT_TOKEN_VAULT_KEY',
      'TOKEN_VAULT_KEY',
      'NUXT_TDF_VAULT_KEY',
      'TDF_VAULT_KEY',
    ]);
  });

  it('keeps a name without the prefix as it is', () => {
    const spec = { ...attendanceSpecs()[0]!, env: 'BOT_TOKEN' };
    expect(secretKeyNames([spec])).toEqual(['BOT_TOKEN']);
  });
});

describeRedactionContract(attendance, {
  mustHide: [...ATTENDANCE_EXTRAS, 'tokenVaultKey'],
  mustShow: LOOK_ALIKES,
});

describe('redact', () => {
  const { redact } = attendance;

  it('hides every sensitive key at any depth, in objects and arrays, whatever its spelling', () => {
    const fields = {
      headers: { Authorization: 'Bearer abc', Cookie: 'sid=c1' },
      body: { refresh_token: 'r1', nested: [{ accessToken: 'a1', dob: '2012-01-01', 'ID-Token': 'i1' }] },
      tokenVaultKey: 'k1',
    };

    expect(redact(fields)).toEqual({
      headers: { Authorization: REDACTED, Cookie: REDACTED },
      body: {
        refresh_token: REDACTED,
        nested: [{ accessToken: REDACTED, dob: REDACTED, 'ID-Token': REDACTED }],
      },
      tokenVaultKey: REDACTED,
    });
  });

  it('hides a whole object or array held under a sensitive key', () => {
    expect(redact({ cookie: { sid: 'x' }, token: ['a', 'b'] })).toEqual({
      cookie: REDACTED,
      token: REDACTED,
    });
  });

  it('leaves null and undefined sensitive values as they are, since absence leaks nothing', () => {
    expect(redact({ token: null, password: undefined })).toEqual({ token: null, password: undefined });
  });

  it('passes numbers, booleans and null through, and scrubs top-level strings', () => {
    expect(redact(3)).toBe(3);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact('password=hunter2')).toBe('password=[REDACTED]');
  });

  it('does not change the caller’s object, even a frozen one', () => {
    const fields = Object.freeze({ password: 'p', nested: Object.freeze({ token: 't' }) });
    expect(redact(fields)).toEqual({ password: REDACTED, nested: { token: REDACTED } });
    expect(fields).toEqual({ password: 'p', nested: { token: 't' } });
  });

  it('turns an error into a plain object, scrubbing its message and stack and redacting its cause', () => {
    const cause = Object.assign(new Error('inner'), { token: 't3' });
    const err = Object.assign(new Error('upstream said Bearer xyz.123 and refresh_token=r2&x=1'), {
      cause,
      statusCode: 502,
    });

    const out = redact({ err }) as { err: Record<string, unknown> };

    expect(out.err).toMatchObject({
      type: 'Error',
      message: 'upstream said Bearer [REDACTED] and refresh_token=[REDACTED]&x=1',
      statusCode: 502,
      cause: { type: 'Error', message: 'inner', token: REDACTED },
    });
    expect(out.err.stack).toEqual(expect.any(String));
    expect(out.err.stack).not.toMatch(/xyz\.123|r2/);
  });

  it('copes with an error that has no stack and a cause that is a plain value', () => {
    const err = new Error('plain', { cause: 'token=t9' });
    Reflect.deleteProperty(err, 'stack');
    expect(redact(err)).toEqual({ type: 'Error', message: 'plain', cause: 'token=[REDACTED]' });
  });

  it('replaces a circular reference instead of throwing, but keeps a repeated one', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const shared = { n: 1 };
    expect(redact({ a })).toEqual({ a: { name: 'a', self: '[Circular]' } });
    expect(redact({ x: shared, y: shared })).toEqual({ x: { n: 1 }, y: { n: 1 } });
  });

  it('replaces a value whose getter throws instead of throwing', () => {
    const bad = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(redact({ bad })).toEqual({ bad: { boom: '[Unserializable]' } });
  });

  it('cuts off anything nested deeper than 8 levels rather than printing it unredacted', () => {
    let deep: Record<string, unknown> = { token: 'leak' };
    for (let i = 0; i < 9; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).not.toContain('leak');
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });
});

describe('scrub', () => {
  const { scrub } = attendance;

  it('hides bearer credentials, case-insensitively', () => {
    expect(scrub('header was bearer eyJhbGciOi.abc.def; next')).toBe('header was bearer [REDACTED]; next');
  });

  it('hides form-, query- and JSON-style values of sensitive names, keeping the rest', () => {
    expect(scrub('refresh_token=r2&x=1')).toBe('refresh_token=[REDACTED]&x=1');
    expect(scrub('refresh_token=abc&state=xyz')).toBe('refresh_token=[REDACTED]&state=xyz');
    expect(scrub('{"access_token":"a2","expires_in":3600}')).toBe(
      '{"access_token":"[REDACTED]","expires_in":3600}',
    );
    expect(scrub('password=hunter2 and code_verifier=v1,')).toBe(
      'password=[REDACTED] and code_verifier=[REDACTED],',
    );
  });

  it('leaves look-alike names, empty values and ordinary text untouched', () => {
    expect(scrub('tokenCount=4 tokenType=Bearer')).toBe('tokenCount=4 tokenType=Bearer');
    expect(scrub('password= next')).toBe('password= next');
    expect(scrub('Submitted 12 players for 2026-10-10')).toBe('Submitted 12 players for 2026-10-10');
  });

  it('leaves the setup-code line alone', () => {
    const line = 'No organizer account yet. Open the app and enter this setup code: ABCD-2345';
    expect(scrub(line)).toBe(line);
  });
});
