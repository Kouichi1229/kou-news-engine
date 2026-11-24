import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DatabaseClosedError,
  openDatabase,
  type SqliteDatabase,
} from '../../src/core/persistence/sqlite.js';
import {
  createRuntime,
  disposeRuntimeAfterFailure,
  RuntimeDisposedError,
  type Runtime,
} from '../../src/runtime.js';
import { LlmError, LlmTimeoutError } from '../../src/core/llm/llm.errors.js';
import type { LlmProvider } from '../../src/core/llm/llm.provider.js';
import type { LlmProviderConfig, LlmProviderDeps } from '../../src/core/llm/provider.factory.js';
import { createProvider as createProviderFromFactory } from '../../src/core/llm/provider.factory.js';
import type { Article } from '../../src/types/article.js';

/** A fresh in-memory database, so no test touches the repository's `data/`. */
function memoryDatabase(): SqliteDatabase {
  return openDatabase({ path: ':memory:' });
}

/**
 * Counts how many times the Gemini transport module is loaded.
 *
 * `vi.mock` replaces the module with a factory that runs only when something
 * imports it, which is exactly the "module registry" observation T-11e assertion 3
 * needs in an ES module graph (there is no public registry to inspect). The counter
 * is falsifiable: the T-11e test loads the module on purpose at the end and watches
 * the count rise.
 */
const transportModuleLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../src/core/llm/providers/gemini.transport.js', () => {
  transportModuleLoads.count += 1;
  return {
    createGeminiTransport: () => {
      throw new Error('the transport must not be constructed in this test file');
    },
  };
});

/**
 * Disposes every runtime, continuing past failures.
 *
 * Returns the errors instead of throwing so one broken fixture cannot stop the
 * remaining handles from being released during teardown.
 */
async function disposeRuntimes(targets: readonly Runtime[]): Promise<unknown[]> {
  const failures: unknown[] = [];

  for (const runtime of targets) {
    try {
      await runtime.dispose();
    } catch (error) {
      failures.push(error);
    }
  }

  return failures;
}

function makeArticle(id: string): Article {
  const url = `https://example.com/${id}`;
  return {
    id,
    title: `Title ${id}`,
    url,
    canonicalUrl: url,
    publishedAt: null,
    publishedAtIsEstimated: false,
    fetchedAt: '2026-11-20T00:00:00.000Z',
    sources: [{ sourceId: 's1', url, resolvedUrl: url, canonicalUrl: url }],
  };
}

/** A handle whose `close()` always throws, for cleanup-failure paths. */
function throwingCloseDatabase(closeError: Error): SqliteDatabase {
  return {
    path: ':memory:',
    version: 3,
    isOpen: true,
    query: () => ({}) as never,
    transaction: () => ({}) as never,
    close: () => {
      throw closeError;
    },
  };
}

