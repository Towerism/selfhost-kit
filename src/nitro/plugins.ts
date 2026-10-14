import { type H3Error, type H3Event, setResponseHeader, setResponseHeaders } from 'h3';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logging/logger.js';
import { acceptRequestId } from '../core/logging/request-id.js';
import { contentSecurityPolicy, isHttpsSite, securityHeaders } from '../core/security/headers.js';
import type { NitroAppPlugin } from './types.js';

export interface SecurityHeadersPluginOptions {
  /** `NUXT_PUBLIC_SITE_URL`. Only an https URL turns on HSTS and `upgrade-insecure-requests`. */
  siteUrl?: string | undefined;
  /** CSP sources added to base directives; additive only (see the core's `contentSecurityPolicy`). */
  extraCsp?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Feed the same CSP and HSTS to nuxt-security's route rules for the HTML shell (default `true`). */
  nuxtSecurity?: boolean;
}

type RouteRules = Record<string, { headers?: Record<string, unknown> } | undefined>;

/** 180 days, no subdomains, no preload: what `securityHeaders` sends as `Strict-Transport-Security`. */
const HSTS = { maxAge: 15_552_000, includeSubdomains: false, preload: false };

/**
 * Security headers on every response, errors and API calls included. With nuxt-security, its route rules for
 * `/**` get the same CSP (with the per-response nonce) and HSTS, because nuxt-security re-sends them on the
 * HTML shell. Everything is computed once, when the plugin is built.
 *
 * App wiring, in `server/plugins/security-headers.ts`:
 * `export default defineNitroPlugin(securityHeadersPlugin({ siteUrl: useRuntimeConfig().public.siteUrl }))`.
 *
 * @throws TypeError for an `extraCsp` entry that would weaken the base policy.
 */
export function securityHeadersPlugin(options: SecurityHeadersPluginOptions = {}): NitroAppPlugin {
  const { siteUrl, extraCsp, nuxtSecurity = true } = options;
  const httpsSite = isHttpsSite(siteUrl);
  const extra = extraCsp ? { extra: extraCsp } : {};
  const headers = securityHeaders({ httpsSite, csp: contentSecurityPolicy({ httpsSite, ...extra }) });
  const htmlCsp = contentSecurityPolicy({ httpsSite, nonce: true, ...extra });

  return (nitroApp) => {
    if (nuxtSecurity) {
      nitroApp.hooks.hook('nuxt-security:routeRules', (rules: RouteRules) => {
        const all = (rules['/**'] ??= {});
        all.headers = {
          ...all.headers,
          contentSecurityPolicy: structuredClone(htmlCsp),
          strictTransportSecurity: httpsSite ? { ...HSTS } : false,
        };
      });
    }
    nitroApp.hooks.hook('request', (event: H3Event) => {
      setResponseHeaders(event, headers);
    });
  };
}

export interface RequestLogPluginOptions {
  /** The app's root logger; request lines go to its `http` child, request-less errors to its `app` child. */
  logger: Logger;
  /** Paths logged at `debug` instead of `info` (default `/healthz` and `/readyz`). */
  quietPaths?: readonly string[];
  /** Times each request (default: `performance.now()`, which never goes backwards). */
  clock?: Clock;
}

const monotonicClock: Clock = { now: () => performance.now() };

/**
 * Request ids and the request log. Every request gets an id (a well-formed `X-Request-Id`, or a new UUID),
 * stored as `event.context.reqId` and returned as `x-request-id`. Each request logs one line when its response
 * closes: `{METHOD} {path} {status} {ms}ms`, with 499 for a client that went away first. Errors are logged at
 * `warn` below 500 and at `error` (with the error) otherwise. Bodies, query strings and headers are never logged.
 *
 * App wiring, in `server/plugins/logging.ts`: `export default defineNitroPlugin(requestLogPlugin({ logger }))`.
 */
export function requestLogPlugin(options: RequestLogPluginOptions): NitroAppPlugin {
  const { logger, quietPaths = ['/healthz', '/readyz'], clock = monotonicClock } = options;
  const http = logger.child('http');
  const app = logger.child('app');
  const quiet = new Set(quietPaths);

  return (nitroApp) => {
    nitroApp.hooks.hook('request', (event: H3Event) => {
      const reqId = acceptRequestId(event.node.req.headers['x-request-id']);
      event.context.reqId = reqId;
      setResponseHeader(event, 'x-request-id', reqId);

      const started = clock.now();
      const res = event.node.res;
      res.once('close', () => {
        const aborted = !res.writableFinished;
        const status = aborted && !res.headersSent ? 499 : res.statusCode;
        const durationMs = Math.round(clock.now() - started);
        const path = pathOf(event.path);
        // `close` can fire outside the request's async context, so the id is passed explicitly.
        const fields = {
          method: event.method,
          path,
          status,
          durationMs,
          reqId,
          ...(aborted ? { aborted: true } : {}),
        };
        const message = `${event.method} ${path} ${String(status)} ${String(durationMs)}ms`;
        if (quiet.has(path)) http.debug(message, fields);
        else http.info(message, fields);
      });
    });

    nitroApp.hooks.hook('error', (error: Error, context: { event?: H3Event }) => {
      const { event } = context;
      if (!event) {
        app.error(`Unhandled error: ${error.message}`, { err: error });
        return;
      }
      const statusCode = (error as Partial<H3Error>).statusCode;
      const path = pathOf(event.path);
      const fields = {
        path,
        reqId: event.context.reqId as string | undefined,
        ...(statusCode ? { statusCode } : {}),
      };
      if (statusCode && statusCode < 500)
        http.warn(`${String(statusCode)} on ${path}: ${error.message}`, fields);
      else http.error(`${String(statusCode || 500)} on ${path}: ${error.message}`, { ...fields, err: error });
    });
  };
}

function pathOf(path: string): string {
  return path.split('?')[0] ?? path;
}
