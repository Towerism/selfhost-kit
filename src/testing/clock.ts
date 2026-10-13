import type { Clock } from '../core/clock.js';

/** A {@link Clock} that only moves when a test moves it. */
export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** @param start the time `now()` returns until the clock is moved (default 0). */
export function fakeClock(start = 0): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}