describe('createRuntime — composition and ownership', () => {
  const runtimes: Runtime[] = [];

  async function build(): Promise<{ runtime: Runtime; database: SqliteDatabase }> {
    const database = memoryDatabase();
    const runtime = createRuntime({ openDatabase: () => database });
    runtimes.push(runtime);
    return { runtime, database };
  }

  afterEach(async () => {
    // Every runtime built through `build()` is released here, so a failing
    // assertion cannot leak a handle into the next test.
    await disposeRuntimes(runtimes.splice(0));
  });

  it('creates a runtime with an open database', async () => {
    const { runtime, database } = await build();

    expect(database.isOpen).toBe(true);
    expect(runtime.database.isOpen).toBe(true);
    expect(runtime.database.path).toBe(':memory:');
    expect(runtime.database.version).toBeGreaterThan(0);
  });

  it('exposes a usable repository', async () => {
    const { runtime } = await build();

    await runtime.repository.save(makeArticle('a1'));

    expect(await runtime.repository.count()).toBe(1);
    expect((await runtime.repository.findById('a1'))?.id).toBe('a1');
  });

  it('gives the repository and the runtime the same database', async () => {
    const { runtime, database } = await build();

    await runtime.repository.save(makeArticle('a1'));

    // Reading through the runtime's own handle sees the repository's write,
    // which can only happen on a shared connection.
    const row = database.query((connection) =>
      connection.get('SELECT id FROM articles WHERE id = ?', ['a1']),
    ) as { id: string } | undefined;

    expect(row?.id).toBe('a1');
    expect(runtime.database.query((c) => c.get('SELECT COUNT(*) AS n FROM articles'))).toEqual({
      n: 1,
    });
  });

  it('publishes a facade that does not expose close', async () => {
    const { runtime, database } = await build();

    expect('close' in runtime.database).toBe(false);
    expect((runtime.database as Record<string, unknown>)['close']).toBeUndefined();
    // The facade is a separate object, not the owned handle with a narrowed type.
    expect(runtime.database).not.toBe(database);
    expect(Object.keys(runtime.database).sort()).toEqual(['isOpen', 'path', 'query', 'version']);
  });

  it('publishes a facade that does not expose transaction', async () => {
    const { runtime } = await build();

    expect('transaction' in runtime.database).toBe(false);
    expect((runtime.database as Record<string, unknown>)['transaction']).toBeUndefined();
  });

  it('lets the facade run supported queries', async () => {
    const { runtime } = await build();

    expect(runtime.database.query((connection) => connection.get('SELECT 1 AS n'))).toEqual({
      n: 1,
    });

    await runtime.repository.save(makeArticle('a1'));

    expect(
      runtime.database.query((connection) => connection.get('SELECT COUNT(*) AS n FROM articles')),
    ).toEqual({
      n: 1,
    });
  });

  it('closes the privately owned database on dispose', async () => {
    const { runtime, database } = await build();

    expect(database.isOpen).toBe(true);
    await runtime.dispose();

    // `database` is the original handle the composition root kept privately;
    // disposal must reach it even though the public facade cannot.
    expect(database.isOpen).toBe(false);
    expect(runtime.database.isOpen).toBe(false);
  });

  it('tolerates repeated dispose calls', async () => {
    const { runtime, database } = await build();

    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(database.isOpen).toBe(false);
  });

  it('fails repository operations with DatabaseClosedError after disposal', async () => {
    const { runtime } = await build();

    await runtime.dispose();

    await expect(runtime.repository.count()).rejects.toBeInstanceOf(DatabaseClosedError);
  });

  it('closes the database when repository construction fails', async () => {
    const database = memoryDatabase();
    const original = new Error('repository construction failed');

    expect(() =>
      createRuntime({
        openDatabase: () => database,
        createRepository: () => {
          throw original;
        },
      }),
    ).toThrow(original);

    expect(database.isOpen).toBe(false);
  });

  it('closes the database when app construction fails', async () => {
    const database = memoryDatabase();
    const original = new Error('app construction failed');

    expect(() =>
      createRuntime({
        openDatabase: () => database,
        createApp: () => {
          throw original;
        },
      }),
    ).toThrow(original);

    expect(database.isOpen).toBe(false);
  });

  it('preserves the original error when cleanup also fails', async () => {
    const original = new Error('app construction failed');
    const closeError = new Error('close failed');

    const database: SqliteDatabase = {
      path: ':memory:',
      version: 3,
      isOpen: true,
      query: () => {
        throw new Error('unused');
      },
      transaction: () => {
        throw new Error('unused');
      },
      close: () => {
        throw closeError;
      },
    };

    let thrown: unknown;
    try {
      createRuntime({
        openDatabase: () => database,
        createApp: () => {
          throw original;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(original);
    expect(errors[1]).toBe(closeError);
  });

  it('propagates a dispose close failure without retrying', async () => {
    const closeError = new Error('close failed');
    const close = vi.fn(() => {
      throw closeError;
    });

    const database: SqliteDatabase = {
      path: ':memory:',
      version: 3,
      isOpen: true,
      query: () => ({}) as never,
      transaction: () => ({}) as never,
      close,
    };

    const runtime = createRuntime({ openDatabase: () => database });

    await expect(runtime.dispose()).rejects.toThrow(closeError);
    // Marked disposed before closing, so a retry does not touch the handle again.
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('creates no database file under the repository data directory', async () => {
    const dataDirectory = join(process.cwd(), 'data');
    const existedBefore = existsSync(dataDirectory);

    const { runtime } = await build();
    await runtime.repository.save(makeArticle('a1'));
    await runtime.dispose();

    expect(existsSync(dataDirectory)).toBe(existedBefore);
  });

  it('keeps the startup error when a failed listen also fails to clean up', async () => {
    const startupError = new Error('EADDRINUSE');
    const cleanupError = new Error('close failed');
    const database = throwingCloseDatabase(cleanupError);

    const runtime = createRuntime({ openDatabase: () => database });

    let thrown: unknown;
    try {
      // Stands in for `startServer()` rejecting after the runtime exists.
      await disposeRuntimeAfterFailure(runtime, startupError);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(startupError);
    expect(errors[1]).toBe(cleanupError);
  });

  it('rethrows the startup error unchanged when disposal succeeds', async () => {
    const startupError = new Error('EADDRINUSE');
    const { runtime, database } = await build();

    await expect(disposeRuntimeAfterFailure(runtime, startupError)).rejects.toBe(startupError);

    expect(database.isOpen).toBe(false);
  });

  it('keeps disposing the remaining runtimes after one cleanup fails', async () => {
    const cleanupError = new Error('close failed');
    const brokenDatabase = throwingCloseDatabase(cleanupError);
    const broken = createRuntime({ openDatabase: () => brokenDatabase });

    const { runtime: healthy } = await build();
    const { runtime: alsoHealthy } = await build();

    const failures = await disposeRuntimes([broken, healthy, alsoHealthy]);

    expect(failures).toEqual([cleanupError]);
    // The failure on the first handle did not stop the later two from closing.
    expect(healthy.database.isOpen).toBe(false);
    expect(alsoHealthy.database.isOpen).toBe(false);
  });
});

describe('createRuntime — lifecycle ownership and readiness', () => {
  const runtimes: Runtime[] = [];

  function build(): Runtime {
    const runtime = createRuntime({ openDatabase: () => memoryDatabase() });
    runtimes.push(runtime);
    return runtime;
  }

  afterEach(async () => {
    await disposeRuntimes(runtimes.splice(0));
  });

  it('RT1: exposes a lifecycle state that starts out not draining', () => {
    const runtime = build();

    expect(runtime.lifecycle).toBeDefined();
    expect(runtime.lifecycle.isDraining()).toBe(false);
  });

  it('RT2: the runtime app reports the lifecycle probe as ready', async () => {
    const runtime = build();

    const response = await request(runtime.app).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.lifecycle).toEqual({ ready: true });
  });

  it('RT3: draining the runtime makes its own app return 503', async () => {
    const runtime = build();

    runtime.lifecycle.beginDraining();
    const response = await request(runtime.app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.lifecycle).toEqual({ ready: false, detail: 'draining' });
  });

  it('RT4: liveness stays 200 on the runtime app while draining', async () => {
    const runtime = build();

    runtime.lifecycle.beginDraining();
    const response = await request(runtime.app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('RT5: each runtime owns an independent lifecycle state', () => {
    const first = build();
    const second = build();

    first.lifecycle.beginDraining();

    expect(first.lifecycle.isDraining()).toBe(true);
    expect(second.lifecycle.isDraining()).toBe(false);
  });

  it('RT6: disposal behaviour is unaffected by the lifecycle state', async () => {
    const runtime = build();

    runtime.lifecycle.beginDraining();
    await runtime.dispose();

    expect(runtime.database.isOpen).toBe(false);
    // Still idempotent after the added dependency.
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('RT7: a throwing app factory still closes the database', () => {
    const database = memoryDatabase();
    const original = new Error('app construction failed');

    expect(() =>
      createRuntime({
        openDatabase: () => database,
        createApp: () => {
          throw original;
        },
      }),
    ).toThrow(original);

    expect(database.isOpen).toBe(false);
  });

  it('RT8: passes the lifecycle and database probes into the injected app factory', () => {
    const database = memoryDatabase();
    const seen: { probes?: readonly unknown[] | undefined } = {};

    const runtime = createRuntime({
      openDatabase: () => database,
      createApp: (options) => {
        seen.probes = options.readinessProbes;
        return express();
      },
    });
    runtimes.push(runtime);

    // Both dependencies are wired by the composition root; neither is optional,
    // because a missing probe silently reports readiness it cannot verify.
    expect(seen.probes?.map((probe) => (probe as { name: string }).name)).toEqual([
      'lifecycle',
      'database',
    ]);
  });
});

describe('createRuntime — request tracker ownership', () => {
  const runtimes: Runtime[] = [];

  function build(): Runtime {
    const runtime = createRuntime({ openDatabase: () => memoryDatabase() });
    runtimes.push(runtime);
    return runtime;
  }

  afterEach(async () => {
    await disposeRuntimes(runtimes.splice(0));
  });

  it('RQ1: exposes a tracker that starts idle', () => {
    const runtime = build();

    expect(runtime.requests).toBeDefined();
    expect(runtime.requests.activeCount()).toBe(0);
    expect(runtime.requests.stats()).toEqual({ active: 0, total: 0, draining: 0 });
  });

  it('RQ2: the runtime app increments its own tracker', async () => {
    const runtime = build();

    await request(runtime.app).get('/api/health');

    // The request is finished by the time supertest resolves, so the count is
    // back to zero while the total records that it happened.
    expect(runtime.requests.activeCount()).toBe(0);
    expect(runtime.requests.stats().total).toBeGreaterThanOrEqual(1);
  });

  it('RQ3: the app and the tracker are the same instance', () => {
    const database = memoryDatabase();
    const seen: { tracker?: unknown } = {};

    const runtime = createRuntime({
      openDatabase: () => database,
      createApp: (options) => {
        seen.tracker = options.requestTracking?.tracker;
        return express();
      },
    });
    runtimes.push(runtime);

    expect(seen.tracker).toBe(runtime.requests);
  });

  it('RQ4: the app receives the runtime lifecycle state for draining detection', () => {
    const database = memoryDatabase();
    const seen: { lifecycle?: unknown } = {};

    const runtime = createRuntime({
      openDatabase: () => database,
      createApp: (options) => {
        seen.lifecycle = options.requestTracking?.lifecycle;
        return express();
      },
    });
    runtimes.push(runtime);

    expect(seen.lifecycle).toBe(runtime.lifecycle);
  });

  it('RQ5: requests served after draining are recorded', async () => {
    const runtime = build();

    runtime.lifecycle.beginDraining();
    await request(runtime.app).get('/api/health');

    expect(runtime.requests.stats().draining).toBe(1);
    expect(runtime.requests.activeCount()).toBe(0);
  });

  it('RQ6: each runtime owns an independent tracker', () => {
    const first = build();
    const second = build();

    first.requests.begin({ draining: false });

    expect(first.requests.activeCount()).toBe(1);
    expect(second.requests.activeCount()).toBe(0);
  });

  it('RQ7: whenIdle resolves for an idle runtime', async () => {
    const runtime = build();

    await expect(runtime.requests.whenIdle()).resolves.toBeUndefined();
  });

  it('RQ8: an injected app factory that throws still closes the database', () => {
    const database = memoryDatabase();
    const original = new Error('app construction failed');

    expect(() =>
      createRuntime({
        openDatabase: () => database,
        createApp: () => {
          throw original;
        },
      }),
    ).toThrow(original);

    expect(database.isOpen).toBe(false);
  });
});

/**
 * A provider stub.
 *
 * Only `complete()` could ever be exercised, and no M4.4 test calls it: the tests
 * assert identity and settlement, not generation. It throws so a test that
 * accidentally generates fails loudly instead of passing on a silent stub.
 */
function stubProvider(id: string): LlmProvider {
  return {
    id,
    model: { name: 'stub-model', vendorModelId: 'stub-vendor-model' },
    complete: () => {
      throw new Error(`stub provider ${id} must not be asked to complete`);
    },
  };
}

/** Deterministic `LlmProviderConfig`, so no test reads or mutates `process.env`. */
const STUB_LLM_CONFIG: LlmProviderConfig = {
  provider: 'fake',
  model: 'stub-model',
  timeoutMs: 1000,
  apiKey: undefined,
};

/**
 * A promise whose settlement the test controls.
 *
 * Deferreds are the only synchronisation these tests use: every ordering they
 * assert is a synchronous decision point, so a sleep would replace the property
 * under test with a timing assumption (§9.0b T-22).
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Records how often the provider factory ran and hands back a deferred attempt.
 *
 * The count is the observable proof of sharing: one call means one initialisation,
 * and it is read without touching any private cell state.
 */
function deferredFactory(): {
  createProvider: () => Promise<LlmProvider>;
  calls: () => number;
  attempt: Deferred<LlmProvider>;
} {
  let calls = 0;
  const attempt = deferred<LlmProvider>();
  return {
    createProvider: () => {
      calls += 1;
      return attempt.promise;
    },
    calls: () => calls,
    attempt,
  };
}

/** Flushes pending microtasks so a wrapper's arbitration has run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Observes a promise without leaving a window in which its rejection is unhandled.
 *
 * A caller that holds a wrapper across an `await` before attaching a handler would
 * create a real unhandled rejection. Attaching both branches here, synchronously,
 * keeps every test honest about the property it is asserting.
 */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function capture<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
}

describe('createRuntime — lazy provider initialisation (T-20..T-23)', () => {
  const runtimes: Runtime[] = [];

  function build(deps: {
    createProvider: () => Promise<LlmProvider>;
    llmConfig?: LlmProviderConfig;
  }): Runtime {
    const runtime = createRuntime({
      openDatabase: () => memoryDatabase(),
      llmConfig: deps.llmConfig ?? STUB_LLM_CONFIG,
      createProvider: deps.createProvider,
    });
    runtimes.push(runtime);
    return runtime;
  }

  afterEach(async () => {
    await disposeRuntimes(runtimes.splice(0, runtimes.length));
  });

  it('T-20: concurrent calls share one initialisation and one provider, but not one promise', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });
    const provider = stubProvider('shared');

    // Three calls in the same tick: two would be enough, the third proves the
    // sharing survives more than a single pair.
    const promiseA = runtime.getProvider();
    const promiseB = runtime.getProvider();
    const promiseC = runtime.getProvider();

    // Distinct caller-facing promises over one shared attempt.
    expect(promiseA).not.toBe(promiseB);
    expect(promiseB).not.toBe(promiseC);
    expect(promiseA).not.toBe(promiseC);

    // Exactly one construction started, and it started before any settlement.
    expect(factory.calls()).toBe(1);

    factory.attempt.resolve(provider);

    await expect(promiseA).resolves.toBe(provider);
    await expect(promiseB).resolves.toBe(provider);
    await expect(promiseC).resolves.toBe(provider);

    // No second initialisation, including for a call made after success.
    const later = await runtime.getProvider();
    expect(later).toBe(provider);
    expect(factory.calls()).toBe(1);
  });

  it('T-20: a later call receives its own promise even when the provider is already ready', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });
    const provider = stubProvider('ready');

    const first = runtime.getProvider();
    factory.attempt.resolve(provider);
    await first;

    const second = runtime.getProvider();
    const third = runtime.getProvider();

    expect(second).not.toBe(third);
    await expect(second).resolves.toBe(provider);
    await expect(third).resolves.toBe(provider);
    expect(factory.calls()).toBe(1);
  });

  it('T-21: a failed initialisation is not cached, so a later call retries and succeeds', async () => {
    const initialisationError = new LlmTimeoutError('first attempt timed out');
    const provider = stubProvider('retried');
    let calls = 0;

    const runtime = build({
      createProvider: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(initialisationError) : Promise.resolve(provider);
      },
    });

    await expect(runtime.getProvider()).rejects.toBe(initialisationError);
    expect(calls).toBe(1);

    // A fresh attempt, not a replayed rejection.
    await expect(runtime.getProvider()).resolves.toBe(provider);
    expect(calls).toBe(2);

    // The provider is now published, so further calls neither retry nor rebuild.
    await expect(runtime.getProvider()).resolves.toBe(provider);
    expect(calls).toBe(2);
  });

  it('T-22 case A: disposal does not await a pending initialisation and stays disposed', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });

    void runtime.getProvider().catch(() => undefined);

    // Settles without the attempt ever settling: the deferred is still pending.
    await expect(runtime.dispose()).resolves.toBeUndefined();

    // Late success is discarded: it cannot resurrect the cell or publish a provider.
    factory.attempt.resolve(stubProvider('late-success'));
    await flushMicrotasks();
    await expect(runtime.getProvider()).rejects.toBeInstanceOf(RuntimeDisposedError);
    expect(factory.calls()).toBe(1);
  });

  it('T-22 case A: a late rejection after disposal neither resurrects nor escapes', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });

    void runtime.getProvider().catch(() => undefined);
    await runtime.dispose();

    // Rejecting after disposal must not produce an unhandled rejection. If it did,
    // the process-level handler installed by the test runner would fail this test.
    factory.attempt.reject(new LlmTimeoutError('late failure'));
    await flushMicrotasks();

    await expect(runtime.getProvider()).rejects.toBeInstanceOf(RuntimeDisposedError);
  });

  it('T-22 case B: a retained wrapper rejects with the disposed error when disposal wins', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });

    // Retained: this is the promise the caller is waiting on. Observed from the
    // moment it is created, so its rejection is never unhandled.
    const retained = capture(runtime.getProvider());
    expect(factory.calls()).toBe(1);

    await runtime.dispose();

    const outcome = await retained;
    expect(outcome.ok).toBe(false);
    const error = (outcome as { ok: false; error: unknown }).error;
    expect(error).toBeInstanceOf(RuntimeDisposedError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LlmError);
    expect((error as RuntimeDisposedError).kind).toBe('disposed');
    expect((error as RuntimeDisposedError).name).toBe('RuntimeDisposedError');

    // Late success must not reach the superseded caller.
    factory.attempt.resolve(stubProvider('superseded'));
    await flushMicrotasks();
    expect((await retained).ok).toBe(false);
  });

  it('T-22 case B: a late rejection cannot override the disposal result', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });

    const retained = capture(runtime.getProvider());
    await runtime.dispose();

    factory.attempt.reject(new LlmTimeoutError('late failure'));
    await flushMicrotasks();

    const outcome = await retained;
    expect(outcome.ok).toBe(false);
    const error = (outcome as { ok: false; error: unknown }).error;
    expect(error).toBeInstanceOf(RuntimeDisposedError);
    expect(error).not.toBeInstanceOf(LlmError);
  });

  it('T-23: calls after disposal reject with the disposed error and start nothing', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });

    await runtime.dispose();
    const callsBefore = factory.calls();

    // Captured eagerly so neither rejection is briefly unhandled.
    const first = capture(runtime.getProvider());
    const second = capture(runtime.getProvider());

    const outcomes = await Promise.all([first, second]);
    const firstError = (outcomes[0] as { ok: false; error: unknown }).error;
    const secondError = (outcomes[1] as { ok: false; error: unknown }).error;

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      const error = (outcome as { ok: false; error: unknown }).error;
      expect(error).toBeInstanceOf(RuntimeDisposedError);
      expect(error).not.toBeInstanceOf(LlmError);
      expect((error as RuntimeDisposedError).kind).toBe('disposed');
    }

    // A freshly created error per call, not one shared rejection value.
    expect(firstError).not.toBe(secondError);

    // No initialisation began, and no provider is reachable.
    expect(factory.calls()).toBe(callsBefore);
    expect(factory.calls()).toBe(0);
  });

  it('T-23: a disposed runtime that had reached ready still hands out nothing', async () => {
    const factory = deferredFactory();
    const runtime = build({ createProvider: factory.createProvider });
    const provider = stubProvider('ready-then-disposed');

    const first = runtime.getProvider();
    factory.attempt.resolve(provider);
    await expect(first).resolves.toBe(provider);

    await runtime.dispose();

    // The ready-state fast path checks disposal first, so the stored provider is
    // not reachable through a disposed runtime.
    await expect(runtime.getProvider()).rejects.toBeInstanceOf(RuntimeDisposedError);
    expect(factory.calls()).toBe(1);
  });
});

