import { defineEventHandler } from 'h3';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../src/core/security/headers.js';
import { jsonErrorHandler } from '../../src/nitro/error.js';
import { securityHeadersPlugin } from '../../src/nitro/plugins.js';
import { h3TestApp } from '../../src/testing/h3-app.js';
import { describeSecurityHeaders } from '../../src/testing/middleware.js';

describe.each([
  ['a plain-HTTP LAN install', 'http://192.0.2.10:3000', false],
  ['an HTTPS site', 'https://example.com', true],
  ['no site URL', undefined, false],
  ['a site URL that does not parse', 'not a url', false],
] as const)('security headers for %s', (_, siteUrl, httpsSite) => {
  describeSecurityHeaders(securityHeadersPlugin({ siteUrl }), {
    httpsSite,
    errorHandler: jsonErrorHandler(),
  });
});

describe('extra CSP sources', () => {
  const extraCsp = { 'img-src': ['https://cdn.example.com'] };

  describeSecurityHeaders(securityHeadersPlugin({ siteUrl: 'https://example.com', extraCsp }), {
    httpsSite: true,
    extraCsp,
  });

  it('appends the extra source after the base ones, in the header and in the nuxt-security CSP', async () => {
    const app = h3TestApp({
      plugins: [securityHeadersPlugin({ siteUrl: 'https://example.com', extraCsp })],
      routes: { '/': defineEventHandler(() => 'ok') },
    });
    const header = (await app.fetch('/')).headers.get('content-security-policy');
    expect(header).toContain("img-src 'self' data: blob: https://cdn.example.com;");

    const rules: Record<string, { headers?: Record<string, unknown> }> = {};
    await app.callHook('nuxt-security:routeRules', rules);
    expect((rules['/**']?.headers?.contentSecurityPolicy as Record<string, string[]>)['img-src']).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://cdn.example.com',
    ]);
  });

  it.each([
    { 'script-src': ["'unsafe-inline'"] },
    { 'object-src': ['https://x.example.com'] },
    { 'img-src': ['*'] },
  ])('refuses %j when the plugin is built', (extra) => {
    expect(() => securityHeadersPlugin({ siteUrl: 'https://example.com', extraCsp: extra })).toThrow(
      TypeError,
    );
  });
});

describe('the nuxt-security hook', () => {
  const run = async (siteUrl: string, rules: Record<string, { headers?: Record<string, unknown> }>) => {
    const app = h3TestApp({ plugins: [securityHeadersPlugin({ siteUrl })] });
    await app.callHook('nuxt-security:routeRules', rules);
    return rules;
  };

  it('gives an HTTPS site the nonce CSP and HSTS, keeping what was there', async () => {
    const rules = await run('https://example.com', {
      '/**': { headers: { xFrameOptions: 'DENY' } },
      '/api/**': {},
    });
    expect(rules).toEqual({
      '/**': {
        headers: {
          xFrameOptions: 'DENY',
          contentSecurityPolicy: contentSecurityPolicy({ httpsSite: true, nonce: true }),
          strictTransportSecurity: { maxAge: 15_552_000, includeSubdomains: false, preload: false },
        },
      },
      '/api/**': {},
    });
  });

  it('gives a plain-HTTP site no HSTS, and creates the rule when it is missing', async () => {
    const rules = await run('http://192.0.2.10:3000', {});
    expect(rules).toEqual({
      '/**': {
        headers: {
          contentSecurityPolicy: contentSecurityPolicy({ httpsSite: false, nonce: true }),
          strictTransportSecurity: false,
        },
      },
    });
  });

  it('is not registered with nuxtSecurity: false', async () => {
    const rules = {};
    const app = h3TestApp({
      plugins: [securityHeadersPlugin({ siteUrl: 'https://example.com', nuxtSecurity: false })],
    });
    await app.callHook('nuxt-security:routeRules', rules);
    expect(rules).toEqual({});
  });
});
