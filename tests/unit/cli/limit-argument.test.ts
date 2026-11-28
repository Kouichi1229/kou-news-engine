import { describe, expect, it } from 'vitest';

import { parseLimitArgument } from '../../../src/cli/limit-argument.js';

/** `extract --limit <n>` parsing. Range bounds are asserted by value, not prose. */
describe('parseLimitArgument — the default run', () => {
  it('leaves the arguments untouched when the flag is absent', () => {
    expect(parseLimitArgument(['--execute'])).toEqual({
      kind: 'ok',
      argument: { rest: ['--execute'] },
    });
  });

  it('reports no limit for an empty argument vector', () => {
    expect(parseLimitArgument([])).toEqual({ kind: 'ok', argument: { rest: [] } });
  });
});

describe('parseLimitArgument — an explicit limit', () => {
  it('takes the flag and its value out of the arguments', () => {
    expect(parseLimitArgument(['--execute', '--limit', '3'])).toEqual({
      kind: 'ok',
      argument: { rest: ['--execute'], limit: 3 },
    });
  });

  it('accepts the documented bounds', () => {
    expect(parseLimitArgument(['--limit', '1'])).toMatchObject({ argument: { limit: 1 } });
    expect(parseLimitArgument(['--limit', '100'])).toMatchObject({ argument: { limit: 100 } });
  });

  it('keeps the arguments that follow the value, so other flags are still checked', () => {
    expect(parseLimitArgument(['--limit', '2', '--frobnicate'])).toEqual({
      kind: 'ok',
      argument: { rest: ['--frobnicate'], limit: 2 },
    });
  });
});

describe('parseLimitArgument — rejections', () => {
  function messageOf(argv: readonly string[]): string {
    const result = parseLimitArgument(argv);
    if (result.kind !== 'error') {
      throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    }
    return result.message;
  }

  it('rejects a flag with no value', () => {
    expect(messageOf(['--limit'])).toContain('needs a value');
  });

  it('rejects a flag whose next token is another flag', () => {
    expect(messageOf(['--limit', '--execute'])).toContain('needs a value');
  });

  it('rejects the flag given twice', () => {
    expect(messageOf(['--limit', '2', '--limit', '3'])).toContain('only once');
  });

  it.each(['0', '-1', '101', '2.5', 'abc', ''])('rejects the value %j', (value) => {
    expect(messageOf(['--limit', value])).toContain('must be a whole number');
  });
});
