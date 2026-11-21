import { existsSync } from 'node:fs';
import { join } from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DatabaseClosedError,
  openDatabase,
  type SqliteDatabase,
} from '../../src/core/persistence/sqlite.js';
import { createRuntime, disposeRuntimeAfterFailure, type Runtime } from '../../src/runtime.js';
import type { Article } from '../../src/types/article.js';

/** A fresh in-memory database, so no test touches the repository's `data/`. */
function memoryDatabase(): SqliteDatabase {
  return openDatabase({ path: ':memory:' });
}

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
