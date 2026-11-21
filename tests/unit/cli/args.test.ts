import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../../../src/cli/args.js';

/**
 * The parser is the safety boundary: it decides whether a command line may
 * write and fetch. Every rejection case is asserted, not just the happy paths.
 */
describe('parseCliArgs', () => {
  it('previews when no argument is given', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'dry-run' });
  });

  it.each([['--dry-run'], ['--execute']] as const)('accepts %s alone', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ mode: flag === '--execute' ? 'execute' : 'dry-run' });
  });

  it.each([['--help'], ['-h']])('answers %s', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ mode: 'help' });
  });

  it('rejects an unknown argument', () => {
    const result = parseCliArgs(['--frobnicate']);
    expect(result.mode).toBe('usage-error');
  });

  it('names every unknown argument in the message', () => {
    const result = parseCliArgs(['--a', '--b']);
    expect(result).toEqual({ mode: 'usage-error', message: 'Unknown arguments: --a, --b' });
  });

  it('rejects a positional argument, which is never valid', () => {
    expect(parseCliArgs(['extract']).mode).toBe('usage-error');
  });

  it('rejects an unknown argument even when --help is present', () => {
    // The important case: answering `--help` here would report success for a
    // command line the parser did not actually understand.
    const result = parseCliArgs(['--help', '--frobnicate']);
    expect(result.mode).toBe('usage-error');
    if (result.mode === 'usage-error') {
      expect(result.message).toContain('--frobnicate');
    }
  });

  it('rejects --help combined with --execute', () => {
    // Otherwise `--help --execute` could be mistaken for a harmless help call
    // while an operator's script believed it had asked for real work.
    expect(parseCliArgs(['--help', '--execute']).mode).toBe('usage-error');
  });

  it('rejects --help combined with --dry-run', () => {
    expect(parseCliArgs(['--dry-run', '-h']).mode).toBe('usage-error');
  });

  it('rejects two conflicting mode flags', () => {
    const result = parseCliArgs(['--execute', '--dry-run']);
    expect(result.mode).toBe('usage-error');
    if (result.mode === 'usage-error') {
      expect(result.message).toContain('Conflicting');
    }
  });

  it('accepts a repeated identical flag as redundant, not conflicting', () => {
    expect(parseCliArgs(['--execute', '--execute'])).toEqual({ mode: 'execute' });
  });

  it.each([['constructor'], ['toString'], ['hasOwnProperty'], ['__proto__']] as const)(
    'rejects %s, which exists on the prototype chain',
    (argument) => {
      // An object-literal flag table would accept these as known flags and read
      // a function out of it, so the mode would not be a mode at all.
      expect(parseCliArgs([argument]).mode).toBe('usage-error');
    },
  );

  it('never grants execute without the literal --execute token', () => {
    for (const argv of [[], ['--dry-run'], ['-h'], ['--help']] as const) {
      expect(parseCliArgs(argv).mode).not.toBe('execute');
    }
  });
});
