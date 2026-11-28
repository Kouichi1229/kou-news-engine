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

/**
 * v4: article extraction state.
 *
 * One row per article, created lazily by `SEED` rather than backfilled, so this
 * migration stays a pure schema change.
 *
 * ## Why the CHECK constraints are this dense
 *
 * The four states are mutually exclusive and each has a complete field matrix.
 * Expressing that as one disjunction makes every illegal combination
 * unrepresentable, which is what lets the service treat a successful write as
 * proof that the row is coherent. Anything the schema cannot express — fencing,
 * lease expiry, "the request was never issued" — stays in the service and is
 * documented there rather than pretended to be a constraint.
 *
 * Two classes of constraint here are easy to get wrong and are deliberate:
 *
 * - `typeof(...) = 'integer'`. SQLite's INTEGER affinity does **not** coerce
 *   `1.5`: it stores REAL and `BETWEEN 0 AND 3` accepts it. Without the
 *   `typeof` guard `attempts = 1.5` would pass.
 * - `instr(content_text, char(0)) = 0`. SQLite's `length()` stops counting at
 *   the first NUL, so a body containing one would satisfy
 *   `content_length = length(content_text)` with a length that is too small.
 *   The normaliser removes NUL; this is the backstop.
 *
 * `empty` records `extracted_at`: it is a completed extraction that found
 * nothing, not an attempt that did not finish.
 */
export const ARTICLE_CONTENTS_MIGRATION: Migration = {
  version: 4,
  name: 'article_contents',
  statements: [
    `CREATE TABLE article_contents (
      article_id        TEXT    PRIMARY KEY NOT NULL
                                REFERENCES articles (id) ON DELETE CASCADE,
      status            TEXT    NOT NULL
                                CHECK (status IN ('extracted','empty','failed','in_progress')),

      content_text      TEXT        NULL,
      content_length    INTEGER NOT NULL DEFAULT 0,
      extracted_at      TEXT        NULL,
      final_url         TEXT        NULL,
      extractor_version TEXT    NOT NULL,
      failure_code      TEXT        NULL,
      http_status       INTEGER     NULL,

      attempts          INTEGER NOT NULL DEFAULT 0,
      lease_owner       TEXT        NULL,
      lease_token       TEXT        NULL,
      lease_expires_at  INTEGER     NULL,

      CHECK (typeof(attempts) = 'integer'),
      CHECK (http_status IS NULL OR typeof(http_status) = 'integer'),
      CHECK (lease_expires_at IS NULL OR typeof(lease_expires_at) = 'integer'),
      CHECK (typeof(content_length) = 'integer'),
      CHECK (attempts BETWEEN 0 AND 3),
      CHECK (content_text IS NULL OR instr(content_text, char(0)) = 0),

      CHECK (
        (status = 'in_progress'
          AND content_text IS NULL AND content_length = 0
          AND extracted_at IS NULL AND final_url IS NULL
          AND failure_code IS 'PENDING' AND http_status IS NULL
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL)
     OR (status = 'extracted'
          AND content_text IS NOT NULL AND content_length > 0
          AND content_length = length(content_text)
          AND extracted_at IS NOT NULL AND final_url IS NOT NULL
          AND failure_code IS NULL
          AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
     OR (status = 'empty'
          AND content_text IS NULL AND content_length = 0
          AND extracted_at IS NOT NULL AND final_url IS NOT NULL
          AND failure_code IS NOT NULL
          AND failure_code IN ('NO_CONTENT','CONTENT_TOO_SHORT')
          AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
     OR (status = 'failed'
          AND content_text IS NULL AND content_length = 0
          AND extracted_at IS NULL AND final_url IS NULL
          AND failure_code IS NOT NULL
          AND failure_code NOT IN ('NO_CONTENT','CONTENT_TOO_SHORT')
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      )
    )`,
    `CREATE UNIQUE INDEX idx_article_contents_lease_token
       ON article_contents (lease_token) WHERE lease_token IS NOT NULL`,
    `CREATE INDEX idx_article_contents_claimable
       ON article_contents (status, extractor_version, attempts)`,
  ],
};

