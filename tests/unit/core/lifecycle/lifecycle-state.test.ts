import { describe, expect, it } from 'vitest';

import {
  createLifecycleState,
  type LifecycleState,
} from '../../../../src/core/lifecycle/lifecycle-state.js';

describe('createLifecycleState', () => {
  it('L1: starts out not draining', () => {
    const state = createLifecycleState();

    expect(state.isDraining()).toBe(false);
  });

  it('L2: reports draining after the transition', () => {
    const state = createLifecycleState();

    state.beginDraining();

    expect(state.isDraining()).toBe(true);
  });

  it('L3: repeated transitions are idempotent', () => {
    const state = createLifecycleState();

    state.beginDraining();
    state.beginDraining();
    state.beginDraining();

    expect(state.isDraining()).toBe(true);
  });

  it('L4: exposes no way back to a running state', () => {
    const state = createLifecycleState();

    // The interface is the contract: only these two members exist, so no reset
    // can be reached even by a caller that wants one.
    expect(Object.keys(state).sort()).toEqual(['beginDraining', 'isDraining']);
    expect(Object.keys(state)).not.toContain('reset');
    expect(Object.keys(state)).not.toContain('endDraining');

    state.beginDraining();
    expect(state.isDraining()).toBe(true);
  });

  it('L5: separate instances are independent', () => {
    const first: LifecycleState = createLifecycleState();
    const second: LifecycleState = createLifecycleState();

    first.beginDraining();

    expect(first.isDraining()).toBe(true);
    expect(second.isDraining()).toBe(false);
  });

  it('L6: a detached method reference still reads the same state', () => {
    const state = createLifecycleState();
    const { beginDraining, isDraining } = state;

    beginDraining();

    expect(isDraining()).toBe(true);
  });
});
