import type { Express } from 'express';

import { createApp, type AppOptions } from './app.js';
import { createLifecycleState, type LifecycleState } from './core/lifecycle/lifecycle-state.js';
import { createRequestTracker, type RequestTracker } from './core/lifecycle/request-tracker.js';
import { logger } from './core/logger.js';
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

    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      // Marked before the close so a throwing close still counts as disposed:
      // retrying would be unsafe once the handle's state is unknown.
      disposed = true;
      database.close();
    };

    logger.info('Runtime initialized', {
      databasePath: database.path,
      schemaVersion: database.version,
    });

    return { app, repository, database: publicDatabase, lifecycle, requests, dispose };
  } catch (error) {
    failInitialization(database, error);
  }
}
