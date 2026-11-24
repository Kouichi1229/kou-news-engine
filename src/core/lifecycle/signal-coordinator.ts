import { logger as defaultLogger } from '../logger.js';
import type { CancellationSignal } from './cancellation.js';

/**
 * Graceful-then-forceful signal handling.
 *
 * The first SIGINT/SIGTERM asks the process to stop starting new work; the
 * second one terminates immediately. Both signals share one counter, so SIGINT
 * followed by SIGTERM is the second signal, and any further signal is ignored —
 * the forced exit is requested exactly once.
 *
 * ## What the forced path does and does not promise
 *
 * The second signal exits the process without waiting for in-flight work. A
 * fetch that is still running has its result discarded, and a write that has not
 * been committed is lost. SQLite keeps the database consistent — a half-applied
 * batch is rolled back and the WAL is recovered on the next open — but
 * *consistency is not completeness*: articles that were fetched but not yet
 * saved are gone, and an operator who sends a second signal has chosen that.
 * Never describe a forced exit as a clean or complete shutdown.
 *
 * ## Why nothing here disposes the runtime
 *
 * Releasing the database from a signal handler would close it while the run
 * that received the cancellation is still using it. Disposal belongs to
 * whoever created the resource, after the run has settled — see
 * `createIngestionLifecycle` in `ingestion-lifecycle.ts`.
 */

/** The slice of `process` this module needs, injected so tests own no real signals. */
export interface SignalHost {
  on(event: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface SignalLogger {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
}

export interface SignalCoordinatorDependencies {
  /** Receives the graceful cancellation request. Usually one per run. */
  signal: CancellationSignal;
  /**
   * Terminates the process after the second signal.
   *
   * Injected rather than calling `process.exit` so a test can observe the
   * request without ending the test runner, and so the exit code stays a
   * decision of the process entry point.
   */
  terminate: (signal: NodeJS.Signals) => void;
  /** Defaults to the global `process`. */
  host?: SignalHost;
  /** Defaults to the application logger. */
  logger?: SignalLogger;
}

export interface SignalCoordinator {
  /**
   * Subscribes to SIGINT and SIGTERM.
   *
   * Idempotent: a second call while installed returns the same state rather
   * than adding duplicate listeners, which would otherwise make one signal
   * count as two and force an immediate exit.
   *
   * All-or-nothing when it succeeds: every listener is registered or none is.
   * If registering one throws, the ones already added are removed again and the
   * registration error is rethrown, leaving the coordinator uninstalled.
   *
   * A rollback can itself fail. Those failures are never discarded: the thrown
   * `AggregateError` carries the registration error first, then one entry per
   * listener that could not be removed. A listener that survives the rollback is
   * still tracked, so a later `install()` does not register a duplicate of it and
   * `uninstall()` can still reach it.
   */
  install(): void;

  /**
   * Unsubscribes.
   *
   * Safe to call more than once and safe to call before `install()`. Every
   * listener this coordinator added is removed, so a test that installs
   * per-case leaves no handler behind for the next one.
   *
   * Best-effort: a failing `removeListener` never stops the remaining ones from
   * being attempted. The failures are collected and thrown afterwards as one
   * `AggregateError` — one entry per listener that could not be removed — so the
   * caller can release its own resources first and still learn that a handler may
   * have been left behind.
   *
   * A listener that could not be removed stays tracked, because it is still
   * attached. Calling `uninstall()` again retries exactly those leftovers — the
   * only way to release a handler whose first removal failed — and is otherwise
   * a no-op.
   */
  uninstall(): void;

  /** Signals observed so far. 0 while untouched, 1 after the graceful request. */
  signalCount(): number;
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export function createSignalCoordinator(
  dependencies: SignalCoordinatorDependencies,
): SignalCoordinator {
  const host = dependencies.host ?? (process as unknown as SignalHost);
  const log = dependencies.logger ?? defaultLogger;

  let installed = false;
  let count = 0;
  let terminated = false;
  // The listeners currently attached to the host, in registration order. Kept
  // per coordinator so a rollback that only partly succeeded stays visible to
  // the next `install()` instead of being forgotten.
  const attached: Array<(typeof SIGNALS)[number]> = [];

  const onSignal = (received: NodeJS.Signals): void => {
    count += 1;

    if (count === 1) {
      dependencies.signal.cancel('signal');
      log.info('Shutdown signal received, stopping after the current step', {
        signal: received,
      });
      return;
    }

    // One-shot. The forced exit is requested exactly once; a third signal arrives
    // after that request has been made, so repeating it would only re-enter a
    // `terminate` that may already be tearing the process down.
    if (terminated) {
      log.warn('Further shutdown signal ignored, termination already requested', {
        signal: received,
        signalCount: count,
      });
      return;
    }

    // Marked before the call so a throwing `terminate` is never retried: the
    // process state is unknown afterwards, and a retry could re-run a partial
    // teardown.
    terminated = true;

    // Deliberately loud: this path loses in-flight work, so it must never look
    // like the graceful one in the logs.
    log.warn('Second shutdown signal received, terminating without waiting', {
      signal: received,
      signalCount: count,
      dataLossRisk: 'in-flight ingestion results are discarded and uncommitted writes are lost',
    });
    dependencies.terminate(received);
  };

  return {
    install: (): void => {
      if (installed) {
        return;
      }

      // Registered incrementally so a failure part way through can be undone.
      // Without the rollback, a throwing `host.on` would leave the listeners
      // already added in place while `installed` stayed false — and the next
      // `install()` would add a second copy of them.
      try {
        for (const signal of SIGNALS) {
          if (attached.includes(signal)) {
            continue;
          }
          host.on(signal, onSignal);
          attached.push(signal);
        }
      } catch (error) {
        // Roll back everything this coordinator registered. Each removal is
        // attempted independently: one failure must not strand the rest.
        const rollbackFailures: unknown[] = [];
        for (const signal of [...attached]) {
          try {
            host.removeListener(signal, onSignal);
            attached.splice(attached.indexOf(signal), 1);
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
        }

        if (rollbackFailures.length === 0) {
          throw error;
        }

        // A listener that could not be removed is still attached, so the
        // coordinator must not claim to be uninstalled: `installed` stays false
        // (the install did not complete), but the leftover is recorded in
        // `attached` so a retry does not register a duplicate and `uninstall()`
        // can still reach it. Both the registration error and every rollback
        // failure are preserved.
        throw new AggregateError(
          [error, ...rollbackFailures],
          `Failed to install signal handlers and to roll back ${String(rollbackFailures.length)} listener(s)`,
        );
      }

      // Set only after every listener is in place, so a failed install leaves
      // the coordinator uninstalled and free to be retried.
      installed = true;
    },

    uninstall: (): void => {
      if (!installed && attached.length === 0) {
        return;
      }
      installed = false;

      // Every listener is attempted before anything is thrown: a failure on
      // SIGINT must not leave the SIGTERM handler registered. The errors are
      // gathered rather than rethrown inside the loop for that reason.
      const failures: unknown[] = [];
      for (const signal of [...attached]) {
        try {
          host.removeListener(signal, onSignal);
          attached.splice(attached.indexOf(signal), 1);
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Failed to remove ${String(failures.length)} signal listener(s)`,
        );
      }
    },

    signalCount: (): number => count,
  };
}
