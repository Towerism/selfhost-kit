import {
  type EventHandler,
  type H3Error,
  type H3Event,
  createApp,
  createRouter,
  getRequestURL,
  getResponseHeader,
  send,
  setResponseHeaders,
  setResponseStatus,
  toWebHandler,
} from 'h3';
import type { DefaultErrorHandler, JsonErrorHandler, NitroAppLike, NitroAppPlugin } from '../nitro/types.js';

export interface H3TestAppOptions {
  /** Run on every request, in order, before the routes (an app's `server/middleware/*`). */
  middleware?: EventHandler[];
  /** Exact path → handler, for any method. Anything else is a 404. */
  routes?: Record<string, EventHandler>;
  /** Nitro plugins, run once when the app is built. */
  plugins?: NitroAppPlugin[];
  /** The app's error handler. Without one, or when it doesn't handle the error, Nitro's own handler answers. */
  errorHandler?: JsonErrorHandler;
}

export interface H3TestApp {
  /** Sends a request through the app in memory. `clientAddress` becomes the request's TCP peer. */
  fetch(path: string, init?: RequestInit & { clientAddress?: string }): Promise<Response>;
  /** Calls every hook the plugins registered under `name`, in order. */
  callHook(name: string, ...args: unknown[]): Promise<void>;
}

type Hook = (...args: never[]) => unknown;

/**
 * An in-memory h3 app wired the way Nitro 2.13's `createNitroApp` wires its h3 app: plugins register hooks; the
 * `request` hook runs before the middleware and its errors are swallowed; an error calls the `error` hook
 * without awaiting it, then the app's error handler with `{ defaultHandler }`, then Nitro's own handler. No
 * port is opened. Each call builds a fresh app, so nothing is shared between tests.
 */
export function h3TestApp(options: H3TestAppOptions = {}): H3TestApp {
  const hooks = new Map<string, Hook[]>();
  const nitroApp: NitroAppLike = {
    hooks: {
      hook(name: string, fn: Hook) {
        hooks.set(name, [...(hooks.get(name) ?? []), fn]);
      },
    },
  };
  const callHook = async (name: string, ...args: unknown[]) => {
    for (const fn of hooks.get(name) ?? []) await (fn as (...a: unknown[]) => unknown)(...args);
  };
  const captureError = (error: unknown, context: { event?: H3Event; tags: string[] }) => {
    // Nitro's `callHookParallel`: every hook starts now, and nobody waits for them.
    void Promise.all(
      (hooks.get('error') ?? []).map((fn) => (fn as (...a: unknown[]) => unknown)(error, context)),
    ).catch(() => undefined);
  };

  for (const plugin of options.plugins ?? []) plugin(nitroApp);

  const handlers: JsonErrorHandler[] = [
    ...(options.errorHandler ? [options.errorHandler] : []),
    nitroErrorHandler,
  ];
  const app = createApp({
    onRequest: async (event) => {
      await callHook('request', event).catch((error: unknown) => {
        captureError(error, { event, tags: ['request'] });
      });
    },
    onError: async (error, event) => {
      captureError(error, { event, tags: ['request'] });
      for (const handler of handlers) {
        try {
          await handler(error, event, { defaultHandler: nitroDefaultHandler });
          if (event.handled) return;
        } catch {
          // Nitro logs a throwing error handler and tries the next one.
        }
      }
    },
  });
  for (const handler of options.middleware ?? []) app.use(handler);
  const router = createRouter();
  for (const [path, handler] of Object.entries(options.routes ?? {})) router.use(path, handler);
  app.use(router);

  const web = toWebHandler(app);
  return {
    fetch(path, init = {}) {
      const { clientAddress, ...requestInit } = init;
      const request = new Request(new URL(path, 'http://localhost'), requestInit);
      return web(request, clientAddress === undefined ? {} : { clientAddress });
    },
    callHook,
  };
}

/** Nitro 2.13's production error handler (`runtime/internal/error/prod.mjs`). */
const nitroErrorHandler: JsonErrorHandler = async (error, event) => {
  const res = nitroDefaultHandler(error, event);
  setResponseHeaders(event, res.headers);
  setResponseStatus(event, res.status, res.statusText);
  await send(event, JSON.stringify(res.body, null, 2));
};

/**
 * Nitro 2.13's `defaultHandler` (`runtime/internal/error/utils.mjs`), without the `baseURL` redirect and the
 * console line. Its own CSP is what an app's JSON error handler has to drop.
 */
const nitroDefaultHandler = ((error: H3Error, event: H3Event) => {
  const isSensitive = error.unhandled || error.fatal;
  const statusCode = error.statusCode || 500;
  const statusMessage = error.statusMessage || 'Server Error';
  const url = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "script-src 'none'; frame-ancestors 'none';",
  };
  setResponseStatus(event, statusCode, statusMessage);
  if (statusCode === 404 || !getResponseHeader(event, 'cache-control')) headers['cache-control'] = 'no-cache';
  return {
    status: statusCode,
    statusText: statusMessage,
    headers,
    body: {
      error: true,
      url: url.href,
      statusCode,
      statusMessage,
      message: isSensitive ? 'Server Error' : error.message,
      data: isSensitive ? undefined : error.data,
    },
  };
}) satisfies DefaultErrorHandler;
