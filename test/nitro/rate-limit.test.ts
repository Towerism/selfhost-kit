import { defineEventHandler } from 'h3';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseTrustedProxies } from '../../src/core/security/client-address.js';
import { securityHeaders } from '../../src/core/security/headers.js';
import { createFixedWindowLimiter } from '../../src/core/security/rate-limit.js';
import { jsonErrorHandler } from '../../src/nitro/error.js';
import { securityHeadersPlugin } from '../../src/nitro/plugins.js';
import { enforceRateLimit } from '../../src/nitro/rate-limit.js';
import { fakeClock, type FakeClock } from '../../src/testing/clock.js';
import { type H3TestApp, h3TestApp } from '../../src/testing/h3-app.js';

const WINDOW_MS = 15 * 60_000;

let clock: FakeClock;
let app: H3TestApp;

function build(trustedProxies = '') {
  clock = fakeClock(1_000_000);
  const limiter = createFixedWindowLimiter({ max: 2, windowMs: WINDOW_MS, clock });
  const trusted = parseTrustedProxies(trustedProxies);
  app = h3TestApp({
    plugins: [securityHeadersPlugin({ siteUrl: 'https://example.com' })],
    routes: {
      '/api/auth/login': defineEventHandler((event) => {
        enforceRateLimit(event, { limiter, trusted });
        return { ok: true };
      }),
    },
    errorHandler: jsonErrorHandler(),
  });
}

const login = (clientAddress: string, forwardedFor?: string) =>
  app.fetch('/api/auth/login', {
    method: 'POST',
    clientAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });

async function statuses(n: number, send: () => Promise<Response>) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
}

describe('enforceRateLimit over HTTP', () => {
  beforeEach(() => {
    build();
  });

  it('allows max requests, then answers 429 with Retry-After, and resets after the window', async () => {
    const first = await login('198.51.100.7');
    expect(first.status).toBe(200);
    expect(first.headers.has('retry-after')).toBe(false);
    expect((await login('198.51.100.7')).status).toBe(200);

    const refused = await login('198.51.100.7');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('900');
    expect(await refused.json()).toMatchObject({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: 'Too many attempts. Try again in 15 minutes.',
      data: { code: 'rate_limited', retryAfterSeconds: 900 },
    });
    for (const [name, value] of Object.entries(securityHeaders({ httpsSite: true }))) {
      expect(refused.headers.get(name), name).toBe(value);
    }

    clock.advance(WINDOW_MS);
    expect((await login('198.51.100.7')).status).toBe(200);
  });

  it('does not count refused requests', async () => {
    expect(await statuses(5, () => login('198.51.100.7'))).toEqual([200, 200, 429, 429, 429]);
    clock.advance(WINDOW_MS);
    expect(await statuses(3, () => login('198.51.100.7'))).toEqual([200, 200, 429]);
  });

  it('says "1 minute" when less than a minute is left', async () => {
    await statuses(2, () => login('198.51.100.7'));
    clock.advance(WINDOW_MS - 30_000);
    const res = await login('198.51.100.7');
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toMatchObject({ message: 'Too many attempts. Try again in 1 minute.' });
  });
});

describe('the rate-limit key', () => {
  it('ignores X-Forwarded-For from an untrusted peer', async () => {
    build();
    let n = 0;
    const sent = await statuses(3, () => login('198.51.100.7', `203.0.113.${String(++n)}`));
    expect(sent).toEqual([200, 200, 429]);
    expect((await login('198.51.100.8')).status).toBe(200);
  });

  it('uses the rightmost untrusted entry behind a trusted proxy', async () => {
    build();
    const viaProxy = () => login('172.17.0.1', '198.51.100.99, 203.0.113.5, 172.17.0.3');
    expect(await statuses(3, viaProxy)).toEqual([200, 200, 429]);
    // Another client behind the same proxy has its own window.
    expect((await login('172.17.0.1', '203.0.113.6')).status).toBe(200);
  });

  it('falls back to the peer for a malformed entry', async () => {
    build();
    expect(await statuses(2, () => login('172.17.0.1', 'not-an-ip'))).toEqual([200, 200]);
    expect((await login('172.17.0.1')).status).toBe(429);
  });

  it('shares a window between an address and its IPv4-mapped IPv6 form', async () => {
    build();
    await statuses(2, () => login('198.51.100.7'));
    expect((await login('::ffff:198.51.100.7')).status).toBe(429);
  });

  it('trusts no proxy with "none"', async () => {
    build('none');
    expect(await statuses(3, () => login('172.17.0.1', '203.0.113.5'))).toEqual([200, 200, 429]);
    expect((await login('172.17.0.1', '203.0.113.6')).status).toBe(429);
  });

  it('puts requests with no known peer into one shared window, whatever X-Forwarded-For says', async () => {
    build();
    let n = 0;
    const anonymous = () =>
      app.fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': `203.0.113.${String(++n)}` },
      });
    expect(await statuses(3, anonymous)).toEqual([200, 200, 429]);
  });
});
