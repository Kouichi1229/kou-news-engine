import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_SUCCESS } from '../../../src/cli/exit-codes.js';
import { runRecoveryCli } from '../../../src/cli/recovery.cli.js';
import { usageFor } from '../../../src/cli/usage.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';

/**
 * Recovery CLI execution logic.
 *
 * Every case runs against a real SQLite file rather than a double, because the
 * behaviour under test is the transaction the repository already owns. The file
 * also lets a case reopen the database after the run closed it, which is how
 * the reopened state is observed.
 */

const NOW = 1_000_000;
const EXPIRED = NOW - 1;
const LIVE = NOW + 60_000;
const CREATED_AT = '2026-11-27T00:00:00Z';

interface LogRecord {
  readonly level: 'info' | 'error';
  readonly message: string;
  readonly meta: unknown;
}

const directories: string[] = [];

function newDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-recovery-cli-'));
  directories.push(directory);
  return join(directory, 'kou-news.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function recordingLogger(records: LogRecord[]) {
  return {
    info: (message: string, meta?: unknown): void => {
      records.push({ level: 'info', message, meta });
    },
    error: (message: string, meta?: unknown): void => {
      records.push({ level: 'error', message, meta });
    },
  };
}

function seedLifecycle(database: SqliteDatabase, lifecycleId: string): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO processing_lifecycle (lifecycle_id, article_id, opened_at)
       VALUES (?, ?, ?)`,
      [lifecycleId, `a1:${lifecycleId}`, CREATED_AT],
    );
  });
}

function seedRunningJob(
  database: SqliteDatabase,
  lifecycleId: string,
  version: number,
  attempts: number,
  leaseExpiresAt: number,
): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO processing_job
         (lifecycle_id, processing_version, state, attempts, lease_owner, lease_token,
          lease_expires_at, created_at, updated_at)
       VALUES (?, ?, 'running', ?, 'worker-1', ?, ?, ?, ?)`,
      [
        lifecycleId,
        version,
        attempts,
        `token-${String(version)}`,
        leaseExpiresAt,
        CREATED_AT,
        CREATED_AT,
      ],
    );
  });
}