/**
 * v5: M7.0 Processing State (S1 §9, §10; `CLM-1`, `CLM-2`, `CLM-5`..`CLM-7`,
 * `CLM-10`, `CLM-12`, `CLM-18`, `CLM-19`; `A.1`, `A.2`, `A.10`).
 *
 * Two tables, separate from `articles` and from derived content (`CLM-14`):
 * the Article Lifecycle and one row per `(lifecycle, processing_version)`.
 *
 * ## Soft reference outward, real key inward
 *
 * `processing_lifecycle.article_id` carries **no** foreign key. `articles` and
 * its children cascade on delete, so a key here would delete processing history
 * — and with it the evidence a notification may still depend on — whenever the
 * 168-hour retention sweep ran (`A.10`, `OUT-26`).
 *
 * `processing_job` does reference its lifecycle, but **without** `ON DELETE
 * CASCADE`. Deleting a lifecycle row must not silently destroy job history:
 * when those rows are removed is undecided (`SPEC-GAP-15`, S1 §23 O-3), so the
 * schema makes the deletion deliberate instead of automatic.
 *
 * ## Terminality is a marker, not a state name
 *
 * `CLM-1` fixes `terminal_reason IS NOT NULL` as the terminal marker and
 * `CLM-2` excludes such rows from Claim. The four outcome *names* are **not**
 * encoded: the terminal-reason vocabulary is undecided (`CLM-9`, L-01), so the
 * column stores whatever marker the caller supplies and the CHECK only enforces
 * that a terminal row has one.
 *
 * `state` is limited to the three shapes this schema can actually verify —
 * `pending`, `running`, `terminal` — so an illegal combination is
 * unrepresentable rather than merely discouraged, following the v4 precedent.
 * A `pending` row has no lease and fewer than three attempts; a `running` row
 * has a complete lease and at least one attempt; a `terminal` row has a marker
 * and no lease. An exhausted job (`attempts = 3`) is therefore never `pending`:
 * it stays `running` until recovery terminalizes it (`CLM-8`, `CLM-13`), and it
 * can never be claimed again (`CLM-10`).
 *
 * `typeof(...) = 'integer'` guards repeat the v4 reasoning: SQLite's INTEGER
 * affinity stores `1.5` as REAL, and `BETWEEN 0 AND 3` would accept it.
 */
export const PROCESSING_STATE_MIGRATION: Migration = {
  version: 5,
  name: 'processing_state',
  statements: [
    `CREATE TABLE processing_lifecycle (
      lifecycle_id       TEXT    PRIMARY KEY NOT NULL,
      article_id         TEXT    NOT NULL,
      published_version  INTEGER NOT NULL DEFAULT 0,
      published_revision INTEGER NOT NULL DEFAULT 0,
      opened_at          TEXT    NOT NULL,
      closed_at          TEXT        NULL,
      abandoned_at       TEXT        NULL,
      CHECK (typeof(published_version) = 'integer'),
      CHECK (typeof(published_revision) = 'integer'),
      CHECK (published_version >= 0),
      CHECK (published_revision >= 0)
    )`,
    `CREATE UNIQUE INDEX idx_processing_lifecycle_open
       ON processing_lifecycle (article_id) WHERE closed_at IS NULL`,
    `CREATE TABLE processing_job (
      lifecycle_id       TEXT    NOT NULL
                                 REFERENCES processing_lifecycle (lifecycle_id),
      processing_version INTEGER NOT NULL,
      state              TEXT    NOT NULL
                                 CHECK (state IN ('pending','running','terminal')),
      attempts           INTEGER NOT NULL DEFAULT 0,
      lease_owner        TEXT        NULL,
      lease_token        TEXT        NULL,
      lease_expires_at   INTEGER     NULL,
      failure_code       TEXT        NULL,
      terminal_reason    TEXT        NULL,
      created_at         TEXT    NOT NULL,
      updated_at         TEXT    NOT NULL,

      PRIMARY KEY (lifecycle_id, processing_version),
      CHECK (typeof(processing_version) = 'integer'),
      CHECK (typeof(attempts) = 'integer'),
      CHECK (attempts BETWEEN 0 AND 3),
      CHECK (lease_expires_at IS NULL OR typeof(lease_expires_at) = 'integer'),

      CHECK (
        (state = 'pending'
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
          AND terminal_reason IS NULL AND attempts < 3)
     OR (state = 'running'
          AND attempts BETWEEN 1 AND 3
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND terminal_reason IS NULL)
     OR (state = 'terminal'
          AND terminal_reason IS NOT NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      )
    )`,
    `CREATE UNIQUE INDEX idx_processing_job_lease_token
       ON processing_job (lease_token) WHERE lease_token IS NOT NULL`,
    `CREATE INDEX idx_processing_job_claimable
       ON processing_job (state, processing_version, attempts)`,
  ],
};

