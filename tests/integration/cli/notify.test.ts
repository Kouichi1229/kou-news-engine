import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_SUCCESS } from '../../../src/cli/exit-codes.js';
import { runNotificationCli, summarizeNotificationRun } from '../../../src/cli/notification.cli.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import type { DerivationCategory } from '../../../src/modules/derivation/derivation.service.js';
import { formatTelegramMessage } from '../../../src/modules/notification/telegram.formatter.js';
import {
  TELEGRAM_API_ORIGIN,
  type TelegramTransport,
} from '../../../src/modules/notification/telegram.provider.js';

/**
 * The notify CLI, end to end except for the socket.
 *
 * The database is real (in-memory, migrated) and the SQL under test is the SQL
 * that runs in production; only the Telegram HTTP transport is replaced, which is
 * the same seam the provider tests use.
 */
const TOKEN = 'test-token';
const CHAT_ID = '-1009876543210';
const OK_BODY = JSON.stringify({ ok: true, result: { message_id: 777 } });

interface SentRequest {
  url: string;
  payload: unknown;
}

function fakeTransport(
  response: { status: number; body: string } = { status: 200, body: OK_BODY },
): { calls: SentRequest[]; transport: TelegramTransport } {
  const calls: SentRequest[] = [];
  return {
    calls,
    transport: {
      async send(url, init) {
        calls.push({ url, payload: JSON.parse(init.body) });
        return response;
      },
    },
  };
}

