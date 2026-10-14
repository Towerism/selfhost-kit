import { createError, defineEventHandler } from 'h3';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../../src/core/security/headers.js';
import { jsonErrorHandler } from '../../src/nitro/error.js';
import { securityHeadersPlugin } from '../../src/nitro/plugins.js';
import type { JsonErrorHandler } from '../../src/nitro/types.js';
import { h3TestApp } from '../../src/testing/h3-app.js';

const NITRO_CSP = "script-src 'none'; frame-ancestors 'none';";
const appCsp = securityHeaders({ httpsSite: false })['Content-Security-Policy'];

const app = (errorHandler?: JsonErrorHandler) =>
  h3TestApp({
    plugins: [securityHeadersPlugin({ siteUrl: 'http://192.0.2.10:3000' })],
    routes: {
      '/api/thing': defineEventHandler(() => {
        throw createError({ statusCode: 422, message: 'Bad thing', data: { field: 'x' } });
      }),
      '/api/boom': defineEventHandler(() => {
        throw new Error('boom');
      }),
    },
    ...(errorHandler ? { errorHandler } : {}),
  });

describe('jsonErrorHandler', () => {
  it('keeps the app’s CSP and renders Nitro’s JSON error body', async () => {
    const res = await app(jsonErrorHandler()).fetch('/api/thing?q=1');
    expect(res.status).toBe(422);
    expect(res.headers.get('content-security-policy')).toBe(appCsp);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const text = await res.text();
    expect(text).toBe(
      JSON.stringify(
        {
          error: true,
          url: 'http://localhost/api/thing?q=1',
          statusCode: 422,
          statusMessage: 'Server Error',
          message: 'Bad thing',
          data: { field: 'x' },
        },
        null,
        2,
      ),
    );
  });

  it('is what keeps the CSP: Nitro’s own handler replaces it', async () => {
    const res = await app().fetch('/api/thing');
    expect(res.status).toBe(422);
    expect(res.headers.get('content-security-policy')).toBe(NITRO_CSP);
  });

  it('hides an unhandled error’s message and data', async () => {
    const res = await app(jsonErrorHandler()).fetch('/api/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-security-policy')).toBe(appCsp);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ statusCode: 500, message: 'Server Error' });
    expect(body).not.toHaveProperty('data');
  });

  it('sends a string body from the default handler as a JSON string', async () => {
    const handler = jsonErrorHandler();
    const redirecting = h3TestApp({
      routes: { '/x': defineEventHandler(() => Promise.reject(createError({ statusCode: 404 }))) },
      errorHandler: (error, event) =>
        handler(error, event, {
          defaultHandler: () => ({
            status: 302,
            statusText: 'Found',
            headers: { location: '/app/x' },
            body: 'Redirecting...',
          }),
        }),
    });
    const res = await redirecting.fetch('/x', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/x');
    expect(await res.text()).toBe('"Redirecting..."');
  });
});