describe('createRuntime — wrapper settlement ordering', () => {
  const runtimes: Runtime[] = [];

  function build(createProvider: () => Promise<LlmProvider>): Runtime {
    const runtime = createRuntime({
      openDatabase: () => memoryDatabase(),
      llmConfig: STUB_LLM_CONFIG,
      createProvider,
    });
    runtimes.push(runtime);
    return runtime;
  }

  afterEach(async () => {
    await disposeRuntimes(runtimes.splice(0, runtimes.length));
  });

  it('case A: an attempt that fulfils before a same-tick disposal still loses to disposal', async () => {
    const factory = deferredFactory();
    const runtime = build(factory.createProvider);
    const provider = stubProvider('fulfilled-then-disposed');

    const wrapper = capture(runtime.getProvider());
    // Fulfils the attempt, then disposes synchronously — before the attempt's
    // reaction has had a chance to run and commit a provider.
    factory.attempt.resolve(provider);
    await runtime.dispose();

    const outcome = await wrapper;
    expect(outcome.ok).toBe(false);
    expect((outcome as { ok: false; error: unknown }).error).toBeInstanceOf(RuntimeDisposedError);
  });

  it('case B: a wrapper that committed the provider keeps it when disposal follows', async () => {
    const factory = deferredFactory();
    const runtime = build(factory.createProvider);
    const provider = stubProvider('committed-first');

    const wrapper = runtime.getProvider();
    factory.attempt.resolve(provider);

    // Let arbitration commit `resolve(provider)` before disposal begins.
    await expect(wrapper).resolves.toBe(provider);

    await runtime.dispose();

    // Non-revocation: a delivered provider is not retracted by later disposal.
    await expect(wrapper).resolves.toBe(provider);
  });

  it('case C: an attempt that rejects before a same-tick disposal loses to disposal', async () => {
    const factory = deferredFactory();
    const runtime = build(factory.createProvider);

    const wrapper = capture(runtime.getProvider());
    factory.attempt.reject(new LlmTimeoutError('rejected-then-disposed'));
    await runtime.dispose();

    const outcome = await wrapper;
    expect(outcome.ok).toBe(false);
    const error = (outcome as { ok: false; error: unknown }).error;
    expect(error).toBeInstanceOf(RuntimeDisposedError);
    expect(error).not.toBeInstanceOf(LlmError);
  });

  it('case D: a wrapper that committed the initialisation error keeps that error', async () => {
    const initialisationError = new LlmTimeoutError('committed-first');
    const factory = deferredFactory();
    const runtime = build(factory.createProvider);

    const wrapper = runtime.getProvider();
    factory.attempt.reject(initialisationError);

    // Arbitration commits the initialisation error before disposal begins.
    await expect(wrapper).rejects.toBe(initialisationError);

    await runtime.dispose();

    await expect(wrapper).rejects.toBe(initialisationError);
  });

  it('settles each wrapper at most once under repeated disposal', async () => {
    const factory = deferredFactory();
    const runtime = build(factory.createProvider);

    const wrapper = runtime.getProvider();

    // Repeated disposal is idempotent and must not settle the wrapper twice.
    await Promise.all([runtime.dispose(), runtime.dispose(), runtime.dispose()]);

    await expect(wrapper).rejects.toBeInstanceOf(RuntimeDisposedError);
  });
});

