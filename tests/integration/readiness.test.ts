import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  createLifecycleState,
  type LifecycleState,
} from '../../src/core/lifecycle/lifecycle-state.js';
import { createDrainingProbe } from '../../src/modules/health/draining.probe.js';
import type { ReadinessProbe, ReadinessProbeResult } from '../../src/modules/health/readiness.js';

/** A probe whose answer is fixed, for asserting the response mapping. */
function fixedProbe(name: string, ready: boolean, detail?: string): ReadinessProbe {
  return {
    name,
    check: () => (detail === undefined ? { ready } : { ready, detail }),
  };
}

describe('createApp — readiness injection', () => {
  it('builds an app without options', () => {
    const app = createApp();

    expect(typeof app).toBe('function');
  });

  it('keeps the documented default readiness response when no probe is injected', async () => {
    const response = await request(createApp()).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks).toEqual({});
    expect(typeof response.body.timestamp).toBe('string');
  });

  it('returns 200 when the injected probe reports ready', async () => {
    const app = createApp({ readinessProbes: [fixedProbe('database', true)] });
    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks).toEqual({ database: { ready: true } });
  });

  it('returns 503 and not_ready when the injected probe reports not ready', async () => {
    const app = createApp({
      readinessProbes: [fixedProbe('database', false, 'database_closed')],
    });
    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks).toEqual({
      database: { ready: false, detail: 'database_closed' },
    });
  });

  it('returns 503 without leaking the thrown error when a probe throws', async () => {
    const secret = 'SQLITE_ERROR: no such table: articles at /app/data/kou-news.db';
    const throwing: ReadinessProbe = {
      name: 'database',
      check: () => {
        throw new Error(secret);
      },
    };

    const response = await request(createApp({ readinessProbes: [throwing] })).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks).toEqual({ database: { ready: false, detail: 'probe_failed' } });
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(response.body)).not.toContain('/app/data');
  });

  it('runs the injected probe on every request', async () => {
    const check = vi.fn(() => ({ ready: true }));
    const app = createApp({ readinessProbes: [{ name: 'database', check }] });

    await request(app).get('/api/ready');
    await request(app).get('/api/ready');
    await request(app).get('/api/ready');

    expect(check).toHaveBeenCalledTimes(3);
  });

  it('keeps two apps with different probes independent', async () => {
    const healthy = createApp({ readinessProbes: [fixedProbe('database', true)] });
    const broken = createApp({
      readinessProbes: [fixedProbe('database', false, 'database_closed')],
    });

    const [healthyResponse, brokenResponse] = await Promise.all([
      request(healthy).get('/api/ready'),
      request(broken).get('/api/ready'),
    ]);

    expect(healthyResponse.status).toBe(200);
    expect(healthyResponse.body.status).toBe('ready');
    expect(brokenResponse.status).toBe(503);
    expect(brokenResponse.body.status).toBe('not_ready');
  });

  it('reports not_ready when any one of several probes fails', async () => {
    const app = createApp({
      readinessProbes: [fixedProbe('database', true), fixedProbe('upstream', false, 'unreachable')],
    });
    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks).toEqual({
      database: { ready: true },
      upstream: { ready: false, detail: 'unreachable' },
    });
  });

  it('publishes only ready and detail when a probe returns extra fields', async () => {
    // A probe is free to attach diagnostics; none of them may reach the response.
    const leaky: ReadinessProbe = {
      name: 'database',
      check: () =>
        ({
          ready: false,
          detail: 'database_error',
          error: 'SQLITE_ERROR: secret',
          path: '/app/data/kou-news.db',
          sql: 'SELECT * FROM private_table',
        }) as unknown as ReadinessProbeResult,
    };

    const response = await request(createApp({ readinessProbes: [leaky] })).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.database).toEqual({
      ready: false,
      detail: 'database_error',
    });
    expect(Object.keys(response.body.checks.database).sort()).toEqual(['detail', 'ready']);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('SQLITE_ERROR');
    expect(body).not.toContain('/app/data');
    expect(body).not.toContain('private_table');
    expect(body).not.toContain('secret');
  });
});

describe('createApp — draining lifecycle integration', () => {
  function appWithLifecycle(state: LifecycleState): ReturnType<typeof createApp> {
    return createApp({ readinessProbes: [createDrainingProbe(state)] });
  }

  it('I1: reports ready with a lifecycle check before draining', async () => {
    const response = await request(appWithLifecycle(createLifecycleState())).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.lifecycle).toEqual({ ready: true });
  });

  it('I2: returns 503 with the draining detail once draining begins', async () => {
    const state = createLifecycleState();
    const app = appWithLifecycle(state);

    state.beginDraining();
    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.lifecycle).toEqual({ ready: false, detail: 'draining' });
  });

  it('I3: stays 503 on every request after the transition', async () => {
    const state = createLifecycleState();
    const app = appWithLifecycle(state);

    state.beginDraining();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app).get('/api/ready');
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
    }
  });

  it('I4: concurrent requests observe a consistent state and never return 500', async () => {
    const state = createLifecycleState();
    const app = appWithLifecycle(state);

    const before = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get('/api/ready')),
    );
    expect(before.every((response) => response.status === 200)).toBe(true);

    state.beginDraining();

    const after = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get('/api/ready')),
    );
    expect(after.every((response) => response.status === 503)).toBe(true);
    expect(after.every((response) => response.body.status === 'not_ready')).toBe(true);
  });

  it('I5: publishes no fields beyond ready and detail', async () => {
    const state = createLifecycleState();
    const app = appWithLifecycle(state);

    state.beginDraining();
    const response = await request(app).get('/api/ready');

    expect(Object.keys(response.body.checks.lifecycle).sort()).toEqual(['detail', 'ready']);
    expect(Object.keys(response.body).sort()).toEqual(['checks', 'status', 'timestamp']);
  });

  it('I6: leaves liveness at 200 while draining', async () => {
    const state = createLifecycleState();
    const app = appWithLifecycle(state);

    state.beginDraining();
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('I7: combines the lifecycle check with other probes', async () => {
    const state = createLifecycleState();
    const app = createApp({
      readinessProbes: [createDrainingProbe(state), fixedProbe('database', true)],
    });

    state.beginDraining();
    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body.checks).toEqual({
      lifecycle: { ready: false, detail: 'draining' },
      database: { ready: true },
    });
  });
});
