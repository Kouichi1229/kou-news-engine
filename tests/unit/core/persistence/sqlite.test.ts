import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  currentVersion,
  INITIAL_MIGRATION,
  INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION,
  MIGRATIONS,
  MigrationError,
  MigrationVersionError,
  PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION,
  runMigrations,
  type Migration,
} from '../../../../src/core/persistence/migrations.js';
import {
  abandonFailedOpen,
  AsyncTransactionCallbackError,
  closeConnection,
  DatabaseClosedError,
  DatabaseOpenError,
  openDatabase,
  SqliteTransactionError,
  type SqliteDatabase,
  type SqliteTransaction,
} from '../../../../src/core/persistence/sqlite.js';

const temporaryDirectories: string[] = [];

/**
 * File-backed databases opened by a test, released in `afterEach`.
 *
 * Each of these tests closes its own handle, but only after its assertions pass.
 * A failing assertion would skip that `close()` and leak the database, WAL and
 * shared-memory file descriptors for the rest of the run.
 */
const openHandles: SqliteDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-news-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Opens a file-backed database and registers it before any assertion can throw. */
function openTrackedDatabase(path: string): SqliteDatabase {
  const handle = openDatabase({ path });
  openHandles.push(handle);
  return handle;
}

afterEach(() => {
  const handles = openHandles.splice(0);
  const failures: unknown[] = [];

  for (const handle of handles) {
    if (!handle.isOpen) {
      continue;
    }
    try {
      handle.close();
    } catch (error) {
      // Keep going so one bad handle cannot strand the rest, then rethrow below
      // so the failure stays visible instead of being swallowed.
      failures.push(error);
    }
  }

  // Directory removal must run even when a close above failed, otherwise the
  // temporary files would outlive the failure that produced them.
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close one or more SQLite databases');
  }
});

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Highest version this build ships, i.e. what a fresh database ends up at. */
const LATEST_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

