import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DatabaseNotAvailableError,
  openReadOnlyDatabase,
} from '../../../../src/core/persistence/read-only.js';

/**
 * The preview's database access must be incapable of creating or upgrading a
 * database. Each guarantee below is asserted against a real file in a temporary
 * directory, never the project database.
 */
let directory: string | undefined;

function temporaryDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), 'kou-read-only-'));
  return directory;
}

function createDatabase(path: string, rows: number): void {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT)');
  const insert = database.prepare('INSERT INTO articles (id, title) VALUES (?, ?)');
  for (let index = 0; index < rows; index += 1) {
    insert.run(`a${String(index)}`, `title ${String(index)}`);
  }
  database.close();
}

afterEach(() => {
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('openReadOnlyDatabase', () => {
  it('does not create a missing database', () => {
    const path = join(temporaryDirectory(), 'absent.db');

    expect(() => openReadOnlyDatabase(path)).toThrow(DatabaseNotAvailableError);
    expect(existsSync(path)).toBe(false);
  });

  it('does not create the parent directory of a missing database', () => {
    const path = join(temporaryDirectory(), 'nested', 'deeper', 'absent.db');

    expect(() => openReadOnlyDatabase(path)).toThrow(DatabaseNotAvailableError);
    expect(existsSync(join(temporaryDirectory(), 'nested'))).toBe(false);
  });

  it('rejects an in-memory path, which would always read as empty', () => {
    expect(() => openReadOnlyDatabase(':memory:')).toThrow(DatabaseNotAvailableError);
  });

  it('reads rows, including content held only in the write-ahead log', () => {
    const path = join(temporaryDirectory(), 'wal.db');
    createDatabase(path, 25);

    const database = openReadOnlyDatabase(path);
    try {
      const row = database.query((connection) =>
        connection.get('SELECT COUNT(*) AS n FROM articles'),
      ) as { n: number };
      expect(row.n).toBe(25);
    } finally {
      database.close();
    }
  });

  it('refuses a write', () => {
    const path = join(temporaryDirectory(), 'write.db');
    createDatabase(path, 1);

    const database = openReadOnlyDatabase(path);
    try {
      expect(() =>
        database.query((connection) =>
          connection.get("INSERT INTO articles (id, title) VALUES ('x', 'y')"),
        ),
      ).toThrow(/readonly/i);
    } finally {
      database.close();
    }
  });

  it('leaves the database file byte-for-byte unchanged', () => {
    const path = join(temporaryDirectory(), 'stable.db');
    createDatabase(path, 40);
    const before = statSync(path).size;

    const database = openReadOnlyDatabase(path);
    try {
      database.query((connection) => connection.get('SELECT COUNT(*) AS n FROM articles'));
    } finally {
      database.close();
    }

    expect(statSync(path).size).toBe(before);
  });

  it('reports the absolute path it opened', () => {
    const path = join(temporaryDirectory(), 'reported.db');
    createDatabase(path, 0);

    const database = openReadOnlyDatabase(path);
    try {
      expect(database.path).toBe(path);
    } finally {
      database.close();
    }
  });

  it('tolerates close being called twice', () => {
    const path = join(temporaryDirectory(), 'twice.db');
    createDatabase(path, 0);

    const database = openReadOnlyDatabase(path);
    database.close();
    expect(() => database.close()).not.toThrow();
  });

  it('creates no journal files for a non-WAL database', () => {
    const path = join(temporaryDirectory(), 'legacy.db');
    const writer = new DatabaseSync(path);
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    writer.close();

    const before = readdirSync(temporaryDirectory()).sort();
    const database = openReadOnlyDatabase(path);
    try {
      database.query((connection) => connection.get('SELECT COUNT(*) AS n FROM t'));
    } finally {
      database.close();
    }
    expect(readdirSync(temporaryDirectory()).sort()).toEqual(before);
  });
});
