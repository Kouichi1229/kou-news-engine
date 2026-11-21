import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { EXTRACTOR_VERSION } from '../../../src/modules/extraction/extraction.constants.js';
import { SqliteArticleContentRepository } from '../../../src/modules/extraction/repository/sqlite-article-content.repository.js';

const run = promisify(execFile);

/**
 * Cross-OS-process contention test.
 *
 * The repository's claim path uses `BEGIN IMMEDIATE` precisely so that two
 * *processes* cannot both claim the same row. A single-process test with two
 * repository objects would share one connection and prove nothing: SQLite's
 * locking is not exercised at all.
 *
 * Each worker is a real child process with its own connection to the same
 * database file, on a temporary directory created with `os.tmpdir()` so the
 * test works on Linux, macOS and Windows and never touches the repository.
 */
describe('cross-process claim contention', () => {
  let directory: string;
  let databasePath: string;
  let database: SqliteDatabase;

  const WORKER_COUNT = 4;
  const ARTICLE_COUNT = 40;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kou-contention-'));
    databasePath = join(directory, 'contention.db');

    database = openDatabase({ path: databasePath });
    database.query((connection) => {
      for (let index = 0; index < ARTICLE_COUNT; index += 1) {
        const id = `article-${String(index).padStart(3, '0')}`;
        connection.all(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
          [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, index],
        );
      }
    });

    const repository = new SqliteArticleContentRepository(database);
    await repository.seed(EXTRACTOR_VERSION);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('never lets two processes claim the same article', async () => {
    const workers = Array.from({ length: WORKER_COUNT }, (_unused, index) =>
      run(
        'npx',
        ['tsx', 'tests/helpers/contention-worker.ts', databasePath, `worker-${String(index)}`],
        { cwd: process.cwd() },
      ),
    );

    const results = await Promise.all(workers);
    const claims = results.map(
      (result) =>
        JSON.parse(result.stdout) as {
          workerId: string;
          won: string[];
        },
    );

    const allWon = claims.flatMap((claim) => claim.won);

    // Every article is claimed exactly once across all processes: no duplicates
    // (the bug `BEGIN IMMEDIATE` prevents) and no gaps (the queue is drained).
    expect(new Set(allWon).size).toBe(allWon.length);
    expect(allWon).toHaveLength(ARTICLE_COUNT);

    // At least one process must have done the work. Asserting that *every*
    // worker won something would be racy: `tsx` startup varies by hundreds of
    // milliseconds, so a late worker can find the queue already drained. That
    // is a property of process scheduling, not of the claim path.
    expect(allWon.length).toBeGreaterThan(0);
    expect(claims.some((claim) => claim.won.length > 0)).toBe(true);
  }, 60_000);

  it('leaves every claimed row in the in_progress state owned by one worker', async () => {
    await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_unused, index) =>
        run(
          'npx',
          ['tsx', 'tests/helpers/contention-worker.ts', databasePath, `worker-${String(index)}`],
          { cwd: process.cwd() },
        ),
      ),
    );

    const rows = database.query((connection) =>
      connection.all(
        `SELECT article_id, status, lease_owner, lease_token, attempts
           FROM article_contents ORDER BY article_id`,
      ),
    ) as Array<{
      article_id: string;
      status: string;
      lease_owner: string | null;
      lease_token: string | null;
      attempts: number;
    }>;

    expect(rows).toHaveLength(ARTICLE_COUNT);
    for (const row of rows) {
      expect(row.status).toBe('in_progress');
      expect(row.lease_owner).not.toBeNull();
      expect(row.lease_token).not.toBeNull();
      expect(row.attempts).toBe(1);
    }

    // Each lease token is unique, which the schema's partial unique index also
    // enforces; asserting it here documents why that index exists.
    const tokens = rows.map((row) => row.lease_token);
    expect(new Set(tokens).size).toBe(ARTICLE_COUNT);
  }, 60_000);
});
