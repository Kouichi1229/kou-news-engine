import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { env } from '../../config/env.js';
import { MIGRATIONS, MigrationVersionError, runMigrations, type Migration } from './migrations.js';

/**
 * Thrown when the database cannot be opened or initialised.
 *
 * The message is deliberately generic: it never contains the resolved file
 * path or SQL text, so a caller can surface it without leaking deployment
 * layout. The original error is preserved as `cause` for server-side logs.
 */
export class DatabaseOpenError extends Error {
  constructor(cause: unknown) {
    super('Failed to open the database', { cause });
    this.name = 'DatabaseOpenError';
  }
}

/** Thrown when the handle is used after `close()`. */
export class DatabaseClosedError extends Error {
  constructor() {
    super('The database connection is closed');
    this.name = 'DatabaseClosedError';
  }
}

/**
 * The statement surface handed to `query()`.
 *
 * **This is not a read-only guarantee.** It only omits `run()`. SQLite executes
 * any statement through `all()` or `get()` — `INSERT ... RETURNING`,
 * `DELETE`, `UPDATE`, and `PRAGMA` all work and are applied immediately:
 *
 * ```sql
 * SELECT all('INSERT INTO articles (...) VALUES (...) RETURNING id')  -- writes
 * SELECT all('PRAGMA user_version = 99')                              -- writes
 * ```
 *
 * `PRAGMA query_only = ON` would block the data writes, but it can be turned
 * back off from the same connection, so it is not a boundary either. A real
 * boundary needs a second connection opened with `readOnly: true`, which is
 * impossible for `:memory:` databases — each connection gets its own database.
 *
 * The responsibility therefore sits with the caller: `query()` is for reads.
 * Repository implementations must not issue writes through it.
 */
export interface SqliteQuery {
  /** Runs a query and returns every row. Executes writes too; see the interface note. */
  all: (sql: string, params?: readonly SQLInputValue[]) => unknown[];
  /** Runs a query and returns the first row, or `undefined`. Executes writes too. */
  get: (sql: string, params?: readonly SQLInputValue[]) => unknown;
}

/** Statement surface available inside `transaction()`. */
export interface SqliteTransaction extends SqliteQuery {
  /** Runs a statement that returns no rows. */
  run: (sql: string, params?: readonly SQLInputValue[]) => void;
}

/**
 * An opened, already-migrated database.
 *
 * The driver instance is captured in this module's closure and never handed
 * out, so callers cannot close it behind the handle's back or run SQL the
 * handle does not know about. Every operation goes through the two callbacks
 * below, which check the closed state first.
 */
export interface SqliteDatabase {
  /** Absolute path of the database file, or `:memory:`. */
  readonly path: string;
  /** Highest applied migration version. */
  readonly version: number;
  readonly isOpen: boolean;
  /**
   * Runs `fn` against the connection without opening a transaction.
   *
   * Intended for reads. The callback can still write, because SQLite applies
   * writes issued through `all()`/`get()` — see `SqliteQuery`.
   */
  query: <T>(fn: (connection: SqliteQuery) => T) => T;
  /**
   * Runs `fn` inside `BEGIN`/`COMMIT`. The callback must be synchronous: an
   * `await` inside it would let other work interleave before `COMMIT`.
   *
   * On failure the transaction is rolled back and the callback's error is
   * rethrown as-is, with any rollback failure attached as `rollbackCause`.
   */
  transaction: <T>(fn: (connection: SqliteTransaction) => T) => T;
  /**
   * Closes the connection. Calling it again after a successful close is a
   * no-op. If the driver refuses to close, the error propagates and the handle
   * keeps reporting `isOpen === true`, because the resource state is unknown.
   */
  close: () => void;
}

/**
 * Thrown when a `transaction()` callback returns a promise.
 *
 * The transaction is rolled back, because nothing that happens after the first
 * `await` can be committed safely: `COMMIT` would already have run. The callback
 * may still be suspended; its connection is invalidated, so any later statement
 * throws instead of escaping the transaction.
 */
export class AsyncTransactionCallbackError extends Error {
  constructor() {
    super('Transaction callback must be synchronous and must not return a promise');
    this.name = 'AsyncTransactionCallbackError';
  }
}

