/** Identifies the clock so tests can advance time without touching the database. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** The production clock. */
export const systemClock: Clock = {
  now: (): number => Date.now(),
};
