import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTICLE_DERIVED_MIGRATION,
  MIGRATIONS,
} from '../../../../src/core/persistence/migrations.js';
import { openDatabase, type SqliteDatabase } from '../../../../src/core/persistence/sqlite.js';

/**
 * Schema-level tests for the v6 `article_derived` migration.
 *
 * They assert the table shape and the retention boundary directly, so a change
 * to the column set — or the accidental addition of a cascading foreign key —
 * fails here rather than in whichever module first writes a derived record.
 */
let database: SqliteDatabase;

function openMigratedDatabase(): SqliteDatabase {
  database = openDatabase({ path: ':memory:' });
  return database;
}

function insertArticle(handle: SqliteDatabase, id: string): void {
  handle.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', 1)`,
      [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`],
    );
  });
}

function insertDerived(
  handle: SqliteDatabase,
  articleId: string,
  titleZh = '繁體中文標題',
  summaryZh = '繁體中文短摘要',
): void {
  handle.query((connection) => {
    connection.all(
      `INSERT INTO article_derived (article_id, title_zh, summary_zh, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [articleId, titleZh, summaryZh],
    );
  });
}

afterEach(() => {
  if (database.isOpen) {
    database.close();
  }
});

describe('v6 article_derived migration', () => {
  it('is the latest migration and is recorded once applied', () => {
    const handle = openMigratedDatabase();

    expect(Math.max(...MIGRATIONS.map((migration) => migration.version))).toBe(
      ARTICLE_DERIVED_MIGRATION.version,
    );
    expect(handle.version).toBe(6);

    const applied = handle.query((connection) =>
      connection.all('SELECT version, name FROM schema_migrations WHERE version = 6'),
    ) as Array<{ version: number; name: string }>;

    expect(applied).toEqual([{ version: 6, name: 'article_derived' }]);
  });

  it('creates the five MVP columns with the expected shape', () => {
    const handle = openMigratedDatabase();

    const columns = handle.query((connection) =>
      connection.all("PRAGMA table_info('article_derived')"),
    ) as Array<{ name: string; type: string; notnull: number; pk: number }>;

    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'article_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'title_zh', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'summary_zh', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
  });

  it('stores and reads back a derived record for an existing article', () => {
    const handle = openMigratedDatabase();
    insertArticle(handle, 'a1');
    insertDerived(handle, 'a1', 'AI 模型發布', '這是一段繁體中文摘要。');

    const rows = handle.query((connection) =>
      connection.all('SELECT * FROM article_derived WHERE article_id = ?', ['a1']),
    ) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        article_id: 'a1',
        title_zh: 'AI 模型發布',
        summary_zh: '這是一段繁體中文摘要。',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('keeps one derived row per article', () => {
    const handle = openMigratedDatabase();
    insertArticle(handle, 'a1');
    insertDerived(handle, 'a1');

    expect(() => insertDerived(handle, 'a1')).toThrow();

    const count = handle.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM article_derived'),
    ) as Array<{ n: number }>;
    expect(count[0]?.n).toBe(1);
  });

  it('keeps the derived record after the article row is deleted', () => {
    // `RET-5`: original-content expiry must not cascade-delete unexpired derived
    // content, so `article_id` is a plain value and not a foreign key.
    const handle = openMigratedDatabase();
    insertArticle(handle, 'a1');
    insertDerived(handle, 'a1', 'AI 模型發布', '摘要');

    handle.query((connection) => connection.all('DELETE FROM articles WHERE id = ?', ['a1']));

    const rows = handle.query((connection) =>
      connection.all('SELECT article_id, title_zh FROM article_derived'),
    ) as Array<{ article_id: string; title_zh: string }>;

    expect(rows).toEqual([{ article_id: 'a1', title_zh: 'AI 模型發布' }]);
  });

  it('rejects an empty title or summary', () => {
    const handle = openMigratedDatabase();
    insertArticle(handle, 'a1');

    expect(() => insertDerived(handle, 'a1', '', '摘要')).toThrow();
    expect(() => insertDerived(handle, 'a1', '標題', '')).toThrow();
  });
});
