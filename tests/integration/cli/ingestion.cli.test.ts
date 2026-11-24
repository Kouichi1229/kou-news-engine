import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXIT_FAILURE,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_SUCCESS,
} from '../../../src/cli/exit-codes.js';
import { runCli, type CliResult } from '../../../src/cli/ingestion.cli.js';
import { openDatabase } from '../../../src/core/persistence/sqlite.js';
import { SqliteArticleRepository } from '../../../src/modules/ingestion/repository/sqlite-article.repository.js';
import type { Runtime } from '../../../src/runtime.js';

import {
  createControlledHost,
  createCountingRuntime,
  createFetchDouble,
  createRecordingRepository,
  failingFetch,
  rssFor,
  testSource,
  type ControlledHost,
} from './harness.js';

/**
 * Integration tests for the one-shot ingestion CLI.
 *
 * The CLI is exercised through `runCli`, which is the same function the
 * executable entry point calls. Only the process boundary is replaced — the
 * exit call, the signal host and the fetch transport — so the lifecycle, the
 * signal coordinator, the ingestion service and the outcome mapping all run for
 * real.
 *
 * No test contacts a news feed: every fetch is a fixture keyed by URL, and an
 * unknown URL fails loudly rather than reaching the network.
 */

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RunOptions {
  routes?: Parameters<typeof createFetchDouble>[0];
  failingNetwork?: boolean;
  failOnSave?: Error;
  host?: ControlledHost;
  /** Called once the runtime exists, before ingestion starts. */
  onRuntimeReady?: () => void;
  /** Makes `createRuntime` throw, simulating a failed database open. */
  failInitialization?: Error;
  /** Makes the runtime's `dispose` throw, simulating a release failure. */
  failOnDispose?: Error;
  deadlineMs?: number;
  clock?: () => number;
  /** Counts fetches, so "ingestion never started" can be asserted. */
  fetchCounter?: { count: number };
}

/**
 * Runs the CLI with a controlled runtime and returns the recorded exit code.
 *
 * The exit call is captured rather than performed, so the test runner survives.
 * `runCli` calls it exactly once; a second call would be a bug the assertion on
 * `exitCalls` catches.
 */