describe('openDatabase — creation and lifecycle', () => {
  it('creates the database file on first open', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'kou-news.db');

    const handle = openTrackedDatabase(path);

    expect(existsSync(path)).toBe(true);
    expect(handle.isOpen).toBe(true);
    handle.close();
  });

  it('creates missing parent directories recursively', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'nested', 'deeper', 'kou-news.db');

    const handle = openTrackedDatabase(path);

    expect(existsSync(path)).toBe(true);
    expect(statSync(join(directory, 'nested', 'deeper')).isDirectory()).toBe(true);
    handle.close();
  });

  it('passes :memory: through untouched without creating a file', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(handle.path).toBe(':memory:');
    handle.close();
  });

  it('opens a file::memory: database as memory, creating no file', () => {
    const directory = temporaryDirectory();
    const previousCwd = process.cwd();
    process.chdir(directory);

    try {
      const handle = openDatabase({ path: 'file::memory:' });

      expect(handle.isOpen).toBe(true);
      expect(handle.path).toBe('file::memory:');

      const databases = handle.query((connection) =>
        connection.all('PRAGMA database_list'),
      ) as Array<{ name: string; file: string }>;
      const main = databases.find((database) => database.name === 'main');
      expect(main?.file).toBe('');

      // Nothing named after the connection string may appear on disk.
      expect(readdirSync(directory)).toEqual([]);

      handle.close();
      expect(handle.isOpen).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('resolves a relative path against the process working directory', () => {
    const directory = temporaryDirectory();
    // Relative to cwd, so the file lands in the temporary directory and never
    // inside the repository.
    const relativePath = `./${relative(process.cwd(), join(directory, 'relative.db'))}`;

    const handle = openTrackedDatabase(relativePath);

    expect(handle.path).toBe(resolve(process.cwd(), relativePath));
    expect(handle.path).toBe(join(directory, 'relative.db'));
    handle.close();
  });

  it('reports the absolute path for a relative file path', () => {
    const directory = temporaryDirectory();
    const handle = openTrackedDatabase(join(directory, 'abs.db'));

    expect(handle.path.startsWith('/')).toBe(true);
    expect(handle.path.endsWith('abs.db')).toBe(true);
    handle.close();
  });

  it('opens an in-memory database without touching the filesystem', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(handle.isOpen).toBe(true);
    expect(handle.version).toBe(LATEST_VERSION);
    handle.close();
  });

  it('closes the connection and reports it as closed', () => {
    const handle = openDatabase({ path: ':memory:' });

    handle.close();

    expect(handle.isOpen).toBe(false);
  });

  it('tolerates being closed twice', () => {
    const handle = openDatabase({ path: ':memory:' });

    handle.close();

    expect(() => handle.close()).not.toThrow();
    expect(handle.isOpen).toBe(false);
  });

  it('persists data across a close and reopen', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'persist.db');

    const first = openTrackedDatabase(path);
    first.transaction((connection) => {
      connection.run(
        `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [
          'a1:x',
          'Title',
          'https://example.com/x',
          'https://example.com/x',
          '2026-11-19T12:00:00.000Z',
        ],
      );
    });
    first.close();

    const second = openTrackedDatabase(path);
    const row = second.query((connection) => connection.get('SELECT id FROM articles')) as
      { id: string } | undefined;

    expect(row?.id).toBe('a1:x');
    second.close();
  });

  it('enables WAL on a file database', () => {
    const directory = temporaryDirectory();
    const handle = openTrackedDatabase(join(directory, 'wal.db'));

    const mode = handle.query((connection) => connection.get('PRAGMA journal_mode')) as {
      journal_mode: string;
    };

    expect(mode.journal_mode).toBe('wal');
    handle.close();
  });

  it('sets a 5 second busy timeout on a file database', () => {
    const directory = temporaryDirectory();
    const handle = openTrackedDatabase(join(directory, 'busy.db'));

    try {
      // Read back from the live connection: busy_timeout is connection state, so
      // this is the only way to prove it was applied rather than merely issued.
      const pragma = handle.query((connection) => connection.get('PRAGMA busy_timeout')) as {
        timeout: number;
      };

      expect(pragma.timeout).toBe(5000);
    } finally {
      handle.close();
    }

    expect(handle.isOpen).toBe(false);
  });

  it('sets the busy timeout on in-memory databases too', () => {
    // busy_timeout is per connection and never persisted in the file, so every
    // connection has to set it. In-memory is the cheapest proof that the same
    // initialisation path runs for both kinds of database.
    const handle = openDatabase({ path: ':memory:' });

    try {
      const pragma = handle.query((connection) => connection.get('PRAGMA busy_timeout')) as {
        timeout: number;
      };

      expect(pragma.timeout).toBe(5000);
    } finally {
      handle.close();
    }

    expect(handle.isOpen).toBe(false);
  });

  it('applies the busy timeout before migrations run', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'busy-before-migrations.db');

    // Captures the live connection setting from inside a migration. If the
    // pragma were applied after `runMigrations`, this row would read 0.
    const capturing: Migration = {
      version: 1,
      name: 'capture_busy_timeout',
      statements: ['CREATE TABLE captured (timeout INTEGER NOT NULL)'],
    };
    const observer: Migration = {
      version: 2,
      name: 'observe_busy_timeout',
      statements: ['INSERT INTO captured (timeout) SELECT timeout FROM pragma_busy_timeout'],
    };

    const handle = openDatabase({ path, migrations: [capturing, observer] });
    try {
      const row = handle.query((connection) => connection.get('SELECT timeout FROM captured')) as
        { timeout: number } | undefined;

      expect(row?.timeout).toBe(5000);
    } finally {
      handle.close();
    }

    expect(handle.isOpen).toBe(false);
  });
});

describe('openDatabase — failure handling', () => {
  it('wraps an unopenable path in DatabaseOpenError', () => {
    const directory = temporaryDirectory();
    // A file where a directory is expected: the parent cannot be created.
    const blocker = join(directory, 'blocker');
    openDatabase({ path: join(directory, 'ok.db') }).close();
    writeFileSync(blocker, 'not a directory');

    expect(() => openDatabase({ path: join(blocker, 'db.sqlite') })).toThrow(DatabaseOpenError);
  });

  it('does not leak the database path in the error message', () => {
    const directory = temporaryDirectory();
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const path = join(blocker, 'secret-location.db');

    let message = '';
    try {
      openDatabase({ path });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('Failed to open the database');
    expect(message).not.toContain('secret-location');
    expect(message).not.toContain(directory);
  });
});

describe('runMigrations — first run', () => {
  it('creates the initial schema', () => {
    const db = new DatabaseSync(':memory:');

    runMigrations(db);

    expect(tableNames(db)).toEqual([
      'article_contents',
      'article_derived',
      'article_sources',
      'articles',
      'notification_delivery',
      'processing_job',
      'processing_lifecycle',
      'schema_migrations',
    ]);
    db.close();
  });

  it('creates the documented indexes', () => {
    const db = new DatabaseSync(':memory:');

    runMigrations(db);

    expect(indexNames(db)).toEqual([
      'idx_article_contents_claimable',
      'idx_article_contents_lease_token',
      'idx_article_sources_identity',
      'idx_article_sources_order',
      'idx_article_sources_primary',
      'idx_article_sources_source_id',
      'idx_articles_fetched_at',
      'idx_articles_inserted_order',
      'idx_articles_published_at',
      'idx_processing_job_claimable',
      'idx_processing_job_lease_token',
      'idx_processing_lifecycle_open',
    ]);
    db.close();
  });

  it('records the applied version and name', () => {
    const db = new DatabaseSync(':memory:');
    const appliedAt = '2026-11-19T12:00:00.000Z';

    runMigrations(db, MIGRATIONS, () => new Date(appliedAt));

    const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations').all();
    expect(rows).toEqual(
      MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        applied_at: appliedAt,
      })),
    );
    db.close();
  });

  it('reports the number of migrations it applied', () => {
    const db = new DatabaseSync(':memory:');

    expect(runMigrations(db)).toBe(MIGRATIONS.length);
    db.close();
  });

  it('does not create the tables reserved for later milestones', () => {
    const db = new DatabaseSync(':memory:');

    runMigrations(db);

    const names = tableNames(db);
    for (const reserved of [
      'article_translations',
      'article_summaries',
      'briefings',
      'briefing_items',
      'deliveries',
      'ingestion_runs',
    ]) {
      expect(names).not.toContain(reserved);
    }
    db.close();
  });
});

describe('runMigrations — idempotency', () => {
  it('applies nothing on a second run', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    expect(runMigrations(db)).toBe(0);
    db.close();
  });

  it('leaves the schema unchanged on a second run', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const before = tableNames(db);

    runMigrations(db);

    expect(tableNames(db)).toEqual(before);
    db.close();
  });

  it('keeps a single migration record', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    runMigrations(db);

    const count = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
    db.close();
  });

  it('is idempotent across separate connections to the same file', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'twice.db');

    openTrackedDatabase(path).close();
    const handle = openTrackedDatabase(path);

    expect(handle.version).toBe(LATEST_VERSION);
    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM schema_migrations'),
    ) as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
    handle.close();
  });
});

describe('runMigrations — failure and rollback', () => {
  it('rolls back a migration that fails part way through', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = {
      version: 1,
      name: 'broken',
      statements: ['CREATE TABLE first_table (id TEXT PRIMARY KEY)', 'THIS IS NOT VALID SQL'],
    };

    expect(() => runMigrations(db, [broken])).toThrow(MigrationError);

    // The first statement must not survive the rollback.
    expect(tableNames(db)).not.toContain('first_table');
    db.close();
  });

  it('records no version for a failed migration', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = {
      version: 1,
      name: 'broken',
      statements: ['CREATE TABLE t1 (id TEXT)', 'INVALID SQL'],
    };

    expect(() => runMigrations(db, [broken])).toThrow(MigrationError);

    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  it('reports the failing version in the error', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = { version: 7, name: 'broken', statements: ['INVALID SQL'] };

    expect(() => runMigrations(db, [broken])).toThrowError(/Migration 7 failed/);
    db.close();
  });

  it('keeps previously applied migrations when a later one fails', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [INITIAL_MIGRATION]);

    const broken: Migration = { version: 2, name: 'broken', statements: ['INVALID SQL'] };

    expect(() => runMigrations(db, [INITIAL_MIGRATION, broken])).toThrow(MigrationError);

    // Version 1 stays applied and its tables remain.
    expect(currentVersion(db)).toBe(1);
    expect(tableNames(db)).toContain('articles');
    db.close();
  });

  it('rejects duplicate migration versions', () => {
    const db = new DatabaseSync(':memory:');
    const duplicate: Migration = { version: 1, name: 'duplicate', statements: [] };

    expect(() => runMigrations(db, [INITIAL_MIGRATION, duplicate])).toThrow(
      /Duplicate migration version/,
    );
    db.close();
  });

  it('rejects a non-positive migration version', () => {
    const db = new DatabaseSync(':memory:');
    const invalid: Migration = { version: 0, name: 'invalid', statements: [] };

    expect(() => runMigrations(db, [invalid])).toThrow(/positive integer/);
    db.close();
  });
});

describe('schema — constraints', () => {
  function migratedDatabase(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('enforces foreign keys on article_sources', () => {
    const db = migratedDatabase();

    expect(() =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, first_seen_at, source_order)
           VALUES ('missing', 'src-a', 'u', 'r', 'c', 'N:', '2026-11-19T12:00:00.000Z', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
  });

  it('cascades deletes from articles to article_sources', () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at)
       VALUES ('a1:x', 'T', 'u', 'c', 0, '2026-11-19T12:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO article_sources
         (article_id, source_id, url, resolved_url, canonical_url, guid_key, first_seen_at, source_order)
       VALUES ('a1:x', 'src-a', 'u', 'r', 'c', 'N:', '2026-11-19T12:00:00.000Z', 1)`,
    ).run();

    db.prepare('DELETE FROM articles WHERE id = ?').run('a1:x');

    const count = db.prepare('SELECT COUNT(*) AS c FROM article_sources').get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });

  it('rejects a duplicate canonical_url', () => {
    const db = migratedDatabase();
    const insert = (id: string): void => {
      db.prepare(
        `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at)
         VALUES (?, 'T', 'u', 'same-canonical', 0, '2026-11-19T12:00:00.000Z')`,
      ).run(id);
    };

    insert('a1:one');
    expect(() => insert('a1:two')).toThrow();

    db.close();
  });

  it('rejects a published_at_is_estimated value other than 0 or 1', () => {
    const db = migratedDatabase();

    expect(() =>
      db
        .prepare(
          `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at)
           VALUES ('a1:x', 'T', 'u', 'c', 2, '2026-11-19T12:00:00.000Z')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('accepts a null published_at', () => {
    const db = migratedDatabase();

    expect(() =>
      db
        .prepare(
          `INSERT INTO articles (id, title, url, canonical_url, published_at, published_at_is_estimated, fetched_at)
           VALUES ('a1:x', 'T', 'u', 'c', NULL, 1, '2026-11-19T12:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();

    db.close();
  });

  it('stores tags as a JSON array preserving order and duplicates', () => {
    const db = migratedDatabase();
    const tags = ['ai', 'ai', 'lab'];

    db.prepare(
      `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, tags)
       VALUES ('a1:x', 'T', 'u', 'c', 0, '2026-11-19T12:00:00.000Z', ?)`,
    ).run(JSON.stringify(tags));

    const row = db.prepare('SELECT tags FROM articles').get() as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(['ai', 'ai', 'lab']);
    db.close();
  });

  it('treats repeated provenance rows as one row', () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at)
       VALUES ('a1:x', 'T', 'u', 'c', 0, '2026-11-19T12:00:00.000Z')`,
    ).run();
    const insertSource = (): void => {
      db.prepare(
        `INSERT INTO article_sources
           (article_id, source_id, url, resolved_url, canonical_url, guid_key, first_seen_at, source_order)
         VALUES ('a1:x', 'src-a', 'u', 'r', 'c', 'N:', '2026-11-19T12:00:00.000Z', 1)
         ON CONFLICT DO NOTHING`,
      ).run();
    };

    insertSource();
    insertSource();

    const count = db.prepare('SELECT COUNT(*) AS c FROM article_sources').get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });
});

describe('runMigrations — version compatibility', () => {
  const futureMigration: Migration = {
    version: 2,
    name: 'future_schema',
    statements: ['CREATE TABLE future_table (id TEXT PRIMARY KEY)'],
  };

  function databaseAtVersionTwo(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [INITIAL_MIGRATION, futureMigration]);
    return db;
  }

  it('rejects a database newer than the supported version', () => {
    const db = databaseAtVersionTwo();

    expect(() => runMigrations(db, [INITIAL_MIGRATION])).toThrow(MigrationVersionError);
    db.close();
  });

  it('reports the database and supported versions in the error', () => {
    const db = databaseAtVersionTwo();

    let error: MigrationVersionError | undefined;
    try {
      runMigrations(db, [INITIAL_MIGRATION]);
    } catch (caught) {
      error = caught as MigrationVersionError;
    }

    expect(error?.databaseVersion).toBe(2);
    expect(error?.supportedVersion).toBe(1);
    expect(error?.message).toContain('2');
    expect(error?.message).toContain('1');
    db.close();
  });

  it('leaves tables and migration records untouched when rejecting', () => {
    const db = databaseAtVersionTwo();
    const tablesBefore = tableNames(db);
    const recordsBefore = db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all();

    expect(() => runMigrations(db, [INITIAL_MIGRATION])).toThrow(MigrationVersionError);

    expect(tableNames(db)).toEqual(tablesBefore);
    expect(
      db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all(),
    ).toEqual(recordsBefore);
    expect(currentVersion(db)).toBe(2);
    db.close();
  });

  it('applies no pending migration when rejecting', () => {
    // Database is at version 5; this build knows versions 1 and 3, so version 3
    // is genuinely pending and must still not run.
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [
      INITIAL_MIGRATION,
      { version: 3, name: 'three', statements: ['CREATE TABLE three_table (id TEXT)'] },
      { version: 5, name: 'five', statements: ['CREATE TABLE five_table (id TEXT)'] },
    ]);

    const pendingThree: Migration = {
      version: 3,
      name: 'three',
      statements: ['CREATE TABLE three_table (id TEXT)'],
    };
    const supported = [INITIAL_MIGRATION, pendingThree];

    expect(() => runMigrations(db, supported)).toThrow(MigrationVersionError);

    expect(currentVersion(db)).toBe(5);
    db.close();
  });

  it('accepts a database at the supported version', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [INITIAL_MIGRATION]);

    expect(() => runMigrations(db, [INITIAL_MIGRATION])).not.toThrow();
    expect(runMigrations(db, [INITIAL_MIGRATION])).toBe(0);
    db.close();
  });

  it('accepts a database older than the supported version and migrates it', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [INITIAL_MIGRATION]);

    expect(runMigrations(db, [INITIAL_MIGRATION, futureMigration])).toBe(1);
    expect(currentVersion(db)).toBe(2);
    db.close();
  });

  it('does not reject an empty database when migrations are empty', () => {
    const db = new DatabaseSync(':memory:');

    expect(runMigrations(db, [])).toBe(0);
    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  it('rejects a migrated database when migrations are empty', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [INITIAL_MIGRATION]);

    expect(() => runMigrations(db, [])).toThrow(MigrationVersionError);
    db.close();
  });
});

describe('runMigrations — rollback failure handling', () => {
  /** Minimal DatabaseSync stand-in whose ROLLBACK always fails. */
  function stubDatabase(options: {
    failure: Error;
    rollbackFailure?: unknown;
    rollbackFails?: boolean;
  }): DatabaseSync {
    const stub = {
      exec: (sql: string): void => {
        if (sql === 'ROLLBACK' && options.rollbackFails === true) {
          throw options.rollbackFailure;
        }
        if (sql.startsWith('CREATE TABLE first_table')) {
          throw options.failure;
        }
      },
      prepare: (): { all: () => unknown[]; get: () => unknown; run: () => unknown } => ({
        all: () => [],
        get: () => undefined,
        run: () => undefined,
      }),
    };
    return stub as unknown as DatabaseSync;
  }

  const broken: Migration = {
    version: 3,
    name: 'broken',
    statements: ['CREATE TABLE first_table (id TEXT)'],
  };

  it('keeps the original error as the cause on a normal failure', () => {
    const failure = new Error('original failure');
    const db = stubDatabase({ failure });

    let error: MigrationError | undefined;
    try {
      runMigrations(db, [broken]);
    } catch (caught) {
      error = caught as MigrationError;
    }

    expect(error).toBeInstanceOf(MigrationError);
    expect(error?.cause).toBe(failure);
    expect(error?.rollbackFailed).toBe(false);
    expect(error?.rollbackCause).toBeUndefined();
    expect(error?.message).toBe('Migration 3 failed and was rolled back');
  });

  it('still constructs MigrationError when the rollback fails', () => {
    const failure = new Error('original failure');
    const rollbackFailure = new Error('cannot rollback - no transaction is active');
    const db = stubDatabase({ failure, rollbackFailure, rollbackFails: true });

    let error: MigrationError | undefined;
    try {
      runMigrations(db, [broken]);
    } catch (caught) {
      error = caught as MigrationError;
    }

    expect(error).toBeInstanceOf(MigrationError);
    expect(error?.rollbackFailed).toBe(true);
  });

  it('keeps the original error as cause even when the rollback fails', () => {
    const failure = new Error('original failure');
    const rollbackFailure = new Error('cannot rollback - no transaction is active');
    const db = stubDatabase({ failure, rollbackFailure, rollbackFails: true });

    let error: MigrationError | undefined;
    try {
      runMigrations(db, [broken]);
    } catch (caught) {
      error = caught as MigrationError;
    }

    expect(error?.cause).toBe(failure);
    expect(error?.cause).not.toBe(rollbackFailure);
  });

  it('exposes the rollback error for diagnosis', () => {
    const failure = new Error('original failure');
    const rollbackFailure = new Error('cannot rollback - no transaction is active');
    const db = stubDatabase({ failure, rollbackFailure, rollbackFails: true });

    let error: MigrationError | undefined;
    try {
      runMigrations(db, [broken]);
    } catch (caught) {
      error = caught as MigrationError;
    }

    expect(error?.rollbackCause).toBe(rollbackFailure);
    expect((error?.rollbackCause as Error).message).toBe(
      'cannot rollback - no transaction is active',
    );
  });

  it('distinguishes a failed rollback in the message', () => {
    const failure = new Error('original failure');
    const rollbackFailure = new Error('cannot rollback - no transaction is active');
    const db = stubDatabase({ failure, rollbackFailure, rollbackFails: true });

    let error: MigrationError | undefined;
    try {
      runMigrations(db, [broken]);
    } catch (caught) {
      error = caught as MigrationError;
    }

    expect(error?.message).toBe('Migration 3 failed and the rollback also failed');
    expect(error?.message).not.toContain('cannot rollback');
  });

  it('treats a rollback that throws undefined as a rollback failure', () => {
    const failure = new Error('original failure');
    // `throw undefined` is legal JavaScript, so the flag must not be inferred
    // from the thrown value.
    const db = stubDatabase({ failure, rollbackFailure: undefined, rollbackFails: true });

    let error: MigrationError | undefined;
    try {
      runMigrations(db, [broken]);
    } catch (caught) {
      error = caught as MigrationError;
    }

    expect(error).toBeInstanceOf(MigrationError);
    expect(error?.cause).toBe(failure);
    expect(error?.rollbackFailed).toBe(true);
    expect(error?.rollbackCause).toBeUndefined();
    expect(error?.message).toBe('Migration 3 failed and the rollback also failed');
  });
});

describe('migration v2 — inserted_order', () => {
  function migrated(db: DatabaseSync): DatabaseSync {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, [INITIAL_MIGRATION]);
    return db;
  }

  function insertArticle(db: DatabaseSync, id: string, order?: number): void {
    if (order === undefined) {
      db.prepare(
        `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at)
         VALUES (?, 'T', 'u', ?, 0, '2026-11-19T12:00:00.000Z')`,
      ).run(id, `https://example.com/${id}`);
    } else {
      db.prepare(
        `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES (?, 'T', 'u', ?, 0, '2026-11-19T12:00:00.000Z', ?)`,
      ).run(id, `https://example.com/${id}`, order);
    }
  }

  it('upgrades a v1 database to v2', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    expect(currentVersion(db)).toBe(1);

    runMigrations(db);

    expect(currentVersion(db)).toBe(LATEST_VERSION);
    db.close();
  });

  it('backfills inserted_order in rowid order for existing articles', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    // Inserted out of alphabetical order on purpose.
    insertArticle(db, 'a1:c');
    insertArticle(db, 'a1:a');
    insertArticle(db, 'a1:b');

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, inserted_order FROM articles ORDER BY inserted_order')
      .all() as Array<{ id: string; inserted_order: number }>;
    expect(rows).toEqual([
      { id: 'a1:c', inserted_order: 1 },
      { id: 'a1:a', inserted_order: 2 },
      { id: 'a1:b', inserted_order: 3 },
    ]);
    db.close();
  });

  it('assigns distinct inserted_order values to every existing article', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    for (let index = 0; index < 25; index += 1) {
      insertArticle(db, `a1:${index}`);
    }

    runMigrations(db);

    const rows = db.prepare('SELECT inserted_order FROM articles').all() as Array<{
      inserted_order: number;
    }>;
    const orders = rows.map((row) => row.inserted_order);
    expect(new Set(orders).size).toBe(25);
    expect(orders).not.toContain(0);
    db.close();
  });

  it('rejects a duplicate inserted_order', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    runMigrations(db);
    insertArticle(db, 'a1:one', 1);

    expect(() => insertArticle(db, 'a1:two', 1)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('rejects a bare insert that would fall back to the default 0', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    runMigrations(db);

    // The default exists only to satisfy ALTER TABLE; new rows must be explicit.
    insertArticle(db, 'a1:first');
    const row = db.prepare("SELECT inserted_order FROM articles WHERE id = 'a1:first'").get() as {
      inserted_order: number;
    };
    expect(row.inserted_order).toBe(0);

    expect(() => insertArticle(db, 'a1:second')).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});

describe('migration v2 — article_sources.is_primary', () => {
  function migrated(db: DatabaseSync): DatabaseSync {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  /**
   * Deterministic per-test fixture counter.
   *
   * `inserted_order` has a UNIQUE index, so drawing from `Math.random()` could
   * collide and fail intermittently. Resetting in `beforeEach` keeps each test
   * independent instead of accumulating state across the file.
   */
  let insertedOrder = 0;

  beforeEach(() => {
    insertedOrder = 0;
  });

  function seedArticle(db: DatabaseSync, id: string): void {
    insertedOrder += 1;
    db.prepare(
      `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, 'T', 'u', ?, 0, '2026-11-19T12:00:00.000Z', ?)`,
    ).run(id, `https://example.com/${id}`, insertedOrder);
  }

  function addSource(
    db: DatabaseSync,
    articleId: string,
    sourceId: string,
    primary: 0 | 1,
    sourceOrder: number,
    guidKey = 'N:',
  ): void {
    db.prepare(
      `INSERT INTO article_sources
         (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid,
          first_seen_at, source_order, is_primary)
       VALUES (?, ?, 'u', 'r', ?, ?, NULL, '2026-11-19T12:00:00.000Z', ?, ?)`,
    ).run(articleId, sourceId, `https://example.com/${sourceId}`, guidKey, sourceOrder, primary);
  }

  it('defaults is_primary to 0 for existing provenance', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');
    addSource(db, 'a1:x', 'src-a', 0, 1);

    const row = db.prepare('SELECT is_primary FROM article_sources').get() as {
      is_primary: number;
    };
    expect(row.is_primary).toBe(0);
    db.close();
  });

  it('rejects an is_primary value other than 0 or 1', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');

    expect(() => {
      db.prepare(
        `INSERT INTO article_sources
           (article_id, source_id, url, resolved_url, canonical_url, guid_key,
            first_seen_at, source_order, is_primary)
         VALUES ('a1:x', 'src-a', 'u', 'r', 'c', 'N:', 't', 1, 2)`,
      ).run();
    }).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('allows at most one primary source per article', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');
    addSource(db, 'a1:x', 'src-a', 1, 1);

    expect(() => addSource(db, 'a1:x', 'src-b', 1, 2)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('allows several non-primary sources for the same article', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');

    addSource(db, 'a1:x', 'src-a', 0, 1);
    addSource(db, 'a1:x', 'src-b', 0, 2);
    addSource(db, 'a1:x', 'src-c', 0, 3);

    const count = db.prepare('SELECT COUNT(*) AS c FROM article_sources').get() as { c: number };
    expect(count.c).toBe(3);
    db.close();
  });

  it('lets different articles each have their own primary source', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');
    seedArticle(db, 'a1:y');

    addSource(db, 'a1:x', 'src-a', 1, 1);
    addSource(db, 'a1:y', 'src-a', 1, 1);

    const count = db
      .prepare('SELECT COUNT(*) AS c FROM article_sources WHERE is_primary = 1')
      .get() as {
      c: number;
    };
    expect(count.c).toBe(2);
    db.close();
  });

  it('rejects a duplicate source_order within the same article', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');

    addSource(db, 'a1:x', 'src-a', 0, 1);

    expect(() => addSource(db, 'a1:x', 'src-b', 0, 1)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('allows the same source_order for different articles', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');
    seedArticle(db, 'a1:y');

    addSource(db, 'a1:x', 'src-a', 0, 1);
    addSource(db, 'a1:y', 'src-a', 0, 1);

    const count = db.prepare('SELECT COUNT(*) AS c FROM article_sources').get() as { c: number };
    expect(count.c).toBe(2);
    db.close();
  });

  it('uses provenance_id as the article_sources primary key', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    const primaryKeyColumns = (
      db.prepare('PRAGMA table_info(article_sources)').all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((column) => column.pk > 0)
      .map((column) => column.name);

    expect(primaryKeyColumns).toEqual(['provenance_id']);
    db.close();
  });

  it('allows the same three-column prefix when the guid key differs', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');

    addSource(db, 'a1:x', 'src-a', 0, 1, 'N:');
    addSource(db, 'a1:x', 'src-a', 0, 2, 'V:other-guid');

    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM article_sources
         WHERE article_id = 'a1:x' AND source_id = 'src-a' AND canonical_url = 'https://example.com/src-a'`,
      )
      .get() as { c: number };
    expect(count.c).toBe(2);
    db.close();
  });

  it('rejects a duplicate four-column identity', () => {
    const db = migrated(new DatabaseSync(':memory:'));
    seedArticle(db, 'a1:x');

    addSource(db, 'a1:x', 'src-a', 0, 1, 'N:');

    expect(() => addSource(db, 'a1:x', 'src-a', 0, 2, 'N:')).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});

describe('migration v3 — provenance identity and source_order', () => {
  /**
   * Builds a database at v2 with the supplied legacy provenance rows, then runs
   * only the v3 migration so the backfill can be observed in isolation.
   */
  function databaseAtVersionTwo(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, [INITIAL_MIGRATION, INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION]);
    return db;
  }

  function insertArticleAtVersionTwo(db: DatabaseSync, id: string, insertedOrder: number): void {
    db.prepare(
      `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, 'T', 'u', ?, 0, '2026-11-19T12:00:00.000Z', ?)`,
    ).run(id, `https://example.com/${id}`, insertedOrder);
  }

  function insertProvenanceAtVersionTwo(
    db: DatabaseSync,
    row: {
      articleId: string;
      sourceId: string;
      canonicalUrl: string;
      guid: string | null;
      firstSeenAt: string;
      isPrimary: 0 | 1;
      sourceName?: string | null;
      sourceUrl?: string | null;
      url?: string;
      resolvedUrl?: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO article_sources
         (article_id, source_id, url, resolved_url, canonical_url, guid,
          source_name, source_url, first_seen_at, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.articleId,
      row.sourceId,
      row.url ?? 'https://example.com/feed',
      row.resolvedUrl ?? 'https://example.com/resolved',
      row.canonicalUrl,
      row.guid,
      row.sourceName ?? null,
      row.sourceUrl ?? null,
      row.firstSeenAt,
      row.isPrimary,
    );
  }

  function migrateToVersionThree(db: DatabaseSync): void {
    runMigrations(db, [PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION]);
  }

  it('encodes a null guid as N:', () => {
    const db = databaseAtVersionTwo();
    insertArticleAtVersionTwo(db, 'a1:x', 1);
    insertProvenanceAtVersionTwo(db, {
      articleId: 'a1:x',
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/c',
      guid: null,
      firstSeenAt: '2026-11-19T12:00:00.000Z',
      isPrimary: 0,
    });

    migrateToVersionThree(db);

    const row = db.prepare('SELECT guid_key FROM article_sources').get() as { guid_key: string };
    expect(row.guid_key).toBe('N:');
    db.close();
  });

  it('encodes an empty guid as V:', () => {
    const db = databaseAtVersionTwo();
    insertArticleAtVersionTwo(db, 'a1:x', 1);
    insertProvenanceAtVersionTwo(db, {
      articleId: 'a1:x',
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/c',
      guid: '',
      firstSeenAt: '2026-11-19T12:00:00.000Z',
      isPrimary: 0,
    });

    migrateToVersionThree(db);

    const row = db.prepare('SELECT guid_key FROM article_sources').get() as { guid_key: string };
    expect(row.guid_key).toBe('V:');
    db.close();
  });

  it('prefixes a non-empty guid with V:', () => {
    const db = databaseAtVersionTwo();
    insertArticleAtVersionTwo(db, 'a1:x', 1);
    insertProvenanceAtVersionTwo(db, {
      articleId: 'a1:x',
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/c',
      guid: 'guid-123',
      firstSeenAt: '2026-11-19T12:00:00.000Z',
      isPrimary: 0,
    });

    migrateToVersionThree(db);

    const row = db.prepare('SELECT guid_key FROM article_sources').get() as { guid_key: string };
    expect(row.guid_key).toBe('V:guid-123');
    db.close();
  });

  it('keeps a null guid distinct from an empty guid', () => {
    const db = databaseAtVersionTwo();
    insertArticleAtVersionTwo(db, 'a1:x', 1);
    insertProvenanceAtVersionTwo(db, {
      articleId: 'a1:x',
      sourceId: 'src-null',
      canonicalUrl: 'https://example.com/null',
      guid: null,
      firstSeenAt: '2026-11-19T12:00:00.000Z',
      isPrimary: 0,
    });
    insertProvenanceAtVersionTwo(db, {
      articleId: 'a1:x',
      sourceId: 'src-empty',
      canonicalUrl: 'https://example.com/empty',
      guid: '',
      firstSeenAt: '2026-11-19T12:00:00.000Z',
      isPrimary: 0,
    });

    migrateToVersionThree(db);

    const rows = db
      .prepare('SELECT source_id, guid_key FROM article_sources ORDER BY source_id')
      .all() as Array<{ source_id: string; guid_key: string }>;
    expect(rows).toEqual([
      { source_id: 'src-empty', guid_key: 'V:' },
      { source_id: 'src-null', guid_key: 'N:' },
    ]);
    db.close();
  });
});

describe('migration v3 — data preservation', () => {
  function databaseAtVersionTwo(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, [INITIAL_MIGRATION, INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION]);
    return db;
  }

  it('carries every provenance row into v3 unchanged', () => {
    const db = databaseAtVersionTwo();
    db.prepare(
      `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES ('a1:x', 'T', 'u', 'https://example.com/a1', 0, '2026-11-19T12:00:00.000Z', 1)`,
    ).run();

    const insert = (row: {
      sourceId: string;
      canonicalUrl: string;
      guid: string | null;
      sourceName: string | null;
      sourceUrl: string | null;
      isPrimary: 0 | 1;
    }): void => {
      db.prepare(
        `INSERT INTO article_sources
           (article_id, source_id, url, resolved_url, canonical_url, guid,
            source_name, source_url, first_seen_at, is_primary)
         VALUES ('a1:x', ?, 'https://example.com/feed', 'https://example.com/resolved',
                 ?, ?, ?, ?, '2026-11-19T12:00:00.000Z', ?)`,
      ).run(row.sourceId, row.canonicalUrl, row.guid, row.sourceName, row.sourceUrl, row.isPrimary);
    };

    insert({
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/a',
      guid: null,
      sourceName: 'Feed A',
      sourceUrl: 'https://example.com/feed-a',
      isPrimary: 0,
    });
    insert({
      sourceId: 'src-b',
      canonicalUrl: 'https://example.com/b',
      guid: 'guid-b',
      sourceName: null,
      sourceUrl: null,
      isPrimary: 1,
    });
    insert({
      sourceId: 'src-c',
      canonicalUrl: 'https://example.com/c',
      guid: '',
      sourceName: 'Feed C',
      sourceUrl: 'https://example.com/feed-c',
      isPrimary: 0,
    });

    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM article_sources').get() as {
      c: number;
    };

    runMigrations(db, [PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION]);

    const rows = db
      .prepare(
        `SELECT provenance_id, source_id, url, resolved_url, canonical_url, guid, guid_key,
                source_name, source_url, is_primary, source_order
         FROM article_sources ORDER BY source_order`,
      )
      .all() as Array<{
      provenance_id: number;
      source_id: string;
      url: string;
      resolved_url: string;
      canonical_url: string;
      guid: string | null;
      guid_key: string;
      source_name: string | null;
      source_url: string | null;
      is_primary: number;
      source_order: number;
    }>;

    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM article_sources').get() as {
      c: number;
    };

    expect(countAfter.c).toBe(countBefore.c);
    expect(rows).toHaveLength(3);

    // URL and GUID columns survive the table rebuild.
    expect(rows.map((row) => row.url)).toEqual([
      'https://example.com/feed',
      'https://example.com/feed',
      'https://example.com/feed',
    ]);
    expect(rows.map((row) => row.resolved_url)).toEqual([
      'https://example.com/resolved',
      'https://example.com/resolved',
      'https://example.com/resolved',
    ]);
    expect(rows.map((row) => row.guid)).toEqual([null, 'guid-b', '']);
    expect(rows.map((row) => row.canonical_url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);

    // Historical columns are carried over even though v3 never writes them.
    expect(rows.map((row) => row.source_name)).toEqual(['Feed A', null, 'Feed C']);
    expect(rows.map((row) => row.source_url)).toEqual([
      'https://example.com/feed-a',
      null,
      'https://example.com/feed-c',
    ]);

    // is_primary is copied verbatim rather than re-derived.
    expect(rows.map((row) => row.is_primary)).toEqual([0, 1, 0]);

    // source_order follows insertion (rowid) order, restarting at 1 per article.
    expect(rows.map((row) => row.source_order)).toEqual([1, 2, 3]);

    // provenance_id is populated and unique.
    const ids = rows.map((row) => row.provenance_id);
    expect(ids.every((id) => typeof id === 'number' && id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);

    db.close();
  });

  it('restarts source_order at 1 for each article', () => {
    const db = databaseAtVersionTwo();
    for (const [id, order] of [
      ['a1:x', 1],
      ['a1:y', 2],
    ] as const) {
      db.prepare(
        `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES (?, 'T', 'u', ?, 0, '2026-11-19T12:00:00.000Z', ?)`,
      ).run(id, `https://example.com/${id}`, order);
    }

    const insert = (articleId: string, sourceId: string): void => {
      db.prepare(
        `INSERT INTO article_sources
           (article_id, source_id, url, resolved_url, canonical_url, guid,
            first_seen_at, is_primary)
         VALUES (?, ?, 'u', 'r', ?, NULL, '2026-11-19T12:00:00.000Z', 0)`,
      ).run(articleId, sourceId, `https://example.com/${sourceId}`);
    };

    insert('a1:x', 'src-a');
    insert('a1:x', 'src-b');
    insert('a1:y', 'src-c');

    runMigrations(db, [PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION]);

    const rows = db
      .prepare(
        'SELECT article_id, source_id, source_order FROM article_sources ORDER BY article_id, source_order',
      )
      .all() as Array<{ article_id: string; source_id: string; source_order: number }>;

    expect(rows).toEqual([
      { article_id: 'a1:x', source_id: 'src-a', source_order: 1 },
      { article_id: 'a1:x', source_id: 'src-b', source_order: 2 },
      { article_id: 'a1:y', source_id: 'src-c', source_order: 1 },
    ]);
    db.close();
  });
});

describe('migration v2 — idempotency and rollback', () => {
  it('does not re-run v2 on a second open', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'twice-v2.db');

    openTrackedDatabase(path).close();
    const handle = openTrackedDatabase(path);

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM schema_migrations'),
    ) as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
    expect(handle.version).toBe(LATEST_VERSION);
    handle.close();
  });

  it('rolls back the whole v2 migration when a statement fails', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [INITIAL_MIGRATION]);
    const columnsBefore = db.prepare('PRAGMA table_info(articles)').all() as Array<{
      name: string;
    }>;

    // A v2 whose unique index collides with the backfilled values.
    const brokenV2: Migration = {
      version: 2,
      name: 'broken_v2',
      statements: [
        'ALTER TABLE articles ADD COLUMN inserted_order INTEGER NOT NULL DEFAULT 0',
        'CREATE UNIQUE INDEX idx_broken ON articles (inserted_order)',
        'THIS IS NOT VALID SQL',
      ],
    };

    expect(() => runMigrations(db, [INITIAL_MIGRATION, brokenV2])).toThrow(MigrationError);

    // The ALTER must not survive: no half-applied schema.
    const columnsAfter = db.prepare('PRAGMA table_info(articles)').all() as Array<{ name: string }>;
    expect(columnsAfter.map((column) => column.name)).toEqual(
      columnsBefore.map((column) => column.name),
    );
    expect(columnsAfter.map((column) => column.name)).not.toContain('inserted_order');
    expect(currentVersion(db)).toBe(1);
    db.close();
  });
});

