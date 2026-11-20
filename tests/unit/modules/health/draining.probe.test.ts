import { describe, expect, it } from 'vitest';

import { createLifecycleState } from '../../../../src/core/lifecycle/lifecycle-state.js';
import {
  createDrainingProbe,
  DRAINING_DETAIL,
} from '../../../../src/modules/health/draining.probe.js';

describe('createDrainingProbe', () => {
  it('P1: reports ready without a detail before draining', () => {
    const probe = createDrainingProbe(createLifecycleState());

    const result = probe.check();

    expect(result).toEqual({ ready: true });
    expect(result.detail).toBeUndefined();
  });

  it('P2: reports not ready with the exact draining detail', () => {
    const state = createLifecycleState();
    const probe = createDrainingProbe(state);

    state.beginDraining();

    expect(probe.check()).toEqual({ ready: false, detail: 'draining' });
    expect(DRAINING_DETAIL).toBe('draining');
  });

  it('P3: publishes the exact probe name', () => {
    const probe = createDrainingProbe(createLifecycleState());

    expect(probe.name).toBe('lifecycle');
  });

  it('P4: reads the current state on every check rather than a snapshot', () => {
    const state = createLifecycleState();
    const probe = createDrainingProbe(state);

    expect(probe.check().ready).toBe(true);

    state.beginDraining();

    // Same probe instance, different answer: nothing was captured at build time.
    expect(probe.check().ready).toBe(false);
  });

  it('P5: never reports ready again once draining started', () => {
    const state = createLifecycleState();
    const probe = createDrainingProbe(state);

    state.beginDraining();

    expect(probe.check().ready).toBe(false);
    expect(probe.check().ready).toBe(false);
    expect(probe.check().ready).toBe(false);
  });
});
