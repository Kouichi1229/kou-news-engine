import { describe, expect, it } from 'vitest';

import {
  EXIT_FAILURE,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_SUCCESS,
  EXIT_USAGE,
  classifyExtractionRun,
  exitCodeForExtractionOutcome,
} from '../../../src/cli/extraction-exit-codes.js';
import type { ExtractionRunSummary } from '../../../src/modules/extraction/extraction.types.js';

function summary(overrides: Partial<ExtractionRunSummary> = {}): ExtractionRunSummary {
  return {
    claimed: 0,
    extracted: 0,
    empty: 0,
    failed: 0,
    released: 0,
    lostClaims: 0,
    cancelled: false,
    ...overrides,
  };
}

describe('exitCodeForExtractionOutcome', () => {
  it('returns 0 for a successful run', () => {
    expect(exitCodeForExtractionOutcome({ kind: 'success', summary: summary() })).toBe(
      EXIT_SUCCESS,
    );
  });

  it('returns 0 for a successful run that did work', () => {
    expect(
      exitCodeForExtractionOutcome({ kind: 'success', summary: summary({ extracted: 5 }) }),
    ).toBe(EXIT_SUCCESS);
  });

  it('returns 130 for SIGINT', () => {
    expect(
      exitCodeForExtractionOutcome({
        kind: 'cancelled',
        summary: summary({ cancelled: true }),
        signal: 'SIGINT',
      }),
    ).toBe(EXIT_SIGINT);
  });

  it('returns 143 for SIGTERM', () => {
    expect(
      exitCodeForExtractionOutcome({
        kind: 'cancelled',
        summary: summary({ cancelled: true }),
        signal: 'SIGTERM',
      }),
    ).toBe(EXIT_SIGTERM);
  });

  it('returns 1 for a persistence failure', () => {
    expect(exitCodeForExtractionOutcome({ kind: 'persistence-failure' })).toBe(EXIT_FAILURE);
  });

  it('returns 1 for an initialization failure', () => {
    expect(exitCodeForExtractionOutcome({ kind: 'initialization-failure' })).toBe(EXIT_FAILURE);
  });

  it('returns 1 for an unexpected error', () => {
    expect(exitCodeForExtractionOutcome({ kind: 'unexpected-error' })).toBe(EXIT_FAILURE);
  });

  it('treats 130 and 143 as the conventional 128+signal values', () => {
    expect(EXIT_SIGINT).toBe(128 + 2);
    expect(EXIT_SIGTERM).toBe(128 + 15);
  });

  it('reserves 2 for a rejected command line', () => {
    expect(EXIT_USAGE).toBe(2);
    expect(new Set([EXIT_SUCCESS, EXIT_FAILURE, EXIT_USAGE]).size).toBe(3);
  });
});

describe('classifyExtractionRun', () => {
  it('classifies an uncancelled run as success', () => {
    const outcome = classifyExtractionRun(summary(), undefined);
    expect(outcome.kind).toBe('success');
  });

  it('classifies a cancelled run as cancelled and keeps the signal', () => {
    const outcome = classifyExtractionRun(summary({ cancelled: true }), 'SIGINT');
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'cancelled') {
      expect(outcome.signal).toBe('SIGINT');
    }
  });

  it('defaults to SIGTERM when cancelled without a recorded signal', () => {
    const outcome = classifyExtractionRun(summary({ cancelled: true }), undefined);
    if (outcome.kind === 'cancelled') {
      expect(outcome.signal).toBe('SIGTERM');
    }
  });

  it('does not treat lost claims as a failure', () => {
    const outcome = classifyExtractionRun(summary({ lostClaims: 3 }), undefined);
    expect(outcome.kind).toBe('success');
  });
});
