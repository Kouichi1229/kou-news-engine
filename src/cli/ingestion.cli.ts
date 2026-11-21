import { createIngestionLifecycle } from '../core/lifecycle/ingestion-lifecycle.js';
import type { SignalHost } from '../core/lifecycle/signal-coordinator.js';
import { logger as defaultLogger } from '../core/logger.js';
import type { FetchLike } from '../modules/ingestion/feed/feed.client.js';
import {
  DEFAULT_INGESTION_DEADLINE_MS,
  runIngestion,
} from '../modules/ingestion/ingestion.service.js';
import type { IngestionRunResult } from '../modules/ingestion/ingestion.types.js';
import { enabledSources } from '../modules/ingestion/sources/source.config.js';
import type { FeedSource } from '../modules/ingestion/sources/source.schema.js';
import type { Runtime } from '../runtime.js';

import {
  classifyRun,
  exitCodeForOutcome,
  type CancellingSignal,
  type CliOutcome,
} from './exit-codes.js';
import { createSignalRecorder, trackPersistence } from './signal-recorder.js';

/**
 * One-shot ingestion CLI.
 *
 * Runs a single ingestion pass against the SQLite-backed runtime, then exits.
 * There is no scheduler: an external timer invokes the process, so it starts,
 * does one pass and stops. Nothing here is reachable from the HTTP server's
 * startup path — `src/index.ts` never imports this module.
 *
 * ## Signal handling
 *
 * Handlers are installed by `createIngestionLifecycle` **before**
 * `createRuntime()` runs, so a signal arriving while the database is opening is
 * recorded rather than lost. That orchestration is reused rather than
 * reimplemented: the graceful/forced split, the exactly-once disposal and the
 * cleanup-error aggregation all live there.
 *
 * The only thing added here is *which* signal arrived, because the exit code
 * differs (130 vs 143). It is captured by wrapping the `SignalHost` handed to
 * the coordinator, so the coordinator remains the sole owner of subscription and
 * teardown and no second listener is registered.
 *
 * ## Exit codes
 *
 * Every outcome is decided by `classifyRun` and converted by
 * `exitCodeForOutcome`. No path inspects a log message or an error's text.
 */

/** Marks a failure that happened while building the runtime. */
export class RuntimeInitializationError extends Error {
  /** The error `createRuntime()` threw, kept for diagnosis. */
  readonly original: unknown;

  constructor(original: unknown) {
    super('Runtime initialization failed');
    this.name = 'RuntimeInitializationError';
    this.original = original;
  }
}

export interface CliLogger {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

export interface CliDependencies {
  /**
   * Builds the runtime. Defaults to the production `createRuntime()`.
   *
   * Injected so a test can supply a controlled repository or simulate an
   * initialization failure. A throw from here is reported as
   * `initialization-failure`.
   */
  createRuntime?: () => Promise<Runtime> | Runtime;

  /** Sources to ingest. Defaults to the enabled configured sources. */
  sources?: readonly FeedSource[];

  /** Whole-run budget. Defaults to `DEFAULT_INGESTION_DEADLINE_MS`. */
  deadlineMs?: number;

  /**
   * Monotonic clock for the deadline. Injected so a test can expire the budget
   * without waiting, and so the production path keeps using `performance.now()`.
   */
  clock?: () => number;

  /** Wall clock for run timestamps. Injected for reproducible results. */
  now?: () => Date;

  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;

  /** Writes the exit code. Defaults to `process.exit`. */
  exit?: (code: number) => void;

  /** Injected so tests own no real signals. Defaults to the global `process`. */
  host?: SignalHost;

  /** Called on the second signal. Defaults to the lifecycle's `process.exit(1)`. */
  terminate?: (signal: NodeJS.Signals) => void;

