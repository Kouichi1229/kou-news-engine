import type { Express } from 'express';

import { env } from './config/env.js';
import { createApp, type AppOptions } from './app.js';
import { createLifecycleState, type LifecycleState } from './core/lifecycle/lifecycle-state.js';
import { createRequestTracker, type RequestTracker } from './core/lifecycle/request-tracker.js';
import { logger } from './core/logger.js';
import type { LlmProvider } from './core/llm/llm.provider.js';
import {
  createProvider as createProviderFromFactory,
  type LlmProviderConfig,
  type LlmProviderDeps,
} from './core/llm/provider.factory.js';
import { openDatabase, type SqliteDatabase, type SqliteQuery } from './core/persistence/sqlite.js';
import { createDatabaseProbe } from './modules/health/database.probe.js';
import { createDrainingProbe } from './modules/health/draining.probe.js';
import type { ArticleRepository } from './modules/ingestion/repository/article.repository.js';
import { SqliteArticleRepository } from './modules/ingestion/repository/sqlite-article.repository.js';

/**
 * The database surface the Runtime publishes.
 *
 * `close` is deliberately absent: the composition root is the only thing that
 * may release the connection, and a consumer holding a closable handle could
 * shut the database out from under in-flight work.
 */
export type RuntimeDatabase = Pick<SqliteDatabase, 'path' | 'version' | 'isOpen' | 'query'>;

/**
 * Closed union of runtime-lifecycle error kinds.
 *
 * Deliberately not a ninth `LlmErrorKind`: every member there must answer a
 * retryability question through `RETRYABLE_BY_KIND`, and a lifecycle condition has
 * no sensible answer. Keeping the two spaces separate also keeps this change inside
 * this module (§6.1.1).
 */
export type RuntimeErrorKind = 'disposed';

/**
 * Rejection reason for every use of a disposed Runtime.
 *
 * A plain `Error`, not an `LlmError`: disposal is a lifecycle outcome, not a model
 * or transport failure, so code that classifies `LlmError` must not swallow it. The
 * stable discriminator is `kind`; `name` is diagnostic only, and no caller may
 * identify this error by matching its message.
 */
export class RuntimeDisposedError extends Error {
  readonly kind: RuntimeErrorKind = 'disposed';

  constructor(message = 'Runtime has been disposed') {
    super(message);
    this.name = 'RuntimeDisposedError';
  }
}

/**
 * Private lifecycle of the lazily built provider (§11.1.8).
 *
 * `pending.attempt` is the internal initialisation promise. It is shared so that
 * `createProvider` runs exactly once, and it is never handed to a caller: callers
 * receive a per-call wrapper (§11.1.8.2). Not exported, and no accessor exposes it.
 */
type ProviderCell =
  | { status: 'idle' }
  | { status: 'pending'; attempt: Promise<LlmProvider> }
  | { status: 'ready'; provider: LlmProvider }
  | { status: 'failed'; error: unknown }
  | { status: 'disposed' };

export interface Runtime {
  app: Express;
  repository: ArticleRepository;
  database: RuntimeDatabase;
  /**
   * The lifecycle state this Runtime owns.
   *
   * Exposed so the process entry point can hand `beginDraining` to the shutdown
   * handler. The app's readiness probe reads the same instance, which is what
   * makes the not-ready response reflect the actual shutdown.
   */
  lifecycle: LifecycleState;
  /**
   * The in-flight request tracker this Runtime owns.
   *
   * The app's middleware increments it and the shutdown handler waits on it, so
   * both sides observe the same requests.
   */
  requests: RequestTracker;
  /**
   * Closes the database this Runtime owns. Safe to call repeatedly; the
   * connection is released at most once and a close failure reaches the caller.
   */
  dispose: () => Promise<void>;
  /**
   * Resolves the LLM provider, building it on first use.
   *
   * Each call returns its **own** wrapper promise, so a caller whose call is still
   * unsettled when disposal begins is rejected with `RuntimeDisposedError` even
   * though the initialisation itself is shared (§11.1.8.2).
   */
  getProvider: () => Promise<LlmProvider>;
}

/**
 * Test seams. Every entry defaults to the production implementation, so
 * omitting them yields the real graph.
 */