function seed(database: SqliteDatabase, articles: readonly { id: string; order: number }[]): void {
  database.query((connection) => {
    for (const { id, order } of articles) {
      connection.all(
        `INSERT INTO articles
           (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
        [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, order],
      );
    }
  });
}

function derive(
  database: SqliteDatabase,
  articleId: string,
  updatedAt: string,
  category: string | null = '財經',
): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO article_derived
         (article_id, title_zh, summary_zh, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [articleId, `標題 ${articleId}`, `摘要 ${articleId}`, category, updatedAt, updatedAt],
    );
  });
}

function deliveries(database: SqliteDatabase): Array<{
  article_id: string;
  message_id: number;
  status: string;
  created_at: string;
}> {
  return database.query((connection) =>
    connection.all(
      'SELECT article_id, message_id, status, created_at FROM notification_delivery ORDER BY article_id',
    ),
  ) as Array<{ article_id: string; message_id: number; status: string; created_at: string }>;
}

/**
 * A file-backed database, one directory per test.
 *
 * Deduplication has to survive a process boundary, and each CLI run opens and
 * closes its own handle — so the only honest fixture is a file the next run can
 * open again.
 */
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-notify-'));
  directories.push(directory);
  return join(directory, 'test.db');
}

function withDatabase<T>(path: string, read: (database: SqliteDatabase) => T): T {
  const database = openDatabase({ path });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/**
 * The summary document, which every run writes as its last stdout line.
 *
 * Kept as one accessor so a test states "the smallest thing the summary must say"
 * once, even after the outcome document above it changes shape.
 */
function summaryOf(run: CapturedRun): unknown {
  return JSON.parse(run.stdout.at(-1) ?? '');
}

interface CapturedRun {
  code: number;
  stdout: string[];
  stderr: string[];
}

async function run(
  options: {
    transport?: TelegramTransport;
    botToken?: string | undefined;
    chatId?: string | undefined;
    database?: SqliteDatabase;
    openDatabase?: () => SqliteDatabase;
    category?: DerivationCategory;
  } = {},
): Promise<CapturedRun> {
  const open =
    options.openDatabase ??
    ((): SqliteDatabase => options.database ?? openDatabase({ path: ':memory:' }));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runNotificationCli({
    openDatabase: open,
    botToken: 'botToken' in options ? options.botToken : TOKEN,
    chatId: 'chatId' in options ? options.chatId : CHAT_ID,
    transport: options.transport ?? fakeTransport().transport,
    ...(options.category === undefined ? {} : { category: options.category }),
    logger: { info: () => undefined, error: () => undefined },
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });

  return { code, stdout, stderr };
}

describe('notify CLI — publishing the newest derived article', () => {
  it('sends only the most recently updated article and reports both ids', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [
      { id: 'a1', order: 1 },
      { id: 'a2', order: 2 },
    ]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    derive(database, 'a2', '2026-03-01T00:00:00.000Z');
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      status: 'sent',
      articleId: 'a2',
      messageId: 777,
    });
    expect(result.stderr).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TELEGRAM_API_ORIGIN}/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.payload).toEqual({
      chat_id: CHAT_ID,
      text: formatTelegramMessage({
        articleId: 'a2',
        titleZh: '標題 a2',
        summaryZh: '摘要 a2',
        at: '2026-03-01T00:00:00.000Z',
        sourceUrl: 'https://example.com/a2',
      }),
    });
  });

  it('closes the database once the run is over', async () => {
    const database = openDatabase({ path: ':memory:' });

    await run({ database });

    expect(() => database.query((connection) => connection.get('SELECT 1'))).toThrow();
  });

  it('treats a derivation whose article row is gone as nothing to publish', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    database.query((connection) => connection.all('DELETE FROM articles WHERE id = ?', ['a1']));
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(calls).toEqual([]);
  });
});

describe('notify CLI — failures exit non-zero with a reason', () => {
  it('reports a Telegram refusal', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    const { transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: false, description: 'chat not found' }),
    });

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toHaveLength(1);
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ articleId: 'a1', outcome: 'failed', reason: 'api_rejected' }],
    });
    expect(JSON.parse(result.stderr[0] ?? '')).toEqual({
      status: 'failed',
      reason: 'api_rejected',
      error: 'Telegram refused the message: chat not found',
    });
  });

  it('reports an HTTP failure', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    const { transport } = fakeTransport({ status: 500, body: '' });

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'http_status',
    });
  });

  it('reports missing configuration without touching the network', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, botToken: undefined, database });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'not_configured',
    });
    expect(calls).toEqual([]);
  });

  it('reports an unreadable database as a failure, not as an empty run', async () => {
    const result = await run({
      openDatabase: () => {
        throw new Error('SQLITE_CANTOPEN');
      },
    });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      reason: 'unexpected-error',
      error: 'SQLITE_CANTOPEN',
    });
  });
});

describe('notify CLI — delivery deduplication', () => {
  function seeded(): string {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [{ id: 'a1', order: 1 }]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    });
    return path;
  }

  function open(path: string): () => SqliteDatabase {
    return () => openDatabase({ path });
  }

  it('records a successful send exactly once', async () => {
    const path = seeded();
    const { transport } = fakeTransport();

    const first = await run({ transport, openDatabase: open(path) });

    expect(first.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(first.stdout[0] ?? '')).toMatchObject({ status: 'sent', articleId: 'a1' });
    expect(withDatabase(path, deliveries)).toEqual([
      {
        article_id: 'a1',
        message_id: 777,
        status: 'sent',
        created_at: expect.any(String) as unknown as string,
      },
    ]);
  });

  it('skips an article it already published', async () => {
    const path = seeded();
    const { calls, transport } = fakeTransport();

    const first = await run({ transport, openDatabase: open(path) });
    const second = await run({ transport, openDatabase: open(path) });

    expect(JSON.parse(first.stdout[0] ?? '')).toMatchObject({ status: 'sent' });
    expect(second.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(second.stdout[0] ?? '')).toEqual({
      status: 'skipped',
      articleId: 'a1',
      messageId: 777,
    });
    expect(second.stderr).toEqual([]);
    expect(summaryOf(first)).toEqual({
      summary: { sent: 1, skipped: 0, failed: 0 },
      results: [{ articleId: 'a1', outcome: 'sent' }],
    });
    expect(summaryOf(second)).toEqual({
      summary: { sent: 0, skipped: 1, failed: 0 },
      results: [{ articleId: 'a1', outcome: 'skipped' }],
    });
    // One send in total: the second run decided before touching the transport.
    expect(calls).toHaveLength(1);
    expect(withDatabase(path, deliveries)).toHaveLength(1);
  });

  it('writes nothing when the send fails, so the next run retries and succeeds', async () => {
    const path = seeded();
    const failing = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: false, description: 'chat not found' }),
    });

    const first = await run({ transport: failing.transport, openDatabase: open(path) });

    expect(first.code).toBe(EXIT_FAILURE);
    expect(withDatabase(path, deliveries)).toEqual([]);

    const succeeding = fakeTransport();
    const second = await run({ transport: succeeding.transport, openDatabase: open(path) });

    expect(second.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(second.stdout[0] ?? '')).toMatchObject({
      status: 'sent',
      articleId: 'a1',
      messageId: 777,
    });
    expect(succeeding.calls).toHaveLength(1);
    expect(withDatabase(path, deliveries)).toHaveLength(1);
  });

  it('retries after a transport failure too', async () => {
    const path = seeded();
    const broken: TelegramTransport = {
      async send() {
        throw new Error('ECONNRESET');
      },
    };

    expect((await run({ transport: broken, openDatabase: open(path) })).code).toBe(EXIT_FAILURE);
    expect(withDatabase(path, deliveries)).toEqual([]);

    expect(
      (await run({ transport: fakeTransport().transport, openDatabase: open(path) })).code,
    ).toBe(EXIT_SUCCESS);
    expect(withDatabase(path, deliveries)).toHaveLength(1);
  });

  it('does not skip an article whose only recorded row is a failure', async () => {
    const path = seeded();
    withDatabase(path, (database) => {
      database.query((connection) =>
        connection.all(
          `INSERT INTO notification_delivery (article_id, message_id, status, created_at)
           VALUES ('a1', 5, 'failed', '2026-02-02T00:00:00.000Z')`,
        ),
      );
    });
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, openDatabase: open(path) });

    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({ status: 'sent', messageId: 777 });
    expect(calls).toHaveLength(1);
    expect(withDatabase(path, deliveries)).toEqual([
      {
        article_id: 'a1',
        message_id: 777,
        status: 'sent',
        created_at: expect.any(String) as unknown as string,
      },
    ]);
  });
});

describe('notify CLI — a delivered message whose record could not be written', () => {
  /** Fails only the write: the table still reads, so the failure is the one under test. */
  function failWrites(path: string): void {
    withDatabase(path, (database) => {
      database.query((connection) =>
        connection.all(
          `CREATE TRIGGER refuse_delivery_write
             BEFORE INSERT ON notification_delivery
           BEGIN
             SELECT RAISE(ABORT, 'disk I/O error');
           END`,
        ),
      );
    });
  }

  function allowWrites(path: string): void {
    withDatabase(path, (database) => {
      database.query((connection) => connection.all('DROP TRIGGER refuse_delivery_write'));
    });
  }

  it('reports delivery-not-recorded with the message id, never sent or skipped', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [{ id: 'a1', order: 1 }]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    });
    failWrites(path);
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, openDatabase: () => openDatabase({ path }) });

    expect(result.code).toBe(EXIT_FAILURE);
    // The message really was delivered, so it must not be reported as a send failure.
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ articleId: 'a1', outcome: 'failed', reason: 'delivery-not-recorded' }],
    });
    expect(JSON.parse(result.stderr[0] ?? '')).toEqual({
      status: 'failed',
      reason: 'delivery-not-recorded',
      articleId: 'a1',
      messageId: 777,
      error: 'disk I/O error',
    });
    expect(calls).toHaveLength(1);
    // No row was invented, and no row was overwritten with a claim of success.
    expect(withDatabase(path, deliveries)).toEqual([]);
  });

  it('leaves the duplicate risk visible: the next run announces the article again', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [{ id: 'a1', order: 1 }]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    });
    failWrites(path);

    expect(
      (
        await run({
          transport: fakeTransport().transport,
          openDatabase: () => openDatabase({ path }),
        })
      ).code,
    ).toBe(EXIT_FAILURE);

    allowWrites(path);
    const { calls, transport } = fakeTransport();
    const second = await run({ transport, openDatabase: () => openDatabase({ path }) });

    expect(second.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(second.stdout[0] ?? '')).toMatchObject({ status: 'sent', articleId: 'a1' });
    expect(calls).toHaveLength(1);
    expect(withDatabase(path, deliveries)).toHaveLength(1);
  });
});

describe('notify CLI — a send Telegram refused writes nothing', () => {
  it('reports the provider reason, not a record failure, and stays retryable', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [{ id: 'a1', order: 1 }]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    });
    const failing = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: false, description: 'chat not found' }),
    });

    const result = await run({
      transport: failing.transport,
      openDatabase: () => openDatabase({ path }),
    });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ articleId: 'a1', outcome: 'failed', reason: 'api_rejected' }],
    });
    // Distinguishable from `delivery-not-recorded`: this failure delivered nothing.
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'api_rejected',
    });
    expect(withDatabase(path, deliveries)).toEqual([]);

    const retry = await run({
      transport: fakeTransport().transport,
      openDatabase: () => openDatabase({ path }),
    });
    expect(retry.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(retry.stdout[0] ?? '')).toMatchObject({ status: 'sent', messageId: 777 });
  });
});

describe('notify CLI — the end-of-run summary', () => {
  function seededPath(): string {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [{ id: 'a1', order: 1 }]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z');
    });
    return path;
  }

  it('counts a first send as one sent and nothing else', async () => {
    const path = seededPath();

    const result = await run({
      transport: fakeTransport().transport,
      openDatabase: () => openDatabase({ path }),
    });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(summaryOf(result)).toEqual({
      summary: { sent: 1, skipped: 0, failed: 0 },
      results: [{ articleId: 'a1', outcome: 'sent' }],
    });
  });

  it('counts a repeat as one skipped and no send', async () => {
    const path = seededPath();
    const { transport } = fakeTransport();
    await run({ transport, openDatabase: () => openDatabase({ path }) });

    const second = await run({ transport, openDatabase: () => openDatabase({ path }) });

    expect(second.code).toBe(EXIT_SUCCESS);
    expect(summaryOf(second)).toEqual({
      summary: { sent: 0, skipped: 1, failed: 0 },
      results: [{ articleId: 'a1', outcome: 'skipped' }],
    });
  });

  it('counts a failed send and keeps the reason and the article id', async () => {
    const path = seededPath();
    const { transport } = fakeTransport({ status: 503, body: '' });

    const result = await run({ transport, openDatabase: () => openDatabase({ path }) });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ articleId: 'a1', outcome: 'failed', reason: 'http_status' }],
    });
  });

  it('writes a zero summary when there was nothing to publish', async () => {
    const path = temporaryDatabasePath();

    const result = await run({
      transport: fakeTransport().transport,
      openDatabase: () => openDatabase({ path }),
    });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 0 },
      results: [],
    });
  });

  it('writes a summary even when the database could not be opened', async () => {
    const result = await run({
      openDatabase: () => {
        throw new Error('SQLITE_CANTOPEN');
      },
    });

    expect(result.code).toBe(EXIT_FAILURE);
    // No article was ever chosen, so the failure carries no article id.
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ outcome: 'failed', reason: 'unexpected-error' }],
    });
  });

  it('counts mixed results in one document', () => {
    expect(
      summarizeNotificationRun([
        { articleId: 'a1', outcome: 'sent' },
        { articleId: 'a2', outcome: 'skipped' },
        { articleId: 'a3', outcome: 'failed', reason: 'api_rejected' },
        { articleId: 'a4', outcome: 'failed', reason: 'missing_content' },
      ]),
    ).toEqual({
      summary: { sent: 1, skipped: 1, failed: 2 },
      results: [
        { articleId: 'a1', outcome: 'sent' },
        { articleId: 'a2', outcome: 'skipped' },
        { articleId: 'a3', outcome: 'failed', reason: 'api_rejected' },
        { articleId: 'a4', outcome: 'failed', reason: 'missing_content' },
      ],
    });
  });
});

describe('notify CLI — an article that fails validation', () => {
  // A blank summary is unreachable here: `article_derived` has a CHECK on
  // `length(summary_zh) > 0`, so the formatter unit tests cover that case.
  it.each([
    [
      'a link that is not an http(s) URL',
      'UPDATE articles SET url = ?, canonical_url = ?',
      ['not-a-url', 'not-a-url'],
    ],
    ['a whitespace-only title', 'UPDATE article_derived SET title_zh = ?', ['   ']],
  ])('is never sent and leaves no delivery record when it has %s', async (_label, sql, params) => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [{ id: 'a1', order: 1 }]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z');
      database.query((connection) => connection.all(sql, params));
    });
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, openDatabase: () => openDatabase({ path }) });

    // The provider refuses before any request, so nothing reaches Telegram and no
    // success row can exist for an article that was never published.
    expect(result.code).toBe(EXIT_FAILURE);
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ articleId: 'a1', outcome: 'failed', reason: 'missing_content' }],
    });
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'missing_content',
    });
    expect(calls).toEqual([]);
    expect(withDatabase(path, deliveries)).toEqual([]);
  });
});

describe('notify CLI — nothing to publish', () => {
  it('exits 0 with no-article when no derivation exists', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(result.stderr).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('notify CLI — publishing one category', () => {
  it('sends the newest article of the named category, not the newest overall', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [
      { id: 'a1', order: 1 },
      { id: 'a2', order: 2 },
      { id: 'a3', order: 3 },
    ]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z', '財經');
    derive(database, 'a2', '2026-03-01T00:00:00.000Z', '科技');
    // Newest overall, and the wrong category for this run.
    derive(database, 'a3', '2026-04-01T00:00:00.000Z', '體育');
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database, category: '財經' });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      status: 'sent',
      articleId: 'a1',
      messageId: 777,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ chat_id: CHAT_ID });
    expect(calls[0]?.payload).toEqual({
      chat_id: CHAT_ID,
      text: formatTelegramMessage({
        articleId: 'a1',
        titleZh: '標題 a1',
        summaryZh: '摘要 a1',
        at: '2026-02-01T00:00:00.000Z',
        sourceUrl: 'https://example.com/a1',
      }),
    });
  });

  it('records the delivery of the category article, not of the newest one', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [
        { id: 'a1', order: 1 },
        { id: 'a2', order: 2 },
      ]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z', '健康');
      derive(database, 'a2', '2026-03-01T00:00:00.000Z', '財經');
    });
    const { transport } = fakeTransport();

    const result = await run({
      transport,
      openDatabase: () => openDatabase({ path }),
      category: '健康',
    });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(withDatabase(path, deliveries)).toEqual([
      {
        article_id: 'a1',
        message_id: 777,
        status: 'sent',
        created_at: expect.any(String) as unknown as string,
      },
    ]);
  });

  it('still publishes the newest article of any category when none is named', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [
      { id: 'a1', order: 1 },
      { id: 'a2', order: 2 },
    ]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z', '財經');
    derive(database, 'a2', '2026-03-01T00:00:00.000Z', '體育');
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({ status: 'sent', articleId: 'a2' });
    expect(calls).toHaveLength(1);
  });

  it('skips an already-published article of that category instead of sending again', async () => {
    const path = temporaryDatabasePath();
    withDatabase(path, (database) => {
      seed(database, [
        { id: 'a1', order: 1 },
        { id: 'a2', order: 2 },
      ]);
      derive(database, 'a1', '2026-02-01T00:00:00.000Z', '財經');
      derive(database, 'a2', '2026-03-01T00:00:00.000Z', '財經');
    });
    const first = fakeTransport();
    const firstRun = await run({
      transport: first.transport,
      openDatabase: () => openDatabase({ path }),
      category: '財經',
    });
    expect(JSON.parse(firstRun.stdout[0] ?? '')).toMatchObject({ articleId: 'a2' });

    const second = fakeTransport();
    const secondRun = await run({
      transport: second.transport,
      openDatabase: () => openDatabase({ path }),
      category: '財經',
    });

    expect(secondRun.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(secondRun.stdout[0] ?? '')).toEqual({
      status: 'skipped',
      articleId: 'a2',
      messageId: 777,
    });
    expect(second.calls).toEqual([]);
    expect(summaryOf(secondRun)).toEqual({
      summary: { sent: 0, skipped: 1, failed: 0 },
      results: [{ articleId: 'a2', outcome: 'skipped' }],
    });
    expect(withDatabase(path, deliveries)).toHaveLength(1);
  });

  it('reports no-article when the category has no derived record', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z', '財經');
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database, category: '娛樂' });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(summaryOf(result)).toEqual({
      summary: { sent: 0, skipped: 0, failed: 0 },
      results: [],
    });
    expect(calls).toEqual([]);
  });

  it('never selects a record whose category is null when a category is named', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z', null);
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database, category: '財經' });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(calls).toEqual([]);
  });

  it('still publishes that unclassified record when no category is named', async () => {
    const database = openDatabase({ path: ':memory:' });
    seed(database, [{ id: 'a1', order: 1 }]);
    derive(database, 'a1', '2026-02-01T00:00:00.000Z', null);
    const { calls, transport } = fakeTransport();

    const result = await run({ transport, database });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({ status: 'sent', articleId: 'a1' });
    expect(calls).toHaveLength(1);
  });
});
