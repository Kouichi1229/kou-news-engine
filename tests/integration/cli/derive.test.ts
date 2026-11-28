import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from '../../../src/cli/exit-codes.js';
import { runDerivationCli } from '../../../src/cli/derivation.cli.js';
import { FakeProvider } from '../../../src/core/llm/fake.provider.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { DERIVATION_LIMITS } from '../../../src/modules/derivation/derivation.service.js';

/**
 * `derive --regenerate <articleId>`, end to end except for the model.
 *
 * The database is real and migrated; the body comes from `article_contents`, which
 * is the property worth proving — no publisher request happens on this path, so
 * the run cannot work unless it reads what extraction already stored.
 */
const BODY = 'A substantial paragraph of real article prose for testing. '.repeat(20);
const FIRST = '2026-02-01T00:00:00.000Z';
const SECOND = '2026-03-01T00:00:00.000Z';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-derive-'));
  directories.push(directory);
  return join(directory, 'test.db');
}

function withDatabase<T>(path: string, work: (database: SqliteDatabase) => T): T {
  const database = openDatabase({ path });
  try {
    return work(database);
  } finally {
    database.close();
  }
}

function seedArticle(database: SqliteDatabase, id: string, withBody: boolean): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', 1)`,
      [id, 'Original English Title', `https://example.com/${id}`, `https://example.com/${id}`],
    );
    if (!withBody) {
      return;
    }
    connection.all(
      `INSERT INTO article_contents
         (article_id, status, content_text, content_length, extracted_at, final_url,
          extractor_version, failure_code, http_status, attempts)
       VALUES (?, 'extracted', ?, ?, '2026-01-02T00:00:00Z', ?, 'v1', NULL, 200, 1)`,
      [id, BODY, BODY.length, `https://example.com/${id}`],
    );
  });
}

function seedDerived(database: SqliteDatabase, id: string, titleZh: string): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO article_derived (article_id, title_zh, summary_zh, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, titleZh, '這'.repeat(110), FIRST, FIRST],
    );
  });
}

function derivedRows(path: string): Array<Record<string, unknown>> {
  return withDatabase(path, (database) =>
    database.query((connection) =>
      connection.all('SELECT * FROM article_derived ORDER BY article_id'),
    ),
  ) as Array<Record<string, unknown>>;
}

function reply(summaryChars: number, titleZh: string): string {
  return JSON.stringify({ title_zh: titleZh, summary_zh: '這'.repeat(summaryChars) });
}

interface Captured {
  code: number;
  stdout: string[];
  stderr: string[];
}

async function run(path: string, articleId: string, provider: FakeProvider): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDerivationCli({
    articleId,
    provider,
    now: () => Date.parse(SECOND),
    openDatabase: () => openDatabase({ path }),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe('derive CLI — regeneration', () => {
  it('uses the stored body and replaces the record', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seedArticle(database, 'a1', true);
      seedDerived(database, 'a1', '第一版標題');
    });
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: reply(120, '第二版') }],
    });

    const result = await run(path, 'a1', provider);

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      articleId: 'a1',
      titleZh: '第二版',
      summaryZh: '這'.repeat(120),
    });
    expect(result.stderr).toEqual([]);
    // The prompt carried the stored body: nothing was fetched to get it.
    expect(provider.receivedRequests[0]?.prompt).toContain(BODY.slice(0, 40));
    expect(derivedRows(path)).toEqual([
      {
        article_id: 'a1',
        title_zh: '第二版',
        summary_zh: '這'.repeat(120),
        created_at: FIRST,
        updated_at: SECOND,
      },
    ]);
  });

  it('creates the record when the article never had one', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => seedArticle(database, 'a1', true));
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: reply(120, '首版') }],
    });

    const result = await run(path, 'a1', provider);

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(derivedRows(path)).toHaveLength(1);
  });

  it('does not touch an existing delivery record', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seedArticle(database, 'a1', true);
      seedDerived(database, 'a1', '第一版標題');
      database.query((connection) =>
        connection.all(
          `INSERT INTO notification_delivery (article_id, message_id, status, created_at)
           VALUES ('a1', 777, 'sent', '2026-02-02T00:00:00.000Z')`,
        ),
      );
    });
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: reply(120, '第二版') }],
    });

    const result = await run(path, 'a1', provider);

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(
      withDatabase(path, (database) =>
        database.query((connection) => connection.all('SELECT * FROM notification_delivery')),
      ),
    ).toEqual([
      { article_id: 'a1', message_id: 777, status: 'sent', created_at: '2026-02-02T00:00:00.000Z' },
    ]);
  });
});

