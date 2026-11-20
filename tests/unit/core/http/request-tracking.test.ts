import { EventEmitter } from 'node:events';

import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createRequestTrackingMiddleware } from '../../../../src/core/http/request-tracking.js';
import { createLifecycleState } from '../../../../src/core/lifecycle/lifecycle-state.js';
import {
  createRequestTracker,
  type BeginRequestOptions,
  type RequestTracker,
  type RequestTrackerStats,
} from '../../../../src/core/lifecycle/request-tracker.js';

/** The response members the middleware touches: `once()` and nothing else. */
function fakeResponse(): Response & EventEmitter {
  return new EventEmitter() as Response & EventEmitter;
}

function fakeRequest(method = 'GET', path = '/api/health'): Request {
  return { method, path } as Request;
}

function run(
  middleware: ReturnType<typeof createRequestTrackingMiddleware>,
  req: Request = fakeRequest(),
  res: Response = fakeResponse(),
): { nextCalls: number } {
  let nextCalls = 0;
  const next: NextFunction = () => {
    nextCalls += 1;
  };

  middleware(req, res, next);

  return { nextCalls };
}

describe('createRequestTrackingMiddleware', () => {
  it('MW1: begins tracking when a request arrives', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });

    run(middleware);

    expect(tracker.activeCount()).toBe(1);
  });

  it('MW2: releases when the response finishes', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });
    const res = fakeResponse();

    run(middleware, fakeRequest(), res);
    res.emit('finish');

    expect(tracker.activeCount()).toBe(0);
  });

  it('MW3: releases when the connection closes without finishing', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });
    const res = fakeResponse();

    run(middleware, fakeRequest(), res);
    res.emit('close');

    expect(tracker.activeCount()).toBe(0);
  });

  it('MW4: finish followed by close decrements only once', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });
    const res = fakeResponse();

    run(middleware, fakeRequest(), res);
    res.emit('finish');
    res.emit('close');
    res.emit('finish');
    res.emit('close');

    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats().active).toBe(0);
  });

  it('MW5: close followed by finish decrements only once', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });
    const res = fakeResponse();

    run(middleware, fakeRequest(), res);
    res.emit('close');
    res.emit('finish');

    expect(tracker.activeCount()).toBe(0);
  });

  it('MW6: always calls next so the request is never blocked', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });

    const { nextCalls } = run(middleware);

    expect(nextCalls).toBe(1);
  });

  it('MW7: records requests that arrive while draining', () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const middleware = createRequestTrackingMiddleware({ tracker, lifecycle });

    lifecycle.beginDraining();
    run(middleware);

    expect(tracker.stats()).toEqual({ active: 1, total: 1, draining: 1 });
  });

  it('MW8: does not record requests that arrive before draining', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });

    run(middleware);

    expect(tracker.stats()).toEqual({ active: 1, total: 1, draining: 0 });
  });

  it('MW9: logs every request served while draining', () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const logger = { info: vi.fn(), error: vi.fn() };
    const middleware = createRequestTrackingMiddleware({ tracker, lifecycle, logger });

    run(middleware, fakeRequest('GET', '/api/health'));
    expect(logger.info).not.toHaveBeenCalled();

    lifecycle.beginDraining();
    run(middleware, fakeRequest('POST', '/api/articles'));

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Request received while draining', {
      method: 'POST',
      path: '/api/articles',
      active: 2,
    });
  });

  it('MW10: a tracker that throws does not prevent the request', () => {
    const failure = new Error('tracker unavailable');
    const tracker: RequestTracker = {
      begin: (): (() => void) => {
        throw failure;
      },
      activeCount: (): number => 0,
      stats: (): RequestTrackerStats => ({ active: 0, total: 0, draining: 0 }),
      whenIdle: (): Promise<void> => Promise.resolve(),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
      logger,
    });

    const { nextCalls } = run(middleware);

    expect(nextCalls).toBe(1);
    expect(logger.error).toHaveBeenCalledWith('Failed to track request', {
      error: String(failure),
    });
  });

  it('MW11: a lifecycle that throws does not prevent the request', () => {
    const tracker = createRequestTracker();
    const lifecycle = {
      isDraining: (): boolean => {
        throw new Error('state unavailable');
      },
      beginDraining: (): void => undefined,
    };
    const middleware = createRequestTrackingMiddleware({ tracker, lifecycle });

    const { nextCalls } = run(middleware);

    expect(nextCalls).toBe(1);
    expect(tracker.activeCount()).toBe(0);
  });

  it('MW12: a listener that cannot be registered leaves no request counted', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });
    const res = {
      once: (): never => {
        throw new Error('cannot register listener');
      },
    } as unknown as Response;

    const { nextCalls } = run(middleware, fakeRequest(), res);

    // The begin() succeeded before registration failed, so the release must have
    // run: a permanently counted request would make every shutdown time out.
    expect(tracker.activeCount()).toBe(0);
    expect(nextCalls).toBe(1);
  });

  it('MW13: a throwing logger does not prevent the request', () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const logger = {
      info: (): void => {
        throw new Error('log sink failed');
      },
      error: (): void => undefined,
    };
    const middleware = createRequestTrackingMiddleware({ tracker, lifecycle, logger });

    lifecycle.beginDraining();
    const { nextCalls } = run(middleware);

    expect(nextCalls).toBe(1);
    expect(tracker.activeCount()).toBe(1);
  });

  it('MW14: concurrent requests are each tracked and released', () => {
    const tracker = createRequestTracker();
    const middleware = createRequestTrackingMiddleware({
      tracker,
      lifecycle: createLifecycleState(),
    });
    const first = fakeResponse();
    const second = fakeResponse();

    run(middleware, fakeRequest(), first);
    run(middleware, fakeRequest(), second);
    expect(tracker.activeCount()).toBe(2);

    first.emit('finish');
    expect(tracker.activeCount()).toBe(1);

    second.emit('close');
    expect(tracker.activeCount()).toBe(0);
  });

  it('MW15: reads the lifecycle state per request, not once at build time', () => {
    const tracker = createRequestTracker();
    const lifecycle = createLifecycleState();
    const middleware = createRequestTrackingMiddleware({ tracker, lifecycle });

    run(middleware);
    expect(tracker.stats().draining).toBe(0);

    lifecycle.beginDraining();

    run(middleware);
    expect(tracker.stats().draining).toBe(1);
  });

  it('MW16: passes the draining flag through to the tracker unchanged', () => {
    const seen: BeginRequestOptions[] = [];
    const tracker: RequestTracker = {
      begin: (options: BeginRequestOptions): (() => void) => {
        seen.push(options);
        return () => undefined;
      },
      activeCount: (): number => 0,
      stats: (): RequestTrackerStats => ({ active: 0, total: 0, draining: 0 }),
      whenIdle: (): Promise<void> => Promise.resolve(),
    };
    const lifecycle = createLifecycleState();
    const middleware = createRequestTrackingMiddleware({ tracker, lifecycle });

    run(middleware);
    lifecycle.beginDraining();
    run(middleware);

    expect(seen).toEqual([{ draining: false }, { draining: true }]);
  });
});
