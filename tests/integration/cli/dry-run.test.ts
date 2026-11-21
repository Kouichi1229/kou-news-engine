import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PREVIEW_NOTES, runExtractionCli } from '../../../src/cli/extraction.cli.js';
import { runCli } from '../../../src/cli/ingestion.cli.js';
import { EXIT_FAILURE, EXIT_SUCCESS } from '../../../src/cli/exit-codes.js';
import { openDatabase } from '../../../src/core/persistence/sqlite.js';
import { EXTRACTOR_VERSION } from '../../../src/modules/extraction/extraction.constants.js';
import { SqliteArticleContentRepository } from '../../../src/modules/extraction/repository/sqlite-article-content.repository.js';

/**
 * Dry-run behaviour of both CLIs.
 *
 * The assertions are about absence: no fetch, no exit code other than success,
 * and one single-line JSON document on stdout. `fetchImpl` throws if called, so
 * any network attempt fails the test rather than reaching the internet.
 */
const directories: string[] = [];

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), 'kou-dry-run-'));
  directories.push(created);
  return created;
}

function forbiddenFetch(): never {
  throw new Error('a dry-run must not perform a network request');
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => {
  // Every directory created during a test is removed: several tests build more
  // than one database, so a single tracked path would leak the rest.
  for (const created of directories.splice(0)) {
    rmSync(created, { recursive: true, force: true });
  }
});

describe('extraction dry-run', () => {
  interface Preview {
    mode: string;
    database: string;
    articles: number | null;
    seeded: boolean | null;
    claimable: number | null;
    note: string;
  }

  /** Runs the preview and parses the single line it must write. */
  async function preview(path: string): Promise<{ code: number; lines: string[]; json: Preview }> {
    const lines: string[] = [];
    const code = await runExtractionCli({
      databasePath: path,
      writeStdout: (line) => lines.push(line),
      logger: silentLogger,
    });
    const parsed = JSON.parse(lines[0] ?? 'null') as Preview;
    return { code, lines, json: parsed };
  }

  /** Creates a migrated database holding `count` articles and returns its path. */
  function databaseWithArticles(count: number): string {
    const path = join(temporaryDirectory(), `articles-${String(count)}.db`);
    const database = openDatabase({ path });
    for (let index = 0; index < count; index += 1) {
      const id = `a${String(index)}`;
      database.query((connection) => {
        connection.all(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
          [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, index],
        );
      });
    }
    database.close();
    return path;
  }

  it('writes one line of JSON and exits successfully', async () => {
    const lines: string[] = [];
    const code = await runExtractionCli({
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      logger: silentLogger,
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ mode: 'dry-run' });
  });

  it('reports an unavailable count rather than creating the database', async () => {
    const lines: string[] = [];
    await runExtractionCli({
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      logger: silentLogger,
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { claimable?: unknown };
    expect(parsed.claimable).toBeNull();
  });

  it('does not extract when execute is omitted', async () => {
    // `openDatabase` would create and migrate a database. It must not be called.
    let opened = false;
    const code = await runExtractionCli({
      openDatabase: () => {
        opened = true;
        throw new Error('must not open a writable database during a dry-run');
      },
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: () => undefined,
      logger: silentLogger,
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(opened).toBe(false);
  });

  it('test 1 — reports an empty database without claiming it is seeded', async () => {
    const { code, json } = await preview(databaseWithArticles(0));

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 0,
      seeded: null,
      claimable: 0,
      note: PREVIEW_NOTES.noArticles,
    });
  });

  it('test 2 — reports articles that have never been seeded', async () => {
    const path = databaseWithArticles(3);
    const { code, json } = await preview(path);

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 3,
      seeded: false,
      claimable: 0,
      note: PREVIEW_NOTES.unseeded,
    });

    // The figure that made this fix necessary: 0 claimable would otherwise read
    // as "nothing to do" while the next run would process all three articles.
    expect(json.note).toBe('articles exist but extraction lifecycle records have not been seeded');

    // And it must not have seeded on our behalf.
    const database = openDatabase({ path });
    const row = database.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM article_contents'),
    ) as { n: number };
    database.close();
    expect(row.n).toBe(0);
  });

  it('test 3 — reports a seeded database with claimable articles', async () => {
    const path = databaseWithArticles(3);
    const database = openDatabase({ path });
    await new SqliteArticleContentRepository(database).seed(EXTRACTOR_VERSION);
    database.close();

    const { code, json } = await preview(path);

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 3,
      seeded: true,
      claimable: 3,
      note: PREVIEW_NOTES.claimable,
    });
  });

  it('test 4 — reports a seeded database with nothing claimable', async () => {
    const path = databaseWithArticles(2);
    const database = openDatabase({ path });
    const repository = new SqliteArticleContentRepository(database);
    await repository.seed(EXTRACTOR_VERSION);

    // Finish both articles, so nothing is left to claim.
    for (const articleId of ['a0', 'a1']) {
      const token = `t-${articleId}`;
      const claim = await repository.claim({
        owner: 'test',
        token,
        now: Date.now(),
        leaseDurationMs: 60_000,
        extractorVersion: EXTRACTOR_VERSION,
      });
      await repository.complete({
        articleId: claim?.articleId ?? '',
        token,
        success: {
          text: 'x'.repeat(250),
          extractedAt: '2026-01-01T00:00:00Z',
          finalUrl: `https://example.com/${articleId}`,
          httpStatus: 200,
        },
      });
    }
    database.close();

    const { code, json } = await preview(path);

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 2,
      seeded: true,
      claimable: 0,
      note: PREVIEW_NOTES.noneClaimable,
    });

    // The note must not suggest the database is empty — it is fully processed.
    expect(json.note).not.toBe(PREVIEW_NOTES.noArticles);
    expect(json.articles).toBe(2);
  });

  it('test 5 — reports a missing database as unavailable and exits 0', async () => {
    const { code, json } = await preview(join(temporaryDirectory(), 'absent.db'));

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'unavailable',
      articles: null,
      seeded: null,
      claimable: null,
      note: PREVIEW_NOTES.unavailable,
    });
  });

  it('test 6 — reports a corrupt database as unavailable, with JSON and exit 1', async () => {
    const path = join(temporaryDirectory(), 'corrupt.db');
    writeFileSync(path, 'this file is not a SQLite database, only filler bytes');

    const { code, lines, json } = await preview(path);

    // The counts failed, so the exit code must not claim success.
    expect(code).toBe(EXIT_FAILURE);
    // But stdout is still exactly one parseable document, never an empty line.
    expect(lines).toHaveLength(1);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'unavailable',
      articles: null,
      seeded: null,
      claimable: null,
      note: PREVIEW_NOTES.unavailable,
    });
  });

  it('test 7 — writes nothing: no rows, no attempts, no leases', async () => {
    const path = databaseWithArticles(2);
    const database = openDatabase({ path });
    const repository = new SqliteArticleContentRepository(database);
    await repository.seed(EXTRACTOR_VERSION);

    // Give one row a consumed attempt so a reset would be visible.
    await repository.claim({
      owner: 'test',
      token: 't',
      now: Date.now(),
      leaseDurationMs: 60_000,
      extractorVersion: EXTRACTOR_VERSION,
    });

    const snapshot = (): unknown =>
      database.query((connection) =>
        connection.all(
          `SELECT article_id, status, attempts, lease_owner, lease_token, lease_expires_at
             FROM article_contents ORDER BY article_id`,
        ),
      );

    const before = snapshot();
    database.close();

    const { code } = await preview(path);
    expect(code).toBe(EXIT_SUCCESS);

    const reopened = openDatabase({ path });
    const after = reopened.query((connection) =>
      connection.all(
        `SELECT article_id, status, attempts, lease_owner, lease_token, lease_expires_at
           FROM article_contents ORDER BY article_id`,
      ),
    );
    const rows = reopened.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM article_contents'),
    ) as { n: number };
    reopened.close();

    expect(after).toEqual(before);
    expect(rows.n).toBe(2);
  });
});

