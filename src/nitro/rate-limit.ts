import { type H3Event, createError, getRequestHeader, getRequestIP, setResponseHeader } from 'h3';
import { type TrustedProxies, clientKey } from '../core/security/client-address.js';
import type { FixedWindowLimiter } from '../core/security/rate-limit.js';

export interface RateLimitOptions {
  /** One limiter per limited route, built once (for example in `server/utils`). */
  limiter: FixedWindowLimiter;
  /** `parseTrustedProxies(NUXT_TRUSTED_PROXIES)`, built once. */
  trusted: TrustedProxies;
}

/**
 * Counts one hit for the request's client and refuses it with 429 once the limiter says no. The client is the
 * TCP peer (h3's `getRequestIP`, without `X-Forwarded-For`), or the `X-Forwarded-For` entry a trusted proxy
 * appended. Call it first in the handler, before reading the body, so a refused request costs nothing.
 *
 * @throws H3Error 429 with `Retry-After` set, `statusMessage: 'Too Many Requests'` and
 * `data: { code: 'rate_limited', retryAfterSeconds }`.
 */
export function enforceRateLimit(event: H3Event, options: RateLimitOptions): void {
  const key = clientKey({
    remoteAddress: getRequestIP(event),
    xForwardedFor: getRequestHeader(event, 'x-forwarded-for'),
    trusted: options.trusted,
  });
  const result = options.limiter.hit(key);
  if (result.allowed) return;

  const { retryAfterSeconds } = result;
  const minutes = Math.ceil(retryAfterSeconds / 60);
  setResponseHeader(event, 'Retry-After', retryAfterSeconds);
  throw createError({
    statusCode: 429,
    statusMessage: 'Too Many Requests',
    message: `Too many attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    data: { code: 'rate_limited', retryAfterSeconds },
  });
}
