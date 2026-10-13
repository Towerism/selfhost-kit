import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/core/clock.js';
import { createFixedWindowLimiter } from '../../src/core/security/rate-limit.js';
import { fakeClock } from '../../src/testing/clock.js';

describe('createFixedWindowLimiter', () => {
  it('allows max hits per key, then rejects with the seconds left', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 1000, clock });

    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toEqual({ allowed: true });
    clock.set(999);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('resets once the window since the first counted hit has elapsed', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 1000, clock });
    limiter.hit('a');
    clock.advance(500);
    limiter.hit('a');

    clock.set(1000);
    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toMatchObject({ allowed: false });
  });

  it('rounds the wait up to whole seconds', () => {
    const clock = fakeClock(10_000);
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 900_000, clock });
    limiter.hit('a');

    clock.advance(100);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 900 });
    clock.advance(899_000);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('keeps a separate count per key', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, clock: fakeClock() });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('does not count rejected hits or extend the window with them', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, clock });
    limiter.hit('a');
    for (let t = 100; t < 1000; t += 100) {
      clock.set(t);
      expect(limiter.hit('a').allowed).toBe(false);
    }
    clock.set(1000);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('lets exactly max through a synchronous burst', () => {
    const limiter = createFixedWindowLimiter({ max: 10, windowMs: 1000, clock: fakeClock() });
    const allowed = Array.from({ length: 15 }, () => limiter.hit('a')).filter((r) => r.allowed);
    expect(allowed).toHaveLength(10);
  });

  it('bounds memory by evicting the entry whose window started first', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 10_000, capacity: 3, clock });
    limiter.hit('a');
    clock.advance(1);
    limiter.hit('b');
    clock.advance(1);
    limiter.hit('c');
    clock.advance(1);
    limiter.hit('d');

    expect(limiter.size()).toBe(3);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('c').allowed).toBe(false);
  });

  it('with capacity 1, evicts the only key on the next new key', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 10_000, capacity: 1, clock: fakeClock() });
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.size()).toBe(1);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('defaults to 10,000 tracked keys and the system clock', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 60_000 });
    for (let i = 0; i < 10_001; i++) limiter.hit(`k${String(i)}`);
    expect(limiter.size()).toBe(10_000);
  });

  it.each([
    ['max', { max: 0 }],
    ['max', { max: -1 }],
    ['max', { max: 1.5 }],
    ['max', { max: Number.NaN }],
    ['windowMs', { windowMs: 0 }],
    ['windowMs', { windowMs: Number.POSITIVE_INFINITY }],
    ['capacity', { capacity: 0 }],
    ['capacity', { capacity: 2 ** 60 }],
  ])('refuses a %s that is not a positive whole number (%o)', (name, bad) => {
    expect(() => createFixedWindowLimiter({ max: 1, windowMs: 1000, ...bad })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ max: 1, windowMs: 1000, ...bad })).toThrow(name);
  });
});

describe('clocks', () => {
  it('the system clock reads Date.now', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it('a fake clock starts where told and moves only when told', () => {
    const clock = fakeClock(5);
    expect(clock.now()).toBe(5);
    clock.advance(10);
    expect(clock.now()).toBe(15);
    clock.set(2);
    expect(clock.now()).toBe(2);
    expect(fakeClock().now()).toBe(0);
  });
});