describe('openDatabase — encapsulation', () => {
  it('does not expose the driver instance', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(Object.keys(handle)).not.toContain('db');
    expect((handle as unknown as Record<string, unknown>).db).toBeUndefined();
    handle.close();
  });

  it('runs queries through query()', () => {
    const handle = openDatabase({ path: ':memory:' });

    const tables = handle.query((connection) =>
      connection.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toContain('articles');
    handle.close();
  });

  it('commits a successful transaction', () => {
    const handle = openDatabase({ path: ':memory:' });

    handle.transaction((connection) => {
      connection.run(
        `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES ('a1:x', 'T', 'u', 'https://example.com/x', 0, 't', 1)`,
      );
    });

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(1);
    handle.close();
  });

  it('rolls back a failed transaction and rethrows the original error', () => {
    const handle = openDatabase({ path: ':memory:' });
    const failure = new Error('boom');

    expect(() =>
      handle.transaction((connection) => {
        connection.run(
          `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES ('a1:x', 'T', 'u', 'https://example.com/x', 0, 't', 1)`,
        );
        throw failure;
      }),
    ).toThrow(failure);

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(0);
    handle.close();
  });

  it('returns the value produced by the transaction callback', () => {
    const handle = openDatabase({ path: ':memory:' });

    const result = handle.transaction(() => 42);

    expect(result).toBe(42);
    handle.close();
  });

  it('rejects a nested transaction', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(() =>
      handle.transaction(() => {
        handle.transaction(() => undefined);
      }),
    ).toThrow(/Nested transactions are not supported/);

    handle.close();
  });

  it('rejects queries and transactions after close', () => {
    const handle = openDatabase({ path: ':memory:' });
    handle.close();

    expect(() => handle.query((connection) => connection.get('SELECT 1'))).toThrow(
      DatabaseClosedError,
    );
    expect(() => handle.transaction(() => undefined)).toThrow(DatabaseClosedError);
  });

  it('reports isOpen correctly across the lifecycle', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(handle.isOpen).toBe(true);
    handle.close();
    expect(handle.isOpen).toBe(false);
  });

  it('tolerates being closed twice', () => {
    const handle = openDatabase({ path: ':memory:' });

    handle.close();

    expect(() => handle.close()).not.toThrow();
    expect(handle.isOpen).toBe(false);
  });
});

