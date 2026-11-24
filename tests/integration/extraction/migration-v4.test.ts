import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../../src/core/persistence/sqlite.js';

/**
 * Schema-level tests for the v4 migration.
 *
 * These assert the constraints directly rather than through the repository, so a
 * regression in the CHECK expressions is caught even if the repository happens to
 * avoid the illegal combinations.
 */
function freshDatabase() {
  const database = openDatabase({ path: ':memory:' });
  database.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES ('a1', 'T', 'https://example.com/a1', 'https://example.com/a1', 0,
               '2026-01-01T00:00:00Z', 1)`,
    );
  });
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

function insert(database: ReturnType<typeof freshDatabase>, row: Row): void {
  database.query((connection) => {
    connection.all(INSERT, ['a1', ...row]);
  });
}

describe('v4 migration', () => {
  it('reaches schema version 4', () => {
    const database = freshDatabase();
    expect(database.version).toBe(4);
    database.close();
  });

  it('creates the article_contents table', () => {
    const database = freshDatabase();
    const table = database.query((connection) =>
      connection.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'article_contents'",
      ),
    );
    expect(table).toBeDefined();
    database.close();
  });
});

describe('v4 constraints — accepted states', () => {
  it('accepts a valid in_progress row', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'in_progress',
        null,
        0,
        null,
        null,
        'v1',
        'PENDING',
        null,
        1,
        'w1',
        'tok1',
        1_000,
      ]),
    ).not.toThrow();
    database.close();
  });

  it('accepts a valid extracted row', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        'BODY',
        4,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        null,
        null,
        null,
      ]),
    ).not.toThrow();
    database.close();
  });

  it('accepts a valid empty row', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'empty',
        null,
        0,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        'NO_CONTENT',
        200,
        1,
        null,
        null,
        null,
      ]),
    ).not.toThrow();
    database.close();
  });

  it('accepts a valid failed row with no http status', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, ['failed', null, 0, null, null, 'v1', 'TIMEOUT', null, 1, null, null, null]),
    ).not.toThrow();
    database.close();
  });

  it('accepts a failed row carrying an http status', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, ['failed', null, 0, null, null, 'v1', 'HTTP_500', 500, 1, null, null, null]),
    ).not.toThrow();
    database.close();
  });

  it('accepts a failed row carrying http_status 300, which the failed branch does not constrain', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'failed',
        null,
        0,
        null,
        null,
        'v1',
        'TOO_MANY_REDIRECTS',
        300,
        1,
        null,
        null,
        null,
      ]),
    ).not.toThrow();
    database.close();
  });
});

describe('v4 constraints — NUL guard', () => {
  it('rejects content_text containing U+0000', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        'AB\u0000CD',
        4,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('accepts content_text without a NUL', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        'ABCD',
        4,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        null,
        null,
        null,
      ]),
    ).not.toThrow();
    database.close();
  });
});

describe('v4 constraints — type enforcement', () => {
  it('rejects a non-integer attempts value', () => {
    const database = freshDatabase();
    // SQLite's INTEGER affinity stores 1.5 as REAL, so only an explicit typeof
    // guard catches it; BETWEEN 0 AND 3 would accept it.
    expect(() =>
      insert(database, [
        'failed',
        null,
        0,
        null,
        null,
        'v1',
        'TIMEOUT',
        null,
        1.5,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects a non-integer http_status', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'failed',
        null,
        0,
        null,
        null,
        'v1',
        'HTTP_500',
        500.5,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects a non-integer lease_expires_at', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'in_progress',
        null,
        0,
        null,
        null,
        'v1',
        'PENDING',
        null,
        1,
        'w',
        'tok',
        1.5,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects attempts above the maximum', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, ['failed', null, 0, null, null, 'v1', 'TIMEOUT', null, 4, null, null, null]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects a negative attempts value', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'failed',
        null,
        0,
        null,
        null,
        'v1',
        'TIMEOUT',
        null,
        -1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });
});

describe('v4 constraints — illegal state combinations', () => {
  it('rejects an unknown status', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'pending',
        null,
        0,
        null,
        null,
        'v1',
        'TIMEOUT',
        null,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an extracted row with no text', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        null,
        0,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an extracted row whose content_length disagrees with the text', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        'BODY',
        999,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an extracted row with a 4xx status', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        'BODY',
        4,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        404,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an extracted row that still holds a lease', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'extracted',
        'BODY',
        4,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        null,
        200,
        1,
        'w',
        'tok',
        1_000,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an in_progress row with a non-PENDING failure code', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'in_progress',
        null,
        0,
        null,
        null,
        'v1',
        'TIMEOUT',
        null,
        1,
        'w',
        'tok',
        1_000,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an in_progress row with no lease token', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'in_progress',
        null,
        0,
        null,
        null,
        'v1',
        'PENDING',
        null,
        1,
        'w',
        null,
        1_000,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an empty row carrying extracted text', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'empty',
        'BODY',
        4,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        'NO_CONTENT',
        200,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an empty row whose code is not an empty code', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'empty',
        null,
        0,
        '2026-01-01T00:00:00Z',
        'https://example.com/a1',
        'v1',
        'TIMEOUT',
        200,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects an empty row with no extracted_at, because the extraction completed', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'empty',
        null,
        0,
        null,
        'https://example.com/a1',
        'v1',
        'NO_CONTENT',
        200,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects a failed row carrying an empty-only code', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'failed',
        null,
        0,
        null,
        null,
        'v1',
        'NO_CONTENT',
        null,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it('rejects a failed row carrying extracted text', () => {
    const database = freshDatabase();
    expect(() =>
      insert(database, [
        'failed',
        'BODY',
        4,
        null,
        null,
        'v1',
        'TIMEOUT',
        null,
        1,
        null,
        null,
        null,
      ]),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });
});

describe('v4 constraints — foreign key and uniqueness', () => {
  it('rejects a row for a non-existent article', () => {
    const database = freshDatabase();
    expect(() =>
      database.query((connection) => {
        connection.all(INSERT, [
          'ghost',
          'failed',
          null,
          0,
          null,
          null,
          'v1',
          'TIMEOUT',
          null,
          1,
          null,
          null,
          null,
        ]);
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    database.close();
  });

  it('rejects two rows for the same article', () => {
    const database = freshDatabase();
    insert(database, ['failed', null, 0, null, null, 'v1', 'TIMEOUT', null, 1, null, null, null]);
    expect(() =>
      insert(database, ['failed', null, 0, null, null, 'v1', 'TIMEOUT', null, 1, null, null, null]),
    ).toThrow(/UNIQUE constraint failed/);
    database.close();
  });

  it('rejects two live rows sharing a lease token', () => {
    const database = freshDatabase();
    database.query((connection) => {
      connection.all(
        `INSERT INTO articles
           (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES ('a2', 'T', 'https://example.com/a2', 'https://example.com/a2', 0,
                 '2026-01-01T00:00:00Z', 2)`,
      );
    });

    insert(database, [
      'in_progress',
      null,
      0,
      null,
      null,
      'v1',
      'PENDING',
      null,
      1,
      'w1',
      'same',
      1_000,
    ]);
    expect(() =>
      database.query((connection) => {
        connection.all(INSERT, [
          'a2',
          'in_progress',
          null,
          0,
          null,
          null,
          'v1',
          'PENDING',
          null,
          1,
          'w2',
          'same',
          1_000,
        ]);
      }),
    ).toThrow(/UNIQUE constraint failed/);
    database.close();
  });

  it('allows several rows with a null lease token', () => {
    const database = freshDatabase();
    database.query((connection) => {
      connection.all(
        `INSERT INTO articles
           (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES ('a2', 'T', 'https://example.com/a2', 'https://example.com/a2', 0,
                 '2026-01-01T00:00:00Z', 2)`,
      );
    });

    insert(database, ['failed', null, 0, null, null, 'v1', 'TIMEOUT', null, 1, null, null, null]);
    expect(() =>
      database.query((connection) => {
        connection.all(INSERT, [
          'a2',
          'failed',
          null,
          0,
          null,
          null,
          'v1',
          'TIMEOUT',
          null,
          1,
          null,
          null,
          null,
        ]);
      }),
    ).not.toThrow();
    database.close();
  });

  it('cascades a delete from articles', () => {
    const database = freshDatabase();
    insert(database, ['failed', null, 0, null, null, 'v1', 'TIMEOUT', null, 1, null, null, null]);
    database.query((connection) => {
      connection.all("DELETE FROM articles WHERE id = 'a1'");
    });
    const remaining = database.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM article_contents'),
    ) as { n: number };
    expect(remaining.n).toBe(0);
    database.close();
  });
});
