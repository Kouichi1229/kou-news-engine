import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  currentVersion,
  INITIAL_MIGRATION,
  INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION,
  MigrationError,
  PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION,
  runMigrations,
  type Migration,
} from '../../../../src/core/persistence/migrations.js';

const UP_TO_V2: readonly Migration[] = [
  INITIAL_MIGRATION,
  INSERTION_ORDER_AND_PRIMARY_SOURCE_MIGRATION,
];

const UP_TO_V3: readonly Migration[] = [
  ...UP_TO_V2,
  PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION,
];

const openDatabases: DatabaseSync[] = [];

/** A database migrated to v2, which is the state v3 has to upgrade from. */
function databaseAtV2(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  openDatabases.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, UP_TO_V2);
  return db;
}

/** A database migrated all the way to v3. */
function databaseAtV3(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  openDatabases.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, UP_TO_V3);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

function insertArticle(db: DatabaseSync, id: string, order: number): void {
  db.prepare(
    `INSERT INTO articles (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
     VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, `title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, order);
}

interface SourceRow {
  articleId: string;
  sourceId: string;
  canonicalUrl?: string;
  guid?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  firstSeenAt?: string;
  isPrimary?: 0 | 1;
}

function insertSource(db: DatabaseSync, row: SourceRow): void {
  db.prepare(
    `INSERT INTO article_sources
       (article_id, source_id, url, resolved_url, canonical_url, guid, source_name, source_url, first_seen_at, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.articleId,
    row.sourceId,
    `https://example.com/${row.sourceId}`,
    `https://example.com/${row.sourceId}`,
    row.canonicalUrl ?? `https://example.com/${row.sourceId}`,
    row.guid ?? null,
    row.sourceName ?? null,
    row.sourceUrl ?? null,
    row.firstSeenAt ?? '2026-01-01T00:00:00.000Z',
    row.isPrimary ?? 0,
  );
}

function columns(
  db: DatabaseSync,
  table: string,
): Array<{
  name: string;
  type: string;
  notnull: number;
  pk: number;
}> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
}