export interface RuntimeDependencies {
  /** Defaults to the production `openDatabase()` reading `env.DATABASE_PATH`. */
  openDatabase?: () => SqliteDatabase;
  /** Defaults to `new SqliteArticleRepository(database)`. */
  createRepository?: (database: SqliteDatabase) => ArticleRepository;
  /** Defaults to `createApp(options)`. */
  createApp?: (options: AppOptions) => Express;
  /**
   * Defaults to `env` projected onto `LlmProviderConfig`.
   *
   * A seam, not a second configuration system: it overrides that projection so a
   * test can supply deterministic configuration without touching `process.env`.
   */
  llmConfig?: LlmProviderConfig;
  /** Defaults to the real `createProvider` from `provider.factory.ts`. */
  createProvider?: (config: LlmProviderConfig, deps: LlmProviderDeps) => Promise<LlmProvider>;
}

/**
 * Answers whether the database can serve a query.
 *
 * Runs one trivial statement through the existing handle rather than opening a
 * second connection: a probe connection would be a second thing to close, and it
 * would answer for a database the application is not actually using. `query()`
 * already rejects use of a closed handle, so disposal is observed without this
 * function tracking state of its own.
 *
 * Any throw propagates; `getReady` classifies it as `probe_failed`. That covers a
 * driver error and a closed handle alike, and keeps the endpoint from deciding
 * what an exception meant.
 */
function probeDatabase(database: SqliteDatabase): boolean {
  const row = database.query((connection) => connection.get('SELECT 1 AS ok'));
  return row !== undefined;
}

/**
 * Copies the readable members into a fresh object.
 *
 * A `Pick` type alone would still hand out the real handle: `close` would remain
 * reachable at runtime and a caller could cast past the type. Building an object
 * with only these four members makes the restriction real.
 */
function restrictDatabase(database: SqliteDatabase): RuntimeDatabase {
  return {
    path: database.path,
    version: database.version,
    get isOpen(): boolean {
      return database.isOpen;
    },
    query: <T>(fn: (connection: SqliteQuery) => T): T => database.query(fn),
  };
}

/**
 * Releases the database after a failed initialisation, then rethrows.
 *
 * The original failure is what the caller needs, so it is thrown untouched when
 * the close succeeds. When the close also fails, both are reported: the original
 * stays identifiable as the first member of the aggregate rather than being
 * replaced by the cleanup error.
 */
function failInitialization(database: SqliteDatabase, cause: unknown): never {
  try {
    database.close();
  } catch (closeError) {
    throw new AggregateError(
      [cause, closeError],
      'Runtime initialization failed and the database could not be closed',
    );
  }
  throw cause;
}

/**
 * Disposes a runtime after a failed startup, then rethrows the startup error.
 *
 * Used when the HTTP server never came up. A failed cleanup must not replace the
 * reason startup failed, so both are reported with the startup error kept as the
 * aggregate's first member.
 */
export async function disposeRuntimeAfterFailure(runtime: Runtime, cause: unknown): Promise<never> {
  try {
    await runtime.dispose();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      'Startup failed and the runtime could not be disposed',
    );
  }
  throw cause;
}

/**
 * Composition root: builds the database, the repository and the app, and owns
 * the connection for the lifetime of the process.
 *
 * Everything after `open()` runs inside one cleanup boundary: any synchronous
 * failure past that point closes the database before the error propagates, so a
 * half-built runtime never escapes. The repository borrows the handle and never
 * closes it, so `dispose()` here is the only place the connection is released.
 */
