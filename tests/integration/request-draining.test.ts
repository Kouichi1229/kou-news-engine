import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/core/http/error-handler.js';
import { notFoundHandler } from '../../src/core/http/not-found.js';
import { createRequestTrackingMiddleware } from '../../src/core/http/request-tracking.js';
import { createLifecycleState } from '../../src/core/lifecycle/lifecycle-state.js';
import { createRequestTracker } from '../../src/core/lifecycle/request-tracker.js';
import { createShutdownHandler } from '../../src/core/lifecycle/shutdown.js';
import { startServer, type RunningServer } from '../../src/server.js';

/** A promise plus its resolver, for holding a handler open without sleeping. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function port(running: RunningServer): number {
  return (running.server.address() as AddressInfo).port;
}

/**
 * Issues a request on a socket that is closed after the response.
 *
 * `fetch` uses a keep-alive pool, and an idle pooled socket keeps
 * `server.close()` from settling until it times out. These tests are about
 * request tracking, not about keep-alive teardown, so each request gets its own
 * connection that the server closes when the response ends.
 */
function oneShot(running: RunningServer, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: port(running),
        path,
        headers: { Connection: 'close' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    request.on('error', reject);
    request.end();
  });
}

/** An app that tracks requests, with a gate-controlled slow route and a throwing route. */
function trackedApp(
  tracker: ReturnType<typeof createRequestTracker>,
  lifecycle = createLifecycleState(),
  hold: Promise<void> = Promise.resolve(),
): Express {
  const app = express();

  app.use(createRequestTrackingMiddleware({ tracker, lifecycle }));

  app.get('/slow', async (_req: Request, res: Response) => {
    await hold;
    res.status(200).json({ ok: true });
  });

  app.get('/boom', () => {
    throw new Error('handler failed');
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

describe('request draining — real sockets', () => {
  const running: RunningServer[] = [];

  async function listen(app: Express): Promise<RunningServer> {
    const server = await startServer(app, 0, '127.0.0.1');
    running.push(server);
    return server;
  }

  afterEach(async () => {
    for (const server of running.splice(0)) {
      try {
        server.closeAllConnections();
        await server.close();
      } catch {
        // Already closed by the test; teardown must not fail the suite.
      }
    }
  });

  it('IT1: a completed request returns the tracker to idle', async () => {
    const tracker = createRequestTracker();
    const server = await listen(trackedApp(tracker));

    const response = await oneShot(server, '/slow');

    expect(response.status).toBe(200);
    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats().total).toBe(1);
  });

  it('IT2: a handler that throws still releases its request', async () => {
    const tracker = createRequestTracker();
    const server = await listen(trackedApp(tracker));

    const response = await oneShot(server, '/boom');

    expect(response.status).toBe(500);
    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats().total).toBe(1);
  });

  it('IT3: a client that disconnects early does not leak a tracked request', async () => {
    const tracker = createRequestTracker();
    const hold = gate();
    const server = await listen(trackedApp(tracker, undefined, hold.promise));

    const request = http.request({
      host: '127.0.0.1',
      port: port(server),
      path: '/slow',
      headers: { Connection: 'close' },
    });
    request.on('error', () => undefined);
    request.end();

    await vi.waitFor(() => expect(tracker.activeCount()).toBe(1));

    request.destroy();

    // The response never finished, so only the close event can release it.
    await vi.waitFor(() => expect(tracker.activeCount()).toBe(0));
    hold.open();
  });

  it('IT4: concurrent requests are all tracked and all released', async () => {
    const tracker = createRequestTracker();
    const hold = gate();
    const server = await listen(trackedApp(tracker, undefined, hold.promise));

    const requests = Array.from({ length: 5 }, () => oneShot(server, '/slow'));

    await vi.waitFor(() => expect(tracker.activeCount()).toBe(5));

    hold.open();
    const responses = await Promise.all(requests);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats().total).toBe(5);
  });

  it('IT5: shutdown waits for a tracked request before disposing', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const hold = gate();
    const server = await listen(trackedApp(tracker, lifecycle, hold.promise));

    const activeAtDispose: number[] = [];
    const disposeRuntime = vi.fn(async (): Promise<void> => {
      activeAtDispose.push(tracker.activeCount());
    });
    const exit = vi.fn();

    const request = oneShot(server, '/slow');
    await vi.waitFor(() => expect(tracker.activeCount()).toBe(1));

    const shutdown = createShutdownHandler({
      beginDraining: () => lifecycle.beginDraining(),
      closeServer: server.close,
      closeIdleConnections: server.closeIdleConnections,
      closeAllConnections: server.closeAllConnections,
      awaitRequestsDrained: () => tracker.whenIdle(),
      disposeRuntime,
      exit,
      timeoutMs: 5000,
    });

    const shutdownDone = shutdown('SIGTERM');

    await delay(20);
    // Parked waiting for the request: nothing disposed, no exit yet.
    expect(disposeRuntime).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    hold.open();
    const response = await request;
    await shutdownDone;

    expect(response.status).toBe(200);
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // The decisive assertion: no request was active when the database closed.
    expect(activeAtDispose).toEqual([0]);
  });

  it('IT6: a request that outlives the deadline takes the timeout path', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const hold = gate();
    const server = await listen(trackedApp(tracker, lifecycle, hold.promise));

    const disposeRuntime = vi.fn(async (): Promise<void> => undefined);
    const exit = vi.fn();

    const request = oneShot(server, '/slow').catch(() => undefined);
    await vi.waitFor(() => expect(tracker.activeCount()).toBe(1));

    const shutdown = createShutdownHandler({
      beginDraining: () => lifecycle.beginDraining(),
      closeServer: server.close,
      closeIdleConnections: server.closeIdleConnections,
      closeAllConnections: server.closeAllConnections,
      awaitRequestsDrained: () => tracker.whenIdle(),
      disposeRuntime,
      exit,
      timeoutMs: 50,
    });

    await shutdown('SIGTERM');

    // Forced close, exit 1, and the database left open: a handler may still be
    // using it, and a forced socket close is not a cancellation.
    expect(exit).toHaveBeenCalledWith(1);
    expect(disposeRuntime).not.toHaveBeenCalled();

    hold.open();
    await request;
  });

  it('IT7: requests arriving while draining are served and recorded', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const server = await listen(trackedApp(tracker, lifecycle));

    lifecycle.beginDraining();

    const response = await oneShot(server, '/slow');

    expect(response.status).toBe(200);
    expect(tracker.stats().draining).toBe(1);
    expect(tracker.activeCount()).toBe(0);
  });
});