/**
 * D6-style migration: the latest-only AI-derived record.
 *
 * `article_id` is a **plain value, not a foreign key** (`SPEC-GAP-15`, Appendix
 * A.10 of the M7.0 register). Original content expires at 168 hours while
 * derived content lives for 720, and `RET-5` forbids original-content expiry
 * from cascade-deleting unexpired derived content, so an `ON DELETE CASCADE`
 * here would break retention: the article row going away must not take the
 * Traditional Chinese title and summary with it.
 *
 * The primary key on `article_id` makes the record 1:1 with the article and
 * therefore latest-only. Whether derived content needs version history is still
 * open (`SPEC-GAP-04`); if it does, the next migration adds the version column
 * rather than this one guessing at it.
 *
 * `title_zh` and `summary_zh` are required and non-empty: a row without either
 * cannot serve as a notification source, and the empty string is not a value a
 * producer can legitimately mean here.
 */
export const ARTICLE_DERIVED_MIGRATION: Migration = {
  version: 6,
  name: 'article_derived',
  statements: [
    `CREATE TABLE article_derived (
      article_id  TEXT PRIMARY KEY NOT NULL,
      title_zh    TEXT NOT NULL,
      summary_zh  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,

      CHECK (length(title_zh) > 0),
      CHECK (length(summary_zh) > 0)
    )`,
  ],
};

/**
 * v7: keep a fetched body across a derivation retry.
 *
 * ## What changed and why
 *
 * v4's matrix required `failed` and `in_progress` rows to hold no body at all,
 * so an attempt that fetched and parsed a body but failed afterwards (the model
 * call, its output contract) had to discard it, and the retry paid for the same
 * request again. The body is the expensive half of the work, so both states now
 * admit a second, complete shape: the body columns present and self-consistent.
 *
 * What each shape means:
 *
 * - `in_progress` with a body — this attempt inherited a body an earlier attempt
 *   fetched at the same extractor version, so only the derived record is missing;
 * - `failed` with a body — the fetch succeeded and the attempt failed afterwards,
 *   with the body kept for the retry.
 *
 * The two shapes are otherwise identical, which is what makes them interchangeable
 * across a retry: the same columns are copied forward unchanged. A row without a
 * body keeps the v4 shape exactly, so fetch failures are unaffected.
 *
 * This is a rebuild rather than an `ALTER`: SQLite cannot alter a CHECK
 * constraint. The columns and their order are unchanged, so the copy is a plain
 * `INSERT ... SELECT`, and no row can fail the new constraints — every shape v4
 * allowed is still allowed.
 */
