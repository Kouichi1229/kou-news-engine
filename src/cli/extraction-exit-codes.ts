import type { ExtractionRunSummary } from '../modules/extraction/extraction.types.js';

/**
 * Exit codes for the extraction CLI.
 *
 * Deliberately a separate module from `cli/exit-codes.ts`: that one is typed
 * against `IngestionRunResult` and its outcome union, and widening it to cover
 * both would make each caller depend on the other's vocabulary. The numbers are
 * shared conventions, not shared code.
 *
 * `130` and `143` are `128 + signal number`, so a shell supervisor reads them
 * correctly without knowing this program.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
/**
 * The command line was rejected before any work started.
 *
 * Distinct from `EXIT_FAILURE` so a supervisor can tell "the invocation was
 * wrong" from "the run failed". Nothing was written and no request was sent
 * when this is returned: argument validation happens before the database is
 * opened.
 */
export const EXIT_USAGE = 2;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export type CancellingSignal = 'SIGINT' | 'SIGTERM';

/**
 * Why an extraction run ended.
 *
 * A union rather than booleans so adding a case is a compile error in
 * `exitCodeForExtractionOutcome` instead of a silent zero.
 */
export type ExtractionCliOutcome =
  | { kind: 'success'; summary: ExtractionRunSummary }
  /** The queue was not empty when a signal stopped the run. */
  | { kind: 'cancelled'; summary: ExtractionRunSummary; signal: CancellingSignal }
  /** A write was attempted and threw. */
  | { kind: 'persistence-failure' }
  | { kind: 'initialization-failure' }
  | { kind: 'unexpected-error' };

/**
 * Maps an outcome to a process exit code.
 *
 * A run that found nothing to do is a success: an empty queue is the normal
 * steady state for a cron-invoked worker, not an error.
 */
export function exitCodeForExtractionOutcome(outcome: ExtractionCliOutcome): number {
  switch (outcome.kind) {
    case 'success':
      return EXIT_SUCCESS;
    case 'cancelled':
      return outcome.signal === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM;
    case 'persistence-failure':
    case 'initialization-failure':
    case 'unexpected-error':
      return EXIT_FAILURE;
  }
}

/**
 * Classifies a completed run.
 *
 * `lostClaims` alone does not make a run a failure: another worker taking the
 * row is the fencing mechanism working as designed, not an error.
 */
export function classifyExtractionRun(
  summary: ExtractionRunSummary,
  signal: CancellingSignal | undefined,
): ExtractionCliOutcome {
  if (summary.cancelled) {
    return { kind: 'cancelled', summary, signal: signal ?? 'SIGTERM' };
  }
  return { kind: 'success', summary };
}