describe('SqliteTransactionError — rollback failure', () => {
  /** A connection whose ROLLBACK always throws. */
  function failingRollbackConnection(options: { failure: Error; rollbackFailure: unknown }) {
    const connection = {
      exec: (sql: string): void => {
        if (sql === 'ROLLBACK') {
          throw options.rollbackFailure;
        }
      },
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        run: () => undefined,
      }),
    };
    return connection;
  }

  it('keeps the original error as cause and exposes the rollback error', () => {
    const failure = new Error('original');
    const rollbackFailure = new Error('cannot rollback - no transaction is active');

    const connection = failingRollbackConnection({ failure, rollbackFailure });

    // Drive the same code path `transaction()` uses, without a real driver.
    let captured: unknown;
    try {
      connection.exec('BEGIN');
      throw failure;
    } catch (error) {
      let rollbackCause: unknown;
      let rollbackFailed = false;
      try {
        connection.exec('ROLLBACK');
      } catch (rollbackError) {
        rollbackFailed = true;
        rollbackCause = rollbackError;
      }
      captured = rollbackFailed ? new SqliteTransactionError(error, rollbackCause) : error;
    }

    expect(captured).toBeInstanceOf(SqliteTransactionError);
    expect((captured as SqliteTransactionError).cause).toBe(failure);
    expect((captured as SqliteTransactionError).rollbackCause).toBe(rollbackFailure);
  });
});

