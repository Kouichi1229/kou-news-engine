import { afterEach, describe, expect, it } from 'vitest';

import {
  MIGRATIONS,
  NOTIFICATION_DELIVERY_MIGRATION,
} from '../../../../src/core/persistence/migrations.js';
import { openDatabase, type SqliteDatabase } from '../../../../src/core/persistence/sqlite.js';

/**
 * Schema-level tests for the v8 delivery ledger.
 *
 * What matters is what the table refuses: a second row for the same article, a
 * status outside the two the schema admits, and a message id that could not have
 * come from Telegram. Those are what keep the skip decision trustworthy.
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

function seedArticle(target: SqliteDatabase, id: string, order: number): void {
  target.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
      [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, order],
    );
  });
}

const INSERT = `INSERT INTO notification_delivery (article_id, message_id, status, created_at)
  VALUES (?, ?, ?, ?)`;

describe('migration v8 — notification_delivery', () => {
  it('is registered below the newest migration', () => {
    // v8 is no longer the newest; that guarantee lives in the v9 suite. What
    // matters here is that this version is present and applied in order.
    expect(MIGRATIONS).toContain(NOTIFICATION_DELIVERY_MIGRATION);
    expect(Math.max(...MIGRATIONS.map((migration) => migration.version))).toBeGreaterThan(8);
  });

  it('exists after migration with the four documented columns', () => {
    const db = openMigrated();

    const columns = db.query((connection) =>
      connection.all("SELECT name FROM pragma_table_info('notification_delivery')"),
    ) as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual([
      'article_id',
      'message_id',
      'status',
      'created_at',
    ]);
  });

  it('keeps article_id unique', () => {
    const db = openMigrated();
    seedArticle(db, 'a1', 1);
    db.query((connection) =>
      connection.all(INSERT, ['a1', 11, 'sent', '2026-02-01T00:00:00.000Z']),
    );

    expect(() =>
      db.query((connection) =>
        connection.all(INSERT, ['a1', 12, 'sent', '2026-02-02T00:00:00.000Z']),
      ),
    ).toThrow();
  });

  it.each(['queued', 'pending', ''])('rejects the status %j', (status) => {
    const db = openMigrated();
    seedArticle(db, 'a1', 1);

    expect(() =>
      db.query((connection) =>
        connection.all(INSERT, ['a1', 11, status, '2026-02-01T00:00:00.000Z']),
      ),
    ).toThrow();
  });

  it('admits both documented statuses', () => {
    const db = openMigrated();
    seedArticle(db, 'a1', 1);
    seedArticle(db, 'a2', 2);

    expect(() =>
      db.query((connection) => {
        connection.all(INSERT, ['a1', 11, 'sent', '2026-02-01T00:00:00.000Z']);
        connection.all(INSERT, ['a2', 12, 'failed', '2026-02-01T00:00:00.000Z']);
      }),
    ).not.toThrow();
  });

  // A numeric string is stored as an integer by column affinity, so only values
  // that cannot be a Telegram id are asserted here.
  it.each([[0], [-1], [1.5]])('rejects the message id %j', (messageId) => {
    const db = openMigrated();
    seedArticle(db, 'a1', 1);

    expect(() =>
      db.query((connection) =>
        connection.all(INSERT, ['a1', messageId, 'sent', '2026-02-01T00:00:00.000Z']),
      ),
    ).toThrow();
  });

  it('removes the row with its article', () => {
    const db = openMigrated();
    seedArticle(db, 'a1', 1);
    db.query((connection) =>
      connection.all(INSERT, ['a1', 11, 'sent', '2026-02-01T00:00:00.000Z']),
    );

    db.query((connection) => connection.all('DELETE FROM articles WHERE id = ?', ['a1']));

    const row = db.query((connection) =>
      connection.get('SELECT article_id FROM notification_delivery WHERE article_id = ?', ['a1']),
    );
    expect(row).toBeUndefined();
  });
});
