import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../../src/core/persistence/sqlite.js';

import { assertNoDatabaseFiles, spawnCli } from './harness.js';

/**
 * Process-level behaviour of the Recovery CLI (`D-3`, `D-4`).
 *
 * These cases assert what a scheduler observes: the exit code and whether a
 * database was touched at all. Nothing here reaches into the run — the
 * repository semantics are covered by the Processing integration suite.
 */

const SCRIPT = 'recover.ts';

const directories: string[] = [];

function newDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), 'kou-recover-cli-'));
  directories.push(created);
  return created;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedExpiredJob(path: string): void {
  const database = openDatabase({ path });
  try {
    database.query((connection) => {
      connection.all(
        `INSERT INTO processing_lifecycle (lifecycle_id, article_id, opened_at)
         VALUES ('lc-1', 'a1:article-1', '2026-11-27T00:00:00Z')`,
      );
      connection.all(
        `INSERT INTO processing_job
           (lifecycle_id, processing_version, state, attempts, lease_owner, lease_token,
            lease_expires_at, created_at, updated_at)
         VALUES ('lc-1', 1, 'running', 1, 'worker-1', 'token-1', ?,
                 '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')`,
        [Date.now() - 60_000],
      );
    });
  } finally {
    database.close();
  }
}

interface JobRow {
  state: string;
  attempts: number;
  lease_token: string | null;
}

function readJob(path: string): JobRow | undefined {
  const database = openDatabase({ path });
  try {
    return database.query((connection) =>
      connection.get(
        `SELECT state, attempts, lease_token
           FROM processing_job
          WHERE lifecycle_id = 'lc-1' AND processing_version = 1`,
      ),
    ) as JobRow | undefined;
  } finally {
    database.close();
  }
}

describe('recover CLI', () => {
  it('rejects an invocation with no arguments and creates no database', () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'absent.db');

    const result = spawnCli({
      script: SCRIPT,
      args: [],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--execute');
    assertNoDatabaseFiles(databasePath);
  });

  it('rejects --dry-run and creates no database', () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'absent.db');

    const result = spawnCli({
      script: SCRIPT,
      args: ['--dry-run'],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Recovery has no preview mode; pass --execute.');
    assertNoDatabaseFiles(databasePath);
  });

  it('prints help and creates no database', () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'absent.db');

    const result = spawnCli({
      script: SCRIPT,
      args: ['--help'],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: recover [--help | --execute]');
    expect(result.stdout).toContain('--execute');
    assertNoDatabaseFiles(databasePath);
  });

  it('rejects an unknown argument and creates no database', () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'absent.db');

    const result = spawnCli({
      script: SCRIPT,
      args: ['--nope'],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown argument: --nope');
    assertNoDatabaseFiles(databasePath);
  });

  it('reports a zero count against an empty database', () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'kou-news.db');

    const result = spawnCli({
      script: SCRIPT,
      args: ['--execute'],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"reopened":0');
  });

  it('reopens an expired job and reports the count', () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'kou-news.db');
    seedExpiredJob(databasePath);

    const result = spawnCli({
      script: SCRIPT,
      args: ['--execute'],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"reopened":1');

    const job = readJob(databasePath);
    expect(job?.state).toBe('pending');
    expect(job?.lease_token).toBeNull();
    expect(job?.attempts).toBe(1);
  });
});
