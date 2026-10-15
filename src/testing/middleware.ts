import { type EventHandler, createError, defineEventHandler } from 'h3';
import { beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from '../core/security/headers.js';
import { jsonErrorHandler } from '../nitro/error.js';
import type { JsonErrorHandler, NitroAppPlugin } from '../nitro/types.js';
import { type H3TestApp, h3TestApp } from './h3-app.js';

const UNSAFE = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SAFE = ['GET', 'HEAD', 'OPTIONS'] as const;
const JSON_TYPES = [
  'application/json',
  'application/json; charset=utf-8',
  'Application/JSON',
  'application/json-patch+json',
];
const NOT_JSON = [
  'text/plain',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'application/jsonx',
];
const JSON_ONLY_MESSAGE = 'Send JSON (Content-Type: application/json)';

const cross = <A, B>(as: readonly A[], bs: readonly B[]) =>
  as.flatMap((a) => bs.map((b) => [a, b] as [A, B]));
const pathOnly = (path: string) => path.split('?')[0] ?? path;

/** Routes that answer 200 `{ ok: true }` without reading the body, and count how often they ran. */
function probeRoutes(paths: string[]) {
  const calls = { count: 0 };
  const probe = defineEventHandler(() => {
    calls.count++;
    return { ok: true };
  });
  return { calls, routes: Object.fromEntries(paths.map((p) => [pathOnly(p), probe])) };
}

async function errorBody(res: Response) {
  return (await res.json()) as { statusCode: number; message: string };
}

/**
 * The JSON-only matrix (ADR-0008), run against the app's own `jsonOnly` middleware: JSON bodies pass on
 * POST/PUT/PATCH/DELETE under `prefix`, form, multipart and text bodies get 415, and safe methods, other
 * paths and `exemptPaths` pass. Call it inside a test file; it registers its own `describe`.
 *
 * `exemptPaths` are concrete request paths the suite sends (e.g. `/api/tdf/preview`), not patterns: each must
 * be matched by one of the regexes the app passed to the middleware's `exempt`.
 */
export function describeJsonOnly(
  handler: EventHandler,
  options: { prefix?: string; exemptPaths?: string[] } = {},
) {
  const { prefix = '/api/', exemptPaths = [] } = options;
  const target = `${prefix}probe`;

  describe(`jsonOnly contract (prefix ${prefix})`, () => {
    let app: H3TestApp;
    beforeEach(() => {
      app = h3TestApp({
        middleware: [handler],
        routes: probeRoutes([target, '/probe', ...exemptPaths]).routes,
      });
    });

    const send = (method: string, path: string, type?: string) =>
      app.fetch(path, {
        method,
        headers: type === undefined ? {} : { 'content-type': type },
        ...(SAFE.includes(method as (typeof SAFE)[number]) ? {} : { body: new Uint8Array([123, 125]) }),
      });

    it.each(cross(UNSAFE, JSON_TYPES))('%s with %s passes', async (method, type) => {
      expect((await send(method, target, type)).status).toBe(200);
    });

    it.each(cross(UNSAFE, NOT_JSON))('%s with %s gets 415', async (method, type) => {
      const res = await send(method, target, type);
      expect(res.status).toBe(415);
      expect(await errorBody(res)).toMatchObject({ statusCode: 415, message: JSON_ONLY_MESSAGE });
    });

    it.each(UNSAFE)('%s with no Content-Type passes', async (method) => {
      expect((await send(method, target)).status).toBe(200);
    });

    it.each(SAFE)('%s with text/plain passes', async (method) => {
      expect((await send(method, target, 'text/plain')).status).toBe(200);
    });

    it('a path outside the prefix passes', async () => {
      expect((await send('POST', '/probe', 'text/plain')).status).toBe(200);
    });

    if (exemptPaths.length) {
      it.each(exemptPaths)('the exempt path %s passes', async (path) => {
        expect((await send('POST', path, 'text/plain')).status).toBe(200);
      });
    }
  });
}

/**
 * The body-size matrix (ADR-0008), run against the app's own `bodySizeLimit` middleware: `maxBytes` passes and
 * one more byte gets 413, a malformed `Content-Length` gets 400, a chunked body with no length gets 411, and
 * safe methods, other paths and `exemptPaths` pass.
 *
 * `exemptPaths` are concrete request paths the suite sends, not patterns: each must be matched by one of the
 * regexes the app passed to the middleware's `exempt`.
 */
export function describeBodySize(
  handler: EventHandler,
  options: { maxBytes: number; prefix?: string; exemptPaths?: string[] },
) {
  const { maxBytes, prefix = '/api/', exemptPaths = [] } = options;
  const target = `${prefix}probe`;

  describe(`bodySizeLimit contract (${String(maxBytes)} bytes, prefix ${prefix})`, () => {
    let app: H3TestApp;
    let calls: { count: number };
    beforeEach(() => {
      const probe = probeRoutes([target, '/probe', ...exemptPaths]);
      calls = probe.calls;
      app = h3TestApp({ middleware: [handler], routes: probe.routes });
    });

    const declared = (method: string, path: string, length: string) =>
      app.fetch(path, { method, headers: { 'content-type': 'application/json', 'content-length': length } });

    it.each(UNSAFE)('%s at exactly maxBytes passes', async (method) => {
      const res = await app.fetch(target, {
        method,
        headers: { 'content-type': 'application/json', 'content-length': String(maxBytes) },
        body: new Uint8Array(maxBytes),
      });
      expect(res.status).toBe(200);
    });

    it.each(UNSAFE)('%s at maxBytes + 1 gets 413 before the route runs', async (method) => {
      const res = await declared(method, target, String(maxBytes + 1));
      expect(res.status).toBe(413);
      expect(await errorBody(res)).toMatchObject({ statusCode: 413, message: 'The request is too large.' });
      expect(calls.count).toBe(0);
    });

    it.each(['abc', '-1', '1.5', ''])('Content-Length %j gets 400', async (length) => {
      const res = await declared('POST', target, length);
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toMatchObject({
        statusCode: 400,
        message: 'The Content-Length header is not a valid length.',
      });
    });

    it('a chunked body with no Content-Length gets 411 before the route runs', async () => {
      const chunk = new Uint8Array(Math.min(maxBytes + 1, 65_536));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const res = await app.fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        body,
        duplex: 'half',
      });
      expect(res.status).toBe(411);
      expect(await errorBody(res)).toMatchObject({
        statusCode: 411,
        message: 'Send the request with a Content-Length header.',
      });
      expect(calls.count).toBe(0);
    });

    it('a request with no body passes', async () => {
      expect((await app.fetch(target, { method: 'POST' })).status).toBe(200);
    });

    it.each(SAFE)('%s with a huge Content-Length passes', async (method) => {
      expect((await app.fetch(target, { method, headers: { 'content-length': '99999999999' } })).status).toBe(
        200,
      );
    });

    it.each(['/probe', ...exemptPaths])('%s passes over maxBytes', async (path) => {
      expect((await declared('POST', path, String(maxBytes + 1))).status).toBe(200);
    });
  });
}

