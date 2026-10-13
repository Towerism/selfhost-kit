import { type Clock, systemClock } from '../clock.js';

export type HitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface FixedWindowLimiter {
  /** Counts the hit when allowed; rejected hits aren't counted. */
  hit(key: string): HitResult;
  /** Keys currently tracked. */
  size(): number;
}

/**
 * At most `max` hits per key in a window that starts at the key's first counted hit. In memory: counts
 * reset on restart. The map is kept in window-start order, so when it's full the oldest window is evicted.
 *
 * @throws RangeError when `max`, `windowMs` or `capacity` isn't a positive whole number. A NaN `max` would
 * otherwise allow every hit.
 */
export function createFixedWindowLimiter(opts: {
  max: number;
  windowMs: number;
  capacity?: number;
  clock?: Clock;
}): FixedWindowLimiter {
  const { max, windowMs, capacity = 10_000, clock = systemClock } = opts;
  for (const [name, value] of [
    ['max', max],
    ['windowMs', windowMs],
    ['capacity', capacity],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`The rate limiter's ${name} must be a whole number of at least 1.`);
    }
  }
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key) {
      const t = clock.now();
      const current = windows.get(key);
      if (current && t - current.start < windowMs) {
        if (current.count >= max) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((current.start + windowMs - t) / 1000)),
          };
        }
        current.count++;
        return { allowed: true };
      }
      // New or expired window: re-insert so the map stays in start order.
      windows.delete(key);
      if (windows.size >= capacity) windows.delete(windows.keys().next().value as string);
      windows.set(key, { start: t, count: 1 });
      return { allowed: true };
    },
    size: () => windows.size,
  };
}
