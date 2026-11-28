import { describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_SUCCESS } from '../../../src/cli/exit-codes.js';
import { runNotificationCli } from '../../../src/cli/notification.cli.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
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

function derive(database: SqliteDatabase, articleId: string, updatedAt: string): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO article_derived (article_id, title_zh, summary_zh, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [articleId, `標題 ${articleId}`, `摘要 ${articleId}`, updatedAt, updatedAt],
    );
  });
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
  } = {},
): Promise<CapturedRun> {
  const database = options.database ?? openDatabase({ path: ':memory:' });
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runNotificationCli({
    openDatabase: options.openDatabase ?? (() => database),
    botToken: 'botToken' in options ? options.botToken : TOKEN,
    chatId: 'chatId' in options ? options.chatId : CHAT_ID,
    transport: options.transport ?? fakeTransport().transport,
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
    expect(result.stdout).toEqual([]);
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
