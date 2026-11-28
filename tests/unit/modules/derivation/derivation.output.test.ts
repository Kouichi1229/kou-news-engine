import { describe, expect, it } from 'vitest';

import {
  DERIVATION_CATEGORIES,
  DERIVATION_LIMITS,
  DerivationError,
  parseDerivationOutput,
} from '../../../../src/modules/derivation/derivation.service.js';

/**
 * The output contract, exercised as a pure function.
 *
 * Nothing here touches a database, a network or the clock: these cases are about
 * which strings are allowed through, and the service-level tests in
 * `tests/integration/derivation` cover what happens to the ones that are.
 */
const SUMMARY_ZH = '台'.repeat(DERIVATION_LIMITS.minSummaryChars);

/**
 * A completion as the prompt asks for it, with `category` defaulted.
 *
 * The default lets a case override it to prove a bad label is rejected, while every
 * other case stays about the field it names.
 */
function reply(fields: Record<string, unknown>): string {
  return JSON.stringify({ category: '財經', ...fields });
}

function parseFailure(raw: string): unknown {
  try {
    parseDerivationOutput(raw);
  } catch (error) {
    return error;
  }
  throw new Error('expected parseDerivationOutput to throw');
}

describe('parseDerivationOutput — accepted output', () => {
  it('returns a normal Traditional Chinese title and summary', () => {
    const result = parseDerivationOutput(
      reply({ title_zh: '台積電公布第三季財報', summary_zh: SUMMARY_ZH }),
    );

    expect(result).toEqual({
      titleZh: '台積電公布第三季財報',
      summaryZh: SUMMARY_ZH,
      category: '財經',
    });
  });

  it('strips surrounding whitespace from both fields', () => {
    const result = parseDerivationOutput(
      reply({ title_zh: '  台積電公布第三季財報\n', summary_zh: `\t${SUMMARY_ZH}  ` }),
    );

    expect(result).toEqual({
      titleZh: '台積電公布第三季財報',
      summaryZh: SUMMARY_ZH,
      category: '財經',
    });
  });

  it('accepts a fenced JSON block', () => {
    const result = parseDerivationOutput(
      '```json\n' + reply({ title_zh: '標題', summary_zh: SUMMARY_ZH }) + '\n```',
    );

    expect(result.titleZh).toBe('標題');
  });
});

describe('parseDerivationOutput — the category', () => {
  it.each(DERIVATION_CATEGORIES)('accepts the fixed label %s', (category) => {
    const result = parseDerivationOutput(
      reply({ title_zh: '標題', summary_zh: SUMMARY_ZH, category }),
    );

    expect(result.category).toBe(category);
  });

  it('keeps the label the model chose, not a default', () => {
    const result = parseDerivationOutput(
      reply({ title_zh: '標題', summary_zh: SUMMARY_ZH, category: '體育' }),
    );

    expect(result.category).toBe('體育');
  });

  it('rejects a label outside the list', () => {
    const error = parseFailure(
      reply({ title_zh: '標題', summary_zh: SUMMARY_ZH, category: '運動' }),
    );

    expect(error).toBeInstanceOf(DerivationError);
    expect(error).toMatchObject({ reason: 'invalid-output' });
  });

  it('rejects a missing category rather than storing an unclassified record', () => {
    const error = parseFailure(JSON.stringify({ title_zh: '標題', summary_zh: SUMMARY_ZH }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
  });

  it('rejects a label in another language even when it means the same thing', () => {
    // 'Technology' is the right idea and still not a value of this closed list.
    const error = parseFailure(
      reply({ title_zh: '標題', summary_zh: SUMMARY_ZH, category: 'Technology' }),
    );

    expect(error).toMatchObject({ reason: 'invalid-output' });
  });
});

describe('parseDerivationOutput — rejected output', () => {
  it('rejects an empty title', () => {
    const error = parseFailure(reply({ title_zh: '', summary_zh: SUMMARY_ZH }));

    expect(error).toBeInstanceOf(DerivationError);
    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('title_zh');
  });

  it('rejects a title made only of whitespace', () => {
    const error = parseFailure(reply({ title_zh: '   \n\t ', summary_zh: SUMMARY_ZH }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('title_zh');
  });

  it('rejects an empty summary', () => {
    const error = parseFailure(reply({ title_zh: '標題', summary_zh: '' }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('summary_zh');
  });

  it('rejects a summary made only of whitespace', () => {
    const error = parseFailure(reply({ title_zh: '標題', summary_zh: '  \n  ' }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('summary_zh');
  });

  it('rejects output missing the title field', () => {
    const error = parseFailure(reply({ summary_zh: SUMMARY_ZH }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('title_zh');
  });

  it('rejects output missing the summary field', () => {
    const error = parseFailure(reply({ title_zh: '標題' }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('summary_zh');
  });

  it('rejects a field of the wrong type', () => {
    const error = parseFailure(reply({ title_zh: '標題', summary_zh: 123 }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
  });

  it('rejects a title longer than the cap once trimmed', () => {
    const padded = `  ${'長'.repeat(DERIVATION_LIMITS.maxTitleChars + 1)}  `;
    const error = parseFailure(reply({ title_zh: padded, summary_zh: SUMMARY_ZH }));

    expect(error).toMatchObject({ reason: 'invalid-output' });
    expect((error as Error).message).toContain('title_zh');
  });
});