describe('openDatabase — error propagation', () => {
  it('lets MigrationVersionError through unwrapped', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'version.db');

    // Migrate the file to v2 using the real migration set.
    openDatabase({ path }).close();

    // Reopen with only v1 available: the database is newer than the code.
    let error: unknown;
    try {
      openDatabase({ path, migrations: [INITIAL_MIGRATION] });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MigrationVersionError);
    expect(error).not.toBeInstanceOf(DatabaseOpenError);
    expect((error as MigrationVersionError).databaseVersion).toBe(LATEST_VERSION);
    expect((error as MigrationVersionError).supportedVersion).toBe(INITIAL_MIGRATION.version);
  });

  it('still wraps a generic open failure in DatabaseOpenError', () => {
    const directory = temporaryDirectory();
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, 'not a directory');

    expect(() => openDatabase({ path: join(blocker, 'db.sqlite') })).toThrow(DatabaseOpenError);
  });

  it('closes the connection when initialisation fails', () => {
    let closeCalls = 0;
    const connection = {
      close: (): void => {
        closeCalls += 1;
      },
    };
    const failure = new Error('init failed');

    expect(() => abandonFailedOpen(connection, failure)).toThrow(DatabaseOpenError);

    expect(closeCalls).toBe(1);
  });

  it('keeps the original initialisation error when the close also fails', () => {
    const connection = {
      close: (): void => {
        throw new Error('close failed');
      },
    };
    const failure = new Error('init failed');

    let error: unknown;
    try {
      abandonFailedOpen(connection, failure);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DatabaseOpenError);
    expect((error as DatabaseOpenError).cause).toBe(failure);
  });

  it('closes the handle when a real migration fails on a real file database', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'migration-failure.db');

    const broken: Migration = {
      version: 1,
      name: 'broken',
      statements: ['CREATE TABLE half_applied (id TEXT PRIMARY KEY)', 'THIS IS NOT VALID SQL'],
    };

    let error: unknown;
    try {
      openDatabase({ path, migrations: [broken] });
    } catch (caught) {
      error = caught;
    }

    // The connection opened, the migration failed, and the caller is told so.
    expect(error).toBeInstanceOf(DatabaseOpenError);
    const cause = (error as DatabaseOpenError).cause;
    expect(cause).toBeInstanceOf(MigrationError);
    expect((cause as MigrationError).version).toBe(1);
    expect((cause as MigrationError).message).toContain('Migration 1 failed');

    // The failed open must have released its connection, so the file is usable
    // afterwards and already migrated to the current version.
    const reopened = openTrackedDatabase(path);
    try {
      expect(reopened.isOpen).toBe(true);
      expect(reopened.version).toBe(LATEST_VERSION);
      expect(reopened.query((query) => query.all('SELECT 1 AS ok'))).toEqual([{ ok: 1 }]);
    } finally {
      reopened.close();
    }

    expect(reopened.isOpen).toBe(false);
  });

  it('leaves no half-applied schema behind after a real migration failure', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'half-applied.db');

    const broken: Migration = {
      version: 1,
      name: 'broken',
      statements: ['CREATE TABLE half_applied (id TEXT PRIMARY KEY)', 'THIS IS NOT VALID SQL'],
    };

    expect(() => openDatabase({ path, migrations: [broken] })).toThrow(DatabaseOpenError);

    // The rollback must have removed the table created by the first statement,
    // so a later open does not see a schema the code never intended.
    const reopened = openTrackedDatabase(path);
    let tables: Array<{ name: string }>;
    try {
      tables = reopened.query((query) =>
        query.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
      ) as Array<{ name: string }>;
    } finally {
      reopened.close();
    }

    expect(tables.map((row) => row.name)).not.toContain('half_applied');
    expect(reopened.isOpen).toBe(false);
  });
});

