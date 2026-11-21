import type { IngestionRunResult } from '../modules/ingestion/ingestion.types.js';

/**
 * Process exit codes for the one-shot ingestion CLI.
 *
 * The numbers are a contract with whatever supervises the process — a cron
 * wrapper, a container runtime, an operator reading `$?` — so they are stated
 * once here and asserted in tests rather than reconstructed from log text.
 * Matching on log output would make the contract depend on message wording.
 *
 * `130` and `143` are the conventional `128 + signal number` values for SIGINT
 * and SIGTERM, so a supervisor that understands shells already reads them
 * correctly, and both stay distinguishable from the plain `1` failure.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

/** The signal that requested cancellation, when one did. */
export type CancellingSignal = 'SIGINT' | 'SIGTERM';

/**
 * Why a run ended, as far as the exit code is concerned.
 *
 * A union rather than a set of booleans, so adding an outcome fails the type
 * check in `exitCodeForOutcome` instead of silently falling through to success.
 */
export type CliOutcome =
  /** Every source that was attempted succeeded. */
  | { kind: 'success' }
  /** Some sources succeeded and some failed; the articles found are real. */
  | { kind: 'partial' }
  /** Every attempted source failed, so the run produced nothing usable. */
  | { kind: 'all-sources-failed' }
  /** Writing to the repository threw. */
  | { kind: 'persistence-failure' }
  /** The deadline expired with sources never attempted. */
  | { kind: 'deadline-exceeded' }
  /** A signal cancelled the run. */
  | { kind: 'cancelled'; signal: CancellingSignal }
  /** The runtime could not be built. */
  | { kind: 'initialization-failure' }
  /** Anything not covered above. */
  | { kind: 'unexpected-error' };

/**
 * Maps an outcome to a process exit code.
 *
 * Deliberately total: every variant is handled and there is no default branch,
 * so a new variant is a compile error here rather than a silent zero exit.
 */
export function exitCodeForOutcome(outcome: CliOutcome): number {
  switch (outcome.kind) {
    case 'success':
    case 'partial':
      return EXIT_SUCCESS;
    case 'cancelled':
      return outcome.signal === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM;
    case 'all-sources-failed':
    case 'persistence-failure':
    case 'deadline-exceeded':
    case 'initialization-failure':
    case 'unexpected-error':
      return EXIT_FAILURE;
  }
}

/** What the CLI observed about the run, beyond the run's own result. */
export interface RunObservations {
  /** The run result, absent when the run never started. */
  result: IngestionRunResult | undefined;
  /** Whether cancellation was requested at any point. */
  cancelled: boolean;
  /**
   * The signal that requested the stop, as observed by the caller.
   *
   * Never inferred: the run result records only that a signal arrived, while
   * the exit code depends on which one.
   */
  signal: CancellingSignal | undefined;
  /** Whether a repository write threw, recorded by the repository wrapper. */
  persistenceFailed: boolean;
}

/**
 * Classifies a finished run.
 *
 * Precedence, in the order an operator would care about:
 *
 * 1. Persistence failure. Articles may be partly written, so this is a failure
 *    regardless of how the sources went.
 * 2. Cancellation. Someone asked for the stop, and the exit code must say so.
 * 3. A deadline that left sources unexecuted. The run did not do what it was
 *    asked even if every source it did reach succeeded, so a zero exit would
 *    mislead the supervisor.
 * 4. The ordinary source outcomes, counted over attempted sources only: a
 *    `skipped` source was never tried, so it is neither success nor failure.
 *
 * A cancellation with no recorded signal is reported as `unexpected-error`
 * rather than guessed into 130 or 143 — an invented signal identity would be
 * indistinguishable from a real one.
 */
export function classifyRun(observations: RunObservations): CliOutcome {
  if (observations.persistenceFailed) {
    return { kind: 'persistence-failure' };
  }

  if (observations.cancelled) {
    if (observations.signal === undefined) {
      return { kind: 'unexpected-error' };
    }
    return { kind: 'cancelled', signal: observations.signal };
  }

  const { result } = observations;
  if (result === undefined) {
    // Not cancelled and no result: the run never produced one, which is a bug
    // rather than a successful no-op.
    return { kind: 'unexpected-error' };
  }

  if (result.stoppedReason === 'deadline') {
    return { kind: 'deadline-exceeded' };
  }

  if (result.stoppedReason === 'signal') {
    // Cancellation should have been observed above; reaching here means the
    // lifecycle and the run disagree, which is not something to report as a
    // specific exit code.
    return { kind: 'unexpected-error' };
  }

  const attempted = result.sources.filter((source) => source.status !== 'skipped');
  const failed = attempted.filter((source) => source.status === 'error');

  if (attempted.length > 0 && failed.length === attempted.length) {
    return { kind: 'all-sources-failed' };
  }

  if (failed.length > 0) {
    return { kind: 'partial' };
  }

  return { kind: 'success' };
}
