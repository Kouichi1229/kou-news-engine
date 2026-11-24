import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SignalHost } from '../../../src/core/lifecycle/signal-coordinator.js';
import type { FetchLike } from '../../../src/modules/ingestion/feed/feed.client.js';
import type { ArticleRepository } from '../../../src/modules/ingestion/repository/article.repository.js';
import type { FeedSource } from '../../../src/modules/ingestion/sources/source.schema.js';
import type { Article } from '../../../src/types/article.js';
import type { Runtime } from '../../../src/runtime.js';

/**
 * Test doubles for the CLI integration tests.
 *
 * These replace only the process boundary — the signal host, the exit call and
 * the fetch transport — never the code under test. The lifecycle, the signal
 * coordinator, the ingestion service and the outcome classification all run for
 * real.
 */

/** A host that records listeners so a test can deliver a signal on demand. */
export interface ControlledHost extends SignalHost {
  /** Delivers `signal` to every listener registered for it. */
  deliver: (signal: 'SIGINT' | 'SIGTERM') => void;
  /** How many listeners are currently attached, across both signals. */
  listenerCount: () => number;
}

export function createControlledHost(): ControlledHost {
  const listeners = new Map<string, Set<(signal: NodeJS.Signals) => void>>();

  return {
    on: (event, listener): unknown => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return undefined;
    },
    removeListener: (event, listener): unknown => {
      listeners.get(event)?.delete(listener);
      return undefined;
    },
    deliver: (signal): void => {
      for (const listener of [...(listeners.get(signal) ?? [])]) {
        listener(signal);
      }
    },
    listenerCount: (): number => {
      let total = 0;
      for (const set of listeners.values()) {
        total += set.size;
      }
      return total;
    },
  };
}

/** A repository that records calls and can be made to fail on write. */
export interface RecordingRepository extends ArticleRepository {
  saved: Article[];
  writes: number;
}

export function createRecordingRepository(
  options: { failOnSave?: Error } = {},
): RecordingRepository {
  const saved: Article[] = [];
  const byId = new Map<string, Article>();

  const repository: RecordingRepository = {
    saved,
    writes: 0,
    save: async (article: Article): Promise<void> => {
      repository.writes += 1;
      if (options.failOnSave !== undefined) {
        throw options.failOnSave;
      }
      byId.set(article.id, article);
      saved.push(article);
    },
    saveMany: async (articles: readonly Article[]): Promise<void> => {
      repository.writes += 1;
      if (options.failOnSave !== undefined) {
        throw options.failOnSave;
      }
      for (const article of articles) {
        byId.set(article.id, article);
        saved.push(article);
      }
    },
    findById: async (id: string): Promise<Article | undefined> => byId.get(id),
    findAll: async (): Promise<Article[]> => [...byId.values()],
    has: async (id: string): Promise<boolean> => byId.has(id),
    delete: async (id: string): Promise<void> => {
      byId.delete(id);
    },
    clear: async (): Promise<void> => {
      byId.clear();
      saved.length = 0;
    },
    count: async (): Promise<number> => byId.size,
  };

  return repository;
}

/** A runtime whose `dispose` counts calls, so exactly-once can be asserted. */
export interface CountingRuntime extends Runtime {
  disposeCalls: number;
}

/**
 * Builds a runtime stand-in with only what the CLI touches.
 *
 * `dispose` is the real subject of several tests, so it counts its own calls
 * rather than relying on a spy framework's bookkeeping.
 */
export function createCountingRuntime(repository: ArticleRepository): CountingRuntime {
  const runtime = {
    disposeCalls: 0,
    repository,
  } as unknown as CountingRuntime;

  runtime.dispose = async (): Promise<void> => {
    runtime.disposeCalls += 1;
  };

  return runtime;
}

/** A source fixture that never leaves the process. */
export function testSource(id: string): FeedSource {
  return {
    id,
    name: `Source ${id}`,
    url: `https://${id}.example.com/feed.xml`,
    homepage: `https://${id}.example.com`,
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['test'],
    reliability: 'high',
  };
}