describe('request draining — health and readiness unchanged', () => {
  const running: RunningServer[] = [];

  async function listen(app: Express): Promise<RunningServer> {
    const server = await startServer(app, 0, '127.0.0.1');
    running.push(server);
    return server;
  }

  afterEach(async () => {
    for (const server of running.splice(0)) {
      try {
        server.closeAllConnections();
        await server.close();
      } catch {
        // Already closed by the test.
      }
    }
  });

  it('IT8: tracking does not change liveness or readiness responses', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const server = await listen(createApp({ requestTracking: { tracker, lifecycle } }));

    const health = await oneShot(server, '/api/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });

    // No probe is injected here, so readiness keeps its documented default; the
    // lifecycle probe is added by `createRuntime()`, which needs a database.
    const ready = await oneShot(server, '/api/ready');
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'ready' });

    expect(tracker.activeCount()).toBe(0);
  });

  it('IT9: tracking does not change the readiness body shape', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const server = await listen(createApp({ requestTracking: { tracker, lifecycle } }));

    const response = await oneShot(server, '/api/ready');
    const body = JSON.parse(response.body) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'timestamp']);
  });

  it('IT10: a malformed JSON body is still tracked and released', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const server = await listen(createApp({ requestTracking: { tracker, lifecycle } }));

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: port(server),
          path: '/api/health',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      request.on('error', reject);
      request.end('{ not json');
    });

    expect(response.status).toBe(400);
    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats().total).toBe(1);
  });
});