function seedTerminalJob(
  database: SqliteDatabase,
  lifecycleId: string,
  version: number,
  reason: string,
): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO processing_job
         (lifecycle_id, processing_version, state, attempts, terminal_reason,
          created_at, updated_at)
       VALUES (?, ?, 'terminal', 3, ?, ?, ?)`,
      [lifecycleId, version, reason, CREATED_AT, CREATED_AT],
    );
  });
}

interface JobRow {
  state: string;
  attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  terminal_reason: string | null;
  updated_at: string;
}

function readJob(path: string, lifecycleId: string, version: number): JobRow | undefined {
  const database = openDatabase({ path });
  try {
    return database.query((connection) =>
      connection.get(
        `SELECT state, attempts, lease_owner, lease_token, lease_expires_at,
                terminal_reason, updated_at
           FROM processing_job
          WHERE lifecycle_id = ? AND processing_version = ?`,
        [lifecycleId, version],
      ),
    ) as JobRow | undefined;
  } finally {
    database.close();
  }
}

describe('runRecoveryCli', () => {
  it('reopens an expired running job and reports the count', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedRunningJob(database, 'lc-1', 1, 1, EXPIRED);

    const records: LogRecord[] = [];
    const code = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger(records),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(records).toEqual([
      { level: 'info', message: 'Recovery run finished', meta: { reopened: 1 } },
    ]);

    const job = readJob(path, 'lc-1', 1);
    expect(job?.state).toBe('pending');
    expect(job?.lease_owner).toBeNull();
    expect(job?.lease_token).toBeNull();
    expect(job?.lease_expires_at).toBeNull();
    expect(job?.attempts).toBe(1);
    expect(job?.updated_at).toBe(new Date(NOW).toISOString());
  });

  it('succeeds with a zero count when nothing is expired', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });

    const records: LogRecord[] = [];
    const code = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger(records),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(records).toEqual([
      { level: 'info', message: 'Recovery run finished', meta: { reopened: 0 } },
    ]);
  });

  it('leaves an exhausted expired job untouched (D-1)', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedRunningJob(database, 'lc-1', 1, 3, EXPIRED);

    const code = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger([]),
    });

    expect(code).toBe(EXIT_SUCCESS);
    const job = readJob(path, 'lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.terminal_reason).toBeNull();
    expect(job?.attempts).toBe(3);
  });

  it('does not rewrite a committed terminal job', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedTerminalJob(database, 'lc-1', 1, 'failed_terminal');

    const code = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger([]),
    });

    expect(code).toBe(EXIT_SUCCESS);
    const job = readJob(path, 'lc-1', 1);
    expect(job?.state).toBe('terminal');
    expect(job?.terminal_reason).toBe('failed_terminal');
  });

  it('does not reopen a lease that has not expired', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedRunningJob(database, 'lc-1', 1, 1, LIVE);

    const code = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger([]),
    });

    expect(code).toBe(EXIT_SUCCESS);
    const job = readJob(path, 'lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.lease_token).toBe('token-1');
  });

  it('closes the database it opened', async () => {
    const database = openDatabase({ path: newDatabasePath() });
    expect(database.isOpen).toBe(true);

    const code = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger([]),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(database.isOpen).toBe(false);
  });

  it('fails without retrying when the database cannot be opened', async () => {
    const records: LogRecord[] = [];
    let attempts = 0;

    const code = await runRecoveryCli({
      openDatabase: (): SqliteDatabase => {
        attempts += 1;
        throw new Error('database unavailable');
      },
      now: () => NOW,
      logger: recordingLogger(records),
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(attempts).toBe(1);
    expect(records).toEqual([
      {
        level: 'error',
        message: 'Recovery run failed',
        meta: { error: 'database unavailable' },
      },
    ]);
  });

  it('reopens nothing on a second consecutive run', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedRunningJob(database, 'lc-1', 1, 1, EXPIRED);

    const first = await runRecoveryCli({
      openDatabase: () => database,
      now: () => NOW,
      logger: recordingLogger([]),
    });
    const second = await runRecoveryCli({
      openDatabase: () => openDatabase({ path }),
      now: () => NOW,
      logger: recordingLogger([]),
    });

    expect(first).toBe(EXIT_SUCCESS);
    expect(second).toBe(EXIT_SUCCESS);
    expect(readJob(path, 'lc-1', 1)?.state).toBe('pending');
  });

  it('keeps the success result when the database cannot be closed', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedRunningJob(database, 'lc-1', 1, 1, EXPIRED);

    const refusing = Object.create(database) as SqliteDatabase;
    Object.defineProperty(refusing, 'close', {
      value: (): void => {
        throw new Error('close refused');
      },
    });

    const records: LogRecord[] = [];
    const code = await runRecoveryCli({
      openDatabase: () => refusing,
      now: () => NOW,
      logger: recordingLogger(records),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(records.map((record) => record.message)).toEqual([
      'Recovery run finished',
      'Recovery database could not be closed',
    ]);

    database.close();
    expect(readJob(path, 'lc-1', 1)?.state).toBe('pending');
  });

  it('keeps the failure result when the database cannot be closed', async () => {
    const path = newDatabasePath();
    const database = openDatabase({ path });
    seedLifecycle(database, 'lc-1');
    seedRunningJob(database, 'lc-1', 1, 1, EXPIRED);
    // A real persistence failure: every write statement is rejected.
    database.query((connection) => {
      connection.all('PRAGMA query_only = ON');
    });

    const refusing = Object.create(database) as SqliteDatabase;
    Object.defineProperty(refusing, 'close', {
      value: (): void => {
        throw new Error('close refused');
      },
    });

    const records: LogRecord[] = [];
    const code = await runRecoveryCli({
      openDatabase: () => refusing,
      now: () => NOW,
      logger: recordingLogger(records),
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(records[0]?.level).toBe('error');
    expect(records[0]?.message).toBe('Recovery run failed');
    expect(records.map((record) => record.message)).toContain(
      'Recovery database could not be closed',
    );

    database.close();
    expect(readJob(path, 'lc-1', 1)?.state).toBe('running');
  });
});

describe('usageFor compatibility', () => {
  it('keeps the ingestion usage byte-for-byte identical', () => {
    expect(usageFor('ingest', 'Run one ingestion pass over the configured feeds.')).toBe(
      `Usage: ingest [--help | --dry-run | --execute]

Run one ingestion pass over the configured feeds.

Options:
  --help, -h   Show this message and exit. Opens no database.
  --dry-run    Preview only. Reads the database read-only, writes nothing,
               and makes no network requests. This is the default.
  --execute    Perform real work. The only flag that may write to the database
               or send requests.

With no arguments the command runs a dry-run preview, never real work. A
scheduler must pass --execute explicitly.
`,
    );
  });

  it('keeps the extraction usage byte-for-byte identical', () => {
    expect(usageFor('extract', 'Extract one batch of article bodies.')).toBe(
      `Usage: extract [--help | --dry-run | --execute]

Extract one batch of article bodies.

Options:
  --help, -h   Show this message and exit. Opens no database.
  --dry-run    Preview only. Reads the database read-only, writes nothing,
               and makes no network requests. This is the default.
  --execute    Perform real work. The only flag that may write to the database
               or send requests.

With no arguments the command runs a dry-run preview, never real work. A
scheduler must pass --execute explicitly.
`,
    );
  });

  it('documents that recovery requires --execute', () => {
    const usage = usageFor('recover', 'Reopen processing jobs whose lease expired.', {
      executeRequired: true,
    });

    expect(usage).toContain('Usage: recover [--help | --execute]');
    expect(usage).not.toContain('--dry-run');
    expect(usage).toContain('must pass');
  });
});
