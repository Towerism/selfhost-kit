import type { H3Error, H3Event } from 'h3';

/**
 * The part of Nitro's `NitroApp` the kit's plugins use. Nitro's own `NitroApp` satisfies it, so a kit plugin
 * goes straight into `defineNitroPlugin(...)`. Declared here because `/nitro` never imports `nitropack`
 * (ADR-0006).
 */
export interface NitroAppLike {
  hooks: { hook(name: string, fn: (...args: never[]) => unknown): unknown };
}

/** A Nitro plugin: `export default defineNitroPlugin(kitPlugin)` in `server/plugins/`. */
export type NitroAppPlugin = (nitroApp: NitroAppLike) => void;

/** What Nitro's built-in `defaultHandler` returns for an error: its status, headers and body. */
export interface DefaultErrorResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Nitro's built-in error renderer, which Nitro passes to every error handler as `{ defaultHandler }`. */
export type DefaultErrorHandler = (
  error: H3Error,
  event: H3Event,
  opts?: { silent?: boolean; json?: boolean },
) => DefaultErrorResponse | Promise<DefaultErrorResponse>;

/** A Nitro error handler: `export default defineNitroErrorHandler(jsonErrorHandler())` in `server/error.ts`. */
export type JsonErrorHandler = (
  error: H3Error,
  event: H3Event,
  ctx: { defaultHandler: DefaultErrorHandler },
) => Promise<void>;