export const ARTICLE_CONTENTS_BODY_RETENTION_MIGRATION: Migration = {
  version: 7,
  name: 'article_contents_body_retention',
  statements: [
    `CREATE TABLE article_contents_v7 (
      article_id        TEXT    PRIMARY KEY NOT NULL
                                REFERENCES articles (id) ON DELETE CASCADE,
      status            TEXT    NOT NULL
                                CHECK (status IN ('extracted','empty','failed','in_progress')),

      content_text      TEXT        NULL,
      content_length    INTEGER NOT NULL DEFAULT 0,
      extracted_at      TEXT        NULL,
      final_url         TEXT        NULL,
      extractor_version TEXT    NOT NULL,
      failure_code      TEXT        NULL,
      http_status       INTEGER     NULL,

      attempts          INTEGER NOT NULL DEFAULT 0,
      lease_owner       TEXT        NULL,
      lease_token       TEXT        NULL,
      lease_expires_at  INTEGER     NULL,

      CHECK (typeof(attempts) = 'integer'),
      CHECK (http_status IS NULL OR typeof(http_status) = 'integer'),
      CHECK (lease_expires_at IS NULL OR typeof(lease_expires_at) = 'integer'),
      CHECK (typeof(content_length) = 'integer'),
      CHECK (attempts BETWEEN 0 AND 3),
      CHECK (content_text IS NULL OR instr(content_text, char(0)) = 0),

      CHECK (
        (status = 'in_progress'
          AND failure_code IS 'PENDING'
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND (
               (content_text IS NULL AND content_length = 0
                AND extracted_at IS NULL AND final_url IS NULL
                AND http_status IS NULL)
            OR (content_text IS NOT NULL AND content_length > 0
                AND content_length = length(content_text)
                AND extracted_at IS NOT NULL AND final_url IS NOT NULL
                AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299)
          ))
     OR (status = 'extracted'
          AND content_text IS NOT NULL AND content_length > 0
          AND content_length = length(content_text)
          AND extracted_at IS NOT NULL AND final_url IS NOT NULL
          AND failure_code IS NULL
          AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
     OR (status = 'empty'
          AND content_text IS NULL AND content_length = 0
          AND extracted_at IS NOT NULL AND final_url IS NOT NULL
          AND failure_code IS NOT NULL
          AND failure_code IN ('NO_CONTENT','CONTENT_TOO_SHORT')
          AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
     OR (status = 'failed'
          AND failure_code IS NOT NULL
          AND failure_code NOT IN ('NO_CONTENT','CONTENT_TOO_SHORT')
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
          AND (
               (content_text IS NULL AND content_length = 0
                AND extracted_at IS NULL AND final_url IS NULL)
            OR (content_text IS NOT NULL AND content_length > 0
                AND content_length = length(content_text)
                AND extracted_at IS NOT NULL AND final_url IS NOT NULL
                AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299)
          ))
      )
    )`,
    `INSERT INTO article_contents_v7
       (article_id, status, content_text, content_length, extracted_at, final_url,
        extractor_version, failure_code, http_status, attempts,
        lease_owner, lease_token, lease_expires_at)
     SELECT article_id, status, content_text, content_length, extracted_at, final_url,
            extractor_version, failure_code, http_status, attempts,
            lease_owner, lease_token, lease_expires_at
       FROM article_contents`,
    `DROP TABLE article_contents`,
    `ALTER TABLE article_contents_v7 RENAME TO article_contents`,
    `CREATE UNIQUE INDEX idx_article_contents_lease_token
       ON article_contents (lease_token) WHERE lease_token IS NOT NULL`,
    `CREATE INDEX idx_article_contents_claimable
       ON article_contents (status, extractor_version, attempts)`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [
  INITIAL_MIGRATION,
  INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION,
  PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION,
  ARTICLE_CONTENTS_MIGRATION,
  PROCESSING_STATE_MIGRATION,
  ARTICLE_DERIVED_MIGRATION,
  ARTICLE_CONTENTS_BODY_RETENTION_MIGRATION,
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