async function run(options: RunOptions = {}): Promise<{
  result: CliResult;
  exitCalls: number[];
  runtime: ReturnType<typeof createCountingRuntime> | undefined;
  repository: ReturnType<typeof createRecordingRepository> | undefined;
}> {
  const exitCalls: number[] = [];
  const repository = createRecordingRepository(
    options.failOnSave === undefined ? {} : { failOnSave: options.failOnSave },
  );
  const runtime = createCountingRuntime(repository);
  if (options.failOnDispose !== undefined) {
    const disposeError = options.failOnDispose;
    runtime.dispose = async (): Promise<void> => {
      runtime.disposeCalls += 1;
      throw disposeError;
    };
  }

  const baseFetch =
    options.failingNetwork === true ? failingFetch() : createFetchDouble(options.routes ?? {});
  const fetchImpl: typeof baseFetch =
    options.fetchCounter === undefined
      ? baseFetch
      : (url, init) => {
          options.fetchCounter!.count += 1;
          return baseFetch(url, init);
        };

  const result = await runCli({
    execute: true,
    sources: [testSource('alpha'), testSource('beta')],
    exit: (code: number): void => {
      exitCalls.push(code);
    },
    createRuntime: (): Runtime => {
      if (options.failInitialization !== undefined) {
        throw options.failInitialization;
      }
      options.onRuntimeReady?.();
      return runtime;
    },
    fetchImpl,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  return { result, exitCalls, runtime, repository };
}

/** Routes where every source answers with one item. */
function allSucceedRoutes(): Parameters<typeof createFetchDouble>[0] {
  return {
    'https://alpha.example.com/feed.xml': { status: 200, body: rssFor('alpha', 'a1') },
    'https://beta.example.com/feed.xml': { status: 200, body: rssFor('beta', 'b1') },
  };
}

describe('ingestion CLI — source outcomes', () => {
  it('exits 0 when every source succeeds', async () => {
    const { result, exitCalls } = await run({ routes: allSucceedRoutes() });

    expect(result.outcome).toEqual({ kind: 'success' });
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(exitCalls).toEqual([EXIT_SUCCESS]);
  });

  it('exits 0 on partial success, because the articles found are real', async () => {
    const { result, exitCalls } = await run({
      routes: {
        'https://alpha.example.com/feed.xml': { status: 200, body: rssFor('alpha', 'a1') },
      },
    });

    expect(result.outcome).toEqual({ kind: 'partial' });
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(exitCalls).toEqual([EXIT_SUCCESS]);
  });

  it('exits 1 when every source fails', async () => {
    const { result, exitCalls } = await run({ failingNetwork: true });

    expect(result.outcome).toEqual({ kind: 'all-sources-failed' });
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(exitCalls).toEqual([EXIT_FAILURE]);
  });

  it('persists the articles it fetched through the runtime repository', async () => {
    const { repository } = await run({ routes: allSucceedRoutes() });

    expect(repository?.saved).toHaveLength(2);
    expect(repository?.saved.map((article) => article.title).sort()).toEqual(['a1', 'b1']);
  });
});

describe('ingestion CLI — persistence failure', () => {
  it('exits 1 when the repository rejects a write', async () => {
    const { result, exitCalls } = await run({
      routes: allSucceedRoutes(),
      failOnSave: new Error('disk full'),
    });

    expect(result.outcome).toEqual({ kind: 'persistence-failure' });
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(exitCalls).toEqual([EXIT_FAILURE]);
  });

  it('reports persistence failure even though the sources succeeded', async () => {
    // The distinction that matters: sources were fine, storage was not, so the
    // exit code must not suggest a feed problem.
    const { result } = await run({
      routes: allSucceedRoutes(),
      failOnSave: new Error('disk full'),
    });

    expect(result.outcome.kind).not.toBe('success');
    expect(result.outcome).toEqual({ kind: 'persistence-failure' });
  });
});

describe('ingestion CLI — deadline', () => {
  it('exits 1 when the deadline leaves sources unexecuted', async () => {
    // A clock that jumps past the budget on its first read: the boundary check
    // fails before any source is attempted, with no real waiting involved.
    let calls = 0;
    const expiredClock = (): number => {
      calls += 1;
      return calls === 1 ? 0 : 1_000_000;
    };

    const { result, exitCalls } = await run({
      routes: allSucceedRoutes(),
      deadlineMs: 1000,
      clock: expiredClock,
    });

    expect(result.outcome).toEqual({ kind: 'deadline-exceeded' });
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(exitCalls).toEqual([EXIT_FAILURE]);
  });

  it('reports skipped sources with a deadline reason', async () => {
    let calls = 0;
    const expiredClock = (): number => {
      calls += 1;
      return calls === 1 ? 0 : 1_000_000;
    };

    const { repository } = await run({
      routes: allSucceedRoutes(),
      deadlineMs: 1000,
      clock: expiredClock,
    });

    // Nothing was attempted, so nothing was written: a deadline stop must not
    // persist a partial batch it never collected.
    expect(repository?.writes).toBe(1);
    expect(repository?.saved).toHaveLength(0);
  });

  it('does not exit 0 merely because the sources it reached succeeded', async () => {
    // One source succeeds, then the budget expires before the second: the run
    // did not finish its job, so it must not report success.
    let calls = 0;
    const clock = (): number => {
      calls += 1;
      // Reads: 1st = start (0), 2nd = before source 1 (0), 3rd = before source 2 (past).
      return calls <= 2 ? 0 : 1_000_000;
    };

    const { result } = await run({
      routes: allSucceedRoutes(),
      deadlineMs: 1000,
      clock,
    });

    expect(result.outcome).toEqual({ kind: 'deadline-exceeded' });
    expect(result.exitCode).toBe(EXIT_FAILURE);
  });
});

describe('ingestion CLI — cancellation', () => {
  it('exits 130 when SIGINT cancels the run', async () => {
    const host = createControlledHost();

    const { result, exitCalls } = await run({
      routes: allSucceedRoutes(),
      host,
      // Deliver SIGINT as soon as the runtime exists: the run has not started,
      // so the lifecycle reports cancellation without attempting a source.
      onRuntimeReady: () => {
        host.deliver('SIGINT');
      },
    });

    expect(result.outcome).toEqual({ kind: 'cancelled', signal: 'SIGINT' });
    expect(result.exitCode).toBe(EXIT_SIGINT);
    expect(exitCalls).toEqual([EXIT_SIGINT]);
  });

  it('exits 143 when SIGTERM cancels the run', async () => {
    const host = createControlledHost();

    const { result, exitCalls } = await run({
      routes: allSucceedRoutes(),
      host,
      onRuntimeReady: () => {
        host.deliver('SIGTERM');
      },
    });

    expect(result.outcome).toEqual({ kind: 'cancelled', signal: 'SIGTERM' });
    expect(result.exitCode).toBe(EXIT_SIGTERM);
    expect(exitCalls).toEqual([EXIT_SIGTERM]);
  });

  it('does not start ingestion when the signal arrives during initialization', async () => {
    const host = createControlledHost();
    const fetchCounter = { count: 0 };

    const { result, repository } = await run({
      host,
      routes: allSucceedRoutes(),
      fetchCounter,
      onRuntimeReady: () => {
        host.deliver('SIGINT');
      },
    });

    // Cancelled before the run: no feed is fetched and no article is saved, so
    // the operator's stop is honoured before any work begins.
    expect(result.outcome).toEqual({ kind: 'cancelled', signal: 'SIGINT' });
    expect(fetchCounter.count).toBe(0);
    expect(repository?.saved).toHaveLength(0);
  });

  it('disposes the runtime after a signal during initialization', async () => {
    const host = createControlledHost();

    const { runtime } = await run({
      routes: allSucceedRoutes(),
      host,
      onRuntimeReady: () => {
        host.deliver('SIGINT');
      },
    });

    // The runtime was built successfully, so it must be released even though the
    // run never started.
    expect(runtime?.disposeCalls).toBe(1);
  });
});

describe('ingestion CLI — cancellation outranks later failures', () => {
  it('exits 130 when the run throws after SIGINT, not 1', async () => {
    const host = createControlledHost();
    const disposeError = new Error('database handle already released');

    const { result, exitCalls } = await run({
      routes: allSucceedRoutes(),
      host,
      failOnDispose: disposeError,
      onRuntimeReady: () => {
        host.deliver('SIGINT');
      },
    });

    // The operator asked for the stop, so the exit code must report the signal
    // even though cleanup then failed; reporting 1 would blame the run.
    expect(result.outcome).toEqual({ kind: 'cancelled', signal: 'SIGINT' });
    expect(result.exitCode).toBe(EXIT_SIGINT);
    expect(exitCalls).toEqual([EXIT_SIGINT]);
  });
});

describe('ingestion CLI — unexpected failure', () => {
  it('exits 1 when a failure is neither persistence, initialization nor a signal', async () => {
    const { result, exitCalls } = await run({
      routes: allSucceedRoutes(),
      failOnDispose: new Error('dispose failed'),
    });

    expect(result.outcome).toEqual({ kind: 'unexpected-error' });
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(exitCalls).toEqual([EXIT_FAILURE]);
  });
});

describe('ingestion CLI — initialization failure', () => {
  it('exits 1 when the runtime cannot be built', async () => {
    const { result, exitCalls } = await run({
      failInitialization: new Error('cannot open database'),
    });

    expect(result.outcome).toEqual({ kind: 'initialization-failure' });
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(exitCalls).toEqual([EXIT_FAILURE]);
  });

  it('leaves no signal listener attached after an initialization failure', async () => {
    const host = createControlledHost();

    await run({ failInitialization: new Error('cannot open database'), host });

    expect(host.listenerCount()).toBe(0);
  });
});

describe('ingestion CLI — production wiring', () => {
  it('exits 130 on a real SIGINT when no host is injected', async () => {
    // Every other test injects a host, so this is the only one that exercises the
    // production default. The signal is emitted on the real `process`, which is
    // safe here: the coordinator installs its own listener (so Node's default
    // handler is replaced) and `exit` is stubbed, so the runner survives.
    //
    // This proves the recorder wraps the production host. Without it the signal
    // identity is lost and the run would be reported as an unexpected error,
    // exiting 1 instead of 130.
    const exitCalls: number[] = [];
    const baseline = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };

    const result = await runCli({
      execute: true,
      sources: [],
      exit: (code: number): void => {
        exitCalls.push(code);
      },
      createRuntime: (): Runtime => {
        // Emitted while handlers are installed and before ingestion starts, so
        // the lifecycle records cancellation rather than running.
        process.emit('SIGINT', 'SIGINT');
        return createCountingRuntime(createRecordingRepository());
      },
      fetchImpl: createFetchDouble({}),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    expect(result.outcome).toEqual({ kind: 'cancelled', signal: 'SIGINT' });
    expect(result.exitCode).toBe(EXIT_SIGINT);
    expect(exitCalls).toEqual([EXIT_SIGINT]);

    // And no listener of the CLI's own is left behind.
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM);
  });
});

describe('ingestion CLI — disposal', () => {
  it('disposes the runtime exactly once on a successful run', async () => {
    const { runtime } = await run({ routes: allSucceedRoutes() });

    expect(runtime?.disposeCalls).toBe(1);
  });

  it('disposes the runtime exactly once when the run fails', async () => {
    const { runtime } = await run({ failingNetwork: true });

    expect(runtime?.disposeCalls).toBe(1);
  });

  it('disposes the runtime exactly once when persistence fails', async () => {
    const { runtime } = await run({
      routes: allSucceedRoutes(),
      failOnSave: new Error('disk full'),
    });

    expect(runtime?.disposeCalls).toBe(1);
  });

  it('removes every signal listener once the run is over', async () => {
    const host = createControlledHost();

    await run({ routes: allSucceedRoutes(), host });

    expect(host.listenerCount()).toBe(0);
  });
});

describe('ingestion CLI — production repository', () => {
  it('writes through a SQLite repository backed by a temporary file', async () => {
    // Exercises the real repository and the real database, in a temporary
    // directory, so the wiring is proven without touching `data/`.
    const directory = temporaryDirectory();
    const path = join(directory, 'ingest.db');
    const database = openDatabase({ path });
    const repository = new SqliteArticleRepository(database);

    const runtime = createCountingRuntime(repository);
    const exitCalls: number[] = [];

    const result = await runCli({
      execute: true,
      sources: [testSource('alpha')],
      exit: (code: number): void => {
        exitCalls.push(code);
      },
      createRuntime: (): Runtime => runtime,
      fetchImpl: createFetchDouble({
        'https://alpha.example.com/feed.xml': { status: 200, body: rssFor('alpha', 'a1') },
      }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(await repository.count()).toBe(1);

    database.close();
  });
});
