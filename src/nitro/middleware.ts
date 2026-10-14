import { type EventHandler, type H3Event, createError, defineEventHandler, getRequestHeader } from 'h3';

/** The methods whose request may carry a body that a handler reads. */
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_TYPE = /^application\/json\b/i;
const DIGITS = /^\d+$/;

export interface JsonOnlyOptions {
  /** Only paths starting with this are guarded (default `/api/`). */
  prefix?: string;
  /** Paths left alone, tested against `event.path` with its query string. */
  exempt?: readonly RegExp[];
}

export interface BodySizeLimitOptions {
  /** The largest `Content-Length` accepted, in bytes: a positive whole number. */
  maxBytes: number;
  /** Only paths starting with this are limited (default `/api/`). */
  prefix?: string;
  /** Paths left alone (for example a route with its own, larger limit), tested against `event.path`. */
  exempt?: readonly RegExp[];
}

function guarded(event: H3Event, prefix: string, exempt: readonly RegExp[]): boolean {
  return (
    WITH_BODY.has(event.method) && event.path.startsWith(prefix) && !exempt.some((re) => re.test(event.path))
  );
}

/**
 * CSRF guard: a POST, PUT, PATCH or DELETE under `prefix` that declares a body type must declare JSON, or it
 * gets 415 before any handler runs. Cross-site forms and no-cors fetches can only send form, multipart or text
 * bodies. A request with no `Content-Type` passes.
 *
 * App wiring, in `server/middleware/json-only.ts`: `export default jsonOnly()`.
 */
export function jsonOnly(options: JsonOnlyOptions = {}): EventHandler {
  const { prefix = '/api/', exempt = [] } = options;
  return defineEventHandler((event) => {
    if (!guarded(event, prefix, exempt)) return;
    const type = getRequestHeader(event, 'content-type');
    if (type && !JSON_TYPE.test(type)) {
      throw createError({ statusCode: 415, message: 'Send JSON (Content-Type: application/json)' });
    }
  });
}

/**
 * Request size limit for POST, PUT, PATCH and DELETE under `prefix`, judged by the headers before the body is
 * read: a `Content-Length` over `maxBytes` gets 413, one that isn't a whole number gets 400, and a body with
 * `Transfer-Encoding` but no `Content-Length` (whose size can't be known up front) gets 411.
 *
 * App wiring, in `server/middleware/body-size.ts`: `export default bodySizeLimit({ maxBytes: 2 * 1024 * 1024 })`.
 *
 * @throws RangeError when `maxBytes` isn't a positive whole number.
 */
export function bodySizeLimit(options: BodySizeLimitOptions): EventHandler {
  const { maxBytes, prefix = '/api/', exempt = [] } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('The body size limit must be a whole number of bytes, at least 1.');
  }
  return defineEventHandler((event) => {
    if (!guarded(event, prefix, exempt)) return;
    const length = getRequestHeader(event, 'content-length');
    if (length === undefined) {
      if (getRequestHeader(event, 'transfer-encoding') !== undefined) {
        throw createError({ statusCode: 411, message: 'Send the request with a Content-Length header.' });
      }
      return;
    }
    const trimmed = length.trim();
    if (!DIGITS.test(trimmed)) {
      throw createError({ statusCode: 400, message: 'The Content-Length header is not a valid length.' });
    }
    if (Number(trimmed) > maxBytes)
      throw createError({ statusCode: 413, message: 'The request is too large.' });
  });
}