/** A minimal RSS document with one item, so the parser produces one record. */
export function rssFor(sourceId: string, itemId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${sourceId}</title>
    <link>https://${sourceId}.example.com/</link>
    <description>fixture</description>
    <item>
      <title>${itemId}</title>
      <link>https://${sourceId}.example.com/${itemId}</link>
      <guid isPermaLink="false">${itemId}</guid>
    </item>
  </channel>
</rss>`;
}

/**
 * A fetch double keyed by URL.
 *
 * No network is involved. An unknown URL answers 404 rather than throwing: 404
 * is non-retryable, so a mistake in the routes fails immediately instead of
 * silently succeeding, and the test never waits on backoff delays.
 */
export function createFetchDouble(
  routes: Record<string, { status: number; body: string }>,
): FetchLike {
  return async (
    url: string,
  ): Promise<{
    status: number;
    headers: { get: () => string | null };
    body: ReadableStream<Uint8Array>;
  }> => {
    const route = routes[url];
    if (route === undefined) {
      const notFound = new TextEncoder().encode('not found');
      return {
        status: 404,
        headers: { get: (): string | null => null },
        body: new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(notFound);
            controller.close();
          },
        }),
      };
    }
    const bytes = new TextEncoder().encode(route.body);
    return {
      status: route.status,
      headers: { get: (): string | null => null },
      body: new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
}

/**
 * A fetch double where every request fails with 404.
 *
 * 404 is deliberately not in the retryable set (`429`, `5xx`), so it fails on
 * the first attempt with no backoff. A network *throw* would instead trigger the
 * retry loop and make the test depend on real backoff delays.
 */
export function failingFetch(): FetchLike {
  return async (): Promise<{
    status: number;
    headers: { get: () => string | null };
    body: ReadableStream<Uint8Array> | null;
  }> => ({
    status: 404,
    headers: { get: (): string | null => null },
    body: null,
  });
}

/**
 * Child-process helpers for the CLI isolation tests.
 *
 * ## Why `spawnCli` is fail-closed
 *
 * A CLI invoked without `DATABASE_PATH` falls back to `env.ts`'s default,
 * `./data/kou-news.db` — the operator's real data. That fallback already caused
 * one incident: a misspelled dependency key silently resolved to the default and
 * a preview read the production database. Validation therefore happens **before**
 * the child is spawned, and a violation throws instead of warning. A test that
 * passes a path outside its own temporary directory cannot start the CLI at all.
 */

/** How the child's database path was validated, kept for the assertion message. */
export interface SpawnCliOptions {
  /** Absolute path to the CLI entry point, relative to the repository root. */
  readonly script: string;
  /** CLI arguments, e.g. `['--help']` or `['--dry-run']`. */
  readonly args: readonly string[];
  /** Absolute path to the database file this test owns. */
  readonly databasePath: string;
  /** The temporary directory this test created; `databasePath` must be inside it. */
  readonly temporaryDirectory: string;
  /** Extra environment variables, merged over the controlled baseline. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Repository root; defaults to three levels above this file. */
  readonly repositoryRoot?: string;
}

export interface CliProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Both streams, for assertions that do not care which one carried the text. */
  readonly combined: string;
  /** Parsed `PROBE_NET_COUNTS`, or `undefined` when the line was absent. */
  readonly netCounts: Readonly<Record<string, number>> | undefined;
}

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..', '..');
const PROBE = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'cli-config-probe.ts');

/**
 * Asserts the database path is safe, then spawns the CLI behind the network guard.
 *
 * Throws — failing the test — rather than degrading, for each of: a missing path,
 * a relative path, a path outside `temporaryDirectory`, or a missing temporary
 * directory. Nothing is spawned when a check fails.
 */
export function spawnCli(options: SpawnCliOptions): CliProcessResult {
  const root = options.repositoryRoot ?? REPOSITORY_ROOT;
  const { databasePath, temporaryDirectory } = options;

  if (databasePath === '') {
    throw new Error(
      'spawnCli: DATABASE_PATH is required; the CLI would fall back to the real database',
    );
  }
  if (!isAbsolute(databasePath)) {
    throw new Error(
      `spawnCli: DATABASE_PATH must be absolute, got "${databasePath}"; a relative path resolves against cwd`,
    );
  }
  if (!isAbsolute(temporaryDirectory)) {
    throw new Error(`spawnCli: temporaryDirectory must be absolute, got "${temporaryDirectory}"`);
  }

  const directory = resolve(temporaryDirectory);
  const database = resolve(databasePath);
  if (database !== directory && !database.startsWith(`${directory}${sep}`)) {
    throw new Error(
      `spawnCli: DATABASE_PATH "${database}" is outside the test directory "${directory}"`,
    );
  }

  const result = spawnSync(
    process.execPath,
    [
      // Guard first: `--import` preloads run in order, before the entry module, so
      // the patched exports are in place before the CLI binds them by name.
      '--import',
      'tsx',
      '--import',
      PROBE,
      join('src', 'cli', options.script),
      ...options.args,
    ],
    {
      cwd: root,
      env: {
        // A controlled baseline, not `...process.env`: a developer's `.env` or shell
        // must not decide what the child sees. No `--env-file-if-exists` either.
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        NODE_ENV: 'test',
        PROBE_MODE: 'guard',
        DATABASE_PATH: database,
        ...options.environment,
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

  const stderr = result.stderr ?? '';
  const match = /PROBE_NET_COUNTS=(\{.*\})/.exec(stderr);

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr,
    combined: `${result.stdout ?? ''}\n${stderr}`,
    netCounts:
      match === null ? undefined : (JSON.parse(match[1] ?? '{}') as Record<string, number>),
  };
}

/**
 * Reads the network counters, failing when the line is absent.
 *
 * An absent line means the child died before its exit handler ran. Treating that
 * as zero would turn a crash into a pass, so it is an explicit failure.
 */
export function requireNetCounts(result: CliProcessResult): Readonly<Record<string, number>> {
  if (result.netCounts === undefined) {
    throw new Error(
      `probe did not report PROBE_NET_COUNTS; the child may have crashed. stderr:\n${result.stderr}`,
    );
  }
  return result.netCounts;
}

/** A point-in-time view of a database, for before/after comparison. */
export interface DatabaseSnapshot {
  /** SHA-256 of the main database file, or `null` when it does not exist. */
  readonly databaseHash: string | null;
  /** SHA-256 of the `-wal` file, or `null` when it does not exist. */
  readonly walHash: string | null;
  /** `PRAGMA user_version`, or `null` when it could not be read. */
  readonly userVersion: number | null;
  /** Every `articles` row, ordered by id. */
  readonly articles: readonly unknown[];
  /** Every `article_contents` row including lifecycle columns, ordered by id. */
  readonly articleContents: readonly unknown[];
}

/**
 * Captures hashes, schema version and the rows the dry-run must not disturb.
 *
 * Hashes are taken from the bytes on disk rather than through SQLite: a write that
 * left the logical rows intact would still be a write, and only the file bytes show
 * it. The `-shm` file is deliberately excluded — a read-only connection to a WAL
 * database legitimately creates or updates it.
 */
export function snapshotDatabase(path: string): DatabaseSnapshot {
  const hashOf = (candidate: string): string | null =>
    existsSync(candidate)
      ? createHash('sha256').update(readFileSync(candidate)).digest('hex')
      : null;

  const databaseHash = hashOf(path);
  const walHash = hashOf(`${path}-wal`);

  if (!existsSync(path)) {
    return { databaseHash, walHash, userVersion: null, articles: [], articleContents: [] };
  }

  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const versionRow = database.prepare('PRAGMA user_version').get() as
      { user_version?: number } | undefined;
    const articles = database.prepare('SELECT * FROM articles ORDER BY id').all() as unknown[];
    const articleContents = database
      .prepare('SELECT * FROM article_contents ORDER BY article_id')
      .all() as unknown[];

    return {
      databaseHash,
      walHash,
      userVersion: versionRow?.user_version ?? null,
      articles,
      articleContents,
    };
  } finally {
    database.close();
  }
}

/**
 * Asserts no database file exists at `path`, in any of its three forms.
 *
 * `-wal` and `-shm` are checked too: a preview that opened a writable handle would
 * leave them behind even if it wrote no rows.
 */
export function assertNoDatabaseFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) {
      throw new Error(`expected no database file, but "${candidate}" exists`);
    }
  }
}