/** Thrown when a `transaction()` callback fails and its rollback also fails. */
export class SqliteTransactionError extends Error {
  /** Value thrown by the rollback. */
  readonly rollbackCause: unknown;

  constructor(cause: unknown, rollbackCause: unknown) {
    super('Transaction failed and the rollback also failed', { cause });
    this.name = 'SqliteTransactionError';
    this.rollbackCause = rollbackCause;
  }
}

export interface OpenDatabaseOptions {
  /**
   * Database file path. Defaults to `env.DATABASE_PATH`.
   *
   * A relative path is resolved against `process.cwd()`, which is the process
   * working directory — `/app` inside the container, the project root in local
   * development. `:memory:` is passed through untouched and creates no file.
   */
  path?: string;
  migrations?: readonly Migration[];
  now?: () => Date;
}

const MEMORY_PATH = ':memory:';

function isMemory(path: string): boolean {
  return path === MEMORY_PATH || path.startsWith('file::memory:');
}

function ensureParentDirectory(absolutePath: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
}

/**
 * @internal
 *
 * Closes a connection that failed to initialise, then throws `DatabaseOpenError`
 * wrapping the original failure.
 *
 * The close is best-effort: a half-initialised connection must not stay open or
 * the file stays locked and the next attempt fails for an unrelated reason. A
 * failing close is deliberately swallowed so the original cause survives; the
 * caller only ever needs to know why opening failed.
 *
 * Takes a structural type rather than `DatabaseSync` so the failure path can be
 * exercised without a real driver.
 */
export function abandonFailedOpen(
  connection: { close: () => void } | undefined,
  cause: unknown,
): never {
  try {
    connection?.close();
  } catch {
    // The original failure is the one worth reporting.
  }
  throw new DatabaseOpenError(cause);
}

/**
 * @internal
 *
 * Closes `connection` once, and only records the handle as closed when the
 * driver confirms it.
 *
 * Marking the handle closed first would report a success that did not happen,
 * and a later retry would be skipped even though the resource may still be
 * open. Letting the error propagate leaves `closed` untouched, so the caller
 * can retry and `isOpen` keeps telling the truth.
 */
export function closeConnection(
  state: { closed: boolean },
  connection: { close: () => void },
): void {
  if (state.closed) {
    return;
  }
  connection.close();
  state.closed = true;
}

/**
 * Detects a promise or any thenable, including objects that only mimic one.
 *
 * TypeScript's `T` cannot express "not a promise", so this check is the only
 * thing standing between an `async` callback and a premature `COMMIT`.
 *
 * Reading `then` can run a getter, so this may throw. That is intentional: the
 * error propagates to the transaction's own catch, which rolls back as usual.
 */
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Attaches a rejection handler to a thenable the transaction is about to
 * abandon.
 *
 * `transaction()` rejects an async callback immediately, without waiting for it.
 * If that callback later throws, its promise rejects with nobody listening and
 * Node reports an unhandled rejection — which can terminate the process. The
 * rejection carries no information the caller can act on: the transaction has
 * already failed with `AsyncTransactionCallbackError`, and nothing was
 * committed. So it is deliberately discarded.
 *
 * `Promise.resolve` is used instead of calling `then` directly because it
 * assimilates thenables per the specification: a throwing `then` getter, a
 * throwing `then` invocation, or a `then` that never settles all become a
 * handled rejection rather than a synchronous throw or a hang. It never throws
 * synchronously, but the guard is kept so a hostile object cannot turn cleanup
 * into a second failure.
 */
function discardRejection(value: unknown): void {
  try {
    void Promise.resolve(value).catch(() => {
      // Intentionally ignored; see the note above.
    });
  } catch {
    // Unreachable for spec-compliant thenables, but cleanup must never throw.
  }
}

