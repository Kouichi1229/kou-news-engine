import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
  MIN_SHUTDOWN_TIMEOUT_MS,
} from '../../../../src/config/constants.js';
import { loadEnv } from '../../../../src/config/env.js';
import {
  createShutdownHandler,
  disposeAll,
  type ShutdownDependencies,
  type ShutdownLogger,
} from '../../../../src/core/lifecycle/shutdown.js';

/** Records the order in which collaborators are invoked. */
interface Harness {
  dependencies: ShutdownDependencies;
  /** Only the three signals the pre-timeout tests asserted on. */
  events: string[];
  /** Every collaborator call, including the connection controls. */
  timeline: string[];
  /** As `timeline`, plus timer scheduling, so the deadline can be ordered. */
  order: string[];
  /**
   * Every collaborator call including `beginDraining` and `awaitRequestsDrained`.
   *
   * Kept separate from `timeline` and `order`: those two carry assertions written
   * against the pre-draining call sequence, and adding a new entry there would
   * silently rewrite them.
   */
  sequence: string[];
  beginDraining: ReturnType<typeof vi.fn>;
  closeServer: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  awaitRequestsDrained: ReturnType<typeof vi.fn>;
  disposeRuntime: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  timers: TimerController;
}

interface TimerController {
  setTimer: ReturnType<typeof vi.fn>;
  clearTimer: ReturnType<typeof vi.fn>;
  /** Milliseconds each scheduled timer was given, in order. */
  scheduled: number[];
  /** Handles passed to the clear hook, in order. */
  cleared: unknown[];
  /** Invokes every timer still pending. */
  fire: () => void;
  /** True while a timer is armed. */
  hasPending: () => boolean;
}

function createTimerController(): TimerController {
  const callbacks = new Map<number, () => void>();
  const scheduled: number[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 1;

  const setTimer = vi.fn((callback: () => void, milliseconds: number): unknown => {
    scheduled.push(milliseconds);
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });

  const clearTimer = vi.fn((handle: unknown): void => {
    cleared.push(handle);
    callbacks.delete(handle as number);
  });

  return {
    setTimer,
    clearTimer,
    scheduled,
    cleared,
    fire: () => {
      for (const [handle, callback] of [...callbacks]) {
        callbacks.delete(handle);
        callback();
      }
    },
    hasPending: () => callbacks.size > 0,
  };
}

function createHarness(
  overrides: {
    beginDraining?: () => void;
    closeServer?: () => Promise<void>;
    closeIdleConnections?: () => void;
    disposeRuntime?: () => Promise<void>;
    closeAllConnections?: () => void;
    awaitRequestsDrained?: () => Promise<void>;
    timeoutMs?: number;
  } = {},
): Harness {
  const events: string[] = [];
  const timeline: string[] = [];
  const order: string[] = [];
  const sequence: string[] = [];
  const timers = createTimerController();

  const beginDraining = vi.fn((): void => {
    sequence.push('beginDraining');
    overrides.beginDraining?.();
  });

  const closeServer = vi.fn(async (): Promise<void> => {
    events.push('closeServer');
    timeline.push('closeServer');
    order.push('closeServer');
    sequence.push('closeServer');
    await overrides.closeServer?.();
  });

  const closeIdleConnections = vi.fn((): void => {
    timeline.push('closeIdleConnections');
    order.push('closeIdleConnections');
    sequence.push('closeIdleConnections');
    overrides.closeIdleConnections?.();
  });

  const closeAllConnections = vi.fn((): void => {
    timeline.push('closeAllConnections');
    order.push('closeAllConnections');
    sequence.push('closeAllConnections');
    overrides.closeAllConnections?.();
  });

  const awaitRequestsDrained = vi.fn(async (): Promise<void> => {
    sequence.push('awaitRequestsDrained');
    await overrides.awaitRequestsDrained?.();
  });

  const disposeRuntime = vi.fn(async (): Promise<void> => {
    events.push('disposeRuntime');
    timeline.push('disposeRuntime');
    order.push('disposeRuntime');
    sequence.push('disposeRuntime');
    await overrides.disposeRuntime?.();
  });

  const exit = vi.fn((code: number): void => {
    events.push(`exit:${code}`);
    timeline.push(`exit:${code}`);
    order.push(`exit:${code}`);
    sequence.push(`exit:${code}`);
  });

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };

  return {
    dependencies: {
      beginDraining,
      closeServer,
      closeIdleConnections,
      closeAllConnections,
      awaitRequestsDrained,
      disposeRuntime,
      exit,
      timeoutMs: overrides.timeoutMs ?? 8000,
      logger: logger as ShutdownLogger,
      setTimer: (callback: () => void, milliseconds: number): unknown => {
        order.push('setTimer');
        return timers.setTimer(callback, milliseconds);
      },
      clearTimer: (handle: unknown): void => {
        timeline.push('clearTimer');
        timers.clearTimer(handle);
      },
    },
    events,
    timeline,
    order,
    sequence,
    beginDraining,
    closeServer,
    closeIdleConnections,
    closeAllConnections,
    awaitRequestsDrained,
    disposeRuntime,
    exit,
    logger,
    timers,
  };
}