function indexNames(db: DatabaseSync, table: string): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all(table) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migration v3 — schema', () => {
  it('records version 3', () => {
    const db = databaseAtV3();
    expect(currentVersion(db)).toBe(3);
  });

  it('creates the provenance_id surrogate primary key', () => {
    const db = databaseAtV3();
    const byName = new Map(columns(db, 'article_sources').map((column) => [column.name, column]));

    expect(byName.get('provenance_id')?.pk).toBe(1);
    expect(byName.get('provenance_id')?.type).toBe('INTEGER');
  });

  it('requires guid_key and source_order', () => {
    const db = databaseAtV3();
    const byName = new Map(columns(db, 'article_sources').map((column) => [column.name, column]));

    expect(byName.get('guid_key')?.notnull).toBe(1);
    expect(byName.get('source_order')?.notnull).toBe(1);
  });

  it('keeps every historical column', () => {
    const db = databaseAtV3();
    const names = columns(db, 'article_sources').map((column) => column.name);

    expect(names).toEqual([
      'provenance_id',
      'article_id',
      'source_id',
      'url',
      'resolved_url',
      'canonical_url',
      'guid_key',
      'guid',
      'source_name',
      'source_url',
      'first_seen_at',
      'source_order',
      'is_primary',
    ]);
  });

  it('creates the four documented indexes', () => {
    const db = databaseAtV3();

    expect(indexNames(db, 'article_sources')).toEqual([
      'idx_article_sources_identity',
      'idx_article_sources_order',
      'idx_article_sources_primary',
      'idx_article_sources_source_id',
    ]);
  });

  it('drops the old composite primary key so the same URL can hold two GUIDs', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);

    const insert = (guid: string) =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES ('a1', 's1', 'u', 'r', 'https://example.com/shared', ?, ?, 't', ?, 0)`,
        )
        .run(`V:${guid}`, guid, guid === 'g1' ? 1 : 2);

    insert('g1');
    insert('g2');

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM article_sources WHERE canonical_url = 'https://example.com/shared'",
        )
        .get(),
    ).toEqual({ count: 2 });
  });
});

describe('migration v3 — guid_key encoding', () => {
  it('distinguishes a missing GUID from an empty one', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, {
      articleId: 'a1',
      sourceId: 's-missing',
      guid: null,
      canonicalUrl: 'https://e/x',
    });
    insertSource(db, {
      articleId: 'a1',
      sourceId: 's-empty',
      guid: '',
      canonicalUrl: 'https://e/y',
    });

    runMigrations(db, UP_TO_V3);

    const rows = db
      .prepare(
        "SELECT source_id, guid_key, guid FROM article_sources WHERE source_id LIKE 's-%' ORDER BY source_id",
      )
      .all() as Array<{ source_id: string; guid_key: string; guid: string | null }>;

    expect(rows).toEqual([
      { source_id: 's-empty', guid_key: 'V:', guid: '' },
      { source_id: 's-missing', guid_key: 'N:', guid: null },
    ]);
  });

  it('prefixes a real GUID with V:', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, { articleId: 'a1', sourceId: 's1', guid: 'guid-1' });

    runMigrations(db, UP_TO_V3);

    expect(db.prepare('SELECT guid_key, guid FROM article_sources').get()).toEqual({
      guid_key: 'V:guid-1',
      guid: 'guid-1',
    });
  });

  it('keeps a literal N: GUID distinct from a missing GUID', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, {
      articleId: 'a1',
      sourceId: 's-missing',
      guid: null,
      canonicalUrl: 'https://e/x',
    });
    insertSource(db, {
      articleId: 'a1',
      sourceId: 's-literal',
      guid: 'N:',
      canonicalUrl: 'https://e/y',
    });

    runMigrations(db, UP_TO_V3);

    const keys = (
      db.prepare('SELECT guid_key FROM article_sources ORDER BY source_id').all() as Array<{
        guid_key: string;
      }>
    ).map((row) => row.guid_key);

    // Ordered by source_id: 's-literal' sorts before 's-missing'.
    expect(keys).toEqual(['V:N:', 'N:']);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('migration v3 — source_order backfill', () => {
  it('numbers each article from 1 independently', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);
    insertSource(db, { articleId: 'a1', sourceId: 's1' });
    insertSource(db, { articleId: 'a1', sourceId: 's2' });
    insertSource(db, { articleId: 'a1', sourceId: 's3' });
    insertSource(db, { articleId: 'a2', sourceId: 's4' });

    runMigrations(db, UP_TO_V3);

    const rows = db
      .prepare(
        'SELECT article_id, source_id, source_order FROM article_sources ORDER BY article_id, source_order',
      )
      .all();

    expect(rows).toEqual([
      { article_id: 'a1', source_id: 's1', source_order: 1 },
      { article_id: 'a1', source_id: 's2', source_order: 2 },
      { article_id: 'a1', source_id: 's3', source_order: 3 },
      { article_id: 'a2', source_id: 's4', source_order: 1 },
    ]);
  });

  it('follows insertion order', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, { articleId: 'a1', sourceId: 'third' });
    insertSource(db, { articleId: 'a1', sourceId: 'first' });
    insertSource(db, { articleId: 'a1', sourceId: 'second' });

    runMigrations(db, UP_TO_V3);

    const ordered = (
      db.prepare('SELECT source_id FROM article_sources ORDER BY source_order').all() as Array<{
        source_id: string;
      }>
    ).map((row) => row.source_id);

    expect(ordered).toEqual(['third', 'first', 'second']);
  });

  it('assigns provenance_id in the same order', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, { articleId: 'a1', sourceId: 's1' });
    insertSource(db, { articleId: 'a1', sourceId: 's2' });

    runMigrations(db, UP_TO_V3);

    const rows = db
      .prepare('SELECT provenance_id, source_id FROM article_sources ORDER BY provenance_id')
      .all();

    expect(rows).toEqual([
      { provenance_id: 1, source_id: 's1' },
      { provenance_id: 2, source_id: 's2' },
    ]);
  });
});

describe('migration v3 — historical data preservation', () => {
  it('preserves first_seen_at for every row', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, { articleId: 'a1', sourceId: 's1', firstSeenAt: '2025-03-04T05:06:07.000Z' });
    insertSource(db, { articleId: 'a1', sourceId: 's2', firstSeenAt: '2025-09-10T11:12:13.000Z' });

    runMigrations(db, UP_TO_V3);

    const rows = db
      .prepare('SELECT source_id, first_seen_at FROM article_sources ORDER BY source_id')
      .all();

    expect(rows).toEqual([
      { source_id: 's1', first_seen_at: '2025-03-04T05:06:07.000Z' },
      { source_id: 's2', first_seen_at: '2025-09-10T11:12:13.000Z' },
    ]);
  });

  it('preserves is_primary without re-deriving it', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);
    // a1 marks its second source primary; a2 marks none. Neither is inferable.
    insertSource(db, { articleId: 'a1', sourceId: 's1', isPrimary: 0 });
    insertSource(db, { articleId: 'a1', sourceId: 's2', isPrimary: 1 });
    insertSource(db, { articleId: 'a2', sourceId: 's3', isPrimary: 0 });

    runMigrations(db, UP_TO_V3);

    const rows = db
      .prepare(
        'SELECT article_id, source_id, is_primary FROM article_sources ORDER BY article_id, source_id',
      )
      .all();

    expect(rows).toEqual([
      { article_id: 'a1', source_id: 's1', is_primary: 0 },
      { article_id: 'a1', source_id: 's2', is_primary: 1 },
      { article_id: 'a2', source_id: 's3', is_primary: 0 },
    ]);
  });

  it('preserves source_name and source_url', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, {
      articleId: 'a1',
      sourceId: 's1',
      sourceName: 'Example Feed',
      sourceUrl: 'https://example.com/feed.xml',
    });

    runMigrations(db, UP_TO_V3);

    expect(db.prepare('SELECT source_name, source_url FROM article_sources').get()).toEqual({
      source_name: 'Example Feed',
      source_url: 'https://example.com/feed.xml',
    });
  });

  it('keeps every provenance row', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);
    for (let index = 0; index < 5; index += 1) {
      insertSource(db, { articleId: 'a1', sourceId: `a-${index}` });
    }
    for (let index = 0; index < 3; index += 1) {
      insertSource(db, { articleId: 'a2', sourceId: `b-${index}` });
    }

    const before = db.prepare('SELECT COUNT(*) AS count FROM article_sources').get();
    runMigrations(db, UP_TO_V3);
    const after = db.prepare('SELECT COUNT(*) AS count FROM article_sources').get();

    expect(before).toEqual({ count: 8 });
    expect(after).toEqual({ count: 8 });
  });

  it('preserves url, resolved_url and canonical_url verbatim', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    db.prepare(
      `INSERT INTO article_sources
         (article_id, source_id, url, resolved_url, canonical_url, guid, first_seen_at, is_primary)
       VALUES ('a1', 's1', '/relative/path', 'https://example.com/resolved', 'https://example.com/canonical', 'g', 't', 0)`,
    ).run();

    runMigrations(db, UP_TO_V3);

    expect(
      db.prepare('SELECT url, resolved_url, canonical_url FROM article_sources').get(),
    ).toEqual({
      url: '/relative/path',
      resolved_url: 'https://example.com/resolved',
      canonical_url: 'https://example.com/canonical',
    });
  });
});

describe('migration v3 — constraints', () => {
  it('cascades deletes from articles', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);
    db.prepare(
      `INSERT INTO article_sources
         (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
       VALUES ('a1', 's1', 'u', 'r', 'c1', 'N:', NULL, 't', 1, 1),
              ('a2', 's2', 'u', 'r', 'c2', 'N:', NULL, 't', 1, 1)`,
    ).run();

    db.prepare("DELETE FROM articles WHERE id = 'a1'").run();

    expect(db.prepare('SELECT article_id FROM article_sources').all()).toEqual([
      { article_id: 'a2' },
    ]);
  });

  it('rejects a foreign key that names no article', () => {
    const db = databaseAtV3();

    expect(() =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES ('missing', 's1', 'u', 'r', 'c1', 'N:', NULL, 't', 1, 0)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('enforces identity uniqueness', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);
    const insert = (order: number) =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES ('a1', 's1', 'u', 'r', 'c1', 'V:g1', 'g1', 't', ?, 0)`,
        )
        .run(order);

    insert(1);

    expect(() => insert(2)).toThrow(/UNIQUE constraint failed: article_sources\.article_id/);
  });

  it('enforces source_order uniqueness per article', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);
    const insert = (sourceId: string) =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES ('a1', ?, 'u', 'r', ?, 'N:', NULL, 't', 1, 0)`,
        )
        .run(sourceId, `https://e/${sourceId}`);

    insert('s1');

    expect(() => insert('s2')).toThrow(/UNIQUE constraint failed: article_sources\.article_id/);
  });

  it('allows the same source_order in different articles', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);
    const insert = (articleId: string) =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES (?, 's1', 'u', 'r', ?, 'N:', NULL, 't', 1, 0)`,
        )
        .run(articleId, `https://e/${articleId}`);

    insert('a1');
    insert('a2');

    expect(db.prepare('SELECT COUNT(*) AS count FROM article_sources').get()).toEqual({ count: 2 });
  });

  it('allows at most one primary per article', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);
    const insert = (sourceId: string, order: number, primary: 0 | 1) =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES ('a1', ?, 'u', 'r', ?, 'N:', NULL, 't', ?, ?)`,
        )
        .run(sourceId, `https://e/${sourceId}`, order, primary);

    insert('s1', 1, 1);

    expect(() => insert('s2', 2, 1)).toThrow(
      /UNIQUE constraint failed: article_sources\.article_id/,
    );
  });

  it('allows one primary in each article', () => {
    const db = databaseAtV3();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);
    const insert = (articleId: string) =>
      db
        .prepare(
          `INSERT INTO article_sources
             (article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary)
           VALUES (?, 's1', 'u', 'r', ?, 'N:', NULL, 't', 1, 1)`,
        )
        .run(articleId, `https://e/${articleId}`);

    insert('a1');
    insert('a2');

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM article_sources WHERE is_primary = 1').get(),
    ).toEqual({
      count: 2,
    });
  });
});