describe('keep-alive shutdown — real sockets', () => {
  const running: RunningServer[] = [];

  async function listen(app: Express): Promise<RunningServer> {
    const server = await startServer(app, 0, '127.0.0.1');
    running.push(server);
    return server;
  }

  afterEach(async () => {
    for (const server of running.splice(0)) {
      try {
        server.closeAllConnections();
        await server.close();
      } catch {
        // Already closed by the test.
      }
    }
  });

  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  afterEach(() => {
    keepAliveAgent.destroy();
  });

  /**
   * Sends one request on a keep-alive socket and resolves once the response has
   * been fully consumed, leaving the socket idle and reusable — the exact state
   * that used to hold `server.close()` open for the whole keep-alive timeout.
   */
  function keepAliveRequest(
    server: RunningServer,
    path: string,
  ): Promise<{ status: number; connection: string | undefined }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: port(server),
          path,
          agent: keepAliveAgent,
          headers: { Connection: 'keep-alive' },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              connection: response.headers.connection,
            });
          });
        },
      );
      request.on('error', reject);
      request.end();
    });
  }

  it('KA1: an idle keep-alive socket no longer delays shutdown by the keep-alive timeout', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const server = await listen(trackedApp(tracker, lifecycle));

    // The server's own default applies (Node 24: 5000 + 1000). Waiting for that
    // to elapse would be the bug; the assertion below is on elapsed time.
    expect(server.server.keepAliveTimeout).toBe(5000);

    const response = await keepAliveRequest(server, '/slow');
    expect(response.status).toBe(200);
    expect(response.connection).toBe('keep-alive');
    expect(tracker.activeCount()).toBe(0);

    const started = Date.now();
    await createShutdownHandler({
      beginDraining: () => lifecycle.beginDraining(),
      closeServer: server.close,
      closeIdleConnections: server.closeIdleConnections,
      closeAllConnections: server.closeAllConnections,
      awaitRequestsDrained: tracker.whenIdle,
      disposeRuntime: async () => undefined,
      exit: () => undefined,
      timeoutMs: 5000,
      logger: { info: () => undefined, error: () => undefined },
    })('SIGTERM');
    const elapsed = Date.now() - started;

    // Before the fix this settled at ~6100 ms. The bound is well under the
    // 5000 + 1000 keep-alive window yet far above scheduler noise.
    expect(elapsed).toBeLessThan(1500);
  });

  it('KA2: graceful shutdown completes within a 1000 ms deadline for a short request', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const server = await listen(trackedApp(tracker, lifecycle));

    const response = await keepAliveRequest(server, '/slow');
    expect(response.status).toBe(200);

    const exitted: number[] = [];
    const started = Date.now();
    await createShutdownHandler({
      beginDraining: () => lifecycle.beginDraining(),
      closeServer: server.close,
      closeIdleConnections: server.closeIdleConnections,
      closeAllConnections: server.closeAllConnections,
      awaitRequestsDrained: tracker.whenIdle,
      disposeRuntime: async () => undefined,
      exit: (code) => exitted.push(code),
      timeoutMs: 1000,
      logger: { info: () => undefined, error: () => undefined },
    })('SIGTERM');
    const elapsed = Date.now() - started;

    // Before the fix this hit the deadline: exit 1 and a forced close.
    expect(exitted).toEqual([0]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('KA3: a request still in flight when shutdown starts is drained, not truncated', async () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const hold = gate();
    const server = await listen(trackedApp(tracker, lifecycle, hold.promise));

    const pending = keepAliveRequest(server, '/slow');
    await vi.waitFor(() => expect(tracker.activeCount()).toBe(1));

    const exitted: number[] = [];
    const shutdownDone = createShutdownHandler({
      beginDraining: () => lifecycle.beginDraining(),
      closeServer: server.close,
      closeIdleConnections: server.closeIdleConnections,
      closeAllConnections: server.closeAllConnections,
      awaitRequestsDrained: tracker.whenIdle,
      disposeRuntime: async () => undefined,
      exit: (code) => exitted.push(code),
      timeoutMs: 5000,
      logger: { info: () => undefined, error: () => undefined },
    })('SIGTERM');

    // Let shutdown reach its first sweep while the request is still in flight,
    // then release the handler.
    await delay(50);
    hold.open();

    // The response must still arrive: the socket was serving a request when the
    // first sweep ran, so only the post-drain sweep may close it.
    const response = await pending;
    expect(response.status).toBe(200);

    await shutdownDone;

    expect(exitted).toEqual([0]);
    expect(tracker.activeCount()).toBe(0);
  });
});
