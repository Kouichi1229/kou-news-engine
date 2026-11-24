/**
 * Process lifecycle state.
 *
 * The only distinction that matters to traffic routing is whether this process
 * should receive *new* work. Once shutdown begins the answer stays "no" until
 * the process exits: nothing re-opens the listener, and the runtime may already
 * be disposed, so reporting ready again would advertise a service that cannot
 * serve. That one-way property is why a single boolean is enough here — a state
 * machine would add states with no observable behaviour.
 *
 * Deliberately free of Express and `process`: the shutdown orchestration owns
 * the transition, and the readiness probe only reads it.
 */
export interface LifecycleState {
  /** Whether the process has begun shutting down. */
  isDraining(): boolean;

  /**
   * Marks the process as draining.
   *
   * Idempotent: a second call is a no-op. There is no counterpart, so a state
   * that reached draining can never report ready again.
   */
  beginDraining(): void;
}

export function createLifecycleState(): LifecycleState {
  let draining = false;

  return {
    isDraining: (): boolean => draining,
    beginDraining: (): void => {
      draining = true;
    },
  };
}
