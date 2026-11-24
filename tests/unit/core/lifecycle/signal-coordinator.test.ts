import { describe, expect, it, vi } from 'vitest';

import { createCancellationSignal } from '../../../../src/core/lifecycle/cancellation.js';
import {
  createSignalCoordinator,
  type SignalHost,
  type SignalLogger,
} from '../../../../src/core/lifecycle/signal-coordinator.js';

/**
 * A stand-in for `process` that records listeners.
 *
 * Injected so a test never registers a real handler: a leaked SIGINT listener
 * would make the runner exit on Ctrl-C and outlive the case that created it.
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

function silentLogger(): SignalLogger {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('createSignalCoordinator', () => {
  it('cancels gracefully on the first SIGINT', () => {
    const fake = fakeHost();
    const signal = createCancellationSignal();
    const terminate = vi.fn();
    const coordinator = createSignalCoordinator({
      signal,
      terminate,
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGINT');

    expect(signal.isCancelled()).toBe(true);
    expect(signal.reason()).toBe('signal');
    expect(terminate).not.toHaveBeenCalled();
    expect(coordinator.signalCount()).toBe(1);
  });

  it('cancels gracefully on the first SIGTERM', () => {
    const fake = fakeHost();
    const signal = createCancellationSignal();
    const terminate = vi.fn();
    const coordinator = createSignalCoordinator({
      signal,
      terminate,
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGTERM');

    expect(signal.isCancelled()).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('terminates on the second signal instead of cancelling again', () => {
    const fake = fakeHost();
    const signal = createCancellationSignal();
    const terminate = vi.fn();
    const coordinator = createSignalCoordinator({
      signal,
      terminate,
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGINT');
    expect(terminate).not.toHaveBeenCalled();

    fake.emit('SIGTERM');

    // The second signal takes the forced path, whatever signal it is.
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
    expect(coordinator.signalCount()).toBe(2);
  });

  it('logs the data-loss risk on the forced path', () => {
    const fake = fakeHost();
    const logger = silentLogger();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host: fake.host,
      logger,
    });
    coordinator.install();

    fake.emit('SIGINT');
    fake.emit('SIGINT');

    // The forced exit must never look like the graceful one in the logs.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('terminating without waiting'),
      expect.objectContaining({ dataLossRisk: expect.stringContaining('lost') }),
    );
  });

  it('subscribes to both signals on install', () => {
    const fake = fakeHost();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host: fake.host,
      logger: silentLogger(),
    });

    coordinator.install();

    expect(fake.listenerCount('SIGINT')).toBe(1);
    expect(fake.listenerCount('SIGTERM')).toBe(1);
  });

  it('removes every listener on uninstall', () => {
    const fake = fakeHost();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    coordinator.uninstall();

    expect(fake.listenerCount('SIGINT')).toBe(0);
    expect(fake.listenerCount('SIGTERM')).toBe(0);
  });

  it('does not double-subscribe when installed twice', () => {
    const fake = fakeHost();
    const signal = createCancellationSignal();
    const terminate = vi.fn();
    const coordinator = createSignalCoordinator({
      signal,
      terminate,
      host: fake.host,
      logger: silentLogger(),
    });

    coordinator.install();
    coordinator.install();

    // Two listeners would make one Ctrl-C count as two and force an exit.
    expect(fake.listenerCount('SIGINT')).toBe(1);

    fake.emit('SIGINT');
    expect(terminate).not.toHaveBeenCalled();
  });

  it('tolerates uninstall before install and repeated uninstall', () => {
    const fake = fakeHost();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host: fake.host,
      logger: silentLogger(),
    });

    expect(() => coordinator.uninstall()).not.toThrow();

    coordinator.install();
    coordinator.uninstall();
    expect(() => coordinator.uninstall()).not.toThrow();
    expect(fake.listenerCount('SIGINT')).toBe(0);
  });

  it('stops reacting once uninstalled', () => {
    const fake = fakeHost();
    const signal = createCancellationSignal();
    const coordinator = createSignalCoordinator({
      signal,
      terminate: vi.fn(),
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();
    coordinator.uninstall();

    fake.emit('SIGINT');

    expect(signal.isCancelled()).toBe(false);
    expect(coordinator.signalCount()).toBe(0);
  });

  it('requests termination only once across four mixed signals', () => {
    const fake = fakeHost();
    const terminate = vi.fn();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate,
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGINT');
    fake.emit('SIGTERM');
    fake.emit('SIGINT');
    fake.emit('SIGTERM');

    // One shared counter, so the mixed sequence is 4 signals, not 2+2. The
    // forced exit is requested on the second one and never again.
    expect(coordinator.signalCount()).toBe(4);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps counting signals after termination without acting on them', () => {
    const fake = fakeHost();
    const terminate = vi.fn();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate,
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGINT');
    fake.emit('SIGINT');
    fake.emit('SIGINT');
    fake.emit('SIGINT');

    // Observed for diagnostics, but a re-entry into `terminate` is what a
    // partially torn-down process must not get.
    expect(coordinator.signalCount()).toBe(4);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('logs the ignored signals instead of terminating again', () => {
    const fake = fakeHost();
    const logger = silentLogger();
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host: fake.host,
      logger,
    });
    coordinator.install();

    fake.emit('SIGINT');
    fake.emit('SIGINT');
    fake.emit('SIGTERM');

    // Two ignored signals, each recorded: silence would look like a lost signal.
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('termination already requested'),
      expect.objectContaining({ signalCount: 3 }),
    );
  });

  it('does not retry a terminate that throws', () => {
    const fake = fakeHost();
    let calls = 0;
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: () => {
        calls += 1;
        throw new Error('terminate failed');
      },
      host: fake.host,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGINT');
    expect(() => fake.emit('SIGINT')).toThrow('terminate failed');
    // The failed attempt already consumed the one-shot, so a further signal is
    // ignored rather than retried — and therefore does not throw again.
    expect(() => fake.emit('SIGINT')).not.toThrow();

    // One attempt only: the process state is unknown after a failed teardown.
    expect(calls).toBe(1);
  });

  it('removes a partially registered listener when install fails', () => {
    const listeners = new Map<string, Set<(signal: NodeJS.Signals) => void>>();
    const host: SignalHost = {
      on: (event, listener) => {
        if (event === 'SIGTERM') {
          throw new Error('SIGTERM registration failed');
        }
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return undefined;
      },
      removeListener: (event, listener) => {
        listeners.get(event)?.delete(listener);
        return undefined;
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    expect(() => coordinator.install()).toThrow('SIGTERM registration failed');

    // The SIGINT listener added before the failure must not survive: it would be
    // live but unreachable by `uninstall()`, which early-returns while uninstalled.
    expect(listeners.get('SIGINT')?.size ?? 0).toBe(0);
  });

  it('can be installed again after a failed install', () => {
    let failNext = true;
    const listeners = new Map<string, Set<(signal: NodeJS.Signals) => void>>();
    const host: SignalHost = {
      on: (event, listener) => {
        if (event === 'SIGTERM' && failNext) {
          throw new Error('SIGTERM registration failed');
        }
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return undefined;
      },
      removeListener: (event, listener) => {
        listeners.get(event)?.delete(listener);
        return undefined;
      },
    };
    const signal = createCancellationSignal();
    const coordinator = createSignalCoordinator({
      signal,
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    expect(() => coordinator.install()).toThrow('SIGTERM registration failed');

    failNext = false;
    coordinator.install();

    // Exactly one of each: the failed attempt left nothing to duplicate.
    expect(listeners.get('SIGINT')?.size).toBe(1);
    expect(listeners.get('SIGTERM')?.size).toBe(1);

    for (const listener of listeners.get('SIGINT') ?? []) {
      listener('SIGINT');
    }
    expect(signal.isCancelled()).toBe(true);
  });

  it('stays uninstalled and safe to uninstall after a failed install', () => {
    const host: SignalHost = {
      on: (event) => {
        if (event === 'SIGTERM') {
          throw new Error('SIGTERM registration failed');
        }
        return undefined;
      },
      removeListener: () => undefined,
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    expect(() => coordinator.install()).toThrow('SIGTERM registration failed');

    // No half-installed state: uninstall is a no-op and does not throw.
    expect(() => coordinator.uninstall()).not.toThrow();
    expect(coordinator.signalCount()).toBe(0);
  });

  it('still removes the other listener when the first removal fails', () => {
    const removed: string[] = [];
    const host: SignalHost = {
      on: () => undefined,
      removeListener: (event) => {
        if (event === 'SIGINT') {
          throw new Error('SIGINT removal failed');
        }
        removed.push(event);
        return undefined;
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });
    coordinator.install();

    // The SIGINT failure must not abort the loop before SIGTERM is attempted.
    let error: unknown;
    try {
      coordinator.uninstall();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe('SIGINT removal failed');
    // SIGTERM was still removed, which is the point of the best-effort loop.
    expect(removed).toEqual(['SIGTERM']);
  });

  it('reports every removal failure, not just the first', () => {
    const host: SignalHost = {
      on: () => undefined,
      removeListener: (event) => {
        throw new Error(`${event} removal failed`);
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });
    coordinator.install();

    let error: unknown;
    try {
      coordinator.uninstall();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AggregateError);
    const messages = (error as AggregateError).errors.map((entry) => (entry as Error).message);
    expect(messages).toEqual(['SIGINT removal failed', 'SIGTERM removal failed']);
  });

  it('retries only the leftovers on a second uninstall, and stops once they are gone', () => {
    let attempts = 0;
    let failNext = true;
    const host: SignalHost = {
      on: () => undefined,
      removeListener: () => {
        attempts += 1;
        if (failNext) {
          throw new Error('removal failed');
        }
        return undefined;
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });
    coordinator.install();

    expect(() => coordinator.uninstall()).toThrow();
    expect(attempts).toBe(2);

    // The leftovers are still tracked because they are still attached: a second
    // call is the only way to release them, so it retries exactly those two.
    failNext = false;
    expect(() => coordinator.uninstall()).not.toThrow();
    expect(attempts).toBe(4);

    // Nothing left to release, so a third call touches the host no further.
    expect(() => coordinator.uninstall()).not.toThrow();
    expect(attempts).toBe(4);
  });

  it('keeps the graceful and forced behaviour when cleanup fails', () => {
    const fake = fakeHost();
    const signal = createCancellationSignal();
    const terminate = vi.fn();
    const failingHost: SignalHost = {
      on: fake.host.on,
      removeListener: () => {
        throw new Error('removal failed');
      },
    };
    const coordinator = createSignalCoordinator({
      signal,
      terminate,
      host: failingHost,
      logger: silentLogger(),
    });
    coordinator.install();

    fake.emit('SIGINT');
    fake.emit('SIGINT');

    // Cleanup trouble must not change signal semantics: one graceful cancel,
    // exactly one forced termination.
    expect(signal.isCancelled()).toBe(true);
    expect(signal.reason()).toBe('signal');
    expect(terminate).toHaveBeenCalledTimes(1);

    expect(() => coordinator.uninstall()).toThrow();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('preserves the registration error and every rollback failure', () => {
    const registrationError = new Error('SIGTERM registration failed');
    const rollbackError = new Error('SIGINT rollback failed');
    const listeners = new Set<(signal: NodeJS.Signals) => void>();
    const host: SignalHost = {
      on: (event, listener) => {
        if (event === 'SIGTERM') {
          throw registrationError;
        }
        listeners.add(listener);
        return undefined;
      },
      removeListener: () => {
        throw rollbackError;
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    let error: unknown;
    try {
      coordinator.install();
    } catch (caught) {
      error = caught;
    }

    // The old code swallowed the rollback failure entirely, leaving a live
    // listener behind with no record of why it was still there.
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(registrationError);
    expect(aggregate.errors[1]).toBe(rollbackError);
    expect(aggregate.message).toContain('roll back 1 listener(s)');
  });

  it('keeps a listener that survived the rollback reachable by uninstall', () => {
    const listeners = new Set<(signal: NodeJS.Signals) => void>();
    let allowRemoval = false;
    const host: SignalHost = {
      on: (event, listener) => {
        if (event === 'SIGTERM') {
          throw new Error('SIGTERM registration failed');
        }
        listeners.add(listener);
        return undefined;
      },
      removeListener: (_event, listener) => {
        if (!allowRemoval) {
          throw new Error('SIGINT rollback failed');
        }
        listeners.delete(listener);
        return undefined;
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    expect(() => coordinator.install()).toThrow(AggregateError);
    // The rollback failed, so the SIGINT listener is still attached.
    expect(listeners.size).toBe(1);

    // The leftover is tracked, so a later uninstall can still release it.
    allowRemoval = true;
    expect(() => coordinator.uninstall()).not.toThrow();
    expect(listeners.size).toBe(0);
  });

  it('does not register a duplicate of a listener that survived the rollback', () => {
    let allowRegistration = false;
    const listeners = new Set<(signal: NodeJS.Signals) => void>();
    let allowRemoval = false;
    const host: SignalHost = {
      on: (event, listener) => {
        if (event === 'SIGTERM' && !allowRegistration) {
          throw new Error('SIGTERM registration failed');
        }
        listeners.add(listener);
        return undefined;
      },
      removeListener: (_event, listener) => {
        if (!allowRemoval) {
          throw new Error('SIGINT rollback failed');
        }
        listeners.delete(listener);
        return undefined;
      },
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    expect(() => coordinator.install()).toThrow(AggregateError);
    expect(listeners.size).toBe(1);

    // Retrying must not add a second copy of the listener that never left.
    allowRegistration = true;
    allowRemoval = true;
    coordinator.install();
    expect(listeners.size).toBe(1);
  });

  it('rethrows the registration error unwrapped when the rollback succeeds', () => {
    const registrationError = new Error('SIGTERM registration failed');
    const host: SignalHost = {
      on: (event) => {
        if (event === 'SIGTERM') {
          throw registrationError;
        }
        return undefined;
      },
      removeListener: () => undefined,
    };
    const coordinator = createSignalCoordinator({
      signal: createCancellationSignal(),
      terminate: vi.fn(),
      host,
      logger: silentLogger(),
    });

    // A clean rollback keeps the original error identity, so existing callers
    // that match on it are unaffected.
    expect(() => coordinator.install()).toThrow(registrationError);
  });
});
