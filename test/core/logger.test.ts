import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, silentLogger } from '../../src/core/logging/logger.js';
import { createRedactor } from '../../src/core/logging/redact.js';
import { runModule, sourceUrl } from '../helpers/child.js';
import { memoryDestination } from '../helpers/memory-destination.js';

type Options = Partial<Parameters<typeof createLogger>[0]>;

function json(opts: Options = {}) {
  const out = memoryDestination();
  const log = createLogger({
    scope: 'test',
    level: 'info',
    format: 'json',
    destination: out.destination,
    ...opts,
  });
  return { log, out };
}

function pretty(opts: Options = {}, isTTY = false) {
  const out = memoryDestination(isTTY);
  const log = createLogger({
    scope: 'test',
    level: 'info',
    format: 'pretty',
    destination: out.destination,
    ...opts,
  });
  return { log, out };
}

const SECRET_FIELDS = {
  headers: { Authorization: 'Bearer abc', Cookie: 'sid=c1' },
  body: { refresh_token: 'r1', nested: [{ accessToken: 'a1', 'ID-Token': 'i1' }] },
  password: 'k1',
};
const SECRET_VALUES = ['abc', 'c1', 'r1', 'a1', 'i1', 'k1'];

describe('createLogger, json format', () => {
  it('writes one JSON object per record with level, time, scope, msg and the fields, no pid or hostname', () => {
    const { log, out } = json();
    log.info('hello', { a: 1 });

    expect(out.lines).toHaveLength(1);
    const [record] = out.records();
    expect(typeof record!.time).toBe('number');
    expect(record).toEqual({
      level: 30,
      time: record!.time,
      scope: 'test',
      msg: 'hello',
      a: 1,
    });
  });

  it('writes each level with its pino number', () => {
    const { log, out } = json({ level: 'debug' });
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(out.records().map((r) => [r.level, r.msg])).toEqual([
      [50, 'e'],
      [40, 'w'],
      [30, 'i'],
      [20, 'd'],
    ]);
  });

  it('honours the level', () => {
    const { log, out } = json({ level: 'warn' });
    log.info('quiet');
    log.warn('loud');
    expect(out.records().map((r) => r.msg)).toEqual(['loud']);
  });

  it('reads the level case-insensitively', () => {
    const { log, out } = json({ level: 'DEBUG' });
    log.debug('seen');
    expect(out.records()[0]).toMatchObject({ level: 20, msg: 'seen' });
  });

  it('falls back to info on an unknown level, and says so once', () => {
    const { log, out } = json({ level: 'loud' });
    log.debug('hidden');
    log.info('shown');
    const records = out.records();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 40,
      msg: 'NUXT_LOG_LEVEL "loud" is not one of fatal, error, warn, info, debug, trace, silent; using info.',
    });
    expect(records[1]).toMatchObject({ msg: 'shown' });
  });

  it('warns once each for an unknown level and an unknown format', () => {
    const out = memoryDestination();
    createLogger({ scope: 'test', level: 'loud', format: 'xml', destination: out.destination }).info('after');
    expect(out.lines).toHaveLength(3);
    expect(out.lines[0]).toContain('NUXT_LOG_LEVEL "loud"');
    expect(out.lines[1]).toContain('NUXT_LOG_FORMAT "xml" is not one of pretty, json; using pretty.');
  });

  it('treats an empty level or format as unset, without a warning', () => {
    const { log, out } = json({ level: '' });
    log.info('only');
    expect(out.records().map((r) => r.msg)).toEqual(['only']);

    const p = pretty({ format: '' });
    p.log.info('only');
    expect(p.out.lines).toHaveLength(1);
  });

  it('writes to stdout by default, and nothing at all when silent', () => {
    expect(() => {
      createLogger({ scope: 'test', level: 'silent' }).error('nothing');
    }).not.toThrow();
  });

  it('writes nothing at silent', () => {
    const { log, out } = json({ level: 'silent' });
    log.error('nothing');
    expect(out.lines).toEqual([]);
  });

  it('redacts sensitive fields with the base list by default', () => {
    const { log, out } = json();
    log.info('request', SECRET_FIELDS);
    for (const value of SECRET_VALUES) expect(out.text()).not.toContain(value);
    expect(out.records()[0]).toMatchObject({
      password: '[REDACTED]',
      headers: { Authorization: '[REDACTED]' },
    });
  });

  it("uses the app's redactor for fields, bindings and messages", () => {
    const { log, out } = json({ redactor: createRedactor({ extraKeys: ['birthdate'] }) });
    log.child('players', { birthdate: 'b1' }).info('imported birthdate=b2', { birthdate: 'b3', name: 'Ash' });
    expect(out.text()).not.toMatch(/b1|b2|b3/);
    expect(out.records()[0]).toMatchObject({ birthdate: '[REDACTED]', name: 'Ash' });
  });

  it('scrubs the message and the error', () => {
    const { log, out } = json();
    log.error('upstream said Bearer xyz.123', {
      err: Object.assign(new Error('refresh_token=r2&x=1 {"access_token":"a2"}'), { cause: { token: 't3' } }),
    });
    const record = out.records()[0]!;
    expect(record.msg).toBe('upstream said Bearer [REDACTED]');
    expect(record.err).toMatchObject({
      message: 'refresh_token=[REDACTED]&x=1 {"access_token":"[REDACTED]"}',
      cause: { token: '[REDACTED]' },
    });
    expect(out.text()).not.toMatch(/xyz\.123|r2|a2|t3/);
  });

  it('keeps look-alike fields visible', () => {
    const { log, out } = json();
    const fields = {
      tokenCount: 3,
      tokenExpiresAt: '2026-10-10T12:00:00Z',
      tokenType: 'Bearer',
      passwordSetAt: 1,
      cookieName: 'sid',
    };
    log.info('meta', fields);
    expect(out.records()[0]).toMatchObject(fields);
  });

  it('gives a child its own scope and bindings, with the same redaction', () => {
    const { log, out } = json();
    log.child('submission', { submissionId: 7 }).warn('slow', { password: 'p' });
    log.child('a', { x: 1 }).child('b').info('nested');
    const [first, second] = out.records();
    expect(first).toMatchObject({ scope: 'submission', submissionId: 7, password: '[REDACTED]' });
    expect(second).toMatchObject({ scope: 'b', x: 1 });
    expect(out.lines[0]!.match(/"scope"/g)).toHaveLength(1);
  });

  it('merges the request context into every record, children included', () => {
    let ctx: Record<string, unknown> | undefined = { reqId: 'req-1' };
    const { log, out } = json({ context: () => ctx });
    log.info('one');
    log.child('pokemon').info('two');
    ctx = undefined;
    log.info('three');
    expect(out.records().map((r) => r.reqId)).toEqual(['req-1', 'req-1', undefined]);
  });

  it('never throws when the context provider fails', () => {
    const { log, out } = json({
      context: () => {
        throw new Error('no context');
      },
    });
    expect(() => {
      log.info('still logged');
    }).not.toThrow();
    expect(out.records()[0]).toMatchObject({ msg: 'still logged' });
    expect(out.records()[0]).not.toHaveProperty('reqId');
  });

  it('never throws on a circular field or a throwing getter', () => {
    const { log, out } = json();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const getter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(() => {
      log.info('odd', { circular, getter });
    }).not.toThrow();
    expect(out.records()[0]).toMatchObject({
      circular: { self: '[Circular]' },
      getter: { boom: '[Unserializable]' },
    });
  });

  it('never throws when the fields object itself has a throwing getter', () => {
    const { log, out } = json();
    const fields = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(() => {
      log.info('odd', fields);
    }).not.toThrow();
    log.info('next');
    expect(out.records().map((r) => r.msg)).toEqual(['next']);
  });

  it('swallows a failing destination (closed pipe) instead of crashing, and keeps trying', () => {
    let calls = 0;
    const log = createLogger({
      scope: 'test',
      format: 'json',
      destination: {
        write() {
          calls++;
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        },
      },
    });
    expect(() => {
      log.error('lost');
      log.error('lost again');
    }).not.toThrow();
    expect(calls).toBe(2);
  });

  it('reads NUXT_LOG_LEVEL and NUXT_LOG_FORMAT when no option is given', async () => {
    const result = await runModule({
      env: { NUXT_LOG_LEVEL: 'warn', NUXT_LOG_FORMAT: 'JSON' },
      source: `
        import { createLogger } from '${sourceUrl('src/core/logging/logger.ts')}';
        const log = createLogger({ scope: 'env' });
        log.info('hidden');
        log.warn('shown');
      `,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ level: 40, scope: 'env', msg: 'shown' });
  });
});

