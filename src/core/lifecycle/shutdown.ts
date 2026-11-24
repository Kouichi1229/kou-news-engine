import { logger as defaultLogger } from '../logger.js';

/**
 * Releases every resource, attempting all of them even when one fails.
 *
 * Sequential `await`s would stop at the first rejection, so a failed HTTP close
 * would skip the database. Both are attempted and every failure is reported,
 * with the first error kept identifiable as the aggregate's first member.
 */
export async function disposeAll(cleanups: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];

  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple resources failed to close');
  }
}

/** The logging surface the handler needs; `logger` satisfies it structurally. */
export interface ShutdownLogger {
  info: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

/** Timer hooks, injectable so tests need no real clock. */
export type SetTimer = (callback: () => void, milliseconds: number) => unknown;
export type ClearTimer = (handle: unknown) => void;

/**
 * Injected collaborators. Nothing here reaches for the real process lifecycle:
 * the caller supplies how to stop listening, how to release the runtime, and how
 * to terminate, so the orchestration is testable without touching a live server.
 */
export interface ShutdownDependencies {
  /**
   * Marks the process as draining, so readiness starts reporting not-ready.
   *
   * Called once, synchronously, before `closeServer()`. Ordering matters: the
   * listener must still be accepting when the state flips, otherwise the
   * not-ready response can never reach whatever routes traffic to this process.
   */
  beginDraining: () => void;
  /** Stops accepting connections and settles once the listener is closed. */
  closeServer: () => Promise<void>;
  /** Closes sockets that are idle between requests. Not a cancellation. */
  closeIdleConnections: () => void;
  /** Closes every socket, including those mid-request. Not a cancellation. */
  closeAllConnections: () => void;
  /**
   * Resolves once no tracked request is being served.
   *
   * Called after `closeServer()` settles and before the runtime is disposed, so
   * SQLite is not closed while a request may still be using it. It is covered by
   * the same deadline as the rest of draining: a wait that never settles runs
   * out the timeout rather than holding the process open.
   *
   * This is HTTP-layer quiescence only. It does not prove an application handler
   * finished — see `docs/architecture.md`.
   */
  awaitRequestsDrained: () => Promise<void>;
  /** Releases the runtime's resources. Attempted even if `closeServer` fails. */
  disposeRuntime: () => Promise<void>;
  /** Terminates the process. Called exactly once per handler. */
  exit: (code: number) => void;
  /** Upper bound on draining, in milliseconds. */
  timeoutMs: number;
  /** Defaults to the application logger. */
  logger?: ShutdownLogger;
  /** Defaults to `setTimeout`. */
  setTimer?: SetTimer;
  /** Defaults to `clearTimeout`. */
  clearTimer?: ClearTimer;
}

export type ShutdownHandler = (signal: NodeJS.Signals) => Promise<void>;

/**
 * Races the work started by `work` against the drain deadline.
 *
 * The timer is armed *before* `work` is invoked, so the deadline covers the
 * whole drain rather than starting after the first connection work has already
 * run. The timer is cleared on every outcome — including a synchronous throw
 * from `work` — so it can never fire after the race settled. When the deadline
 * wins, `work` may still settle later; the handler attached below observes that
 * settlement, which keeps a late rejection from surfacing as an unhandled one.
 * The work is not cancelled: it keeps running while the process is torn down.
 */
async function withDeadline(
  work: () => Promise<void>,
  timeoutMs: number,
  setTimer: SetTimer,
  clearTimer: ClearTimer,
): Promise<{ timedOut: boolean }> {
  let handle: unknown;
  let timedOut = false;

  const deadline = new Promise<{ timedOut: boolean }>((resolve) => {
    handle = setTimer(() => {
      timedOut = true;
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  try {
    const settled = work().then(
      () => ({ timedOut: false }),
      (error: unknown) => {
        // Only a rejection that beats the deadline is reported; afterwards the
        // timeout already decided the outcome.
        if (timedOut) {
          return { timedOut: true };
        }
        throw error;
      },
    );

    return await Promise.race([settled, deadline]);
  } finally {
    clearTimer(handle);
  }
}

/**
 * Runs the shutdown sequence: stop listening, drain, release the runtime, exit.
 *
 * `closeServer()` is started before `closeIdleConnections()` so the listener
 * stops accepting first; clearing idle sockets first would leave a window where
 * a fresh connection is still accepted.
 *
 * `closeIdleConnections()` runs twice. The first sweep reaches only sockets that
 * are already idle, so a keep-alive socket that was serving a request at that
 * moment survives it and `closeServer()` would wait for that socket's
 * `keepAliveTimeout + keepAliveTimeoutBuffer` — about 6 seconds by default on
 * Node 24. The second sweep, after the drain wait, catches exactly those sockets.
 *
 * Two outcomes are possible and they are not interchangeable:
 *
 * - Draining finished in time. The runtime is disposed, then the process exits
 *   0 — or 1 if a cleanup failed.
 * - Draining hit the deadline. Every socket is forced closed and the process
 *   exits 1 *without* disposing the runtime. Forcing sockets shut says nothing
 *   about in-flight handlers, so one may still be running; closing SQLite
 *   underneath it would trade a clean shutdown for a database race. Leaving the
 *   connection open lets the process die with a consistent WAL that SQLite
 *   recovers on the next open.
 *
 * The deadline bounds draining only. It is cleared before disposal begins, so a
 * timer can never fire mid-disposal, and disposal is never revoked once started.
 */
async function runShutdown(
  dependencies: ShutdownDependencies,
  signal: NodeJS.Signals,
): Promise<void> {
  const log = dependencies.logger ?? defaultLogger;
  const setTimer: SetTimer =
    dependencies.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer: ClearTimer =
    dependencies.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  log.info('Shutdown signal received', { signal });

  // Before the listener closes, so readiness can answer while traffic routing
  // still has somewhere to ask. A failure here is reported but never aborts the
  // shutdown: refusing to close the server because a status flag could not be
  // set would be worse than closing it.
  try {
    dependencies.beginDraining();
  } catch (error) {
    log.error('Failed to mark the process as draining', { error: String(error) });
  }

  const drain = async (): Promise<void> => {
    // Started first so the listener stops accepting before idle sockets go.
    const closing = dependencies.closeServer();
    dependencies.closeIdleConnections();

    // A close that rejects must surface without waiting for a drain that may
    // never finish: holding the shutdown open would let the deadline win, and
    // the timeout path skips disposal, losing both the cleanup and the error.
    // The rejection is recorded and the promise is settled with a value, so a
    // late rejection can never resolve the shutdown silently.
    let closeFailed = false;
    let closeFailure: unknown;
    const closed = closing.then(
      () => 'closed' as const,
      (error: unknown) => {
        closeFailed = true;
        closeFailure = error;
        return 'closed' as const;
      },
    );

    // Caught so a drain rejection never becomes an unhandled one, and logged
    // here so observability cannot change the exit semantics.
    const drained = dependencies.awaitRequestsDrained().then(
      () => 'drained' as const,
      // Swallowed on purpose: a drain failure is reported, not fatal, and the
      // close outcome below still decides how the shutdown ends.
      (error: unknown) => {
        log.error('Failed to await drained requests', { error: String(error) });
        return 'drained' as const;
      },
    );

    // The first of the two to settle decides what happens next. Both settle
    // into a value rather than rejecting, so neither can surface as unhandled
    // and a late rejection can never resolve the shutdown silently.
    const first = await Promise.race([closed, drained]);

    // Covers the fast case: close failed and the drain was never waited on, so a
    // drain that never settles cannot turn a known close error into a timeout.
    if (first === 'closed' && closeFailed) {
      dependencies.closeIdleConnections();
      throw closeFailure;
    }

    if (first === 'closed') {
      // Close succeeded while the drain was still running, so the second sweep
      // waits for it: sweeping now would target sockets that are still
      // mid-request, leaving the keep-alive connection to be waited out.
      await drained;
      dependencies.closeIdleConnections();
      return;
    }

    // The drain settled first, so sweep now — that is what lets the remaining
    // close settle promptly on a real server — then observe the close outcome.
    dependencies.closeIdleConnections();
    await closed;

    // A close that failed after the race must still surface, otherwise the
    // shutdown would end as a success.
    if (closeFailed) {
      throw closeFailure;
    }
  };

  let outcome: { timedOut: boolean };
  try {
    outcome = await withDeadline(drain, dependencies.timeoutMs, setTimer, clearTimer);
  } catch (error) {
    // The server failed to close before the deadline. Disposal is still
    // attempted so the database is released, and both failures are reported
    // together — the close error stays the aggregate's first member.
    log.error('Error during shutdown', { error: String(error) });
    try {
      await disposeAll([dependencies.disposeRuntime]);
    } catch (disposeError) {
      log.error('Error during shutdown', { error: String(disposeError) });
      dependencies.exit(1);
      throw new AggregateError([error, disposeError], 'Multiple resources failed to close');
    }
    dependencies.exit(1);
    throw error;
  }

  if (outcome.timedOut) {
    const timeoutError = new Error(`Draining did not finish within ${dependencies.timeoutMs}ms`);
    log.error('Shutdown timed out', {
      error: timeoutError.message,
      timeoutMs: dependencies.timeoutMs,
    });

    // A failure to force sockets closed must not swallow the timeout itself:
    // both are reported, with the timeout first so it stays the primary cause.
    // Tracked with a flag rather than by inspecting the thrown value: `throw
    // undefined` is legal, so the error's value cannot signal whether a throw
    // happened.
    let forcedCloseFailed = false;
    let forcedCloseError: unknown;
    try {
      dependencies.closeAllConnections();
    } catch (error) {
      forcedCloseFailed = true;
      forcedCloseError = error;
      log.error('Failed to force connections closed', { error: String(error) });
    }

    // No disposeRuntime() here on purpose: in-flight handlers may still be using
    // the database, and a forced socket close does not stop them.
    dependencies.exit(1);

    if (forcedCloseFailed) {
      throw new AggregateError(
        [timeoutError, forcedCloseError],
        'Shutdown timed out and forcing connections closed failed',
      );
    }
    return;
  }

  try {
    await dependencies.disposeRuntime();
  } catch (error) {
    log.error('Error during shutdown', { error: String(error) });
    dependencies.exit(1);
    throw error;
  }

  log.info('Server closed');
  dependencies.exit(0);
}

/**
 * Builds a shutdown handler that runs the sequence at most once.
 *
 * The first signal starts the work and its promise is cached, so every later
 * signal — a second SIGTERM, an interleaved SIGINT, or a call arriving while the
 * first is still in flight — receives that same promise. The cache is never
 * cleared, so a failed shutdown keeps reporting its original outcome instead of
 * retrying a cleanup whose intermediate state is unknown.
 */
export function createShutdownHandler(dependencies: ShutdownDependencies): ShutdownHandler {
  let shutdownPromise: Promise<void> | undefined;

  return (signal: NodeJS.Signals): Promise<void> => {
    shutdownPromise ??= runShutdown(dependencies, signal);
    return shutdownPromise;
  };
}
