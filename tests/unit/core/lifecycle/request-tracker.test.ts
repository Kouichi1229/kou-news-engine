import { describe, expect, it } from 'vitest';

import { createRequestTracker } from '../../../../src/core/lifecycle/request-tracker.js';

const RUNNING = { draining: false } as const;
const DRAINING = { draining: true } as const;

describe('createRequestTracker', () => {
  it('T1: starts with no active requests', () => {
    const tracker = createRequestTracker();

    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats()).toEqual({ active: 0, total: 0, draining: 0 });
  });

  it('T2: counts a request between begin and release', () => {
    const tracker = createRequestTracker();

    const release = tracker.begin(RUNNING);

    expect(tracker.activeCount()).toBe(1);

    release();

    expect(tracker.activeCount()).toBe(0);
  });

  it('T3: releasing twice decrements only once', () => {
    const tracker = createRequestTracker();
    const release = tracker.begin(RUNNING);

    release();
    release();
    release();

    expect(tracker.activeCount()).toBe(0);
    expect(tracker.stats().active).toBe(0);
  });

  it('T4: counts concurrent requests independently', () => {
    const tracker = createRequestTracker();

    const first = tracker.begin(RUNNING);
    const second = tracker.begin(RUNNING);
    const third = tracker.begin(RUNNING);

    expect(tracker.activeCount()).toBe(3);

    second();
    expect(tracker.activeCount()).toBe(2);

    first();
    expect(tracker.activeCount()).toBe(1);

    third();
    expect(tracker.activeCount()).toBe(0);
  });

  it('T5: whenIdle resolves immediately when nothing is active', async () => {
    const tracker = createRequestTracker();

    await expect(tracker.whenIdle()).resolves.toBeUndefined();
  });

  it('T6: whenIdle resolves when the last request is released', async () => {
    const tracker = createRequestTracker();
    const release = tracker.begin(RUNNING);

    let settled = false;
    const idle = tracker.whenIdle().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await idle;

    expect(settled).toBe(true);
  });

  it('T7: whenIdle waits for every concurrent request', async () => {
    const tracker = createRequestTracker();
    const first = tracker.begin(RUNNING);
    const second = tracker.begin(RUNNING);

    let settled = false;
    const idle = tracker.whenIdle().then(() => {
      settled = true;
    });

    first();
    await Promise.resolve();
    expect(settled).toBe(false);

    second();
    await idle;

    expect(settled).toBe(true);
  });

  it('T8: every waiter settles, not just the first', async () => {
    const tracker = createRequestTracker();
    const release = tracker.begin(RUNNING);

    const waiters = [tracker.whenIdle(), tracker.whenIdle(), tracker.whenIdle()];
    release();

    await expect(Promise.all(waiters)).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('T9: a waiter registered after idle resolves immediately', async () => {
    const tracker = createRequestTracker();
    tracker.begin(RUNNING)();

    await expect(tracker.whenIdle()).resolves.toBeUndefined();
  });

  it('T10: total counts every request ever begun', () => {
    const tracker = createRequestTracker();

    tracker.begin(RUNNING)();
    tracker.begin(RUNNING)();
    const pending = tracker.begin(RUNNING);

    expect(tracker.stats()).toEqual({ active: 1, total: 3, draining: 0 });
    pending();
  });

  it('T11: draining requests are recorded and never un-recorded', () => {
    const tracker = createRequestTracker();

    const release = tracker.begin(DRAINING);
    expect(tracker.stats()).toEqual({ active: 1, total: 1, draining: 1 });

    release();
    // The observation counter is cumulative: the request arrived while draining
    // and that stays true after it finishes.
    expect(tracker.stats()).toEqual({ active: 0, total: 1, draining: 1 });
  });

  it('T12: only requests begun while draining are recorded', () => {
    const tracker = createRequestTracker();

    tracker.begin(RUNNING)();
    tracker.begin(DRAINING)();
    tracker.begin(DRAINING)();

    expect(tracker.stats()).toEqual({ active: 0, total: 3, draining: 2 });
  });

  it('T13: whenIdle never rejects', async () => {
    const tracker = createRequestTracker();
    const release = tracker.begin(RUNNING);

    const idle = tracker.whenIdle();
    release();

    await expect(idle).resolves.toBeUndefined();
  });

  it('T14: a release that empties the tracker does not consume later requests', async () => {
    const tracker = createRequestTracker();
    const release = tracker.begin(RUNNING);

    const idle = tracker.whenIdle();
    release();

    // A new request begins in the same tick the waiter list drains; the next
    // whenIdle must wait for it rather than resolving on the stale signal.
    const second = tracker.begin(RUNNING);
    await idle;

    let settled = false;
    const secondIdle = tracker.whenIdle().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    second();
    await secondIdle;
    expect(settled).toBe(true);
  });

  it('T15: separate trackers are independent', () => {
    const first = createRequestTracker();
    const second = createRequestTracker();

    first.begin(RUNNING);

    expect(first.activeCount()).toBe(1);
    expect(second.activeCount()).toBe(0);
  });
});
