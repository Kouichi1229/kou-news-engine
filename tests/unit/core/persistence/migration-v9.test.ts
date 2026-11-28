import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTICLE_DERIVED_CATEGORY_MIGRATION,
  MIGRATIONS,
} from '../../../../src/core/persistence/migrations.js';
import { openDatabase, type SqliteDatabase } from '../../../../src/core/persistence/sqlite.js';
import { DERIVATION_CATEGORIES } from '../../../../src/modules/derivation/derivation.service.js';

/**
 * Schema-level tests for the v9 `article_derived.category` migration.
 *
 * The column's vocabulary is closed in two places — the parser that accepts the
 * model's answer and the CHECK that guards the table — and these tests pin the
 * second one, plus the agreement between the CHECK and the list the service uses.
 */
let database: SqliteDatabase;

function openMigrated(): SqliteDatabase {
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

function insertDerived(handle: SqliteDatabase, articleId: string, category: string | null): void {
  handle.query((connection) => {
    connection.all(
      `INSERT INTO article_derived
         (article_id, title_zh, summary_zh, category, created_at, updated_at)
       VALUES (?, '標題', '摘要', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [articleId, category],
    );
  });
}

afterEach(() => {
  if (database?.isOpen === true) {
    database.close();
  }
});

describe('v9 article_derived.category migration', () => {
  it('is registered as the newest migration', () => {
    const newest = MIGRATIONS.at(-1);

    expect(newest).toBe(ARTICLE_DERIVED_CATEGORY_MIGRATION);
    expect(newest?.version).toBe(9);
    expect(newest?.name).toBe('article_derived_category');
  });

  it('adds one nullable column, leaving the rest of the table alone', () => {
    const handle = openMigrated();

    const columns = handle.query((connection) =>
      connection.all("PRAGMA table_info('article_derived')"),
    ) as Array<{ name: string; type: string; notnull: number; pk: number }>;

    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'article_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'title_zh', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'summary_zh', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'category', type: 'TEXT', notnull: 0, pk: 0 },
    ]);
  });

  it('accepts every category the service lists', () => {
    const handle = openMigrated();
    insertArticle(handle, 'a0');

    for (const [index, category] of DERIVATION_CATEGORIES.entries()) {
      insertDerived(handle, `a${String(index)}`, category);
    }

    const stored = handle.query((connection) =>
      connection.all('SELECT category FROM article_derived ORDER BY article_id'),
    ) as Array<{ category: string }>;

    expect(stored.map((row) => row.category)).toEqual([...DERIVATION_CATEGORIES]);
  });

  it('allows the column to stay null for a record derived before categories', () => {
    const handle = openMigrated();
    insertArticle(handle, 'a1');

    insertDerived(handle, 'a1', null);

    const stored = handle.query((connection) =>
      connection.get('SELECT category FROM article_derived WHERE article_id = ?', ['a1']),
    ) as { category: string | null };
    expect(stored.category).toBeNull();
  });

  it('refuses a label the service does not list', () => {
    const handle = openMigrated();
    insertArticle(handle, 'a1');

    expect(() => insertDerived(handle, 'a1', '運動')).toThrow(/CHECK constraint failed/);
  });
});
