/**
 * In-flight request accounting.
 *
 * Answers one question: how many HTTP requests is this process still serving?
 * Nothing here knows about Express, HTTP, or the process lifecycle — the
 * middleware feeds it, the shutdown orchestration reads it.
 *
 * What this proves and does not prove:
 *
 * - It proves **HTTP-layer quiescence**: every tracked request has had its
 *   response finished or its connection closed.
 * - It does **not** prove handler completion. A handler that awaits after
 *   `res.json()`, or whose client disconnected early, is released here while
 *   its promise may still be running. Callers must not read `whenIdle()` as
 *   "all application work is finished".
 */

/** Snapshot of the tracker's counters. */
export interface RequestTrackerStats {
  /** Requests currently being served. Never negative. */
  active: number;
  /** Requests begun since this tracker was created. Only ever grows. */
  total: number;
  /**
   * Requests that began while the process was draining.
   *
   * An observation counter, not a live gauge: it is never decremented, so it
   * answers "how many arrived after draining started" rather than "how many
   * are still running".
   */
  draining: number;
}

export interface BeginRequestOptions {
  /** Whether the process was draining when this request arrived. */
  draining: boolean;
}

export interface RequestTracker {
  /**
   * Registers one in-flight request and returns its release function.
   *
   * The returned function is idempotent: calling it more than once decrements
   * the active count at most once. That is what makes it safe to attach to both
   * `finish` and `close`, which both fire on a normal response.
   */
  begin(options: BeginRequestOptions): () => void;

  /** Requests currently being served. */
  activeCount(): number;

  /** Current counter values. */
  stats(): RequestTrackerStats;

  /**
   * Resolves once no request is being served.
   *
   * Resolves immediately when the count is already zero. Never rejects: there
   * is no failure mode to report, so a caller may await it unconditionally.
   * Every caller gets its own promise, and all of them settle when the count
   * reaches zero.
   */
  whenIdle(): Promise<void>;
}

export function createRequestTracker(): RequestTracker {
  let active = 0;
  let total = 0;
  let draining = 0;
  const waiters: Array<() => void> = [];

  return {
    begin({ draining: whileDraining }: BeginRequestOptions): () => void {
      active += 1;
      total += 1;
      if (whileDraining) {
        draining += 1;
      }

      let released = false;

      return (): void => {
        if (released) {
          return;
        }
        released = true;
        active -= 1;

        if (active === 0) {
          // Drain the waiter list before resolving: a waiter's `then` may
          // register a new request, which must not be released by this pass.
          for (const resolve of waiters.splice(0, waiters.length)) {
            resolve();
          }
        }
      };
    },

    activeCount: (): number => active,

    stats: (): RequestTrackerStats => ({ active, total, draining }),

    whenIdle: (): Promise<void> => {
      if (active === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