describe('closeConnection', () => {
  it('marks the state closed when the driver closes', () => {
    const state = { closed: false };
    let calls = 0;

    closeConnection(state, {
      close: (): void => {
        calls += 1;
      },
    });

    expect(calls).toBe(1);
    expect(state.closed).toBe(true);
  });

  it('is a no-op once already closed', () => {
    const state = { closed: true };
    let calls = 0;

    closeConnection(state, {
      close: (): void => {
        calls += 1;
      },
    });

    expect(calls).toBe(0);
    expect(state.closed).toBe(true);
  });

  it('keeps the state open when the driver refuses to close', () => {
    const state = { closed: false };
    const failure = new Error('cannot close');

    expect(() =>
      closeConnection(state, {
        close: (): void => {
          throw failure;
        },
      }),
    ).toThrow(failure);

    // The resource state is unknown, so the handle must not claim to be closed.
    expect(state.closed).toBe(false);
  });
});

describe('transaction — async callback rejection', () => {
  const INSERT_ARTICLE = `INSERT INTO articles
      (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
    VALUES (?, 'T', 'u', ?, 0, 't', ?)`;

  it('rejects a callback that returns a promise', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(() =>
      handle.transaction(async () => {
        await Promise.resolve();
      }),
    ).toThrow(AsyncTransactionCallbackError);

    handle.close();
  });

  it('does not commit when the callback is async', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(() =>
      handle.transaction(async (connection) => {
        connection.run(INSERT_ARTICLE, ['a1:x', 'https://example.com/x', 1]);
        await Promise.resolve();
      }),
    ).toThrow(AsyncTransactionCallbackError);

    // The synchronous part ran inside the transaction, which was rolled back.
    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(0);
    handle.close();
  });

  it('leaves no data behind after rejecting an async callback', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(() =>
      handle.transaction(async (connection) => {
        connection.run(INSERT_ARTICLE, ['a1:one', 'https://example.com/1', 1]);
        await Promise.resolve();
        connection.run(INSERT_ARTICLE, ['a1:two', 'https://example.com/2', 2]);
      }),
    ).toThrow(AsyncTransactionCallbackError);

    const rows = handle.query((connection) => connection.all('SELECT id FROM articles')) as Array<{
      id: string;
    }>;
    expect(rows).toEqual([]);
    handle.close();
  });

  it('rejects a thenable that is not a real promise', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(() =>
      handle.transaction(() => ({ then: (): void => undefined }) as unknown as void),
    ).toThrow(AsyncTransactionCallbackError);

    handle.close();
  });

  it('invalidates the transaction connection once the callback has returned', () => {
    const handle = openDatabase({ path: ':memory:' });
    let escaped: SqliteTransaction | undefined;

    expect(() =>
      handle.transaction(async (connection) => {
        escaped = connection;
        await Promise.resolve();
      }),
    ).toThrow(AsyncTransactionCallbackError);

    // The callback is still suspended and holds its connection; it must not work.
    expect(() => escaped?.run(INSERT_ARTICLE, ['a1:late', 'https://example.com/late', 9])).toThrow(
      DatabaseClosedError,
    );

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(0);
    handle.close();
  });

  it('does not let a resumed async callback write outside the transaction', async () => {
    const handle = openDatabase({ path: ':memory:' });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let resumed: unknown;
    expect(() =>
      handle.transaction(async (connection) => {
        await gate;
        try {
          connection.run(INSERT_ARTICLE, ['a1:late', 'https://example.com/late', 9]);
          resumed = 'wrote';
        } catch (error) {
          resumed = error;
        }
      }),
    ).toThrow(AsyncTransactionCallbackError);

    // Let the suspended body continue after the transaction is already over.
    release?.();
    await gate;
    await Promise.resolve();

    expect(resumed).toBeInstanceOf(DatabaseClosedError);

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(0);
    handle.close();
  });

  it('still commits a synchronous callback', () => {
    const handle = openDatabase({ path: ':memory:' });

    const result = handle.transaction((connection) => {
      connection.run(INSERT_ARTICLE, ['a1:ok', 'https://example.com/ok', 1]);
      return 'committed';
    });

    expect(result).toBe('committed');
    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(1);
    handle.close();
  });

  it('allows a new transaction after an async callback was rejected', () => {
    const handle = openDatabase({ path: ':memory:' });

    expect(() => handle.transaction(async () => Promise.resolve())).toThrow(
      AsyncTransactionCallbackError,
    );

    expect(handle.transaction(() => 'ok')).toBe('ok');
    handle.close();
  });
});