describe('createLogger, pretty format', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T19:03:22.123Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the default, and prints one readable line with the fields after the message', () => {
    const out = memoryDestination();
    const log = createLogger({ scope: 'test', level: 'info', destination: out.destination });

    log.child('submission').warn('#12 failed', { submissionId: 12 });

    expect(out.text()).toBe('[2026-10-10 19:03:22.123] WARN: [submission] #12 failed {"submissionId":12}\n');
  });

  it("prints attendance's setup-code line byte for byte, unredacted", () => {
    const { log, out } = pretty();
    log.child('setup').info('No organizer account yet. Open the app and enter this setup code: ABCD-2345');
    expect(out.text()).toBe(
      '[2026-10-10 19:03:22.123] INFO: [setup] No organizer account yet. Open the app and enter this setup code: ABCD-2345\n',
    );
  });

  it('falls back to pretty on an unknown format, and says so', () => {
    const { log, out } = pretty({ format: 'xml' });
    log.info('after');
    expect(out.lines).toEqual([
      '[2026-10-10 19:03:22.123] WARN: [test] NUXT_LOG_FORMAT "xml" is not one of pretty, json; using pretty.\n',
      '[2026-10-10 19:03:22.123] INFO: [test] after\n',
    ]);
  });

  it('prints an error’s stack on the following lines, each indented by 4 spaces', () => {
    const { log, out } = pretty();
    log.error('failed', { err: new Error('boom', { cause: new Error('root') }), statusCode: 500 });
    const [first, ...rest] = out.text().trimEnd().split('\n');
    expect(first).toBe('[2026-10-10 19:03:22.123] ERROR: [test] failed {"statusCode":500}');
    expect(rest[0]).toBe('    Error: boom');
    expect(rest.length).toBeGreaterThan(1);
    for (const line of rest) expect(line).toMatch(/^ {4}\S/);
  });

  it('prints type and message for an error that has no stack', () => {
    const { log, out } = pretty();
    log.error('failed', { err: { type: 'TimeoutError', message: 'slow' } });
    log.error('failed', { err: {} });
    expect(out.lines).toEqual([
      '[2026-10-10 19:03:22.123] ERROR: [test] failed\n    TimeoutError: slow\n',
      '[2026-10-10 19:03:22.123] ERROR: [test] failed\n    Error:\n',
    ]);
  });

  it('escapes newlines in the message so one record cannot forge another line', () => {
    const { log, out } = pretty();
    log.info('line1\n[2026-10-10 00:00:00.000] INFO: [setup] fake\r\nend\rx');
    expect(out.lines).toHaveLength(1);
    expect(out.text().trimEnd().split('\n')).toHaveLength(1);
    expect(out.text()).toBe(
      '[2026-10-10 19:03:22.123] INFO: [test] line1\\n[2026-10-10 00:00:00.000] INFO: [setup] fake\\nend\\nx\n',
    );
  });

  it('prints an http record as method, path, status and duration, with only the other fields after it', () => {
    const { log, out } = pretty();
    log.child('http').info('GET /api/players 200 12ms', {
      method: 'GET',
      path: '/api/players',
      status: 200,
      durationMs: 12,
      reqId: 'r-1',
    });
    log.child('jobs').info('ran', { status: 'ok' });
    expect(out.lines).toEqual([
      '[2026-10-10 19:03:22.123] INFO: [http] GET /api/players 200 12ms {"reqId":"r-1"}\n',
      '[2026-10-10 19:03:22.123] INFO: [jobs] ran {"status":"ok"}\n',
    ]);
  });

  it('redacts before formatting', () => {
    const { log, out } = pretty();
    log.info('request with Bearer abc', SECRET_FIELDS);
    for (const value of SECRET_VALUES) expect(out.text()).not.toContain(value);
    expect(out.text()).toContain('[REDACTED]');
  });

  it('uses no colour codes off a terminal', () => {
    const { log, out } = pretty();
    log.info('x');
    expect(out.text()).not.toContain('\u001b[');
  });
});

