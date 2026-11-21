import { describe, expect, it } from 'vitest';

import {
  classifyRun,
  EXIT_FAILURE,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_SUCCESS,
  exitCodeForOutcome,
  type CliOutcome,
  type RunObservations,
} from '../../../src/cli/exit-codes.js';
import type {
  IngestionRunResult,
  SourceRunResult,
} from '../../../src/modules/ingestion/ingestion.types.js';

function okSource(sourceId: string): SourceRunResult {
  return { sourceId, status: 'ok', itemCount: 1, recordCount: 1, skippedCount: 0 };
}

function failedSource(sourceId: string): SourceRunResult {
  return {
    sourceId,
    status: 'error',
    itemCount: 0,
    recordCount: 0,
    skippedCount: 0,
    error: { code: 'FEED_FETCH_FAILED', message: 'boom' },
  };
}

function skippedSource(sourceId: string): SourceRunResult {
  return {
    sourceId,
    status: 'skipped',
    itemCount: 0,
    recordCount: 0,
    skippedCount: 0,
    skipReason: 'deadline',
  };
}

function runResult(
  sources: SourceRunResult[],
  stoppedReason?: 'deadline' | 'signal',
): IngestionRunResult {
  return {
    startedAt: '2026-11-19T00:00:00.000Z',
    finishedAt: '2026-11-19T00:00:05.000Z',
    sources,
    articleCount: 0,
    possibleDuplicateCount: 0,
    ...(stoppedReason === undefined ? {} : { stoppedReason }),
  };
}

function observations(overrides: Partial<RunObservations> = {}): RunObservations {
  return {
    result: runResult([okSource('a')]),
    cancelled: false,
    signal: undefined,
    persistenceFailed: false,
    ...overrides,
  };
}

describe('exitCodeForOutcome — the published contract', () => {
  // One case per row of the approved table. Written as a table so a changed
  // number is visible as a changed expectation rather than a moved assertion.
  const cases: Array<[string, CliOutcome, number]> = [
    ['all sources succeed', { kind: 'success' }, 0],
    ['partial source success', { kind: 'partial' }, 0],
    ['all sources fail', { kind: 'all-sources-failed' }, 1],
    ['persistence failure', { kind: 'persistence-failure' }, 1],
    ['deadline leaves sources unexecuted', { kind: 'deadline-exceeded' }, 1],
    ['SIGINT cancellation', { kind: 'cancelled', signal: 'SIGINT' }, 130],
    ['SIGTERM cancellation', { kind: 'cancelled', signal: 'SIGTERM' }, 143],
    ['runtime initialization failure', { kind: 'initialization-failure' }, 1],
    ['unexpected error', { kind: 'unexpected-error' }, 1],
  ];

  for (const [name, outcome, expected] of cases) {
    it(`maps ${name} to ${String(expected)}`, () => {
      expect(exitCodeForOutcome(outcome)).toBe(expected);
    });
  }

  it('keeps the named constants equal to the table values', () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_FAILURE).toBe(1);
    expect(EXIT_SIGINT).toBe(130);
    expect(EXIT_SIGTERM).toBe(143);
  });

  it('distinguishes the two cancellation signals', () => {
    // The whole reason the signal identity is recorded: these must not collapse
    // to one code.
    expect(exitCodeForOutcome({ kind: 'cancelled', signal: 'SIGINT' })).not.toBe(
      exitCodeForOutcome({ kind: 'cancelled', signal: 'SIGTERM' }),
    );
  });
});

