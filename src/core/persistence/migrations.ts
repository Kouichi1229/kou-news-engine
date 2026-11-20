import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  /** Strictly increasing, unique. Recorded in `schema_migrations`. */
  readonly version: number;
  readonly name: string;
  /** Applied in order, all inside one transaction. */
  readonly statements: readonly string[];
}

/**
 * Thrown when the database was migrated by a newer build than this one.
 *
 * Running older code against a newer schema cannot be made safe: there are no
 * down migrations, and the old code does not know the new constraints. Failing
 * fast keeps the damage visible at startup instead of at the first bad write.
 */
export class MigrationVersionError extends Error {
  readonly databaseVersion: number;
  readonly supportedVersion: number;

  constructor(databaseVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${databaseVersion} is newer than the supported version ${supportedVersion}`,
    );
    this.name = 'MigrationVersionError';
    this.databaseVersion = databaseVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class MigrationError extends Error {
  readonly version: number;
  /** `true` when the rollback threw. Tracked separately because `throw undefined` is legal. */
  readonly rollbackFailed: boolean;
  /** Value thrown by the rollback. Meaningful only when `rollbackFailed` is `true`. */
  readonly rollbackCause: unknown;

  constructor(version: number, cause: unknown, rollbackFailed = false, rollbackCause?: unknown) {
    super(
      rollbackFailed
        ? `Migration ${version} failed and the rollback also failed`
        : `Migration ${version} failed and was rolled back`,
      { cause },
    );
    this.name = 'MigrationError';
    this.version = version;
    this.rollbackFailed = rollbackFailed;
    this.rollbackCause = rollbackCause;
  }
}

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/**
 * D6-1 initial schema.
 *
 * Only the tables required for today's persistence exist here. Translation,
 * summary, briefing and delivery tables are deliberately absent: each is added
 * by the migration that first needs it.
 *
 * `articles.tags` is TEXT holding a JSON array. The `Article.tags` contract
 * keeps the original order and keeps duplicates, so a normalised tag table
 * would lose both. `article_sources` is append-only by primary-key design:
 * re-ingesting an article inserts nothing new rather than replacing rows.
 */
export const INITIAL_MIGRATION: Migration = {
  version: 1,
  name: 'initial_schema',
  statements: [
    `CREATE TABLE articles (
      id                        TEXT    PRIMARY KEY NOT NULL,
      title                     TEXT    NOT NULL,
      url                       TEXT    NOT NULL,
      canonical_url             TEXT    NOT NULL UNIQUE,
      published_at              TEXT        NULL,
      published_at_is_estimated INTEGER NOT NULL CHECK (published_at_is_estimated IN (0, 1)),
      fetched_at                TEXT    NOT NULL,
      summary_raw               TEXT        NULL,
      summary_text              TEXT        NULL,
      published_at_raw          TEXT        NULL,
      guid                      TEXT        NULL,
      author                    TEXT        NULL,
      language                  TEXT        NULL,
      tags                      TEXT        NULL,
      image_url                 TEXT        NULL
    )`,
    `CREATE INDEX idx_articles_published_at ON articles (published_at)`,
    `CREATE INDEX idx_articles_fetched_at ON articles (fetched_at)`,
    `CREATE TABLE article_sources (
      article_id    TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
      source_id     TEXT NOT NULL,
      url           TEXT NOT NULL,
      resolved_url  TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      guid          TEXT     NULL,
      source_name   TEXT     NULL,
      source_url    TEXT     NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (article_id, source_id, canonical_url)
    )`,
    `CREATE INDEX idx_article_sources_source_id ON article_sources (source_id)`,
  ],
};

/**
 * v2: insertion order for `articles`, and a primary-source marker for
 * `article_sources`.
 *
 * `inserted_order` restores the ordering guarantee `ArticleRepository.findAll()`
 * makes. A table has no inherent row order, so the order is materialised here.
 * Existing rows are backfilled from `rowid`, which is the order they were
 * inserted. `DEFAULT 0` exists only because `ALTER TABLE` cannot add a NOT NULL
 * column without one; every new row must supply a value explicitly. Otherwise
 * the first such row silently takes 0 and sorts ahead of every backfilled row,
 * and the second fails on the unique index.
 *
 * `is_primary` marks which provenance row is the article's primary source.
 * Existing rows keep 0: the primary source cannot be derived from stored data,
 * so the migration deliberately does not guess.
 */
export const INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION: Migration = {
  version: 2,
  name: 'insertion_order_and_primary_source',
  statements: [
    `ALTER TABLE articles ADD COLUMN inserted_order INTEGER NOT NULL DEFAULT 0`,
    `UPDATE articles
        SET inserted_order = (
          SELECT ranked.position
            FROM (SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY rowid) AS position
                    FROM articles) AS ranked
           WHERE ranked.rid = articles.rowid
        )`,
    `CREATE UNIQUE INDEX idx_articles_inserted_order ON articles (inserted_order)`,
    `ALTER TABLE article_sources ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
       CHECK (is_primary IN (0, 1))`,
    `CREATE UNIQUE INDEX idx_article_sources_primary
       ON article_sources (article_id) WHERE is_primary = 1`,
  ],
};

/**
 * v3: provenance identity and explicit source ordering for `article_sources`.
 *
 * The v1/v2 primary key `(article_id, source_id, canonical_url)` cannot hold two
 * records that differ only by GUID, yet the ingestion layer legitimately emits
 * exactly that. Rebuilding the table under a surrogate `provenance_id` lifts the
 * limitation without dropping anything.
 *
 * `guid_key` is the identity component for the GUID, encoded so that "no GUID"
 * and "empty GUID" stay distinguishable while both remain comparable. A plain
 * nullable `guid` column cannot serve: SQL treats `NULL != NULL`, so a unique
 * index over it would accept unlimited duplicates of the no-GUID case.
 *
 * `source_order` records the position of each provenance row within its article,
 * which is the order `Article.sources` was written in. It is backfilled from
 * `rowid` — the only ordering signal stored so far — and restarts at 1 for each
 * article. `is_primary` is copied verbatim: the original primary cannot be
 * derived from the data, so the migration does not re-derive it.
 *
 * The table is rebuilt rather than altered because SQLite cannot change a
 * primary key in place. Every historical column is carried over, including
 * `source_name` and `source_url`.
 */
export const PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION: Migration = {
  version: 3,
  name: 'provenance_identity_and_source_order',
  statements: [
    `CREATE TABLE article_sources_v3 (
      provenance_id INTEGER PRIMARY KEY,
      article_id    TEXT    NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
      source_id     TEXT    NOT NULL,
      url           TEXT    NOT NULL,
      resolved_url  TEXT    NOT NULL,
      canonical_url TEXT    NOT NULL,
      guid_key      TEXT    NOT NULL,
      guid          TEXT        NULL,
      source_name   TEXT        NULL,
      source_url    TEXT        NULL,
      first_seen_at TEXT    NOT NULL,
      source_order  INTEGER NOT NULL,
      is_primary    INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))
    )`,
    `INSERT INTO article_sources_v3
       (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid,
        source_name, source_url, first_seen_at, source_order, is_primary)
     SELECT article_id, source_id, url, resolved_url, canonical_url,
            CASE WHEN guid IS NULL THEN 'N:' ELSE 'V:' || guid END,
            guid, source_name, source_url, first_seen_at,
            ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY rowid),
            is_primary
       FROM article_sources`,
    `DROP TABLE article_sources`,
    `ALTER TABLE article_sources_v3 RENAME TO article_sources`,
    `CREATE UNIQUE INDEX idx_article_sources_identity
       ON article_sources (article_id, source_id, canonical_url, guid_key)`,
    `CREATE UNIQUE INDEX idx_article_sources_order
       ON article_sources (article_id, source_order)`,
    `CREATE UNIQUE INDEX idx_article_sources_primary
       ON article_sources (article_id) WHERE is_primary = 1`,
    `CREATE INDEX idx_article_sources_source_id ON article_sources (source_id)`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [
  INITIAL_MIGRATION,
  INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION,
  PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION,
];

function validateMigrations(migrations: readonly Migration[]): void {
  const seen = new Set<number>();

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Migration version must be a positive integer: ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);
  }
}

function highestVersion(versions: Iterable<number>): number {
  let highest = 0;
  for (const version of versions) {
    if (version > highest) {
      highest = version;
    }
  }
  return highest;
}

function appliedVersions(db: DatabaseSync): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((row) => row.version));
}

/**
 * Applies every pending migration in ascending version order.
 *
 * Each migration runs inside its own transaction together with the row that
 * records it, so a failure leaves neither partial schema nor a false record.
 * Already-applied versions are skipped, which makes repeated initialisation a
 * no-op rather than an error.
 *
 * @returns the number of migrations applied by this call.
 * @throws MigrationVersionError when the database is newer than this build.
 * @throws MigrationError when a migration fails; the original error is `cause`.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = (): Date => new Date(),
): number {
  validateMigrations(migrations);

  db.exec(CREATE_MIGRATIONS_TABLE);
  const applied = appliedVersions(db);

  // Compared by version number, not by how many migrations exist: a database
  // migrated by a newer build has a higher version but no pending work here.
  const databaseVersion = highestVersion(applied);
  const supportedVersion = highestVersion(migrations.map((migration) => migration.version));

  if (databaseVersion > supportedVersion) {
    throw new MigrationVersionError(databaseVersion, supportedVersion);
  }

  const pending = [...migrations]
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        now().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      // A failed rollback must not replace the error that actually caused the
      // migration to abort, so it is captured separately instead of thrown.
      // `rollbackFailed` is tracked as a flag rather than inferred from the
      // thrown value, because `throw undefined` would otherwise look like success.
      let rollbackFailed = false;
      let rollbackCause: unknown;
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        rollbackFailed = true;
        rollbackCause = rollbackError;
      }
      throw new MigrationError(migration.version, error, rollbackFailed, rollbackCause);
    }
  }

  return pending.length;
}

export function currentVersion(db: DatabaseSync): number {
  db.exec(CREATE_MIGRATIONS_TABLE);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
}