describe('ingestion dry-run', () => {
  it('writes one line of JSON and exits successfully', async () => {
    const lines: string[] = [];
    const exitCalls: number[] = [];

    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      exit: (code) => exitCalls.push(code),
      logger: silentLogger,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ mode: 'dry-run' });
    expect(exitCalls).toEqual([EXIT_SUCCESS]);
  });

  it('writes nothing to the application logger, so stdout stays parseable', async () => {
    // `logger.info` goes to stdout. A preview that logged would put a second
    // JSON document on stdout and break a single `JSON.parse(stdout)`.
    const logged: string[] = [];
    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: () => undefined,
      exit: () => undefined,
      logger: {
        info: (message) => logged.push(`info:${message}`),
        warn: () => undefined,
        error: () => undefined,
      },
    });

    expect(logged).toEqual([]);
  });

  it('does not create the runtime or reach the network', async () => {
    let runtimeCreated = false;

    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      createRuntime: () => {
        runtimeCreated = true;
        throw new Error('a dry-run must not build the runtime');
      },
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: () => undefined,
      exit: () => undefined,
      logger: silentLogger,
    });

    expect(runtimeCreated).toBe(false);
  });

  it('lists the enabled sources it would fetch', async () => {
    const lines: string[] = [];
    await runCli({
      sources: [
        {
          id: 'alpha',
          name: 'Alpha',
          url: 'https://alpha.example.com/feed.xml',
          homepage: 'https://alpha.example.com',
          kind: 'rss',
          enabled: true,
          defaultLanguage: 'en',
          tags: [],
          reliability: 'high',
        },
        {
          id: 'disabled',
          name: 'Disabled',
          url: 'https://disabled.example.com/feed.xml',
          homepage: 'https://disabled.example.com',
          kind: 'rss',
          enabled: false,
          defaultLanguage: 'en',
          tags: [],
          reliability: 'high',
        },
      ],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      exit: () => undefined,
      logger: silentLogger,
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { sources?: string[] };
    expect(parsed.sources).toEqual(['alpha']);
  });

  it('reports an unavailable article count rather than creating the database', async () => {
    const lines: string[] = [];
    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      exit: () => undefined,
      logger: silentLogger,
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { existingArticles?: unknown };
    expect(parsed.existingArticles).toBeNull();
  });
});
