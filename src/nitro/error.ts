import { send, setResponseHeaders, setResponseStatus } from 'h3';
import type { JsonErrorHandler } from './types.js';

/**
 * JSON errors as Nitro renders them, minus Nitro's own CSP, so the app's CSP (set by
 * `securityHeadersPlugin` on the request) stays on the error response like every other security header.
 * The status, status text, body and Nitro's other headers are kept; the body is sent as 2-space JSON.
 *
 * App wiring, in `server/error.ts`: `export default defineNitroErrorHandler(jsonErrorHandler())`.
 */
export function jsonErrorHandler(): JsonErrorHandler {
  return async (error, event, { defaultHandler }) => {
    const res = await defaultHandler(error, event);
    const headers = Object.fromEntries(
      Object.entries(res.headers).filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
    );
    setResponseHeaders(event, headers);
    setResponseStatus(event, res.status, res.statusText);
    await send(event, JSON.stringify(res.body, null, 2));
  };
}
