import { defineEventHandler } from 'h3';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../../src/core/security/headers.js';
import { jsonErrorHandler } from '../../src/nitro/error.js';
import { bodySizeLimit, jsonOnly } from '../../src/nitro/middleware.js';
import { securityHeadersPlugin } from '../../src/nitro/plugins.js';
import { h3TestApp } from '../../src/testing/h3-app.js';
import { describeBodySize, describeJsonOnly } from '../../src/testing/middleware.js';

const ok = defineEventHandler(() => ({ ok: true }));

describe('jsonOnly with its defaults', () => {
  describeJsonOnly(jsonOnly());
});

describe('jsonOnly with a prefix and an exempt path', () => {
  describeJsonOnly(jsonOnly({ prefix: '/rpc/', exempt: [/^\/rpc\/upload(?:\?|$)/] }), {
    prefix: '/rpc/',
    exemptPaths: ['/rpc/upload', '/rpc/upload?x=1'],
  });
});

describe('jsonOnly edge cases', () => {
  const app = () =>
    h3TestApp({
      middleware: [jsonOnly({ exempt: [/^\/api\/up\?/] })],
      routes: { '/api/x': ok, '/apix/thing': ok, '/api': ok, '/api/up': ok },
    });
  const post = (path: string, type: string) =>
    app().fetch(path, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array([1]) });

  it.each(['; charset=utf-8', 'text/html, application/json'])('refuses the Content-Type %j', async (type) => {
    expect((await post('/api/x', type)).status).toBe(415);
  });

  it('lets application/json;x through, since json is followed by a word boundary', async () => {
    expect((await post('/api/x', 'application/json;x')).status).toBe(200);
  });

  it.each(['/apix/thing', '/api'])('leaves %s alone, since it is not under /api/', async (path) => {
    expect((await post(path, 'text/plain')).status).toBe(200);
  });

  it('matches exempt patterns against the query string too', async () => {
    expect((await post('/api/up?a=1', 'text/plain')).status).toBe(200);
    expect((await post('/api/up', 'text/plain')).status).toBe(415);
  });
});

describe('bodySizeLimit with its defaults', () => {
  describeBodySize(bodySizeLimit({ maxBytes: 1024 }), { maxBytes: 1024 });
});

describe('bodySizeLimit with an exempt path', () => {
  describeBodySize(bodySizeLimit({ maxBytes: 1024, exempt: [/^\/api\/big(?:\?|$)/] }), {
    maxBytes: 1024,
    exemptPaths: ['/api/big', '/api/big?part=2'],
  });
});

describe('bodySizeLimit edge cases', () => {
  const app = () => h3TestApp({ middleware: [bodySizeLimit({ maxBytes: 1024 })], routes: { '/api/x': ok } });
  const post = (headers: Record<string, string>) => app().fetch('/api/x', { method: 'POST', headers });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuses maxBytes %s', (maxBytes) => {
    expect(() => bodySizeLimit({ maxBytes })).toThrow(RangeError);
  });

  it.each(['1024 ', '0001024', '0'])('accepts the Content-Length %j', async (length) => {
    expect((await post({ 'content-length': length })).status).toBe(200);
  });

  it('refuses a length beyond the safe-integer range as too large', async () => {
    expect((await post({ 'content-length': '99999999999999999999' })).status).toBe(413);
  });

  it('refuses a duplicated Content-Length joined by a proxy', async () => {
    expect((await post({ 'content-length': '10, 10' })).status).toBe(400);
  });

  it('judges a request with both headers by its Content-Length', async () => {
    expect((await post({ 'content-length': '10', 'transfer-encoding': 'chunked' })).status).toBe(200);
    expect((await post({ 'content-length': '1025', 'transfer-encoding': 'chunked' })).status).toBe(413);
  });
});

describe('a refusal still carries the security headers', () => {
  const app = () =>
    h3TestApp({
      plugins: [securityHeadersPlugin({ siteUrl: 'https://example.com' })],
      middleware: [jsonOnly(), bodySizeLimit({ maxBytes: 1024 })],
      routes: { '/api/x': ok },
      errorHandler: jsonErrorHandler(),
    });
  const expected = securityHeaders({ httpsSite: true });

  it.each([
    ['413', { 'content-type': 'application/json', 'content-length': '2048' }, 413],
    ['411', { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, 411],
    ['400', { 'content-type': 'application/json', 'content-length': 'abc' }, 400],
    ['415', { 'content-type': 'text/plain' }, 415],
  ] as const)('on a %s', async (_, headers, status) => {
    const res = await app().fetch('/api/x', { method: 'POST', headers });
    expect(res.status).toBe(status);
    for (const [name, value] of Object.entries(expected)) expect(res.headers.get(name), name).toBe(value);
  });
});
