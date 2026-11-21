/**
 * Cooperative cancellation, checked at work boundaries.
 *
 * The signal does not interrupt anything: a caller polls `isCancelled()` at a
 * point where stopping is safe and decides what to do with the work it already
 * has. That is deliberate — a hard abort in the middle of a write is exactly the
 * partial state cancellation exists to avoid.
 *
 * The state lives in one object handed to the caller. Nothing here is module
 * global, so two runs in the same process cannot cancel each other, and a test
 * can create as many independent signals as it needs.
 */

/**
 * Why a run stopped early.
 *
 * The two reasons are kept apart because they carry different meanings to an
 * operator: `deadline` means the run budget ran out with sources left, `signal`
 * means an operator asked the process to stop. Folding them together would make
 * "the feeds are too slow" indistinguishable from "someone pressed Ctrl-C".
 */
export type CancellationReason = 'deadline' | 'signal';

export interface CancellationSignal {
  /** Whether cancellation has been requested. Never transitions back to false. */
  isCancelled(): boolean;

  /**
   * The first reason recorded, or `undefined` while still running.
   *
   * The first cause wins: a deadline that expires and a signal that arrives
   * afterwards describe one outcome, and the earlier one is what the run
   * actually reacted to.
   */
  reason(): CancellationReason | undefined;

  /**
   * Requests cancellation.
   *
   * Idempotent, and a later call never overwrites an existing reason. Returns
   * whether this call was the one that changed the state, which lets a caller
   * distinguish "I caused it" from "it was already cancelled".
   */
  cancel(reason: CancellationReason): boolean;
}

export function createCancellationSignal(): CancellationSignal {
  let current: CancellationReason | undefined;

  return {
    isCancelled: (): boolean => current !== undefined,
    reason: (): CancellationReason | undefined => current,
    cancel: (reason: CancellationReason): boolean => {
      if (current !== undefined) {
        return false;
      }
      current = reason;
      return true;
    },
  };
}
