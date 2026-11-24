import type { LifecycleState } from '../../core/lifecycle/lifecycle-state.js';
import type { ReadinessProbe, ReadinessProbeResult } from './readiness.js';

/** Stable reason code published while the process is shutting down. */
export const DRAINING_DETAIL = 'draining';

/**
 * Readiness entry that reports the process lifecycle.
 *
 * Readiness answers "should this process receive new traffic?", so a draining
 * process is not ready even though it is still healthy. Liveness is untouched:
 * the process is alive and finishing work, it just should not be given more.
 *
 * `check()` reads the state on every call rather than snapshotting it, so a
 * transition that happens after the probe is built is reflected immediately.
 */
export function createDrainingProbe(state: LifecycleState): ReadinessProbe {
  return {
    name: 'lifecycle',
    check: (): ReadinessProbeResult =>
      state.isDraining() ? { ready: false, detail: DRAINING_DETAIL } : { ready: true },
  };
}