describe('createRuntime — no eager Gemini initialisation (T-11e)', () => {
  const runtimes: Runtime[] = [];

  function build(deps: {
    createProvider: (
      config: LlmProviderConfig,
      providerDeps: LlmProviderDeps,
    ) => Promise<LlmProvider>;
    llmConfig?: LlmProviderConfig;
  }): Runtime {
    const runtime = createRuntime({
      openDatabase: () => memoryDatabase(),
      llmConfig: deps.llmConfig ?? { ...STUB_LLM_CONFIG, apiKey: undefined },
      createProvider: deps.createProvider,
    });
    runtimes.push(runtime);
    return runtime;
  }

  afterEach(async () => {
    await disposeRuntimes(runtimes.splice(0, runtimes.length));
  });

  it('T-11e: createRuntime builds no provider, loads no transport, and never calls the seam', async () => {
    let providerCalls = 0;
    const loadsBefore = transportModuleLoads.count;

    // Assertion 1: a missing GEMINI_API_KEY must not fail startup.
    const runtime = build({
      llmConfig: { ...STUB_LLM_CONFIG, provider: 'gemini', apiKey: undefined },
      createProvider: () => {
        providerCalls += 1;
        return Promise.resolve(stubProvider('eager'));
      },
    });

    // Assertion 2: nothing was constructed during createRuntime().
    expect(providerCalls).toBe(0);

    // Assertion 3: the transport module was not loaded at startup.
    expect(transportModuleLoads.count).toBe(loadsBefore);

    // The provider is only built on demand.
    const provider = await runtime.getProvider();
    expect(provider.id).toBe('eager');
    expect(providerCalls).toBe(1);

    // Still not loaded: an injected factory never reaches the lazy callback.
    expect(transportModuleLoads.count).toBe(loadsBefore);

    // Control: the counter is falsifiable, not inert. Loading the module raises it.
    await import('../../src/core/llm/providers/gemini.transport.js');
    expect(transportModuleLoads.count).toBe(loadsBefore + 1);
  });

  it('T-11e: the real factory rejects a missing key before the transport callback runs', async () => {
    // Assertion 4, made falsifiable: the real factory is used, so the ordering
    // between credential validation (stage 4) and transport resolution (stage 6)
    // is actually exercised. A seam that counted its invocations must stay at 0,
    // and the module must stay unloaded.
    const loadsBefore = transportModuleLoads.count;
    const runtime = build({
      llmConfig: { ...STUB_LLM_CONFIG, provider: 'gemini', apiKey: undefined },
      createProvider: createProviderFromFactory,
    });

    // Assertion 2 again, now against the production factory.
    expect(transportModuleLoads.count).toBe(loadsBefore);

    await expect(runtime.getProvider()).rejects.toThrow(/GEMINI_API_KEY/);

    // The key was rejected before the transport was ever resolved or loaded.
    expect(transportModuleLoads.count).toBe(loadsBefore);
  });

  it('T-11e: assertion 5 is a forward-looking guard, not evidence', () => {
    // No vendor SDK is installed, so "no SDK loaded" cannot fail today. This test
    // records the dependency state that makes assertion 5 vacuous, so the claim
    // stays honest rather than being cited as proof of lazy loading.
    const dependencies = Object.keys(
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).dependencies ?? {},
    );
    expect(dependencies).not.toContain('@google/generative-ai');
  });
});