/** A promise plus its resolver, for holding a cleanup open without sleeping. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('createShutdownHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('S1: closes the server, disposes the runtime and exits with 0', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
    // Cleanup ordering: HTTP first, then the runtime, then the exit decision.
    expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:0']);
  });

  it('S2: runs cleanup once when invoked again after completing', async () => {
    const harness = createHarness();
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    await first;
    const second = shutdown('SIGTERM');
    await second;

    expect(second).toBe(first);
    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
  });

  it('S3: shares one promise and one cleanup while the first call is in flight', async () => {
    const closeGate = gate();
    const harness = createHarness({ closeServer: () => closeGate.promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    // The first call is parked inside closeServer, so this second call arrives
    // mid-shutdown rather than after it.
    const second = shutdown('SIGINT');

    expect(second).toBe(first);

    closeGate.open();
    await Promise.all([first, second]);

    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:0']);
  });

  it('S4: still disposes the runtime and exits 1 when the server close fails', async () => {
    const closeError = new Error('close failed');
    const harness = createHarness({
      closeServer: () => Promise.reject(closeError),
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(closeError);

    expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:1']);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    // The original error survives into the log rather than being swallowed.
    expect(harness.logger.error).toHaveBeenCalledWith('Error during shutdown', {
      error: String(closeError),
    });
  });

  it('S5: exits 1 and preserves the error when the runtime dispose fails', async () => {
    const disposeError = new Error('dispose failed');
    const harness = createHarness({
      disposeRuntime: () => Promise.reject(disposeError),
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(disposeError);

    expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:1']);
    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.logger.error).toHaveBeenCalledWith('Error during shutdown', {
      error: String(disposeError),
    });
  });

  it('S6: attempts both cleanups and aggregates both errors', async () => {
    const closeError = new Error('close failed');
    const disposeError = new Error('dispose failed');
    const harness = createHarness({
      closeServer: () => Promise.reject(closeError),
      disposeRuntime: () => Promise.reject(disposeError),
    });

    let thrown: unknown;
    try {
      await createShutdownHandler(harness.dependencies)('SIGTERM');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(closeError);
    expect(errors[1]).toBe(disposeError);

    expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:1']);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('S7: a SIGINT after a SIGTERM does not repeat the cleanup', async () => {
    const harness = createHarness();
    const shutdown = createShutdownHandler(harness.dependencies);

    const fromTerm = shutdown('SIGTERM');
    const fromInt = shutdown('SIGINT');

    expect(fromInt).toBe(fromTerm);
    await Promise.all([fromTerm, fromInt]);

    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    // Both signals drive the same lifecycle, so only the first is logged.
    expect(harness.logger.info).toHaveBeenCalledWith('Shutdown signal received', {
      signal: 'SIGTERM',
    });
    expect(harness.logger.info).not.toHaveBeenCalledWith('Shutdown signal received', {
      signal: 'SIGINT',
    });
  });

  it('S8: replays the first failure without re-running cleanup', async () => {
    const closeError = new Error('close failed');
    const harness = createHarness({
      closeServer: () => Promise.reject(closeError),
    });
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    await expect(first).rejects.toBe(closeError);

    const second = shutdown('SIGINT');

    expect(second).toBe(first);
    await expect(second).rejects.toBe(closeError);

    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  describe('normal shutdown', () => {
    it('N1: stops accepting before clearing idle connections', async () => {
      const harness = createHarness();

      await createShutdownHandler(harness.dependencies)('SIGTERM');

      expect(harness.closeServer).toHaveBeenCalledTimes(1);
      // Twice: once before the drain wait, once after it.
      expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
      // `closeServer` is entered first, so the listener stops accepting before
      // any idle socket is cleared.
      expect(harness.timeline.slice(0, 2)).toEqual(['closeServer', 'closeIdleConnections']);
    });

    it('N2: disposes the runtime only after the server finished closing', async () => {
      const closeGate = gate();
      const harness = createHarness({ closeServer: () => closeGate.promise });
      const shutdown = createShutdownHandler(harness.dependencies);

      const running = shutdown('SIGTERM');
      await Promise.resolve();

      // Close is still parked, so the runtime must not be touched yet.
      expect(harness.closeServer).toHaveBeenCalledTimes(1);
      expect(harness.disposeRuntime).not.toHaveBeenCalled();

      closeGate.open();
      await running;

      expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
      expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:0']);
    });

    it('N3: exits 0 and leaves no timer armed', async () => {
      const harness = createHarness();

      await createShutdownHandler(harness.dependencies)('SIGTERM');

      expect(harness.exit).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledWith(0);
      expect(harness.timers.scheduled).toEqual([8000]);
      expect(harness.timers.hasPending()).toBe(false);
      expect(harness.timers.cleared).toHaveLength(1);
    });

    it('N4: clears the timer before disposing the runtime', async () => {
      const harness = createHarness();

      await createShutdownHandler(harness.dependencies)('SIGTERM');

      // The deadline covers draining only; disposal runs with no timer armed.
      expect(harness.timeline).toEqual([
        'closeServer',
        'closeIdleConnections',
        'closeIdleConnections',
        'clearTimer',
        'disposeRuntime',
        'exit:0',
      ]);
    });

    it('N5: completes when there is nothing to drain', async () => {
      const harness = createHarness();

      await createShutdownHandler(harness.dependencies)('SIGTERM');

      expect(harness.closeAllConnections).not.toHaveBeenCalled();
      expect(harness.events).toEqual(['closeServer', 'disposeRuntime', 'exit:0']);
    });

    it('N6: uses the injected timeout value for the deadline', async () => {
      const harness = createHarness({ timeoutMs: 1500 });

      await createShutdownHandler(harness.dependencies)('SIGTERM');

      expect(harness.timers.scheduled).toEqual([1500]);
    });
  });

  describe('timeout', () => {
    it('T1: forces connections closed when draining overruns', async () => {
      const closeGate = gate();
      const harness = createHarness({ closeServer: () => closeGate.promise });
      const shutdown = createShutdownHandler(harness.dependencies);

      const running = shutdown('SIGTERM');
      await Promise.resolve();

      harness.timers.fire();
      await running;

      expect(harness.closeAllConnections).toHaveBeenCalledTimes(1);
      closeGate.open();
    });

    it('T2: never disposes the runtime on the timeout path', async () => {
      const closeGate = gate();
      const harness = createHarness({ closeServer: () => closeGate.promise });
      const shutdown = createShutdownHandler(harness.dependencies);

      const running = shutdown('SIGTERM');
      await Promise.resolve();

      harness.timers.fire();
      await running;

      // Closing sockets says nothing about in-flight handlers, so SQLite must
      // stay open rather than be closed underneath them.
      expect(harness.disposeRuntime).not.toHaveBeenCalled();
      expect(harness.timeline).not.toContain('disposeRuntime');
      closeGate.open();
    });

    it('T3: exits 1 and records the timeout', async () => {
      const closeGate = gate();
      const harness = createHarness({ closeServer: () => closeGate.promise, timeoutMs: 2500 });
      const shutdown = createShutdownHandler(harness.dependencies);

      const running = shutdown('SIGTERM');
      await Promise.resolve();

      harness.timers.fire();
      await running;

      expect(harness.exit).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledWith(1);
      expect(harness.logger.error).toHaveBeenCalledWith('Shutdown timed out', {
        error: 'Draining did not finish within 2500ms',
        timeoutMs: 2500,
      });
      closeGate.open();
    });

    it('T4: exits exactly once on the timeout path', async () => {
      const closeGate = gate();
      const harness = createHarness({ closeServer: () => closeGate.promise });
      const shutdown = createShutdownHandler(harness.dependencies);

      const running = shutdown('SIGTERM');
      await Promise.resolve();

      harness.timers.fire();
      await running;

      expect(harness.exit).toHaveBeenCalledTimes(1);
      closeGate.open();
    });

    it('T5: a late close rejection after the deadline stays handled', async () => {
      let rejectClose!: (error: unknown) => void;
      const harness = createHarness({
        closeServer: () =>
          new Promise<void>((_resolve, reject) => {
            rejectClose = reject;
          }),
      });
      const shutdown = createShutdownHandler(harness.dependencies);

      // Listen for real unhandled rejections rather than inferring from timing.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        const running = shutdown('SIGTERM');
        await Promise.resolve();

        harness.timers.fire();
        await running;

        // Settle the abandoned close after the deadline already decided the
        // outcome; the handler must observe it rather than let it escape.
        rejectClose(new Error('late close failure'));
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).toEqual([]);
        expect(harness.exit).toHaveBeenCalledTimes(1);
        expect(harness.exit).toHaveBeenCalledWith(1);
        expect(harness.disposeRuntime).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('T6: a signal arriving after the timeout does not restart cleanup', async () => {
      const closeGate = gate();
      const harness = createHarness({ closeServer: () => closeGate.promise });
      const shutdown = createShutdownHandler(harness.dependencies);

      const first = shutdown('SIGTERM');
      await Promise.resolve();
      harness.timers.fire();
      await first;

      const second = shutdown('SIGINT');

      expect(second).toBe(first);
      expect(harness.closeServer).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledTimes(1);
      closeGate.open();
    });
  });

  describe('concurrency', () => {
    it('C1: repeated signals share one promise and one cleanup', async () => {
      const harness = createHarness();
      const shutdown = createShutdownHandler(harness.dependencies);

      const first = shutdown('SIGTERM');
      const second = shutdown('SIGINT');

      expect(second).toBe(first);
      await Promise.all([first, second]);

      expect(harness.closeServer).toHaveBeenCalledTimes(1);
      // Still exactly two sweeps for the whole shutdown: the promise is shared.
      expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
      expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledTimes(1);
    });

    it('C2: a close that beats the deadline follows the normal path only', async () => {
      const harness = createHarness();

      const running = createShutdownHandler(harness.dependencies)('SIGTERM');
      await running;
      // The deadline timer is gone, so firing it now cannot resurrect a path.
      harness.timers.fire();

      expect(harness.closeAllConnections).not.toHaveBeenCalled();
      expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledWith(0);
    });

    it('C3: clears exactly one timer per shutdown, never twice', async () => {
      const harness = createHarness();

      await createShutdownHandler(harness.dependencies)('SIGTERM');

      expect(harness.timers.setTimer).toHaveBeenCalledTimes(1);
      expect(harness.timers.clearTimer).toHaveBeenCalledTimes(1);
      expect(harness.timers.cleared).toHaveLength(1);
    });

    it('C4: reports a cleanup failure with exit 1 while still closing idle sockets', async () => {
      const disposeError = new Error('dispose failed');
      const harness = createHarness({ disposeRuntime: () => Promise.reject(disposeError) });

      await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(
        disposeError,
      );

      expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
      expect(harness.exit).toHaveBeenCalledWith(1);
      expect(harness.timers.hasPending()).toBe(false);
    });

    it('C5: aggregates a close failure and a dispose failure after the deadline is cleared', async () => {
      const closeError = new Error('close failed');
      const disposeError = new Error('dispose failed');
      const harness = createHarness({
        closeServer: () => Promise.reject(closeError),
        disposeRuntime: () => Promise.reject(disposeError),
      });

      let thrown: unknown;
      try {
        await createShutdownHandler(harness.dependencies)('SIGTERM');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      const errors = (thrown as AggregateError).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBe(closeError);
      expect(errors[1]).toBe(disposeError);
      expect(harness.timers.hasPending()).toBe(false);
      expect(harness.exit).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledWith(1);
    });
  });
});

describe('disposeAll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs every cleanup in order and resolves when all succeed', async () => {
    const events: string[] = [];

    await disposeAll([
      async () => {
        events.push('first');
      },
      async () => {
        events.push('second');
      },
    ]);

    expect(events).toEqual(['first', 'second']);
  });

  it('continues past a failing cleanup and rethrows a single error unchanged', async () => {
    const failure = new Error('first failed');
    const events: string[] = [];

    await expect(
      disposeAll([
        async () => {
          events.push('first');
          throw failure;
        },
        async () => {
          events.push('second');
        },
      ]),
    ).rejects.toBe(failure);

    expect(events).toEqual(['first', 'second']);
  });

  it('aggregates multiple failures in order', async () => {
    const first = new Error('first failed');
    const second = new Error('second failed');

    let thrown: unknown;
    try {
      await disposeAll([
        async () => {
          throw first;
        },
        async () => {
          throw second;
        },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors[0]).toBe(first);
    expect(errors[1]).toBe(second);
  });

  it('resolves without invoking exit when nothing is registered', async () => {
    await expect(disposeAll([])).resolves.toBeUndefined();
  });
});

describe('deadline ordering', () => {
  it('D1: arms the deadline before any draining work begins', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    // The timer must exist before closeServer is entered, otherwise a close
    // that blocks synchronously would never be bounded.
    expect(harness.order.slice(0, 3)).toEqual(['setTimer', 'closeServer', 'closeIdleConnections']);
  });

  it('D2: arms the deadline before closeServer can observe it', async () => {
    const seen = { timersArmed: -1 };
    const holder: { harness?: Harness } = {};

    const harness = createHarness({
      closeServer: async () => {
        seen.timersArmed = holder.harness?.timers.setTimer.mock.calls.length ?? -1;
      },
    });
    holder.harness = harness;

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(seen.timersArmed).toBe(1);
    expect(harness.timers.scheduled).toEqual([8000]);
  });

  it('D3: arms the deadline before idle connections are cleared', async () => {
    const seen = { timersArmed: -1 };
    const holder: { harness?: Harness } = {};

    const harness = createHarness({
      closeIdleConnections: () => {
        seen.timersArmed = holder.harness?.timers.setTimer.mock.calls.length ?? -1;
      },
    });
    holder.harness = harness;

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(seen.timersArmed).toBe(1);
  });
});

describe('forced close failure', () => {
  it('F1: still exits 1 when closeAllConnections throws', async () => {
    const closeGate = gate();
    const forcedCloseError = new Error('force close failed');
    const harness = createHarness({
      closeServer: () => closeGate.promise,
      closeAllConnections: () => {
        throw forcedCloseError;
      },
    });

    const running = createShutdownHandler(harness.dependencies)('SIGTERM');
    await Promise.resolve();
    harness.timers.fire();

    await expect(running).rejects.toThrowError(/forcing connections closed failed/);

    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    closeGate.open();
  });

  it('F2: never disposes the runtime when closeAllConnections throws', async () => {
    const closeGate = gate();
    const harness = createHarness({
      closeServer: () => closeGate.promise,
      closeAllConnections: () => {
        throw new Error('force close failed');
      },
    });

    const running = createShutdownHandler(harness.dependencies)('SIGTERM');
    await Promise.resolve();
    harness.timers.fire();
    await expect(running).rejects.toThrowError();

    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    expect(harness.timeline).not.toContain('disposeRuntime');
    closeGate.open();
  });

  it('F3: reports both the timeout and the forced-close failure, timeout first', async () => {
    const closeGate = gate();
    const forcedCloseError = new Error('force close failed');
    const harness = createHarness({
      closeServer: () => closeGate.promise,
      closeAllConnections: () => {
        throw forcedCloseError;
      },
      timeoutMs: 3000,
    });

    const running = createShutdownHandler(harness.dependencies)('SIGTERM');
    await Promise.resolve();
    harness.timers.fire();

    let thrown: unknown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    // Fixed order: the timeout stays the primary cause.
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe('Draining did not finish within 3000ms');
    expect(errors[1]).toBe(forcedCloseError);

    // Both are also identifiable in the log.
    expect(harness.logger.error).toHaveBeenCalledWith('Shutdown timed out', {
      error: 'Draining did not finish within 3000ms',
      timeoutMs: 3000,
    });
    expect(harness.logger.error).toHaveBeenCalledWith('Failed to force connections closed', {
      error: 'Error: force close failed',
    });
    closeGate.open();
  });

  it('F4: repeated signals do not repeat the forced close or the exit', async () => {
    const closeGate = gate();
    const harness = createHarness({
      closeServer: () => closeGate.promise,
      closeAllConnections: () => {
        throw new Error('force close failed');
      },
    });
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    await Promise.resolve();
    harness.timers.fire();
    await expect(first).rejects.toThrowError();

    const second = shutdown('SIGINT');

    expect(second).toBe(first);
    await expect(second).rejects.toThrowError();

    expect(harness.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    closeGate.open();
  });

  it('F5: a timeout without a forced-close failure still resolves', async () => {
    const closeGate = gate();
    const harness = createHarness({ closeServer: () => closeGate.promise });

    const running = createShutdownHandler(harness.dependencies)('SIGTERM');
    await Promise.resolve();
    harness.timers.fire();

    await expect(running).resolves.toBeUndefined();
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.logger.error).not.toHaveBeenCalledWith(
      'Failed to force connections closed',
      expect.anything(),
    );
    closeGate.open();
  });

  it('F6: treats `throw undefined` from closeAllConnections as a failure', async () => {
    const closeGate = gate();
    const harness = createHarness({
      closeServer: () => closeGate.promise,
      closeAllConnections: () => {
        // Legal JavaScript: the thrown value cannot signal that a throw happened.
        throw undefined;
      },
      timeoutMs: 4000,
    });

    const running = createShutdownHandler(harness.dependencies)('SIGTERM');
    await Promise.resolve();
    harness.timers.fire();

    let thrown: unknown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe('Draining did not finish within 4000ms');
    expect(errors[1]).toBeUndefined();

    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    expect(harness.timeline).not.toContain('disposeRuntime');
    closeGate.open();
  });
});

describe('SHUTDOWN_TIMEOUT_MS validation', () => {
  it('defaults to 8000 when unset', () => {
    expect(loadEnv({}).SHUTDOWN_TIMEOUT_MS).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(8000);
  });

  it('accepts the minimum of 1000', () => {
    expect(loadEnv({ SHUTDOWN_TIMEOUT_MS: '1000' }).SHUTDOWN_TIMEOUT_MS).toBe(
      MIN_SHUTDOWN_TIMEOUT_MS,
    );
  });

  it('accepts the maximum of 60000', () => {
    expect(loadEnv({ SHUTDOWN_TIMEOUT_MS: '60000' }).SHUTDOWN_TIMEOUT_MS).toBe(
      MAX_SHUTDOWN_TIMEOUT_MS,
    );
  });

  it('coerces a numeric string into a number', () => {
    const value = loadEnv({ SHUTDOWN_TIMEOUT_MS: '4500' }).SHUTDOWN_TIMEOUT_MS;
    expect(value).toBe(4500);
    expect(typeof value).toBe('number');
  });

  it('rejects a value below the minimum', () => {
    expect(() => loadEnv({ SHUTDOWN_TIMEOUT_MS: '999' })).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects a value above the maximum', () => {
    expect(() => loadEnv({ SHUTDOWN_TIMEOUT_MS: '60001' })).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects a non-integer value', () => {
    expect(() => loadEnv({ SHUTDOWN_TIMEOUT_MS: '8000.5' })).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('names the offending field in the error message', () => {
    expect(() => loadEnv({ SHUTDOWN_TIMEOUT_MS: '10' })).toThrowError(/SHUTDOWN_TIMEOUT_MS/);
  });
});

describe('draining transition', () => {
  it('G1: marks the process draining exactly once on a normal shutdown', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.beginDraining).toHaveBeenCalledTimes(1);
  });

  it('G2: begins draining before the server is closed', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    // Readiness must be able to answer while the listener still accepts: if the
    // state flipped after closeServer(), nothing could observe it.
    const drainingAt = harness.sequence.indexOf('beginDraining');
    const closingAt = harness.sequence.indexOf('closeServer');
    expect(drainingAt).toBeGreaterThanOrEqual(0);
    expect(drainingAt).toBeLessThan(closingAt);
  });

  it('G3: begins draining on the timeout path', async () => {
    const harness = createHarness({ closeServer: () => gate().promise });

    const shutdown = createShutdownHandler(harness.dependencies);
    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.closeServer).toHaveBeenCalled());
    harness.timers.fire();
    await pending;

    expect(harness.beginDraining).toHaveBeenCalledTimes(1);
    expect(harness.sequence[0]).toBe('beginDraining');
  });

  it('G4: begins draining when the server fails to close', async () => {
    const harness = createHarness({
      closeServer: () => Promise.reject(new Error('close failed')),
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toThrow(
      'close failed',
    );

    expect(harness.beginDraining).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('G5: begins draining when runtime disposal fails', async () => {
    const harness = createHarness({
      disposeRuntime: () => Promise.reject(new Error('dispose failed')),
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toThrow(
      'dispose failed',
    );

    expect(harness.beginDraining).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('G6: repeated signals do not begin draining twice', async () => {
    const harness = createHarness();
    const shutdown = createShutdownHandler(harness.dependencies);

    await shutdown('SIGTERM');
    await shutdown('SIGINT');
    await shutdown('SIGTERM');

    expect(harness.beginDraining).toHaveBeenCalledTimes(1);
  });

  it('G7: a concurrent signal during shutdown does not begin draining twice', async () => {
    const hold = gate();
    const harness = createHarness({ closeServer: () => hold.promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.closeServer).toHaveBeenCalled());
    const second = shutdown('SIGINT');

    hold.open();
    await Promise.all([first, second]);

    expect(harness.beginDraining).toHaveBeenCalledTimes(1);
  });

  it('G8: a throwing beginDraining is logged and shutdown still completes', async () => {
    const failure = new Error('state unavailable');
    const harness = createHarness({
      beginDraining: () => {
        throw failure;
      },
    });

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.logger.error).toHaveBeenCalledWith('Failed to mark the process as draining', {
      error: String(failure),
    });
    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('G9: a throwing beginDraining does not change the timeout exit code', async () => {
    const harness = createHarness({
      beginDraining: () => {
        throw new Error('state unavailable');
      },
      closeServer: () => gate().promise,
    });

    const shutdown = createShutdownHandler(harness.dependencies);
    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.closeServer).toHaveBeenCalled());
    harness.timers.fire();
    await pending;

    expect(harness.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
  });

  it('G10: a throwing beginDraining does not change the close-failure exit code', async () => {
    const harness = createHarness({
      beginDraining: () => {
        throw new Error('state unavailable');
      },
      closeServer: () => Promise.reject(new Error('close failed')),
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toThrow(
      'close failed',
    );

    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
  });

  it('G11: beginDraining runs before the deadline timer is armed', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    // The transition is synchronous and unconditional, so it cannot be starved
    // by a close that blocks: it happens before any draining work is scheduled.
    expect(harness.sequence[0]).toBe('beginDraining');
    expect(harness.order[0]).toBe('setTimer');
  });
});

describe('request drain wait', () => {
  it('W1: waits for tracked requests before disposing the runtime', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
    expect(harness.sequence).toEqual([
      'beginDraining',
      'closeServer',
      'closeIdleConnections',
      'awaitRequestsDrained',
      'closeIdleConnections',
      'disposeRuntime',
      'exit:0',
    ]);
  });

  it('W2: starts the wait after the listener stops accepting, before close settles', async () => {
    const hold = gate();
    const harness = createHarness({ closeServer: () => hold.promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.awaitRequestsDrained).toHaveBeenCalled());

    // Parking inside closeServer is expected: `server.close()` stops accepting
    // immediately and only the callback waits, so the drain wait can run
    // concurrently with it. That overlap is what lets the second idle sweep land
    // before `closeServer()` settles. Only the first sweep has run so far.
    expect(harness.closeServer).toHaveBeenCalledTimes(1);
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();

    hold.open();
    await pending;

    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
  });

  it('W3: a request drain wait that never settles follows the timeout path', async () => {
    const harness = createHarness({ awaitRequestsDrained: () => gate().promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const pending = shutdown('SIGTERM');

    // Waiting only for `awaitRequestsDrained` to be entered is too early: the
    // race with the close may not have resolved yet. A macrotask boundary flushes
    // the pending microtasks, so the shutdown is provably parked on the drain.
    await vi.waitFor(() => expect(harness.awaitRequestsDrained).toHaveBeenCalled());
    await new Promise((resolve) => void setTimeout(resolve, 0));

    // Parked on a drain that will never settle, so the post-drain sweep has not
    // happened and nothing has been disposed.
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();

    harness.timers.fire();
    await pending;

    expect(harness.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    // The timeout path must not have disposed the runtime.
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
  });

  it('W4: a timed-out request drain wait never disposes the runtime', async () => {
    const harness = createHarness({ awaitRequestsDrained: () => gate().promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.awaitRequestsDrained).toHaveBeenCalled());

    harness.timers.fire();
    await pending;

    // In-flight handlers may still be using SQLite; the timeout path must not
    // close it underneath them.
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    expect(harness.timeline).not.toContain('disposeRuntime');
  });

  it('W5: a failing request drain wait is logged and shutdown still completes', async () => {
    const failure = new Error('tracker unavailable');
    const harness = createHarness({ awaitRequestsDrained: () => Promise.reject(failure) });

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.logger.error).toHaveBeenCalledWith('Failed to await drained requests', {
      error: String(failure),
    });
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('W6: a failing request drain wait does not change the timeout exit code', async () => {
    const harness = createHarness({
      awaitRequestsDrained: () => Promise.reject(new Error('tracker unavailable')),
      closeServer: () => gate().promise,
    });

    const shutdown = createShutdownHandler(harness.dependencies);
    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.closeServer).toHaveBeenCalled());

    harness.timers.fire();
    await pending;

    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
  });

  it('W7: a failing request drain wait does not change the close-failure exit code', async () => {
    const harness = createHarness({
      awaitRequestsDrained: () => Promise.reject(new Error('tracker unavailable')),
      closeServer: () => Promise.reject(new Error('close failed')),
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toThrow(
      'close failed',
    );

    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
  });

  it('W8: repeated signals do not repeat the request drain wait', async () => {
    const harness = createHarness();
    const shutdown = createShutdownHandler(harness.dependencies);

    await shutdown('SIGTERM');
    await shutdown('SIGINT');
    await shutdown('SIGTERM');

    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
  });

  it('W9: a concurrent signal does not repeat the request drain wait', async () => {
    const hold = gate();
    const harness = createHarness({ closeServer: () => hold.promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.closeServer).toHaveBeenCalled());
    const second = shutdown('SIGINT');

    hold.open();
    await Promise.all([first, second]);

    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
  });

  it('W10: a throwing beginDraining does not skip the request drain wait', async () => {
    const harness = createHarness({
      beginDraining: () => {
        throw new Error('state unavailable');
      },
    });

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('W11: the request drain wait stays covered by the deadline timer', async () => {
    const harness = createHarness({ awaitRequestsDrained: () => gate().promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.awaitRequestsDrained).toHaveBeenCalled());

    // No second timer: the wait shares the one armed for draining.
    expect(harness.timers.scheduled).toHaveLength(1);
    expect(harness.timers.scheduled[0]).toBe(8000);

    harness.timers.fire();
    await pending;
  });
});

describe('keep-alive completion — second idle sweep', () => {
  it('K1: sweeps idle sockets before the drain wait and again after it succeeds', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);

    // Exactly one call on each side of the drain wait, and the second one is
    // after it settled successfully rather than before it started.
    const calls = harness.sequence.reduce<number[]>((positions, entry, index) => {
      if (entry === 'closeIdleConnections') positions.push(index);
      return positions;
    }, []);
    const drainedAt = harness.sequence.indexOf('awaitRequestsDrained');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeLessThan(drainedAt);
    expect(calls[1]).toBeGreaterThan(drainedAt);
  });

  it('K2: sweeps again before waiting for closeServer to settle', async () => {
    const hold = gate();
    const harness = createHarness({ closeServer: () => hold.promise });
    const shutdown = createShutdownHandler(harness.dependencies);

    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2));

    // The crucial ordering guarantee: close is still parked, yet the second
    // sweep has already run. Without it, closeServer would sit on an idle
    // keep-alive socket for its full keep-alive timeout before settling.
    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();

    hold.open();
    await pending;
  });

  it('K3: still sweeps twice when the drain wait fails, so close can settle', async () => {
    const drainError = new Error('drain failed');
    const harness = createHarness({ awaitRequestsDrained: () => Promise.reject(drainError) });

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    // The failure is logged, the sweep still happens, and the shutdown keeps its
    // success semantics instead of degrading into a deadline timeout.
    expect(harness.logger.error).toHaveBeenCalledWith('Failed to await drained requests', {
      error: String(drainError),
    });
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.closeAllConnections).not.toHaveBeenCalled();
    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
  });

  it('K4: disposes the runtime only after both sweeps and the drain wait', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.sequence).toEqual([
      'beginDraining',
      'closeServer',
      'closeIdleConnections',
      'awaitRequestsDrained',
      'closeIdleConnections',
      'disposeRuntime',
      'exit:0',
    ]);
  });

  it('K5: does not add a timer or extra waiting for the second sweep', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    // One deadline only, cleared once; the extra sweep is synchronous.
    expect(harness.timers.scheduled).toHaveLength(1);
    expect(harness.timers.cleared).toHaveLength(1);
    expect(harness.timers.hasPending()).toBe(false);
  });

  it('K6: never sweeps a third time, even on a repeated signal', async () => {
    const harness = createHarness();
    const shutdown = createShutdownHandler(harness.dependencies);

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    await Promise.all([first, second]);

    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
  });

  it('K7: a throwing second sweep does not skip disposal', async () => {
    let sweep = 0;
    const sweepError = new Error('sweep failed');
    const harness = createHarness({
      closeIdleConnections: () => {
        sweep += 1;
        if (sweep === 2) {
          throw sweepError;
        }
      },
    });

    // The sweep runs inside the drain wait's `finally`; a throw there is a
    // shutdown failure, not a silent one, and must still not skip disposal.
    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(sweepError);

    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });
});

describe('closeServer failure semantics', () => {
  /**
   * Asserts the contract shared by every case below: the caller must observe the
   * close error, the runtime must still be disposed, both idle sweeps must run,
   * and the deadline must not be the thing that ended the shutdown.
   */
  function expectCloseFailureDisposes(harness: Harness, closeError: Error): void {
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.logger.error).toHaveBeenCalledWith('Error during shutdown', {
      error: String(closeError),
    });
    // The deadline must not have decided the outcome. On the timeout path the
    // handler force-closes sockets and logs a dedicated message.
    expect(harness.closeAllConnections).not.toHaveBeenCalled();
    expect(harness.logger.error).not.toHaveBeenCalledWith('Shutdown timed out', expect.anything());
  }

  it('F1a: close rejects immediately while the drain already resolved', async () => {
    const closeError = new Error('close failed');
    const harness = createHarness({ closeServer: () => Promise.reject(closeError) });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(closeError);

    expectCloseFailureDisposes(harness, closeError);
  });

  it('F1b: close rejects immediately while the drain never resolves', async () => {
    const closeError = new Error('close failed');
    const harness = createHarness({
      closeServer: () => Promise.reject(closeError),
      awaitRequestsDrained: () => gate().promise,
    });

    // A close failure is already known, so shutdown must not sit on the drain
    // until the deadline: the runtime is disposed and the close error surfaces.
    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(closeError);

    expectCloseFailureDisposes(harness, closeError);
  });

  it('F1c: close rejects while the drain is still pending', async () => {
    const closeError = new Error('close failed');
    const drainGate = gate();
    let rejectClose!: (error: unknown) => void;
    const closing = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    const harness = createHarness({
      closeServer: () => closing,
      awaitRequestsDrained: () => drainGate.promise,
    });

    const shutdown = createShutdownHandler(harness.dependencies);
    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(harness.awaitRequestsDrained).toHaveBeenCalled());

    rejectClose(closeError);

    await expect(pending).rejects.toBe(closeError);

    expectCloseFailureDisposes(harness, closeError);
  });

  it('F1d: close succeeds while the drain rejects', async () => {
    const drainError = new Error('drain failed');
    const harness = createHarness({
      awaitRequestsDrained: () => Promise.reject(drainError),
    });

    // A drain failure is logged, not propagated: the shutdown still succeeds.
    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.logger.error).toHaveBeenCalledWith('Failed to await drained requests', {
      error: String(drainError),
    });
    expect(harness.closeAllConnections).not.toHaveBeenCalled();
  });

  it('F1e: close succeeds while the drain resolves', async () => {
    const harness = createHarness();

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expect(harness.closeAllConnections).not.toHaveBeenCalled();
  });

  it('F1f: close rejects after the second sweep, once the drain already resolved', async () => {
    const closeError = new Error('late close failure');
    const drainGate = gate();
    let rejectClose!: (error: unknown) => void;
    const closing = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });

    const harness = createHarness({
      closeServer: () => closing,
      // Resolving the gate is the test's signal that the drain finished, which
      // is what lets the sweep run while `close` is still outstanding.
      awaitRequestsDrained: () => drainGate.promise,
    });

    const shutdown = createShutdownHandler(harness.dependencies);
    const pending = shutdown('SIGTERM');

    drainGate.open();
    await vi.waitFor(() => expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2));

    // The second sweep has run and close is still pending; only now does the
    // listener's close fail.
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();

    rejectClose(closeError);

    await expect(pending).rejects.toBe(closeError);

    expectCloseFailureDisposes(harness, closeError);
  });
});