/**
 * The security-headers matrix (ADR-0008), run against the app's own plugin and error handler: every header is
 * present, with the app's CSP, on HTML, JSON, 404, 400 and 500 responses; HSTS and `upgrade-insecure-requests`
 * appear only on an HTTPS site; and every base CSP directive and source survives. `errorHandler` defaults to
 * the kit's `jsonErrorHandler()`.
 */
export function describeSecurityHeaders(
  plugin: NitroAppPlugin,
  options: {
    httpsSite: boolean;
    extraCsp?: Readonly<Record<string, readonly string[]>>;
    errorHandler?: JsonErrorHandler;
  },
) {
  const { httpsSite, extraCsp, errorHandler = jsonErrorHandler() } = options;
  const expected = securityHeaders({
    httpsSite,
    csp: contentSecurityPolicy({ httpsSite, ...(extraCsp ? { extra: extraCsp } : {}) }),
  });
  const base = contentSecurityPolicy({ httpsSite });

  const routes = {
    '/html': defineEventHandler(() => '<!doctype html><title>probe</title>'),
    '/json': defineEventHandler(() => ({ ok: true })),
    '/throws-400': defineEventHandler(() => {
      throw createError({ statusCode: 400, message: 'Bad probe' });
    }),
    '/throws-500': defineEventHandler(() => {
      throw new Error('probe failure');
    }),
  };
  const cases = [
    ['an HTML 200', '/html', 200],
    ['a JSON 200', '/json', 200],
    ['an unknown path’s 404', '/no-such-path', 404],
    ['a thrown 400', '/throws-400', 400],
    ['a thrown 500', '/throws-500', 500],
  ] as const;

  describe(`security headers contract (${httpsSite ? 'https' : 'http'} site)`, () => {
    let app: H3TestApp;
    beforeEach(() => {
      app = h3TestApp({ plugins: [plugin], routes, errorHandler });
    });

    it.each(cases)('%s carries every security header with the app’s values', async (_, path, status) => {
      const res = await app.fetch(path);
      expect(res.status).toBe(status);
      for (const [name, value] of Object.entries(expected)) expect(res.headers.get(name), name).toBe(value);
    });

    it.each(cases)('%s has HSTS and upgrade-insecure-requests only on an HTTPS site', async (_, path) => {
      const res = await app.fetch(path);
      expect(res.headers.has('strict-transport-security')).toBe(httpsSite);
      expect(res.headers.get('content-security-policy')?.includes('upgrade-insecure-requests')).toBe(
        httpsSite,
      );
    });

    it.each(cases)('%s keeps every base CSP directive and source', async (_, path) => {
      const csp = parseCsp((await app.fetch(path)).headers.get('content-security-policy') ?? '');
      for (const [directive, sources] of Object.entries(base)) {
        if (sources === false) continue;
        expect(csp.has(directive), directive).toBe(true);
        if (Array.isArray(sources)) expect(csp.get(directive)).toEqual(expect.arrayContaining(sources));
      }
    });
  });
}

function parseCsp(header: string): Map<string, string[]> {
  return new Map(
    header
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name ?? '', sources]),
  );
}
