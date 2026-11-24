import { describe, expect, it } from 'vitest';

import { createCancellationSignal } from '../../../../src/core/lifecycle/cancellation.js';

describe('createCancellationSignal', () => {
  it('starts uncancelled with no reason', () => {
    const signal = createCancellationSignal();

    expect(signal.isCancelled()).toBe(false);
    expect(signal.reason()).toBeUndefined();
  });

  it('reports cancelled and the reason after cancel', () => {
    const signal = createCancellationSignal();

    expect(signal.cancel('signal')).toBe(true);
    expect(signal.isCancelled()).toBe(true);
    expect(signal.reason()).toBe('signal');
  });

  it('keeps the first reason and ignores later ones', () => {
    const signal = createCancellationSignal();

    signal.cancel('deadline');
    expect(signal.cancel('signal')).toBe(false);

    // The earlier cause is what the run reacted to; the later one did not change
    // anything and must not rewrite history.
    expect(signal.reason()).toBe('deadline');
  });

  it('returns false on every repeat cancel', () => {
    const signal = createCancellationSignal();

    expect(signal.cancel('signal')).toBe(true);
    expect(signal.cancel('signal')).toBe(false);
    expect(signal.cancel('signal')).toBe(false);
  });

  it('keeps independent instances isolated', () => {
    const first = createCancellationSignal();
    const second = createCancellationSignal();

    first.cancel('signal');

    // No module-level state: one run's signal never leaks into another's.
    expect(first.isCancelled()).toBe(true);
    expect(second.isCancelled()).toBe(false);
  });
});
