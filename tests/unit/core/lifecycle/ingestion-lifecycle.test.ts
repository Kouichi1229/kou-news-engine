import { describe, expect, it, vi } from 'vitest';

import type { CancellationSignal } from '../../../../src/core/lifecycle/cancellation.js';
import {
  createIngestionLifecycle,
  type IngestionLifecycleLogger,
} from '../../../../src/core/lifecycle/ingestion-lifecycle.js';
import type { SignalHost } from '../../../../src/core/lifecycle/signal-coordinator.js';

/**
 * Records listeners instead of touching the real process, so a leaked handler
 * cannot affect the test runner.
 */
function fakeHost(): {
  host: SignalHost;
  emit: (signal: NodeJS.Signals) => void;
  listenerCount: (signal: 'SIGINT' | 'SIGTERM') => number;
} {
  const listeners = new Map<string, Set<(signal: NodeJS.Signals) => void>>();
  const bucket = (event: string): Set<(signal: NodeJS.Signals) => void> => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    return set;
  };

  return {
    host: {
      on: (event, listener) => {
        bucket(event).add(listener);
        return undefined;
      },
      removeListener: (event, listener) => {
        bucket(event).delete(listener);
        return undefined;
      },
    },
    emit: (signal) => {
      for (const listener of [...bucket(signal)]) {
        listener(signal);
      }
    },
    listenerCount: (signal) => bucket(signal).size,
  };
}

function silentLogger(): IngestionLifecycleLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A host whose listeners register normally but cannot be removed.
 *
 * Lets a test drive the cleanup-failure path without touching real signals.
 */
function hostWithFailingRemoval(): SignalHost {
  return {
    on: () => undefined,
    removeListener: () => {
      throw new Error('removal failed');
    },
  };
}