describe('migration v3 — rollback', () => {
  it('restores the v2 schema and data when a later statement fails', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, {
      articleId: 'a1',
      sourceId: 's1',
      guid: 'g1',
      firstSeenAt: 'T-ORIGINAL',
      isPrimary: 1,
    });

    const broken: Migration = {
      version: 3,
      name: 'broken_v3',
      statements: [...PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION.statements, 'INVALID SQL'],
    };

    expect(() => runMigrations(db, [...UP_TO_V2, broken])).toThrow(MigrationError);

    expect(currentVersion(db)).toBe(2);
    expect(columns(db, 'article_sources').map((column) => column.name)).not.toContain(
      'provenance_id',
    );
    expect(
      db
        .prepare(
          'SELECT article_id, source_id, guid, first_seen_at, is_primary FROM article_sources',
        )
        .all(),
    ).toEqual([
      { article_id: 'a1', source_id: 's1', guid: 'g1', first_seen_at: 'T-ORIGINAL', is_primary: 1 },
    ]);
  });

  it('leaves the articles table untouched when v3 fails', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertArticle(db, 'a2', 2);

    const broken: Migration = {
      version: 3,
      name: 'broken_v3',
      statements: [...PROVENANCE_IDENTITY_AND_SOURCE_ORDER_MIGRATION.statements, 'INVALID SQL'],
    };

    expect(() => runMigrations(db, [...UP_TO_V2, broken])).toThrow(MigrationError);

    expect(db.prepare('SELECT id FROM articles ORDER BY inserted_order').all()).toEqual([
      { id: 'a1' },
      { id: 'a2' },
    ]);
  });
});

