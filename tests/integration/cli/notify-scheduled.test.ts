import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from '../../../src/cli/exit-codes.js';
import { scheduledConfigFromEnv } from '../../../src/cli/scheduled-notify.cli.js';
import { runScheduledNotification } from '../../../src/cli/scheduled-notify.cli.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
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

interface Captured {
  code: number;
  stdout: string[];
  stderr: string[];
}

async function run(
  path: string,
  options: { transport?: TelegramTransport; token?: string | undefined } = {},
): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runScheduledNotification({
    config: {
      databasePath: path,
      botToken: 'token' in options ? options.token : TOKEN,
      chatId: CHAT_ID,
    },
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
    expect(result.stdout).toEqual([]);
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
});
