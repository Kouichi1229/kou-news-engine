import { logger as defaultLogger } from '../logger.js';
import { createCancellationSignal, type CancellationSignal } from './cancellation.js';
import { createSignalCoordinator, type SignalHost } from './signal-coordinator.js';

/**
 * Runs one ingestion pass under signal handling, then releases the runtime.
 *
 * This is the composition a future CLI entry point will call; it is not an entry
 * point itself. It maps nothing to an exit code and reads no arguments — that
 * integration is a separate concern.
 *
 * ## Ordering: handlers before resources
 *
 * Signals are wired **before** `createRuntime()` is called. The alternative —
 * build the runtime, then subscribe — leaves a window in which a signal during a
 * slow database open kills the process with a connection already acquired and
 * never closed. Subscribing first means a signal during initialisation is
 * recorded on the cancellation signal, so the run that follows sees it on its
 * first poll instead of starting work nobody wants.
 *
 * That choice has a cost: initialisation itself cannot be interrupted. It is
 * bounded by the open, which is local I/O, and the alternative is leaking a file
 * handle.
 *
 * ## Exactly one disposal
 *
 * Disposal happens once, guarded by a flag rather than by the shape of the
 * thrown value. There is no `finally` block: the work runs inside `execute()`,
 * and the body that awaits it handles the two outcomes separately — a `catch`
 * for a failed run, then the straight-line path for a successful one — each of
 * which uninstalls the signal handlers and then disposes. Keeping the two apart
 * is what lets a disposal failure be reported differently depending on whether
 * the run had already failed.
 *
 * ## Cleanup never blocks disposal
 *
 * Removing a signal handler can fail, and that must not cost the runtime: the
 * database handle is the resource that actually leaks. So the handlers are
 * removed through `uninstallSafely()`, which returns the failures instead of
 * throwing, and disposal runs regardless. Those failures are not swallowed —
 * they are merged into one `AggregateError` alongside whatever else failed, so a
 * run failure, a cleanup failure and a disposal failure are all inspectable. A
 * run that succeeded but left a handler attached is reported as a failure, not
 * as success.
 *
 * Every path is covered: clean run, throw from the run, throw from runtime
 * creation, and cancellation before the run started. When the runtime was never
 * created there is nothing to dispose and the call is a no-op rather than an
 * error.
 */

export interface IngestionLifecycleLogger {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

/** The part of a runtime this orchestration needs. */
export interface DisposableRuntime {
  dispose: () => Promise<void>;
}

export interface IngestionLifecycleDependencies<TResult> {
  /**
   * Builds the runtime. Called after the handlers are installed.
   *
   * If it throws, no runtime exists and there is nothing to dispose.
   */
  createRuntime: () => Promise<DisposableRuntime>;

  /**
   * Runs the work with the runtime and the cancellation signal.
   *
   * Receives the signal so the work can poll it at its own boundaries. A signal
   * that arrived earlier is already recorded, so the work sees it on its first
   * poll rather than needing a special case. The work owns its own deadline; this
   * orchestration does not impose one, because only the run knows what a sensible
   * budget is.
   */
  run: (runtime: DisposableRuntime, signal: CancellationSignal) => Promise<TResult>;

  /** Defaults to the global `process`. Injected so tests own no real signals. */
  host?: SignalHost;

  /**
   * Called on the second signal. Defaults to `process.exit(1)`.
   *
   * Injected so a test can observe the request without ending the runner. The
   * forced path is deliberately not modelled as clean: see
   * `signal-coordinator.ts` for the data risk.
   */
  terminate?: (signal: NodeJS.Signals) => void;