describe('createLogger, pretty format in a real process', () => {
  const script = `
    import { createLogger } from '${sourceUrl('src/core/logging/logger.ts')}';
    Date.now = () => Date.parse('2026-10-10T19:03:22.123Z');
    const lines = [];
    const log = createLogger({ scope: 'tz', level: 'info', destination: { isTTY: process.env.TTY === '1', write: (l) => lines.push(l) } });
    log.info('x');
    process.stdout.write(JSON.stringify(lines));
  `;
  const run = async (env: Record<string, string>) =>
    JSON.parse((await runModule({ env, source: script })).stdout) as string[];

  it('prints local time', async () => {
    expect(await run({ TZ: 'America/Chicago' })).toEqual(['[2026-10-10 14:03:22.123] INFO: [tz] x\n']);
  });

  it('colours on a terminal unless NO_COLOR is set', async () => {
    expect((await run({ TZ: 'UTC', TTY: '1' }))[0]).toContain('\u001b[');
    expect((await run({ TZ: 'UTC', TTY: '1', NO_COLOR: '1' }))[0]).not.toContain('\u001b[');
  });
});

describe('silentLogger', () => {
  it('accepts every call and returns itself as every child', () => {
    expect(() => {
      silentLogger.error('x');
      silentLogger.warn('x');
      silentLogger.info('x');
      silentLogger.debug('x');
      silentLogger.child('y').error('z', { token: 't' });
    }).not.toThrow();
    expect(silentLogger.child('y', { a: 1 })).toBe(silentLogger);
  });
});