describe('derive CLI — a missing article or body', () => {
  it('reports article-missing without calling the model', async () => {
    const path = temporaryDatabasePath();
    // Opening and migrating the database is enough: the table must exist and be empty.
    withDatabase(path, () => undefined);
    const provider = new FakeProvider({ responses: [{ kind: 'success', text: reply(120, 'x') }] });

    const result = await run(path, 'ghost', provider);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toEqual([]);
    expect(JSON.parse(result.stderr[0] ?? '')).toEqual({
      status: 'failed',
      reason: 'article-missing',
      articleId: 'ghost',
      error: 'No article row for ghost',
    });
    expect(provider.receivedRequests).toEqual([]);
  });

  it('reports body-missing when extraction never stored the text', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => seedArticle(database, 'a1', false));
    const provider = new FakeProvider({ responses: [{ kind: 'success', text: reply(120, 'x') }] });

    const result = await run(path, 'a1', provider);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      reason: 'body-missing',
      articleId: 'a1',
    });
    expect(provider.receivedRequests).toEqual([]);
  });

  it('does not treat a failed extraction body as usable', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seedArticle(database, 'a1', false);
      database.query((connection) =>
        connection.all(
          `INSERT INTO article_contents
             (article_id, status, extractor_version, failure_code, attempts)
           VALUES ('a1', 'failed', 'v1', 'FETCH_FAILED', 1)`,
        ),
      );
    });
    const provider = new FakeProvider({ responses: [{ kind: 'success', text: reply(120, 'x') }] });

    expect((await run(path, 'a1', provider)).code).toBe(EXIT_FAILURE);
    expect(provider.receivedRequests).toEqual([]);
  });
});

describe('derive CLI — a failed regeneration keeps the old text', () => {
  function seeded(): string {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seedArticle(database, 'a1', true);
      seedDerived(database, 'a1', '第一版標題');
    });
    return path;
  }

  it('reports the provider failure and writes nothing', async () => {
    const path = seeded();
    const provider = new FakeProvider({ responses: [{ kind: 'error', error: 'unavailable' }] });

    const result = await run(path, 'a1', provider);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toEqual([]);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'unavailable',
      articleId: 'a1',
    });
    expect(derivedRows(path)).toEqual([
      {
        article_id: 'a1',
        title_zh: '第一版標題',
        summary_zh: '這'.repeat(110),
        created_at: FIRST,
        updated_at: FIRST,
      },
    ]);
  });

  it('reports a rejected answer and writes nothing', async () => {
    const path = seeded();
    const provider = new FakeProvider({
      responses: [
        { kind: 'success', text: reply(DERIVATION_LIMITS.maxSummaryChars + 1, '太長的摘要') },
      ],
    });

    const result = await run(path, 'a1', provider);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({ reason: 'summary-length' });
    expect(derivedRows(path)).toEqual([
      {
        article_id: 'a1',
        title_zh: '第一版標題',
        summary_zh: '這'.repeat(110),
        created_at: FIRST,
        updated_at: FIRST,
      },
    ]);
  });
});

describe('derive CLI — the command line', () => {
  const repositoryRoot = join(import.meta.dirname, '..', '..', '..');

  function spawn(args: readonly string[], databasePath: string): number | null {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join('src', 'cli', 'derive.ts'), ...args],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          DATABASE_PATH: databasePath,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    return result.status;
  }

  it('answers --help and exits 0 without opening a database', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--help'], path)).toBe(EXIT_SUCCESS);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects an invocation without an article id and opens no database', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--regenerate'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects a bare article id, which would hide the intent to rewrite', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['a1'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });
});