describe('completion order — drain gates the second sweep', () => {
  // A macrotask boundary flushes every pending microtask, so a close that was
  // going to settle has settled by the time the assertions run. Counting ticks
  // by hand made these tests pass while the drain was still racing ahead.
  const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

  it('P1: a close that succeeds first does not sweep until the drain finishes', async () => {
    const drainGate = gate();
    const harness = createHarness({
      // Close settles immediately; the drain is the slower of the two.
      closeServer: () => Promise.resolve(),
      awaitRequestsDrained: () => drainGate.promise,
    });

    const pending = createShutdownHandler(harness.dependencies)('SIGTERM');

    await settle();

    // Close has settled and the drain has been entered but not finished, so the
    // second sweep must still be outstanding — that sweep is the one that only
    // makes sense once requests have drained.
    expect(harness.awaitRequestsDrained).toHaveBeenCalledTimes(1);
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();

    drainGate.open();
    await pending;

    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('P2: the second sweep follows the drain even when close succeeded long before', async () => {
    const order: string[] = [];
    const drainGate = gate();
    const harness = createHarness({
      closeServer: () => Promise.resolve(),
      awaitRequestsDrained: async () => {
        order.push('drain-start');
        await drainGate.promise;
        order.push('drain-end');
      },
      closeIdleConnections: () => {
        order.push('sweep');
      },
    });

    const pending = createShutdownHandler(harness.dependencies)('SIGTERM');

    await settle();

    // Close has certainly settled by now, yet the drain is still blocked: the
    // only sweep on record is the first one, taken before the drain was entered.
    expect(order).toContain('drain-start');
    expect(order).not.toContain('drain-end');
    expect(order.filter((entry) => entry === 'sweep')).toHaveLength(1);

    drainGate.open();
    await pending;

    expect(order.lastIndexOf('sweep')).toBeGreaterThan(order.indexOf('drain-end'));
  });

  it('P3: a close that fails first never waits for the drain', async () => {
    const closeError = new Error('close failed first');
    const harness = createHarness({
      closeServer: () => Promise.reject(closeError),
      // Never settles: waiting on it would hang the shutdown.
      awaitRequestsDrained: () => gate().promise,
    });

    await expect(createShutdownHandler(harness.dependencies)('SIGTERM')).rejects.toBe(closeError);

    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.closeAllConnections).not.toHaveBeenCalled();
  });

  it('P4: a drain that fails after close succeeded is logged, not fatal', async () => {
    const drainError = new Error('drain failed');
    const harness = createHarness({
      closeServer: () => Promise.resolve(),
      awaitRequestsDrained: () => Promise.reject(drainError),
    });

    await createShutdownHandler(harness.dependencies)('SIGTERM');

    expect(harness.logger.error).toHaveBeenCalledWith('Failed to await drained requests', {
      error: String(drainError),
    });
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.disposeRuntime).toHaveBeenCalledTimes(1);
  });

  it('P5: a drain that never finishes is still bounded by the single deadline', async () => {
    const harness = createHarness({
      closeServer: () => Promise.resolve(),
      awaitRequestsDrained: () => gate().promise,
    });

    const pending = createShutdownHandler(harness.dependencies)('SIGTERM');

    // The drain never settles, so the second sweep must never happen either.
    await vi.waitFor(() => expect(harness.awaitRequestsDrained).toHaveBeenCalled());
    expect(harness.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(harness.timers.scheduled).toHaveLength(1);

    harness.timers.fire();
    await pending;

    expect(harness.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.disposeRuntime).not.toHaveBeenCalled();
    // Still exactly one timer for the whole shutdown.
    expect(harness.timers.scheduled).toHaveLength(1);
  });
});