describe('migration v3 — idempotency', () => {
  it('does not re-apply when the database is already at v3', () => {
    const db = databaseAtV3();

    expect(runMigrations(db, UP_TO_V3)).toBe(0);
    expect(currentVersion(db)).toBe(3);
  });

  it('does not duplicate provenance rows on a second run', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, { articleId: 'a1', sourceId: 's1' });

    runMigrations(db, UP_TO_V3);
    const first = db.prepare('SELECT COUNT(*) AS count FROM article_sources').get();

    runMigrations(db, UP_TO_V3);
    const second = db.prepare('SELECT COUNT(*) AS count FROM article_sources').get();

    expect(first).toEqual({ count: 1 });
    expect(second).toEqual({ count: 1 });
  });

  it('keeps source_order stable across a reopen', () => {
    const db = databaseAtV2();
    insertArticle(db, 'a1', 1);
    insertSource(db, { articleId: 'a1', sourceId: 's1' });
    insertSource(db, { articleId: 'a1', sourceId: 's2' });

    runMigrations(db, UP_TO_V3);
    const before = db
      .prepare('SELECT source_id, source_order FROM article_sources ORDER BY source_order')
      .all();

    runMigrations(db, UP_TO_V3);
    const after = db
      .prepare('SELECT source_id, source_order FROM article_sources ORDER BY source_order')
      .all();

    expect(after).toEqual(before);
  });
});