  /** Defaults to the application logger. */
  logger?: IngestionLifecycleLogger;
}

export interface IngestionLifecycleResult<TResult> {
  /**
   * The work's result, or `undefined` when the run was never started.
   *
   * A signal that arrives before the run begins makes this `undefined`: starting
   * work that is already cancelled would fetch sources the operator just asked us
   * to stop starting.
   */
  result?: TResult;
  /** Whether cancellation was requested at any point before completion. */
  cancelled: boolean;
  /** Whether a runtime was created and therefore disposed. */
  runtimeCreated: boolean;
}

export type IngestionRunner<TResult> = () => Promise<IngestionLifecycleResult<TResult>>;

export function createIngestionLifecycle<TResult>(
  dependencies: IngestionLifecycleDependencies<TResult>,
): IngestionRunner<TResult> {
  const log = dependencies.logger ?? defaultLogger;
  const terminate =
    dependencies.terminate ??
    ((_signal: NodeJS.Signals): void => {
      process.exit(1);
    });

  return async (): Promise<IngestionLifecycleResult<TResult>> => {
    const signal = createCancellationSignal();
    const coordinator = createSignalCoordinator({
      signal,
      terminate,
      ...(dependencies.host === undefined ? {} : { host: dependencies.host }),
      logger: log,
    });

    // Before createRuntime: a signal during initialisation must not be lost.
    coordinator.install();

    let runtime: DisposableRuntime | undefined;
    let disposed = false;

    const disposeOnce = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      // Marked before the call so a throwing dispose is never retried: the
      // handle's state is unknown afterwards, and retrying could double-release.
      disposed = true;
      if (runtime === undefined) {
        return;
      }
      await runtime.dispose();
    };

    /**
     * Removes the signal handlers without letting a failure escape here.
     *
     * A listener that cannot be removed must not prevent the runtime from being
     * disposed: releasing the database is the more urgent of the two, and the
     * caller still needs the cleanup errors to report them.
     */
    const uninstallSafely = (): unknown[] => {
      try {
        coordinator.uninstall();
        return [];
      } catch (error) {
        if (error instanceof AggregateError) {
          return [...error.errors];
        }
        return [error];
      }
    };

    let outcome: IngestionLifecycleResult<TResult>;
    try {
      outcome = await execute();
    } catch (error) {
      // The run (or initialisation) failed. Cleanup and disposal must still
      // happen, and no failure may mask another: every original error is kept.
      const cleanupFailures = uninstallSafely();
      try {
        await disposeOnce();
      } catch (disposeError) {
        log.error('Failed to dispose runtime after error', { error: String(disposeError) });
        throw new AggregateError(
          [error, ...cleanupFailures, disposeError],
          cleanupFailures.length === 0
            ? 'Runtime disposal failed while handling another error'
            : 'Ingestion run, signal handler cleanup, and runtime disposal all failed',
        );
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          'Ingestion run and signal handler cleanup both failed',
        );
      }
      throw error;
    }

    const cleanupFailures = uninstallSafely();
    try {
      await disposeOnce();
    } catch (disposeError) {
      // A runtime that could not be released is a failure an operator must see,
      // not a footnote on an otherwise successful run.
      log.error('Failed to dispose runtime', { error: String(disposeError) });
      if (cleanupFailures.length === 0) {
        throw disposeError;
      }
      throw new AggregateError(
        [...cleanupFailures, disposeError],
        'Signal handler cleanup and runtime disposal both failed',
      );
    }

    if (cleanupFailures.length > 0) {
      // The run succeeded, but a handler may still be attached. Reporting that as
      // success would hide a leaked listener from the operator.
      throw new AggregateError(cleanupFailures, 'Failed to remove signal handlers');
    }

    return outcome;

    async function execute(): Promise<IngestionLifecycleResult<TResult>> {
      runtime = await dependencies.createRuntime();
      log.info('Ingestion runtime initialised', {
        cancelledDuringInitialisation: signal.isCancelled(),
      });

      if (signal.isCancelled()) {
        // Nothing was attempted, so there is nothing to persist and no reason to
        // start fetching sources the operator already asked us to leave alone.
        log.warn('Ingestion skipped: cancellation requested before the run started');
        return { cancelled: true, runtimeCreated: true };
      }

      const result = await dependencies.run(runtime, signal);
      return { result, cancelled: signal.isCancelled(), runtimeCreated: true };
    }
  };
}