export function createRuntime(deps: RuntimeDependencies = {}): Runtime {
  const open = deps.openDatabase ?? ((): SqliteDatabase => openDatabase());
  const buildRepository =
    deps.createRepository ?? ((database: SqliteDatabase) => new SqliteArticleRepository(database));
  const buildApp = deps.createApp ?? ((options: AppOptions): Express => createApp(options));

  const database = open();

  try {
    const repository = buildRepository(database);

    // One state per Runtime: the probe the app reads and the `beginDraining`
    // the shutdown handler calls are the same object, so readiness cannot drift
    // from the real shutdown.
    const lifecycle = createLifecycleState();

    // One tracker per Runtime, for the same reason: the middleware increments the
    // instance the shutdown handler later waits on.
    const requests = createRequestTracker();

    // Both dependencies are read on every request. `createDrainingProbe`
    // reports the lifecycle; `createDatabaseProbe` queries the handle this
    // Runtime owns. Neither opens a resource of its own.
    const app = buildApp({
      readinessProbes: [
        createDrainingProbe(lifecycle),
        createDatabaseProbe(() => probeDatabase(database)),
      ],
      requestTracking: { tracker: requests, lifecycle },
    });
    const publicDatabase = restrictDatabase(database);

    // Projected once, here: a retry must not rebuild against a different model
    // than the first attempt (§11.1.8.1).
    const llmConfig: LlmProviderConfig = deps.llmConfig ?? {
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL,
      timeoutMs: env.LLM_TIMEOUT_MS,
      apiKey: env.GEMINI_API_KEY,
    };
    const providerFactory = deps.createProvider ?? createProviderFromFactory;

    let disposed = false;
    let providerCell: ProviderCell = { status: 'idle' };
    // Settles every wrapper that has not committed yet, so disposal reaches a
    // caller whose call is still unsettled. Entries remove themselves on settle.
    const pendingWrappers = new Set<() => void>();

    const startProviderAttempt = (): Promise<LlmProvider> => {
      // Created here, not at `createRuntime()` time, and never stored: the
      // transport module must load only if this attempt selects `gemini`.
      const attempt = providerFactory(llmConfig, {
        createTransport: async () => {
          const { createGeminiTransport } =
            await import('./core/llm/providers/gemini.transport.js');
          // The factory validates the key before invoking this callback
          // (§9.5.5.1 rule 7), so the fallback is unreachable.
          return createGeminiTransport({
            apiKey: llmConfig.apiKey ?? '',
            timeoutMs: llmConfig.timeoutMs,
          });
        },
      });

      // Stored synchronously, before any await, so two calls in one tick cannot
      // both observe `idle` and start a second construction.
      providerCell = { status: 'pending', attempt };

      // Attached now rather than at disposal: an attempt that rejects before any
      // disposal must never surface as an unhandled rejection (§11.1.8.2).
      attempt.then(
        (provider) => {
          if (providerCell.status === 'pending' && providerCell.attempt === attempt) {
            providerCell = { status: 'ready', provider };
          }
        },
        (error: unknown) => {
          if (providerCell.status === 'pending' && providerCell.attempt === attempt) {
            providerCell = { status: 'failed', error };
          }
        },
      );

      return attempt;
    };

    // One wrapper per call, settled exactly once by its own arbitration
    // (§11.1.8.2). The attempt is shared; the wrapper is not.
    const createCallerWrapper = (attempt: Promise<LlmProvider>): Promise<LlmProvider> =>
      new Promise<LlmProvider>((resolve, reject) => {
        let settled = false;

        const commitDisposal = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          pendingWrappers.delete(commitDisposal);
          reject(new RuntimeDisposedError());
        };

        const commit = (outcome: { provider: LlmProvider } | { error: unknown }): void => {
          if (settled) {
            return;
          }
          // Disposal observed before this commit wins; the reverse order keeps the
          // initialisation outcome, so an earlier commit is final.
          if (disposed) {
            commitDisposal();
            return;
          }
          settled = true;
          pendingWrappers.delete(commitDisposal);
          if ('provider' in outcome) {
            resolve(outcome.provider);
          } else {
            reject(outcome.error);
          }
        };

        pendingWrappers.add(commitDisposal);
        attempt.then(
          (provider) => commit({ provider }),
          (error: unknown) => commit({ error }),
        );
      });

    const getProvider = (): Promise<LlmProvider> => {
      // Disposal is checked before anything else, including in `ready` state.
      if (disposed || providerCell.status === 'disposed') {
        return Promise.reject(new RuntimeDisposedError());
      }
      if (providerCell.status === 'ready') {
        // Already available, so this wrapper commits at creation: a later
        // disposal cannot revoke a provider that was delivered first.
        return Promise.resolve(providerCell.provider);
      }
      if (providerCell.status === 'pending') {
        return createCallerWrapper(providerCell.attempt);
      }
      return createCallerWrapper(startProviderAttempt());
    };

    const dispose = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      // Marked before the close so a throwing close still counts as disposed:
      // retrying would be unsafe once the handle's state is unknown.
      disposed = true;
      // Terminal, and it drops any stored provider or error reference.
      providerCell = { status: 'disposed' };
      // Disposal does not await the attempt: a hung build must not block exit.
      for (const settle of [...pendingWrappers]) {
        settle();
      }
      database.close();
    };

    logger.info('Runtime initialized', {
      databasePath: database.path,
      schemaVersion: database.version,
    });

    return {
      app,
      repository,
      database: publicDatabase,
      lifecycle,
      requests,
      dispose,
      getProvider,
    };
  } catch (error) {
    failInitialization(database, error);
  }
}
