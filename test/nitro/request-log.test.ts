import { createError, defineEventHandler } from 'h3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/core/logging/logger.js';
import { createRedactor } from '../../src/core/logging/redact.js';
import { jsonErrorHandler } from '../../src/nitro/error.js';
import { requestLogPlugin } from '../../src/nitro/plugins.js';
import { fakeClock, type FakeClock } from '../../src/testing/clock.js';
import { type H3TestApp, h3TestApp } from '../../src/testing/h3-app.js';
import { memoryDestination } from '../helpers/memory-destination.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// pino's numeric levels
const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

let clock: FakeClock;
let log: ReturnType<typeof memoryDestination>;
let app: H3TestApp;

beforeEach(() => {
  clock = fakeClock(1_000);
  log = memoryDestination();
  const logger = createLogger({
    redactor: createRedactor(),
    scope: 'app',
    level: 'debug',
    format: 'json',
    destination: log.destination,
  });
  app = h3TestApp({
    plugins: [requestLogPlugin({ logger, clock })],
    routes: {
      '/api/items': defineEventHandler(() => {
        clock.advance(42);
        return { items: [] };
      }),
      '/healthz': defineEventHandler(() => 'ok'),
      '/api/gone': defineEventHandler((event) => {
        // The client went away: the response closes without finishing.
        event.node.res.emit('close');
        return '';
      }),
      '/x': defineEventHandler(() => {
        throw createError({ statusCode: 404, message: 'No such thing' });
      }),
      '/y': defineEventHandler(() => {
        throw new Error('boom');
      }),
    },
    errorHandler: jsonErrorHandler(),
  });
});

const records = () => log.records();
const httpRecords = () => records().filter((r) => r.scope === 'http');

describe('request ids', () => {
  it('accepts a well-formed X-Request-Id and returns it', async () => {
    const res = await app.fetch('/api/items?secret=abc', { headers: { 'x-request-id': 'req-123' } });
    expect(res.headers.get('x-request-id')).toBe('req-123');
  });

  it.each(['bad id', 'a'.repeat(65), 'req-1, req-2'])('replaces %j with a fresh UUID', async (header) => {
    const res = await app.fetch('/api/items', { headers: { 'x-request-id': header } });
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(UUID);
    expect(httpRecords()[0]?.reqId).toBe(id);
  });

  it('gives a request without one a fresh UUID', async () => {
    expect((await app.fetch('/api/items')).headers.get('x-request-id')).toMatch(UUID);
  });
});

describe('the request log', () => {
  it('writes one line per request with only the method, path, status, duration and id', async () => {
    await app.fetch('/api/items?secret=abc', {
      headers: { 'x-request-id': 'req-123', authorization: 'Bearer sekrit', cookie: 'session=sekrit' },
    });
    const lines = httpRecords();
    expect(lines).toHaveLength(1);
    const line = { ...lines[0]! };
    expect(typeof line.time).toBe('number');
    delete line.time;
    expect(line).toEqual({
      level: INFO,
      scope: 'http',
      msg: 'GET /api/items 200 42ms',
      method: 'GET',
      path: '/api/items',
      status: 200,
      durationMs: 42,
      reqId: 'req-123',
    });
    expect(log.text()).not.toMatch(/secret=abc|sekrit/);
  });

  it('logs health checks at debug', async () => {
    await app.fetch('/healthz');
    expect(httpRecords()).toEqual([expect.objectContaining({ level: DEBUG, msg: 'GET /healthz 200 0ms' })]);
  });

  it('logs an aborted request as 499', async () => {
    await app.fetch('/api/gone', { method: 'POST' });
    expect(httpRecords()).toEqual([
      expect.objectContaining({ level: INFO, msg: 'POST /api/gone 499 0ms', status: 499, aborted: true }),
    ]);
  });
});

describe('the default clock', () => {
  it('times requests with a clock that never goes backwards', async () => {
    const own = memoryDestination();
    const logger = createLogger({
      redactor: createRedactor(),
      scope: 'app',
      format: 'json',
      destination: own.destination,
    });
    const plain = h3TestApp({
      plugins: [requestLogPlugin({ logger })],
      routes: { '/': defineEventHandler(() => 'ok') },
    });
    await plain.fetch('/');
    const { durationMs } = own.records()[0]!;
    expect(Number.isInteger(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('the error log', () => {
  it('logs a client error at warn', async () => {
    const res = await app.fetch('/x?q=1', { headers: { 'x-request-id': 'req-404' } });
    expect(res.status).toBe(404);
    expect(httpRecords()).toContainEqual(
      expect.objectContaining({
        level: WARN,
        msg: '404 on /x: No such thing',
        path: '/x',
        reqId: 'req-404',
        statusCode: 404,
      }),
    );
    expect(httpRecords().find((r) => r.level === WARN)).not.toHaveProperty('err');
  });

  it('logs a server error at error, with the error', async () => {
    await app.fetch('/y');
    const line = httpRecords().find((r) => r.level === ERROR);
    expect(line).toMatchObject({ msg: '500 on /y: boom', path: '/y', statusCode: 500 });
    expect(line?.err).toMatchObject({ message: 'boom' });
  });

  it('logs an error without a request under the app scope', async () => {
    await app.callHook('error', new Error('boom'), { tags: ['startup'] });
    const lines = records();
    expect(lines).toEqual([
      expect.objectContaining({ level: ERROR, scope: 'app', msg: 'Unhandled error: boom' }),
    ]);
    expect(lines[0]?.err).toMatchObject({ message: 'boom' });
  });

  it('logs an error with no status code as 500', async () => {
    await app.callHook('error', Object.assign(new Error('odd'), { statusCode: 0 }), {
      event: { path: '/z?q', context: { reqId: 'r1' } },
    });
    expect(records()).toEqual([
      expect.objectContaining({
        level: ERROR,
        scope: 'http',
        msg: '500 on /z: odd',
        path: '/z',
        reqId: 'r1',
      }),
    ]);
  });
});
