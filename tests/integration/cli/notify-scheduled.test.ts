import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from '../../../src/cli/exit-codes.js';
import { scheduledConfigFromEnv } from '../../../src/cli/scheduled-notify.cli.js';
import { runScheduledNotification } from '../../../src/cli/scheduled-notify.cli.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import type { DerivationCategory } from '../../../src/modules/derivation/derivation.service.js';
import type { TelegramTransport } from '../../../src/modules/notification/telegram.provider.js';

/**
 * The scheduled entry, exercised without a scheduler.
 *
 * The point of this file is that the entry adds nothing: every outcome below is
 * produced by `runNotificationCli`, so a change in deduplication or error
 * reporting shows up here too. Only the HTTP transport is replaced.
 */
const TOKEN = 'scheduled-token';
const CHAT_ID = '-1005550001111';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-notify-scheduled-'));
  directories.push(directory);
  return join(directory, 'test.db');
}

function withDatabase<T>(path: string, write: (database: SqliteDatabase) => T): T {
  const database = openDatabase({ path });
  try {
    return write(database);
  } finally {
    database.close();
  }
}

function seed(path: string): void {
  withDatabase(path, (database) => {
    database.query((connection) => {
      connection.all(
        `INSERT INTO articles
           (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
         VALUES ('a1', 'Title a1', 'https://example.com/a1', 'https://example.com/a1', 0,
                 '2026-01-01T00:00:00Z', 1)`,
      );
      connection.all(
        `INSERT INTO article_derived (article_id, title_zh, summary_zh, created_at, updated_at)
         VALUES ('a1', '標題 a1', '摘要 a1', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
      );
    });
  });
}

/**
 * Seeds several derived records, each with an explicit category and timestamp.
 *
 * The existing `seed()` writes one row without a category, which is the legacy
 * shape; these fixtures name both so the filter has something to choose between.
 */
function seedCategories(
  path: string,
  rows: ReadonlyArray<{ id: string; updatedAt: string; category: string | null }>,
): void {
  withDatabase(path, (database) => {
    database.query((connection) => {
      for (const [index, row] of rows.entries()) {
        connection.all(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
          [
            row.id,
            `Title ${row.id}`,
            `https://example.com/${row.id}`,
            `https://example.com/${row.id}`,
            index + 1,
          ],
        );
        connection.all(
          `INSERT INTO article_derived
             (article_id, title_zh, summary_zh, category, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.id, `標題 ${row.id}`, `摘要 ${row.id}`, row.category, row.updatedAt, row.updatedAt],
        );
      }
    });
  });
}

function fakeTransport(
  response: { status: number; body: string } = {
    status: 200,
    body: '{"ok":true,"result":{"message_id":901}}',
  },
): { calls: () => number; transport: TelegramTransport } {
  let calls = 0;
  return {
    calls: () => calls,
    transport: {
      async send() {
        calls += 1;
        return response;
      },
    },
  };
}

function summary(run: Captured): unknown {
  return JSON.parse(run.stdout.at(-1) ?? '');
}

interface Captured {
  code: number;
  stdout: string[];
  stderr: string[];
}

async function run(
  path: string,
  options: {
    transport?: TelegramTransport;
    token?: string | undefined;
    category?: DerivationCategory;
  } = {},
): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runScheduledNotification({
    config: {
      databasePath: path,
      botToken: 'token' in options ? options.token : TOKEN,
      chatId: CHAT_ID,
    },
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    logger: { info: () => undefined, error: () => undefined },
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe('scheduled entry — it runs the existing publish flow', () => {
  it('publishes the newest derived article and records the delivery', async () => {
    const path = temporaryDatabasePath();
    seed(path);
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      status: 'sent',
      articleId: 'a1',
      messageId: 901,
    });
    expect(calls()).toBe(1);

    const rows = withDatabase(path, (database) =>
      database.query((connection) =>
        connection.all('SELECT article_id, message_id, status FROM notification_delivery'),
      ),
    );
    expect(rows).toEqual([{ article_id: 'a1', message_id: 901, status: 'sent' }]);
  });

  it('inherits the deduplication: a second run skips instead of sending', async () => {
    const path = temporaryDatabasePath();
    seed(path);
    const { calls, transport } = fakeTransport();

    await run(path, { transport });
    const second = await run(path, { transport });

    expect(second.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(second.stdout[0] ?? '')).toEqual({
      status: 'skipped',
      articleId: 'a1',
      messageId: 901,
    });
    expect(calls()).toBe(1);
  });

  it('reports an empty database as a successful no-op', async () => {
    const path = temporaryDatabasePath();
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(calls()).toBe(0);
  });
});

describe('scheduled entry — failures reach the caller', () => {
  it('passes a Telegram refusal through with a non-zero code', async () => {
    const path = temporaryDatabasePath();
    seed(path);
    const { transport } = fakeTransport({
      status: 200,
      body: '{"ok":false,"description":"chat not found"}',
    });

    const result = await run(path, { transport });

    expect(result.code).toBe(EXIT_FAILURE);
    // The failure document goes to stderr; stdout still carries the run summary.
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      summary: { sent: 0, skipped: 0, failed: 1 },
      results: [{ articleId: 'a1', outcome: 'failed', reason: 'api_rejected' }],
    });
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'api_rejected',
    });
  });

  it('passes a transport failure through with a non-zero code', async () => {
    const path = temporaryDatabasePath();
    seed(path);
    const transport: TelegramTransport = {
      async send() {
        throw new Error('ECONNREFUSED');
      },
    };

    const result = await run(path, { transport });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({
      status: 'failed',
      reason: 'network',
    });
  });

  it('passes missing configuration through without touching the network', async () => {
    const path = temporaryDatabasePath();
    seed(path);
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport, token: undefined });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stderr[0] ?? '')).toMatchObject({ reason: 'not_configured' });
    expect(calls()).toBe(0);
  });
});

describe('scheduled entry — configuration comes from the environment', () => {
  it('reads the database path, the credentials and nothing else', () => {
    const config = scheduledConfigFromEnv({
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      APP_TIMEZONE: 'Asia/Taipei',
      DATABASE_PATH: '/var/lib/kou/news.db',
      SHUTDOWN_TIMEOUT_MS: 8000,
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'default',
      LLM_TIMEOUT_MS: 30000,
      LLM_MAX_OUTPUT_TOKENS: 2048,
      GEMINI_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: 'token-from-env',
      TELEGRAM_CHAT_ID: '-1001234567890',
    });

    expect(config).toEqual({
      databasePath: '/var/lib/kou/news.db',
      botToken: 'token-from-env',
      chatId: '-1001234567890',
    });
  });

  it('reports no configuration rather than a hard-coded default', () => {
    const config = scheduledConfigFromEnv({
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      APP_TIMEZONE: 'Asia/Taipei',
      DATABASE_PATH: '/var/lib/kou/news.db',
      SHUTDOWN_TIMEOUT_MS: 8000,
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'default',
      LLM_TIMEOUT_MS: 30000,
      LLM_MAX_OUTPUT_TOKENS: 2048,
      GEMINI_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    });

    expect(config.botToken).toBeUndefined();
    expect(config.chatId).toBeUndefined();
  });
});

describe('scheduled entry — one category', () => {
  it('publishes the newest article of the named category, not the newest overall', async () => {
    const path = temporaryDatabasePath();
    seedCategories(path, [
      { id: 'a1', updatedAt: '2026-02-01T00:00:00.000Z', category: '財經' },
      { id: 'a2', updatedAt: '2026-03-01T00:00:00.000Z', category: '科技' },
      { id: 'a3', updatedAt: '2026-04-01T00:00:00.000Z', category: '體育' },
    ]);
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport, category: '財經' });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      status: 'sent',
      articleId: 'a1',
      messageId: 901,
    });
    expect(calls()).toBe(1);
    expect(summary(result)).toEqual({
      summary: { sent: 1, skipped: 0, failed: 0 },
      results: [{ articleId: 'a1', outcome: 'sent' }],
    });

    const rows = withDatabase(path, (database) =>
      database.query((connection) =>
        connection.all('SELECT article_id, status FROM notification_delivery'),
      ),
    );
    expect(rows).toEqual([{ article_id: 'a1', status: 'sent' }]);
  });

  it('keeps the deduplication: the same category article is skipped next time', async () => {
    const path = temporaryDatabasePath();
    seedCategories(path, [{ id: 'a1', updatedAt: '2026-02-01T00:00:00.000Z', category: '財經' }]);
    const first = fakeTransport();

    await run(path, { transport: first.transport, category: '財經' });
    const second = fakeTransport();
    const result = await run(path, { transport: second.transport, category: '財經' });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({
      status: 'skipped',
      articleId: 'a1',
      messageId: 901,
    });
    expect(second.calls()).toBe(0);
  });

  it('publishes the newest article of any category when none is named', async () => {
    const path = temporaryDatabasePath();
    seedCategories(path, [
      { id: 'a1', updatedAt: '2026-02-01T00:00:00.000Z', category: '財經' },
      { id: 'a2', updatedAt: '2026-03-01T00:00:00.000Z', category: '體育' },
    ]);
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport });

    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({ status: 'sent', articleId: 'a2' });
    expect(calls()).toBe(1);
  });

  it('reports no-article when that category has nothing to publish', async () => {
    const path = temporaryDatabasePath();
    seedCategories(path, [{ id: 'a1', updatedAt: '2026-02-01T00:00:00.000Z', category: '財經' }]);
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport, category: '娛樂' });

    expect(result.code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(calls()).toBe(0);
  });

  it('does not reach the network for a record whose category is null', async () => {
    const path = temporaryDatabasePath();
    seedCategories(path, [{ id: 'a1', updatedAt: '2026-02-01T00:00:00.000Z', category: null }]);
    const { calls, transport } = fakeTransport();

    const result = await run(path, { transport, category: '財經' });

    expect(JSON.parse(result.stdout[0] ?? '')).toEqual({ status: 'no-article' });
    expect(calls()).toBe(0);
  });
});

describe('scheduled entry — the command line', () => {
  const repositoryRoot = join(import.meta.dirname, '..', '..', '..');

  function spawn(args: readonly string[], databasePath: string): number | null {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join('src', 'cli', 'notify-scheduled.ts'), ...args],
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

  it('rejects any other argument with exit 2 and opens no database', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--execute'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects an unknown category with exit 2 and opens no database', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--category', '運動'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects --category with no value, and --category given twice', () => {
    const noValue = temporaryDatabasePath();
    const twice = temporaryDatabasePath();

    expect(spawn(['--category'], noValue)).toBe(EXIT_USAGE);
    expect(spawn(['--category', '財經', '--category', '科技'], twice)).toBe(EXIT_USAGE);
    expect(existsSync(noValue)).toBe(false);
    expect(existsSync(twice)).toBe(false);
  });

  it('rejects an unknown flag with exit 2 and opens no database', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--frobnicate'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects an unknown flag even when a valid --category is also given', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--category', '財經', '--frobnicate'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects the --category=<value> spelling as an unknown argument', () => {
    const path = temporaryDatabasePath();

    expect(spawn(['--category=財經'], path)).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });

  it('accepts a known category and hands off, finding nothing in an empty database', () => {
    const path = temporaryDatabasePath();

    // The run gets past argument parsing and past the category check: it opens the
    // database and reports the steady state. Nothing is sent, because there is
    // nothing to send.
    expect(spawn(['--category', '財經'], path)).toBe(EXIT_SUCCESS);
    expect(existsSync(path)).toBe(true);
  });
});
