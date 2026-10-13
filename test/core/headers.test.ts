import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isHttpsSite, securityHeaders } from '../../src/core/security/headers.js';

const BASE_CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";

describe('isHttpsSite', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['http://tower:3000', false],
    ['https://ppa.example.com', true],
    ['HTTPS://PPA.EXAMPLE.COM', true],
    ['https//broken', false],
    ['not a url', false],
    ['https:', false],
    ['https://', false],
  ])('%j → %s', (siteUrl, expected) => {
    expect(isHttpsSite(siteUrl)).toBe(expected);
  });
});

describe('contentSecurityPolicy', () => {
  it('locks scripts to same-origin with no inline or eval escape hatch', () => {
    const csp = contentSecurityPolicy({ httpsSite: false });
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['upgrade-insecure-requests']).toBe(false);
  });

  it('adds the nonce placeholder when asked, for the HTML shell', () => {
    expect(contentSecurityPolicy({ httpsSite: false, nonce: true })['script-src']).toEqual([
      "'self'",
      "'nonce-{{nonce}}'",
    ]);
  });

  it('upgrades insecure requests only on an HTTPS site', () => {
    expect(contentSecurityPolicy({ httpsSite: true })['upgrade-insecure-requests']).toBe(true);
  });

  it('returns a new policy each time, so changing one result cannot change the next', () => {
    const first = contentSecurityPolicy({ httpsSite: false });
    (first['img-src'] as string[]).push('https://evil.example.com');
    first['frame-ancestors'] = ['*'];
    expect(contentSecurityPolicy({ httpsSite: false })['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(contentSecurityPolicy({ httpsSite: false })['frame-ancestors']).toEqual(["'none'"]);
  });

  describe('extra sources are additive only', () => {
    it('appends host and scheme sources after the base ones, once each', () => {
      const csp = contentSecurityPolicy({
        httpsSite: false,
        extra: {
          'img-src': ['https://cdn.example.com', 'https://cdn.example.com', 'blob:'],
          'connect-src': ['wss:'],
        },
      });
      expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://cdn.example.com']);
      expect(csp['connect-src']).toEqual(["'self'", 'wss:']);
      expect(csp['script-src']).toEqual(["'self'"]);
    });

    it.each([
      ['a quoted keyword', 'script-src', "'unsafe-inline'"],
      ['unsafe-eval', 'script-src', "'unsafe-eval'"],
      ['a nonce', 'script-src', "'nonce-abc'"],
      ['a hash', 'style-src', "'sha256-abc'"],
      ["'self', even though it is already there", 'img-src', "'self'"],
      ['a wildcard', 'connect-src', '*'],
      ["a 'none' directive", 'object-src', 'https://cdn.example.com'],
      ["another 'none' directive", 'frame-ancestors', 'https://parent.example.com'],
      ['the upgrade flag', 'upgrade-insecure-requests', 'https://x.example.com'],
      ['a directive outside the base policy', 'frame-src', 'https://x.example.com'],
    ])('refuses %s, naming the directive and the source', (_label, directive, source) => {
      expect(() => contentSecurityPolicy({ httpsSite: false, extra: { [directive]: [source] } })).toThrow(
        TypeError,
      );
      expect(() => contentSecurityPolicy({ httpsSite: false, extra: { [directive]: [source] } })).toThrow(
        directive,
      );
      expect(() => contentSecurityPolicy({ httpsSite: false, extra: { [directive]: [source] } })).toThrow(
        source,
      );
    });
  });
});

describe('securityHeaders', () => {
  it('serializes the CSP and the fixed headers, with no HSTS over plain HTTP', () => {
    const headers = securityHeaders({ httpsSite: false });
    expect(headers).toEqual({
      'Content-Security-Policy': BASE_CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Origin-Agent-Cluster': '?1',
      'X-DNS-Prefetch-Control': 'off',
      'X-Permitted-Cross-Domain-Policies': 'none',
      'X-XSS-Protection': '0',
      'Permissions-Policy': 'camera=(), display-capture=(), fullscreen=(), geolocation=(), microphone=()',
    });
  });

  it('adds HSTS (180 days, no subdomains, no preload) and the upgrade on an HTTPS site', () => {
    const headers = securityHeaders({ httpsSite: true });
    expect(headers['Strict-Transport-Security']).toBe('max-age=15552000');
    expect(headers['Content-Security-Policy']).toBe(`${BASE_CSP}; upgrade-insecure-requests`);
  });

  it("serializes the app's own CSP when given one", () => {
    const csp = contentSecurityPolicy({
      httpsSite: false,
      extra: { 'img-src': ['https://cdn.example.com'] },
    });
    expect(securityHeaders({ httpsSite: false, csp })['Content-Security-Policy']).toContain(
      "img-src 'self' data: blob: https://cdn.example.com;",
    );
  });

  it('returns a new object each time', () => {
    const first = securityHeaders({ httpsSite: false });
    first['X-Frame-Options'] = 'ALLOWALL';
    expect(securityHeaders({ httpsSite: false })['X-Frame-Options']).toBe('DENY');
  });
});