describe('createIngestionLifecycle', () => {
  it('installs the signal handlers before createRuntime is called', async () => {
    const fake = fakeHost();
    let listenersAtCreate = -1;

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => {
        // The whole point of the ordering: a signal during a slow open must
        // already have somewhere to land.
        listenersAtCreate = fake.listenerCount('SIGINT');
        return { dispose: async () => undefined };
      },
      run: async () => 'done',
    });

    await run();

    expect(listenersAtCreate).toBe(1);
  });

  it('records a signal that arrives during initialisation and skips the run', async () => {
    const fake = fakeHost();
    const runWork = vi.fn(async () => 'done');

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => {
        fake.emit('SIGINT');
        return { dispose: async () => undefined };
      },
      run: runWork,
    });

    const outcome = await run();

    // The cancellation landed before any work started, so no source is fetched.
    expect(runWork).not.toHaveBeenCalled();
    expect(outcome.cancelled).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(outcome.runtimeCreated).toBe(true);
  });

  it('still disposes a runtime created after a signal during initialisation', async () => {
    const fake = fakeHost();
    const dispose = vi.fn(async () => undefined);

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => {
        fake.emit('SIGTERM');
        return { dispose };
      },
      run: async () => 'done',
    });

    await run();

    // Even though the run never ran, the handle that was opened is released.
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('passes the signal to the run and reports cancellation', async () => {
    const fake = fakeHost();
    let observed: CancellationSignal | undefined;

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({ dispose: async () => undefined }),
      run: async (_runtime, signal) => {
        observed = signal;
        fake.emit('SIGINT');
        return 'finished';
      },
    });

    const outcome = await run();

    // The work saw the cancellation on its own boundary.
    expect(observed?.isCancelled()).toBe(true);
    expect(outcome.result).toBe('finished');
    expect(outcome.cancelled).toBe(true);
  });

  it('returns the run result when nothing is cancelled', async () => {
    const run = createIngestionLifecycle({
      host: fakeHost().host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({ dispose: async () => undefined }),
      run: async () => 'clean',
    });

    const outcome = await run();

    expect(outcome).toEqual({ result: 'clean', cancelled: false, runtimeCreated: true });
  });

  it('disposes exactly once and removes the listeners on the clean path', async () => {
    const fake = fakeHost();
    const dispose = vi.fn(async () => undefined);

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({ dispose }),
      run: async () => 'clean',
    });

    await run();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount('SIGINT')).toBe(0);
    expect(fake.listenerCount('SIGTERM')).toBe(0);
  });

  it('disposes exactly once when the run throws, and rethrows the original error', async () => {
    const fake = fakeHost();
    const dispose = vi.fn(async () => undefined);
    const failure = new Error('ingestion exploded');

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({ dispose }),
      run: async () => {
        throw failure;
      },
    });

    await expect(run()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount('SIGINT')).toBe(0);
  });

  it('does not attempt disposal when createRuntime itself fails', async () => {
    const fake = fakeHost();
    const creationError = new Error('cannot open database');

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => {
        throw creationError;
      },
      run: async () => 'never',
    });

    await expect(run()).rejects.toBe(creationError);
    // Nothing was created, so nothing can be disposed — and nothing throws.
    expect(fake.listenerCount('SIGINT')).toBe(0);
  });

  it('surfaces a disposal failure instead of hiding it behind a successful run', async () => {
    const disposeError = new Error('close failed');

    const run = createIngestionLifecycle({
      host: fakeHost().host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({
        dispose: async () => {
          throw disposeError;
        },
      }),
      run: async () => 'clean',
    });

    // A runtime that cannot be released is a failure an operator must see.
    await expect(run()).rejects.toBe(disposeError);
  });

  it('does not retry a disposal that already failed', async () => {
    let attempts = 0;

    const run = createIngestionLifecycle({
      host: fakeHost().host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({
        dispose: async () => {
          attempts += 1;
          throw new Error('close failed');
        },
      }),
      run: async () => 'clean',
    });

    await expect(run()).rejects.toThrow('close failed');
    // One attempt: retrying a failed release could double-free a handle.
    expect(attempts).toBe(1);
  });

  it('terminates on a second signal during a graceful shutdown', async () => {
    const fake = fakeHost();
    const terminate = vi.fn();
    let reachedRun: (() => void) | undefined;
    const enteredRun = new Promise<void>((resolve) => {
      reachedRun = resolve;
    });
    let releaseRun: (() => void) | undefined;
    const holdRun = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    const run = createIngestionLifecycle({
      host: fake.host,
      terminate,
      logger: silentLogger(),
      createRuntime: async () => ({ dispose: async () => undefined }),
      run: async () => {
        // Stands in for a source still being fetched.
        reachedRun?.();
        await holdRun;
        return 'finished';
      },
    });

    const running = run();
    await enteredRun;

    fake.emit('SIGINT');
    fake.emit('SIGINT');

    // The second signal takes the forced path while work is still in flight.
    expect(terminate).toHaveBeenCalledTimes(1);

    releaseRun?.();
    await running;
  });

  it('leaves one listener per signal after many runs', async () => {
    const fake = fakeHost();

    for (let index = 0; index < 5; index += 1) {
      const run = createIngestionLifecycle({
        host: fake.host,
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({ dispose: async () => undefined }),
        run: async () => 'clean',
      });
      await run();
    }

    // Nothing accumulated across runs: each uninstall removed exactly its own.
    expect(fake.listenerCount('SIGINT')).toBe(0);
    expect(fake.listenerCount('SIGTERM')).toBe(0);
  });

  it('installs and removes listeners per run without cross-run contamination', async () => {
    const fake = fakeHost();

    const first = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({ dispose: async () => undefined }),
      run: async (_runtime, signal) => {
        fake.emit('SIGINT');
        return signal.isCancelled();
      },
    });

    expect(await first()).toMatchObject({ result: true, cancelled: true });

    const second = createIngestionLifecycle({
      host: fake.host,
      terminate: vi.fn(),
      logger: silentLogger(),
      createRuntime: async () => ({ dispose: async () => undefined }),
      run: async (_runtime, signal) => signal.isCancelled(),
    });

    // A fresh signal per run: the first run's cancellation does not carry over.
    expect(await second()).toMatchObject({ result: false, cancelled: false });
  });

  describe('run and disposal both failing', () => {
    it('preserves both causes in an AggregateError', async () => {
      const fake = fakeHost();
      const runError = new Error('run failed');
      const disposeError = new Error('dispose failed');

      const run = createIngestionLifecycle({
        host: fake.host,
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({
          dispose: async () => {
            throw disposeError;
          },
        }),
        run: async () => {
          throw runError;
        },
      });

      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      // Neither failure may be dropped: the run error explains why the
      // invocation failed, the disposal error explains the leaked resource.
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(runError);
      expect(aggregate.errors[1]).toBe(disposeError);
      expect(aggregate.message).toBe('Runtime disposal failed while handling another error');
    });

    it('removes every listener even when both the run and the disposal fail', async () => {
      const fake = fakeHost();

      const run = createIngestionLifecycle({
        host: fake.host,
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({
          dispose: async () => {
            throw new Error('dispose failed');
          },
        }),
        run: async () => {
          throw new Error('run failed');
        },
      });

      await expect(run()).rejects.toBeInstanceOf(AggregateError);

      // A leaked SIGINT handler would keep the process alive and fire against a
      // runtime that no longer exists.
      expect(fake.listenerCount('SIGINT')).toBe(0);
      expect(fake.listenerCount('SIGTERM')).toBe(0);
    });

    it('does not retry the disposal that failed', async () => {
      const fake = fakeHost();
      let attempts = 0;

      const run = createIngestionLifecycle({
        host: fake.host,
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({
          dispose: async () => {
            attempts += 1;
            throw new Error('dispose failed');
          },
        }),
        run: async () => {
          throw new Error('run failed');
        },
      });

      await expect(run()).rejects.toBeInstanceOf(AggregateError);

      expect(attempts).toBe(1);
    });

    it('reports the disposal failure in the log', async () => {
      const fake = fakeHost();
      const logger = silentLogger();

      const run = createIngestionLifecycle({
        host: fake.host,
        terminate: vi.fn(),
        logger,
        createRuntime: async () => ({
          dispose: async () => {
            throw new Error('dispose failed');
          },
        }),
        run: async () => {
          throw new Error('run failed');
        },
      });

      await expect(run()).rejects.toBeInstanceOf(AggregateError);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to dispose runtime after error',
        expect.objectContaining({ error: expect.stringContaining('dispose failed') }),
      );
    });
  });

  describe('signal handler cleanup failure', () => {
    it('disposes the runtime even when removing the listeners fails', async () => {
      const dispose = vi.fn(async () => undefined);

      const run = createIngestionLifecycle({
        host: hostWithFailingRemoval(),
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({ dispose }),
        run: async () => 'clean',
      });

      // The run succeeded, but a handler may still be attached: that is a
      // failure, not a silent success.
      await expect(run()).rejects.toBeInstanceOf(AggregateError);

      // The database handle is released regardless.
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('reports the cleanup failures and nothing else on an otherwise clean run', async () => {
      const run = createIngestionLifecycle({
        host: hostWithFailingRemoval(),
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({ dispose: async () => undefined }),
        run: async () => 'clean',
      });

      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      // One entry per listener that could not be removed.
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map((entry) => (entry as Error).message)).toEqual([
        'removal failed',
        'removal failed',
      ]);
      expect(aggregate.message).toBe('Failed to remove signal handlers');
    });

    it('keeps the run error, the cleanup failures and the disposal failure all inspectable', async () => {
      const runError = new Error('run failed');
      const disposeError = new Error('dispose failed');

      const run = createIngestionLifecycle({
        host: hostWithFailingRemoval(),
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({
          dispose: async () => {
            throw disposeError;
          },
        }),
        run: async () => {
          throw runError;
        },
      });

      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      // Four entries: the run error, two cleanup failures, the disposal failure.
      expect(aggregate.errors).toHaveLength(4);
      expect(aggregate.errors[0]).toBe(runError);
      expect(aggregate.errors[3]).toBe(disposeError);
      expect(aggregate.message).toBe(
        'Ingestion run, signal handler cleanup, and runtime disposal all failed',
      );
    });

    it('keeps the run error and the cleanup failures when disposal succeeds', async () => {
      const runError = new Error('run failed');
      const dispose = vi.fn(async () => undefined);

      const run = createIngestionLifecycle({
        host: hostWithFailingRemoval(),
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({ dispose }),
        run: async () => {
          throw runError;
        },
      });

      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors[0]).toBe(runError);
      expect(aggregate.errors).toHaveLength(3);
      expect(aggregate.message).toBe('Ingestion run and signal handler cleanup both failed');

      // Disposal still ran exactly once.
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps the disposal failure and the cleanup failures when the run succeeded', async () => {
      const disposeError = new Error('dispose failed');

      const run = createIngestionLifecycle({
        host: hostWithFailingRemoval(),
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({
          dispose: async () => {
            throw disposeError;
          },
        }),
        run: async () => 'clean',
      });

      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors).toHaveLength(3);
      expect(aggregate.errors[2]).toBe(disposeError);
      expect(aggregate.message).toBe('Signal handler cleanup and runtime disposal both failed');
    });

    it('does not dispose twice or terminate twice after a cleanup failure', async () => {
      const dispose = vi.fn(async () => undefined);
      const terminate = vi.fn();

      const run = createIngestionLifecycle({
        host: hostWithFailingRemoval(),
        terminate,
        logger: silentLogger(),
        createRuntime: async () => ({ dispose }),
        run: async () => 'clean',
      });

      await expect(run()).rejects.toBeInstanceOf(AggregateError);

      // One disposal attempt, and no forced termination was ever requested.
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(terminate).not.toHaveBeenCalled();
    });

    it('still reports a single error type when cleanup succeeds', async () => {
      // Regression guard: the ordinary path must not start throwing AggregateError.
      const run = createIngestionLifecycle({
        host: fakeHost().host,
        terminate: vi.fn(),
        logger: silentLogger(),
        createRuntime: async () => ({ dispose: async () => undefined }),
        run: async () => 'clean',
      });

      await expect(run()).resolves.toMatchObject({ result: 'clean', cancelled: false });
    });
  });
});
