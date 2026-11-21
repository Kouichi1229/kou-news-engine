import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DatabaseClosedError,
  openDatabase,
  type SqliteDatabase,
} from '../../src/core/persistence/sqlite.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';

/**
 * Database readiness through the real composition root.
 *
 * Every runtime here owns a `:memory:` database, so nothing can reach the
 * repository's `data/` directory. The handle is opened by the test and injected,
 * which lets a case close or break it without touching the runtime's own
 * disposal path.
 */
const runtimes: Runtime[] = [];

function memoryDatabase(): SqliteDatabase {
  return openDatabase({ path: ':memory:' });
}

function buildRuntime(database: SqliteDatabase = memoryDatabase()): Runtime {
  const runtime = createRuntime({ openDatabase: () => database });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.dispose();
    } catch {
      // Teardown must not mask an assertion failure.
    }
  }
});

describe('GET /api/ready — database dependency', () => {
  it('R1: returns 200 when the runtime is ready, the database is healthy and not draining', async () => {
    const runtime = buildRuntime();

    const response = await request(runtime.app).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks).toEqual({
      lifecycle: { ready: true },
      database: { ready: true },
    });
  });

  it('R2: returns 503 with a stable detail when the database probe reports failure', async () => {
    // A handle that answers `get` with nothing: the probe cannot confirm the
    // database is usable, so readiness must fail rather than assume health.
    const broken: SqliteDatabase = {
      path: ':memory:',
      version: 3,
      isOpen: true,
      query: () => undefined as never,
      transaction: () => undefined as never,
      close: () => undefined,
    };

    const response = await request(buildRuntime(broken).app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.database).toEqual({
      ready: false,
      detail: 'database_unavailable',
    });
  });

  it('R3: returns 503 and probe_failed when the database probe throws', async () => {
    const throwing: SqliteDatabase = {
      path: ':memory:',
      version: 3,
      isOpen: true,
      query: () => {
        throw new Error('SQLITE_ERROR: disk I/O error at /app/data/kou-news.db');
      },
      transaction: () => undefined as never,
      close: () => undefined,
    };

    const response = await request(buildRuntime(throwing).app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.database).toEqual({ ready: false, detail: 'probe_failed' });

    // The exception text must not reach an unauthenticated response.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('SQLITE_ERROR');
    expect(body).not.toContain('/app/data');
    expect(body).not.toContain('kou-news.db');
  });

  it('R4: returns 503 once the process is draining, even with a healthy database', async () => {
    const runtime = buildRuntime();

    runtime.lifecycle.beginDraining();
    const response = await request(runtime.app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks).toEqual({
      lifecycle: { ready: false, detail: 'draining' },
      database: { ready: true },
    });
  });

  it('R5: reports every failing dependency, not just the first', async () => {
    const runtime = buildRuntime();

    runtime.lifecycle.beginDraining();
    await runtime.dispose();
    const response = await request(runtime.app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.checks.lifecycle).toEqual({ ready: false, detail: 'draining' });
    // The database check is present and failing rather than omitted.
    expect(response.body.checks.database).toEqual({ ready: false, detail: 'probe_failed' });
  });

  it('R6: does not crash the process when the database is unusable', async () => {
    const broken: SqliteDatabase = {
      path: ':memory:',
      version: 3,
      isOpen: true,
      query: () => {
        throw new DatabaseClosedError();
      },
      transaction: () => undefined as never,
      close: () => undefined,
    };
    const app = buildRuntime(broken).app;

    // Repeated failures must be answered, not thrown: an unhandled rejection or
    // an uncaught exception would fail the whole test file.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app).get('/api/ready');
      expect(response.status).toBe(503);
    }
  });

  it('R7: publishes no field beyond ready and detail for the database check', async () => {
    const runtime = buildRuntime();

    const response = await request(runtime.app).get('/api/ready');

    expect(Object.keys(response.body.checks.database).sort()).toEqual(['ready']);
    expect(Object.keys(response.body).sort()).toEqual(['checks', 'status', 'timestamp']);
  });
});

describe('GET /api/health — liveness is independent of readiness', () => {
  it('L1: returns 200 while the database is healthy', async () => {
    const response = await request(buildRuntime().app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('L2: returns 200 while the database is broken', async () => {
    const broken: SqliteDatabase = {
      path: ':memory:',
      version: 3,
      isOpen: true,
      query: () => {
        throw new Error('SQLITE_ERROR: database is locked');
      },
      transaction: () => undefined as never,
      close: () => undefined,
    };

    const response = await request(buildRuntime(broken).app).get('/api/health');

    // Liveness asks only whether the process runs. A database outage is a
    // readiness concern, and restarting the process would not fix it.
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('L3: returns 200 while draining', async () => {
    const runtime = buildRuntime();

    runtime.lifecycle.beginDraining();
    const response = await request(runtime.app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('L4: returns 200 after the runtime is disposed', async () => {
    const runtime = buildRuntime();

    await runtime.dispose();
    const response = await request(runtime.app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('readiness lifecycle — disposal and connection ownership', () => {
  it('C1: stops reporting ready after the runtime is disposed', async () => {
    const runtime = buildRuntime();

    expect((await request(runtime.app).get('/api/ready')).status).toBe(200);

    await runtime.dispose();

    const response = await request(runtime.app).get('/api/ready');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.database.ready).toBe(false);
  });

  it('C2: opens no additional connection per readiness request', async () => {
    const database = memoryDatabase();
    let opens = 0;
    const runtime = createRuntime({
      openDatabase: () => {
        opens += 1;
        return database;
      },
    });
    runtimes.push(runtime);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(runtime.app).get('/api/ready');
    }

    // One open for the runtime, none for the probes: the probe reuses the handle.
    expect(opens).toBe(1);
    expect(database.isOpen).toBe(true);
  });

  it('C3: leaves the handle open across readiness requests', async () => {
    const database = memoryDatabase();
    const runtime = buildRuntime(database);

    await request(runtime.app).get('/api/ready');
    await request(runtime.app).get('/api/ready');

    // A probe that closed its handle would break the application it reports on.
    expect(database.isOpen).toBe(true);
    expect(runtime.database.isOpen).toBe(true);
  });

  it('C4: disposal stays idempotent with a database probe wired', async () => {
    const database = memoryDatabase();
    const runtime = buildRuntime(database);

    await runtime.dispose();
    await runtime.dispose();

    expect(database.isOpen).toBe(false);
  });

  it('C5: keeps the database check accurate after disposal without throwing', async () => {
    const runtime = buildRuntime();
    await runtime.dispose();

    // Disposal closes the handle, so the probe throws `DatabaseClosedError`.
    // Readiness must degrade to 503 instead of surfacing a 500.
    const first = await request(runtime.app).get('/api/ready');
    const second = await request(runtime.app).get('/api/ready');

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(second.body.checks.database).toEqual({ ready: false, detail: 'probe_failed' });
  });
});
