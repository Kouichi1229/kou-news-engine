import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTICLE_CONTENTS_BODY_RETENTION_MIGRATION,
  MIGRATIONS,
  runMigrations,
} from '../../../../src/core/persistence/migrations.js';
import { openDatabase, type SqliteDatabase } from '../../../../src/core/persistence/sqlite.js';

/**
 * Schema-level tests for the v7 body-retention migration.
 *
 * The interesting question is not the columns — v7 does not change them — but the
 * two shapes it adds: a `failed` row and an `in_progress` row that both carry a
 * body. Those are asserted directly against the CHECK expression, plus the
 * rebuild's one real risk: that rows written under v6 survive it.
 */
let database: SqliteDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function openMigrated(): SqliteDatabase {
  database = openDatabase({ path: ':memory:' });
  return database;
}

const INSERT = `INSERT INTO article_contents
  (article_id, status, content_text, content_length, extracted_at, final_url,
   extractor_version, failure_code, http_status, attempts,
   lease_owner, lease_token, lease_expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

type Row = [
  status: string,
  contentText: string | null,
  contentLength: number,
  extractedAt: string | null,
  finalUrl: string | null,
  extractorVersion: string,
  failureCode: string | null,
  httpStatus: number | null,
  attempts: number,
  leaseOwner: string | null,
  leaseToken: string | null,
  leaseExpiresAt: number | null,
];

const BODY = '一段已抓取的新聞正文';
const BODY_LENGTH = [...BODY].length;

function insertRow(handle: SqliteDatabase, articleId: string, row: Row): void {
  handle.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, 'T', ?, ?, 0, '2026-01-01T00:00:00Z', 1)`,
      [articleId, `https://example.com/${articleId}`, `https://example.com/${articleId}`],
    );
    connection.all(INSERT, [articleId, ...row]);
  });
}

const storedBody: Row = [
  'failed',
  BODY,
  BODY_LENGTH,
  '2026-02-01T00:00:00Z',
  'https://example.com/a1',
  'v1',
  'DERIVATION_FAILED',
  200,
  1,
  null,
  null,
  null,
];

describe('v7 article_contents body retention', () => {
  it('is registered and recorded once applied', () => {
    const handle = openMigrated();

    expect(MIGRATIONS).toContain(ARTICLE_CONTENTS_BODY_RETENTION_MIGRATION);

    const applied = handle.query((connection) =>
      connection.all('SELECT version, name FROM schema_migrations WHERE version = 7'),
    );

    expect(applied).toEqual([{ version: 7, name: 'article_contents_body_retention' }]);
  });

  it('keeps the v6 column set and its indexes', () => {
    const handle = openMigrated();

    const columns = handle.query((connection) =>
      connection.all("PRAGMA table_info('article_contents')"),
    ) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'article_id',
      'status',
      'content_text',
      'content_length',
      'extracted_at',
      'final_url',
      'extractor_version',
      'failure_code',
      'http_status',
      'attempts',
      'lease_owner',
      'lease_token',
      'lease_expires_at',
    ]);

    const indexes = handle.query((connection) =>
      connection.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'article_contents' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    ) as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      'idx_article_contents_claimable',
      'idx_article_contents_lease_token',
    ]);
  });

  it('carries v6 rows through the rebuild', () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 6),
      );
      db.exec(
        `INSERT INTO articles
           (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES ('a1', 'T', 'https://example.com/a1', 'https://example.com/a1', 0,
                 '2026-01-01T00:00:00Z', 1)`,
      );
      db.prepare(INSERT).run(
        'a1',
        'extracted',
        BODY,
        BODY_LENGTH,
        '2026-02-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        null,
        null,
        null,
      );

      runMigrations(db, MIGRATIONS);

      const row = db
        .prepare('SELECT status, content_text, failure_code FROM article_contents')
        .get() as { status: string; content_text: string; failure_code: string | null };
      expect(row).toEqual({ status: 'extracted', content_text: BODY, failure_code: null });
    } finally {
      db.close();
    }
  });
});

describe('v7 accepted shapes', () => {
  it('accepts a failed row that kept the body it fetched', () => {
    const handle = openMigrated();

    expect(() => {
      insertRow(handle, 'a1', storedBody);
    }).not.toThrow();
  });

  it('accepts an in_progress row that inherited a stored body', () => {
    const handle = openMigrated();

    expect(() => {
      insertRow(handle, 'a1', [
        'in_progress',
        BODY,
        BODY_LENGTH,
        '2026-02-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        'PENDING',
        200,
        1,
        'worker:1',
        'token-1',
        1_900_000_000_000,
      ]);
    }).not.toThrow();
  });

  it('still accepts a failed row that fetched nothing', () => {
    const handle = openMigrated();

    expect(() => {
      insertRow(handle, 'a1', [
        'failed',
        null,
        0,
        null,
        null,
        'v1',
        'HTTP_404',
        404,
        1,
        null,
        null,
        null,
      ]);
    }).not.toThrow();
  });
});

describe('v7 rejected shapes', () => {
  it('rejects a retained body whose length does not match', () => {
    const handle = openMigrated();

    expect(() => {
      insertRow(handle, 'a1', [
        'failed',
        BODY,
        BODY_LENGTH + 1,
        '2026-02-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        'DERIVATION_FAILED',
        200,
        1,
        null,
        null,
        null,
      ]);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects a retained body without the extraction metadata', () => {
    const handle = openMigrated();

    expect(() => {
      insertRow(handle, 'a1', [
        'failed',
        BODY,
        BODY_LENGTH,
        null,
        'https://example.com/a1',
        'v1',
        'DERIVATION_FAILED',
        200,
        1,
        null,
        null,
        null,
      ]);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an in_progress row whose body has no fetch status', () => {
    const handle = openMigrated();

    expect(() => {
      insertRow(handle, 'a1', [
        'in_progress',
        BODY,
        BODY_LENGTH,
        '2026-02-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        'PENDING',
        null,
        1,
        'worker:1',
        'token-1',
        1_900_000_000_000,
      ]);
    }).toThrow(/CHECK constraint failed/);
  });
});
