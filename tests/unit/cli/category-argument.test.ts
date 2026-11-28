import { describe, expect, it } from 'vitest';

import { parseCategoryArgument } from '../../../src/cli/category-argument.js';
import { DERIVATION_CATEGORIES } from '../../../src/modules/derivation/derivation.service.js';

/**
 * `--category` parsing, which both notification entry points share.
 *
 * The three rejection messages are asserted by content rather than by whole string:
 * what matters is that each mistake is told apart and that the list is quoted, not
 * the exact prose.
 */
describe('parseCategoryArgument — the unfiltered run', () => {
  it('leaves the arguments untouched when the flag is absent', async () => {
    const result = await parseCategoryArgument(['--execute']);

    expect(result).toEqual({ kind: 'ok', argument: { rest: ['--execute'] } });
  });

  it('reports no category for an empty argument vector', async () => {
    const result = await parseCategoryArgument([]);

    expect(result).toEqual({ kind: 'ok', argument: { rest: [] } });
  });
});

describe('parseCategoryArgument — a named category', () => {
  it('takes the flag and its value out of the arguments', async () => {
    const result = await parseCategoryArgument(['--execute', '--category', '財經']);

    expect(result).toEqual({
      kind: 'ok',
      argument: { rest: ['--execute'], category: '財經' },
    });
  });

  it.each(DERIVATION_CATEGORIES)('accepts %s', async (category) => {
    const result = await parseCategoryArgument(['--category', category]);

    expect(result.kind === 'ok' && result.argument.category).toBe(category);
  });

  it('keeps the arguments that follow the value, so other flags are still checked', async () => {
    const result = await parseCategoryArgument(['--category', '科技', '--frobnicate']);

    expect(result).toEqual({
      kind: 'ok',
      argument: { rest: ['--frobnicate'], category: '科技' },
    });
  });
});

describe('parseCategoryArgument — rejections', () => {
  async function messageOf(argv: readonly string[]): Promise<string> {
    const result = await parseCategoryArgument(argv);
    if (result.kind !== 'error') {
      throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    }
    return result.message;
  }

  it('rejects a label outside the closed list and quotes the list', async () => {
    const message = await messageOf(['--category', '運動']);

    expect(message).toContain('Unknown category "運動"');
    for (const category of DERIVATION_CATEGORIES) {
      expect(message).toContain(category);
    }
  });

  it('rejects an empty value rather than treating it as "no filter"', async () => {
    const message = await messageOf(['--execute', '--category', '']);

    expect(message).toContain('Unknown category ""');
  });

  it('rejects a flag with no value', async () => {
    expect(await messageOf(['--category'])).toContain('needs a value');
  });

  it('rejects a flag whose next token is another flag', async () => {
    expect(await messageOf(['--category', '--execute'])).toContain('needs a value');
  });

  it('rejects the flag given twice instead of guessing which was meant', async () => {
    expect(await messageOf(['--category', '財經', '--category', '科技'])).toContain('only once');
  });

  it('rejects a value with surrounding whitespace, because it is a different label', async () => {
    expect(await messageOf(['--category', ' 財經'])).toContain('Unknown category');
  });
});