  /** Defaults to the application logger. */
  logger?: CliLogger;
}

export interface CliResult {
  outcome: CliOutcome;
  exitCode: number;
}

/**
 * Runs one ingestion pass, then reports the outcome and exit code.
 *
 * Returns the result rather than only exiting, so the decision is observable in
 * a test without a process boundary. `exit` is invoked exactly once.
 */
export async function runCli(dependencies: CliDependencies = {}): Promise<CliResult> {
  const log = dependencies.logger ?? defaultLogger;
  const exit = dependencies.exit ?? ((code: number): void => process.exit(code));
  // Deferred rather than a static import: `runtime.ts` reaches `env.ts` through
  // `sqlite.ts`, which validates `process.env` on evaluation. Importing lazily
  // keeps this module loadable with no environment configured, and moves a
  // configuration failure onto the lifecycle's catch path.
  const buildRuntime =
    dependencies.createRuntime ??
    (async (): Promise<Runtime> => {
      const { createRuntime } = await import('../runtime.js');
      return createRuntime();
    });

  // Wraps whatever host the coordinator will use — the real `process` by
  // default — so the signal identity is captured without a second subscription.
  const recorder = createSignalRecorder(dependencies.host ?? (process as unknown as SignalHost));

  let persistenceFailed = false;

  const lifecycle = createIngestionLifecycle<IngestionRunResult>({
    createRuntime: async () => {
      try {
        return await buildRuntime();
      } catch (error) {
        // Tagged here so the classifier has a stable type to test rather than
        // matching a message that belongs to the persistence module.
        throw new RuntimeInitializationError(error);
      }
    },
    run: async (runtime, signal) => {
      const repository = (runtime as Runtime).repository;
      const tracked = trackPersistence(repository);
      try {
        return await runIngestion({
          sources: dependencies.sources ?? enabledSources(),
          repository: tracked.repository,
          deadlineMs: dependencies.deadlineMs ?? DEFAULT_INGESTION_DEADLINE_MS,
          signal,
          ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
          ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        });
      } finally {
        // Recorded even when the run throws, so a rejected write is still known
        // to be a persistence failure rather than an anonymous error.
        persistenceFailed = tracked.failed();
      }
    },
    host: recorder.host,
    ...(dependencies.terminate === undefined ? {} : { terminate: dependencies.terminate }),
    logger: log,
  });

  const outcome = await decideOutcome(lifecycle, recorder.received, () => persistenceFailed, log);
  const exitCode = exitCodeForOutcome(outcome);

  log.info('Ingestion CLI finished', { outcome: outcome.kind, exitCode });
  exit(exitCode);

  return { outcome, exitCode };
}

/**
 * Runs the lifecycle and turns whatever it did into an outcome.
 *
 * The lifecycle throws for a failed run, a failed disposal or a leaked signal
 * handler, so the throw is the only place those become exit codes.
 */
async function decideOutcome(
  lifecycle: () => Promise<{
    result?: IngestionRunResult;
    cancelled: boolean;
  }>,
  receivedSignal: () => CancellingSignal | undefined,
  persistenceFailed: () => boolean,
  log: CliLogger,
): Promise<CliOutcome> {
  try {
    const completed = await lifecycle();
    return classifyRun({
      result: completed.result,
      cancelled: completed.cancelled,
      signal: receivedSignal(),
      persistenceFailed: persistenceFailed(),
    });
  } catch (error) {
    const failed = persistenceFailed();
    log.error('Ingestion CLI failed', {
      error: error instanceof Error ? error.message : String(error),
      persistenceFailed: failed,
    });

    if (failed) {
      return { kind: 'persistence-failure' };
    }
    if (error instanceof RuntimeInitializationError) {
      return { kind: 'initialization-failure' };
    }
    // A failure carrying a cancellation is still a cancellation: the operator
    // asked for the stop, and the exit code must say so even if cleanup also
    // failed afterwards.
    const signal = receivedSignal();
    if (signal !== undefined) {
      return { kind: 'cancelled', signal };
    }
    return { kind: 'unexpected-error' };
  }
}