describe('query — read-only guarantees', () => {
  it('does not expose run()', () => {
    const handle = openDatabase({ path: ':memory:' });

    handle.query((connection) => {
      expect((connection as unknown as Record<string, unknown>).run).toBeUndefined();
      return undefined;
    });
    handle.close();
  });

  it('cannot write through all() because the statement is wrapped, not filtered', () => {
    // Documents the actual boundary: `all`/`get` do not prevent a write. SQLite
    // executes `INSERT ... RETURNING` under `all()`, so the absence of `run` is a
    // convenience, not a security boundary. See the JSDoc on `SqliteQuery`.
    const handle = openDatabase({ path: ':memory:' });

    const returned = handle.query((connection) =>
      connection.all(
        `INSERT INTO articles
           (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES ('a1:q', 'T', 'u', 'https://example.com/q', 0, 't', 1)
         RETURNING id`,
      ),
    ) as Array<{ id: string }>;

    expect(returned).toEqual([{ id: 'a1:q' }]);
    handle.close();
  });
});

describe('transaction — async callback rejection is not left unhandled', () => {
  const INSERT_ARTICLE = `INSERT INTO articles
      (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
    VALUES (?, 'T', 'u', ?, 0, 't', ?)`;

  /**
   * Collects unhandled rejections for the duration of `body`.
   *
   * Rejections are reported on a later tick than the rejection itself, so the
   * listener is installed before the callback can resume and given two
   * `setImmediate` turns afterwards. No timers or sleeps are involved, so the
   * result does not depend on machine speed.
   */
  async function whileCollectingUnhandled(body: () => Promise<void>): Promise<unknown[]> {
    const collected: unknown[] = [];
    const listener = (reason: unknown): void => {
      collected.push(reason);
    };

    process.on('unhandledRejection', listener);
    try {
      await body();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listener);
    }
    return collected;
  }

  it('handles a rejection that happens after the transaction was rejected', async () => {
    const handle = openDatabase({ path: ':memory:' });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callbackFailure = new Error('Async operation failed');

    const unhandled = await whileCollectingUnhandled(async () => {
      let thrown: unknown;
      try {
        handle.transaction(async (connection) => {
          connection.run(INSERT_ARTICLE, ['a1:x', 'https://example.com/x', 1]);
          await gate;
          throw callbackFailure;
        });
      } catch (error) {
        thrown = error;
      }

      // The transaction rejected synchronously, before the callback resumed.
      expect(thrown).toBeInstanceOf(AsyncTransactionCallbackError);

      // Only now let the callback continue and reject.
      release?.();
      await gate;
      await Promise.resolve();
    });

    expect(unhandled).toEqual([]);
    expect(callbackFailure).toBeInstanceOf(Error);

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(0);
    handle.close();
  });

  it('does not leave a rejection unhandled for a callback that rejects immediately', async () => {
    const handle = openDatabase({ path: ':memory:' });

    const unhandled = await whileCollectingUnhandled(async () => {
      expect(() =>
        handle.transaction(async () => {
          throw new Error('Async operation failed');
        }),
      ).toThrow(AsyncTransactionCallbackError);
      await Promise.resolve();
    });

    expect(unhandled).toEqual([]);
    handle.close();
  });

  it('reports AsyncTransactionCallbackError even when the callback rejects later', async () => {
    const handle = openDatabase({ path: ':memory:' });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let thrown: unknown;
    try {
      handle.transaction(async () => {
        await gate;
        throw new Error('Async operation failed');
      });
    } catch (error) {
      thrown = error;
    }

    release?.();
    await gate;
    await Promise.resolve();

    // The callback's own error never becomes the transaction's error.
    expect(thrown).toBeInstanceOf(AsyncTransactionCallbackError);
    expect((thrown as Error).message).not.toContain('Async operation failed');
    handle.close();
  });

  it('keeps the rollback error when the rollback also fails', () => {
    const handle = openDatabase({ path: ':memory:' });
    const failure = new Error('original');

    // Closing the handle mid-transaction makes the ROLLBACK itself fail, which
    // exercises the real path rather than constructing the error by hand.
    let caught: unknown;
    try {
      handle.transaction((connection) => {
        connection.run(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES ('a1:r', 'T', 'u', 'https://example.com/r', 0, 't', 1)`,
        );
        handle.close();
        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqliteTransactionError);
    expect((caught as SqliteTransactionError).cause).toBe(failure);
    expect((caught as SqliteTransactionError).rollbackCause).toBeInstanceOf(Error);
  });
});

describe('transaction — thenable edge cases', () => {
  it('rolls back when the then getter throws', () => {
    const handle = openDatabase({ path: ':memory:' });
    const thenable = {
      get then(): never {
        throw new Error('then getter exploded');
      },
    };

    // Reading `then` throws inside the callback's return path, so the error
    // surfaces from the transaction and the write is rolled back.
    expect(() =>
      handle.transaction((connection) => {
        connection.run(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES ('a1:g', 'T', 'u', 'https://example.com/g', 0, 't', 1)`,
        );
        return thenable as unknown as void;
      }),
    ).toThrow('then getter exploded');

    const count = handle.query((connection) =>
      connection.get('SELECT COUNT(*) AS c FROM articles'),
    ) as { c: number };
    expect(count.c).toBe(0);
    handle.close();
  });

  it('rejects a thenable whose then() throws synchronously', () => {
    const handle = openDatabase({ path: ':memory:' });
    const thenable = {
      then: (): never => {
        throw new Error('then invocation exploded');
      },
    };

    expect(() => handle.transaction(() => thenable as unknown as void)).toThrow(
      AsyncTransactionCallbackError,
    );

    // A new transaction still works, so the handle was left consistent.
    expect(handle.transaction(() => 'ok')).toBe('ok');
    handle.close();
  });

  it('rejects a thenable that never settles without hanging', () => {
    const handle = openDatabase({ path: ':memory:' });
    const thenable = { then: (): void => undefined };

    // The transaction must not wait for the thenable to settle.
    expect(() => handle.transaction(() => thenable as unknown as void)).toThrow(
      AsyncTransactionCallbackError,
    );

    expect(handle.transaction(() => 'ok')).toBe('ok');
    handle.close();
  });
});
