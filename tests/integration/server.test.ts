import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { startServer, type RunningServer } from '../../src/server.js';

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('startServer', () => {
  const runningServers = new Set<RunningServer>();
  const rawServers = new Set<Server>();

  async function closeRunning(running: RunningServer): Promise<void> {
    if (!runningServers.delete(running)) {
      return;
    }
    await running.close();
  }

  afterEach(async () => {
    const failures: unknown[] = [];

    try {
      for (const running of [...runningServers]) {
        try {
          await closeRunning(running);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      for (const raw of [...rawServers]) {
        if (!rawServers.delete(raw)) {
          continue;
        }
        try {
          await closeServer(raw);
        } catch (error) {
          failures.push(error);
        }
      }
    }

    if (failures.length > 0) {
      throw failures[0];
    }
  });

  it('starts on an ephemeral port and reports a bound address', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);

    const address = running.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe('object');
    if (address && typeof address === 'object') {
      expect(address.port).toBeGreaterThan(0);
    }
  });

  it('serves requests once started and stops after close', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);
    const address = running.server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);

    await closeRunning(running);

    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it('rejects when the port is already in use', async () => {
    const blocker = createServer();
    rawServers.add(blocker);
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(address && typeof address === 'object' ? address.port : 0);
      });
    });

    const outcome = await startServer(createApp(), port, '127.0.0.1').then(
      (running) => {
        runningServers.add(running);
        return { rejected: false } as const;
      },
      () => ({ rejected: true }) as const,
    );

    expect(outcome.rejected).toBe(true);
  });

  it('resolves a repeated close without closing the server twice', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);

    const closeSpy = vi.spyOn(running.server, 'close');

    await closeRunning(running);
    await expect(running.close()).resolves.toBeUndefined();
    await expect(running.close()).resolves.toBeUndefined();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  it('returns the same promise for concurrent close calls', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);

    const first = running.close();
    const second = running.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
  });

  it('replays the original close failure on repeated calls', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    // Registered as a raw server: the mocked `close` below never closes the
    // listener, so teardown must take the direct `server.close()` path.
    rawServers.add(running.server);

    const closeError = new Error('close failed');
    const closeSpy = vi.spyOn(running.server, 'close').mockImplementation(((
      callback?: (err?: Error) => void,
    ) => {
      callback?.(closeError);
      return running.server;
    }) as typeof running.server.close);

    await expect(running.close()).rejects.toBe(closeError);
    // The failure is cached: a retry reports the same error and never calls
    // `server.close()` again.
    await expect(running.close()).rejects.toBe(closeError);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    closeSpy.mockRestore();
  });

  it('delegates closeIdleConnections to the HTTP server', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);

    const idleSpy = vi.spyOn(running.server, 'closeIdleConnections');

    running.closeIdleConnections();

    expect(idleSpy).toHaveBeenCalledTimes(1);
    idleSpy.mockRestore();
  });

  it('delegates closeAllConnections to the HTTP server', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);

    const allSpy = vi.spyOn(running.server, 'closeAllConnections');

    running.closeAllConnections();

    expect(allSpy).toHaveBeenCalledTimes(1);
    allSpy.mockRestore();
  });

  it('leaves close idempotent after the connection controls are used', async () => {
    const running = await startServer(createApp(), 0, '127.0.0.1');
    runningServers.add(running);

    const closeSpy = vi.spyOn(running.server, 'close');

    running.closeIdleConnections();
    running.closeAllConnections();

    const first = running.close();
    const second = running.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});
