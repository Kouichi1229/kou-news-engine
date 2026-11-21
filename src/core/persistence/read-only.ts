import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SqliteQuery } from './sqlite.js';

const MEMORY_PATH = ':memory:';

/**
 * Thrown when a read-only preview cannot be served.
 *
 * Deliberately distinct from `DatabaseOpenError`: a missing database is an
 * expected state for a preview, not a fault. Callers report the count as
 * unavailable and exit cleanly instead of treating it as a failure.
 */
export class DatabaseNotAvailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'DatabaseNotAvailableError';
  }
}

/** A read-only connection. No `transaction`, because nothing here may write. */
export interface ReadOnlyDatabase {
  /** Absolute path of the database file that was opened. */
  readonly path: string;
  query: <T>(fn: (connection: SqliteQuery) => T) => T;
  close: () => void;
}

/**
 * Opens an existing database for reading only.
 *
 * ## What this guarantees
 *
 * - **No file is created.** A missing path throws rather than producing an empty
 *   database, so a preview can never manufacture the state it is previewing.
 * - **No migration runs.** `runMigrations` is not called, so a preview of an
 *   older schema cannot silently upgrade it.
 * - **No write can succeed.** The connection is opened with `readOnly: true` and
 *   additionally pinned with `PRAGMA query_only`, so a statement that slipped
 *   through would be rejected by SQLite rather than applied.
 *
 * ## Why `readOnly` and not `immutable`
 *
 * A `file:…?immutable=1` URI creates no `-shm`/`-wal` files, which is tempting.
 * It also makes SQLite ignore the write-ahead log entirely: on a database with
 * uncommitted WAL content it reported *no such table* where the real answer was
 * 100 rows. A preview that silently under-reports is worse than none, so this
 * uses a real read-only connection, which does read the WAL.
 *
 * The cost is that SQLite maintains the `-shm` shared-memory index while the
 * connection is open. That file holds no article data — it is a transient index
 * over the WAL — and the database file and `-wal` are left byte-identical. It is
 * still a filesystem touch, so it is stated here rather than left implicit.
 *
 * `:memory:` is rejected: each connection gets its own private database, so a
 * preview of it would always report zero and mean nothing.
 */
export function openReadOnlyDatabase(path: string): ReadOnlyDatabase {
  if (path === MEMORY_PATH) {
    throw new DatabaseNotAvailableError('A read-only preview cannot use an in-memory database');
  }

  const absolutePath = resolve(process.cwd(), path);
  if (!existsSync(absolutePath)) {
    throw new DatabaseNotAvailableError(`Database file does not exist: ${absolutePath}`);
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(absolutePath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The original failure is the one worth reporting.
    }
    throw new DatabaseNotAvailableError(`Database could not be opened read-only`, {
      cause: error,
    });
  }

  const connection: SqliteQuery = {
    all: (sql, params = []) => (db === undefined ? [] : db.prepare(sql).all(...params)),
    get: (sql, params = []) => (db === undefined ? undefined : db.prepare(sql).get(...params)),
  };

  return {
    path: absolutePath,
    query: <T>(fn: (c: SqliteQuery) => T): T => fn(connection),
    close: (): void => {
      if (db !== undefined) {
        const closing = db;
        db = undefined;
        closing.close();
      }
    },
  };
}