describe('classifyRun — source outcomes', () => {
  it('reports success when every attempted source succeeded', () => {
    expect(
      classifyRun(observations({ result: runResult([okSource('a'), okSource('b')]) })),
    ).toEqual({ kind: 'success' });
  });

  it('reports partial when some sources succeeded and some failed', () => {
    expect(
      classifyRun(observations({ result: runResult([okSource('a'), failedSource('b')]) })),
    ).toEqual({ kind: 'partial' });
  });

  it('reports all-sources-failed when every attempted source failed', () => {
    expect(
      classifyRun(observations({ result: runResult([failedSource('a'), failedSource('b')]) })),
    ).toEqual({ kind: 'all-sources-failed' });
  });

  it('reports all-sources-failed for a single failed source', () => {
    expect(classifyRun(observations({ result: runResult([failedSource('a')]) }))).toEqual({
      kind: 'all-sources-failed',
    });
  });

  it('reports success for a run with no sources at all', () => {
    // Nothing was attempted and nothing failed. Treating an empty registry as a
    // failure would make a misconfigured-but-harmless run indistinguishable from
    // a broken one.
    expect(classifyRun(observations({ result: runResult([]) }))).toEqual({ kind: 'success' });
  });

  it('does not count a skipped source as a failure', () => {
    // One source succeeded, one was never attempted: this is a deadline stop,
    // which is reported separately, never as `partial`.
    const outcome = classifyRun(
      observations({ result: runResult([okSource('a'), skippedSource('b')], 'deadline') }),
    );
    expect(outcome).toEqual({ kind: 'deadline-exceeded' });
  });
});

describe('classifyRun — deadline', () => {
  it('reports deadline-exceeded even when every attempted source succeeded', () => {
    // The important case: a run that did well on what it reached still did not
    // finish the job, so exiting 0 would mislead the supervisor.
    const outcome = classifyRun(
      observations({ result: runResult([okSource('a'), skippedSource('b')], 'deadline') }),
    );
    expect(outcome).toEqual({ kind: 'deadline-exceeded' });
    expect(exitCodeForOutcome(outcome)).toBe(EXIT_FAILURE);
  });

  it('reports deadline-exceeded when no source ran at all', () => {
    const outcome = classifyRun(
      observations({ result: runResult([skippedSource('a')], 'deadline') }),
    );
    expect(outcome).toEqual({ kind: 'deadline-exceeded' });
  });
});

describe('classifyRun — cancellation', () => {
  it('reports the SIGINT identity when one was observed', () => {
    expect(classifyRun(observations({ cancelled: true, signal: 'SIGINT' }))).toEqual({
      kind: 'cancelled',
      signal: 'SIGINT',
    });
  });

  it('reports the SIGTERM identity when one was observed', () => {
    expect(classifyRun(observations({ cancelled: true, signal: 'SIGTERM' }))).toEqual({
      kind: 'cancelled',
      signal: 'SIGTERM',
    });
  });

  it('never guesses a signal identity when none was recorded', () => {
    // Cancelled but no signal known: reporting 130 or 143 here would be an
    // invention indistinguishable from a real observation.
    const outcome = classifyRun(observations({ cancelled: true, signal: undefined }));
    expect(outcome).toEqual({ kind: 'unexpected-error' });
    expect(exitCodeForOutcome(outcome)).toBe(EXIT_FAILURE);
  });

  it('prefers cancellation over a result that also reports failed sources', () => {
    const outcome = classifyRun(
      observations({
        cancelled: true,
        signal: 'SIGINT',
        result: runResult([failedSource('a')]),
      }),
    );
    expect(outcome).toEqual({ kind: 'cancelled', signal: 'SIGINT' });
  });

  it('reports an unexpected error when the run stopped on a signal but no cancellation was observed', () => {
    // The lifecycle and the run disagree; inventing a specific code would hide
    // that from the operator.
    const outcome = classifyRun(observations({ result: runResult([okSource('a')], 'signal') }));
    expect(outcome).toEqual({ kind: 'unexpected-error' });
  });
});

describe('classifyRun — persistence and missing results', () => {
  it('reports persistence-failure regardless of source outcomes', () => {
    const outcome = classifyRun(
      observations({ persistenceFailed: true, result: runResult([okSource('a')]) }),
    );
    expect(outcome).toEqual({ kind: 'persistence-failure' });
    expect(exitCodeForOutcome(outcome)).toBe(EXIT_FAILURE);
  });

  it('prefers persistence-failure over cancellation', () => {
    // A partly written batch is the more urgent fact: it needs an operator.
    const outcome = classifyRun(
      observations({ persistenceFailed: true, cancelled: true, signal: 'SIGINT' }),
    );
    expect(outcome).toEqual({ kind: 'persistence-failure' });
  });

  it('reports an unexpected error when there is no result and no cancellation', () => {
    expect(classifyRun(observations({ result: undefined }))).toEqual({
      kind: 'unexpected-error',
    });
  });
});