/**
 * Opens the database, applies connection-level pragmas and runs pending
 * migrations.
 *
 * `DatabaseSync` is synchronous, so every use of it stays inside this module and
 * the callbacks exposed by the returned handle.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): SqliteDatabase {
  const requested = options.path ?? env.DATABASE_PATH;
  const absolutePath = isMemory(requested) ? requested : resolve(process.cwd(), requested);

  let db: DatabaseSync | undefined;
  const state = { closed: false };
  let inTransaction = false;

  function requireOpen(): DatabaseSync {
    if (state.closed || db === undefined) {
      throw new DatabaseClosedError();
    }
    return db;
  }

  const queryConnection: SqliteQuery = {
    all: (sql, params = []) =>
      requireOpen()
        .prepare(sql)
        .all(...params),
    get: (sql, params = []) =>
      requireOpen()
        .prepare(sql)
        .get(...params),
  };

  /**
   * Builds the statement surface handed to one `transaction()` callback.
   *
   * `alive` is flipped to `false` as soon as the transaction ends, so a callback
   * that was suspended at an `await` cannot keep issuing statements afterwards.
   * Without it, a resumed async callback would run its remaining SQL outside the
   * transaction, on a connection that has already been committed or rolled back.
   */
  function createTransactionConnection(alive: { value: boolean }): SqliteTransaction {
    const assertAlive = (): void => {
      if (!alive.value) {
        throw new DatabaseClosedError();
      }
    };

    return {
      all: (sql, params = []) => {
        assertAlive();
        return queryConnection.all(sql, params);
      },
      get: (sql, params = []) => {
        assertAlive();
        return queryConnection.get(sql, params);
      },
      run: (sql, params = []): void => {
        assertAlive();
        requireOpen()
          .prepare(sql)
          .run(...params);
      },
    };
  }

  try {
    if (!isMemory(absolutePath)) {
      ensureParentDirectory(absolutePath);
    }

    db = new DatabaseSync(absolutePath);

    // Referential integrity is off by default in SQLite and must be enabled per
    // connection, otherwise the article_sources foreign key is decorative.
    db.exec('PRAGMA foreign_keys = ON');

    // WAL lets readers proceed while a write is in flight. Meaningless for an
    // in-memory database, which has no file to journal.
    if (!isMemory(absolutePath)) {
      db.exec('PRAGMA journal_mode = WAL');
    }

    runMigrations(db, options.migrations ?? MIGRATIONS, options.now ?? ((): Date => new Date()));

    const versionRow = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      { version: number | null } | undefined;

    return {
      path: absolutePath,
      version: versionRow?.version ?? 0,
      get isOpen(): boolean {
        return !state.closed;
      },
      query: <T>(fn: (connection: SqliteQuery) => T): T => {
        requireOpen();
        return fn(queryConnection);
      },
      transaction: <T>(fn: (connection: SqliteTransaction) => T): T => {
        const connection = requireOpen();

        if (inTransaction) {
          throw new Error('Nested transactions are not supported');
        }

        inTransaction = true;
        const alive = { value: true };
        const scoped = createTransactionConnection(alive);
        connection.exec('BEGIN');

        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          const result = fn(scoped);
          // A promise means the callback has not finished; COMMIT here would
          // close the transaction while its body is still suspended.
          if (isThenable(result)) {
            // Detach the callback's promise before abandoning the transaction,
            // so a later rejection is handled instead of becoming unhandled.
            discardRejection(result);
            throw new AsyncTransactionCallbackError();
          }
          outcome = { ok: true, value: result };
        } catch (error) {
          outcome = { ok: false, error };
        } finally {
          // Invalidate first: nothing the callback still holds may reach the
          // connection once the transaction is being finalised.
          alive.value = false;
        }

        if (outcome.ok) {
          connection.exec('COMMIT');
          inTransaction = false;
          return outcome.value;
        }

        let rollbackCause: unknown;
        let rollbackFailed = false;
        try {
          connection.exec('ROLLBACK');
        } catch (rollbackError) {
          rollbackFailed = true;
          rollbackCause = rollbackError;
        } finally {
          inTransaction = false;
        }

        // A rejected async callback is reported as itself unless the rollback
        // also failed, which is the more serious of the two.
        throw rollbackFailed
          ? new SqliteTransactionError(outcome.error, rollbackCause)
          : outcome.error;
      },
      close: (): void => {
        if (db !== undefined) {
          closeConnection(state, db);
        }
      },
    };
  } catch (error) {
    // A version mismatch is a configuration problem the caller must be able to
    // tell apart from a generic open failure, so it passes through untouched.
    if (error instanceof MigrationVersionError) {
      try {
        db?.close();
      } catch {
        // Keep the version error.
      }
      throw error;
    }
    abandonFailedOpen(db, error);
  }
}
