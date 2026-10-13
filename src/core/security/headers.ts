/** CSP directive → sources; `upgrade-insecure-requests` is a flag. */
export type CspDirectives = Record<string, string[] | boolean>;

/**
 * True when `siteUrl` (`NUXT_PUBLIC_SITE_URL`) parses as an https URL. The same signal turns on HSTS,
 * `upgrade-insecure-requests` and the Secure session cookie: plain HTTP on the LAN must keep working.
 */
export function isHttpsSite(siteUrl: string | undefined): boolean {
  try {
    return new URL(siteUrl ?? '').protocol === 'https:';
  } catch {
    return false;
  }
}

/** Host sources (`https://cdn.example.com`, `*.example.com`) and scheme sources (`wss:`), nothing quoted. */
const PLAIN_SOURCE = /^[^'\s*][^'\s]*$|^\*\.[^'\s]+$/;

/**
 * The base Content-Security-Policy, as a new object on every call. Inline scripts are allowed only by the
 * per-response nonce that nuxt-security puts on the HTML shell's `<script>`s (`nonce: true`).
 *
 * `extra` is additive only: it appends host or scheme sources to base directives whose value isn't
 * `'none'`. It can never remove or weaken the base policy.
 *
 * @throws TypeError for an `extra` entry on a directive outside the base policy, a `'none'` directive or
 * `upgrade-insecure-requests`, or for a quoted source (`'unsafe-inline'`, a nonce, a hash) or `*`.
 */
export function contentSecurityPolicy(opts: {
  httpsSite: boolean;
  nonce?: boolean;
  extra?: Readonly<Record<string, readonly string[]>>;
}): CspDirectives {
  const csp: CspDirectives = {
    'default-src': ["'self'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': opts.nonce ? ["'self'", "'nonce-{{nonce}}'"] : ["'self'"],
    'script-src-attr': ["'none'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    // Over plain HTTP this would send the browser to https:// for every asset.
    'upgrade-insecure-requests': opts.httpsSite,
  };

  for (const [directive, sources] of Object.entries(opts.extra ?? {})) {
    const base = csp[directive];
    for (const source of sources) {
      if (!Array.isArray(base) || base.includes("'none'") || !PLAIN_SOURCE.test(source)) {
        throw new TypeError(
          `CSP extra "${source}" can't be added to ${directive}: only host or scheme sources may be added, ` +
            "and only to a base directive that isn't 'none'.",
        );
      }
      if (!base.includes(source)) base.push(source);
    }
  }
  return csp;
}

/** HSTS is host-wide (every port), so only an HTTPS site gets it: 180 days, no subdomains, no preload. */
const HSTS = 'max-age=15552000';

const PERMISSIONS_POLICY = 'camera=(), display-capture=(), fullscreen=(), geolocation=(), microphone=()';

/**
 * Every security header the app sends on every response, by name, as a new object. `csp` defaults to
 * {@link contentSecurityPolicy}'s base policy; pass the app's own when it has `extra` sources.
 */
export function securityHeaders(opts: { httpsSite: boolean; csp?: CspDirectives }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': serializeCsp(opts.csp ?? contentSecurityPolicy({ httpsSite: opts.httpsSite })),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'X-DNS-Prefetch-Control': 'off',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-XSS-Protection': '0',
    'Permissions-Policy': PERMISSIONS_POLICY,
  };
  if (opts.httpsSite) headers['Strict-Transport-Security'] = HSTS;
  return headers;
}

function serializeCsp(csp: CspDirectives): string {
  return Object.entries(csp)
    .flatMap(([directive, value]) => {
      if (value === false) return [];
      return [value === true ? directive : `${directive} ${value.join(' ')}`];
    })
    .join('; ');
}
