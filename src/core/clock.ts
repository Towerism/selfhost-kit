/** The time port. Code that needs "now" takes a `Clock`, so tests use `fakeClock()` from `/testing`. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The real clock (`Date.now`). */
export const systemClock: Clock = { now: () => Date.now() };
