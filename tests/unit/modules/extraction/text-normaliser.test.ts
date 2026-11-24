import { describe, expect, it } from 'vitest';

import {
  codePointLength,
  normaliseText,
  normaliseWhitespace,
  stripControlCharacters,
} from '../../../../src/modules/extraction/parse/text-normaliser.js';

describe('stripControlCharacters', () => {
  it('removes U+0000 entirely rather than replacing it', () => {
    expect(stripControlCharacters('AB\u0000CD')).toBe('ABCD');
  });

  it('removes a leading NUL', () => {
    expect(stripControlCharacters('\u0000AB')).toBe('AB');
  });

  it('removes a NUL that is the whole string', () => {
    expect(stripControlCharacters('\u0000')).toBe('');
  });

  it('removes every NUL in a run', () => {
    expect(stripControlCharacters('A\u0000\u0000\u0000B')).toBe('AB');
  });

  it('keeps TAB, LF and CR because they carry layout meaning', () => {
    expect(stripControlCharacters('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('turns other C0 controls into a single space each', () => {
    expect(stripControlCharacters('a\u0001b\u001fc')).toBe('a b c');
  });

  it('leaves printable text and astral characters untouched', () => {
    expect(stripControlCharacters('繁體中文 😀')).toBe('繁體中文 😀');
  });

  it('leaves C1 controls alone, since Windows-1252 text legitimately contains them', () => {
    expect(stripControlCharacters('a\u0085b')).toBe('a\u0085b');
  });
});

describe('normaliseWhitespace', () => {
  it('collapses intra-line runs to one space and trims each line', () => {
    expect(normaliseWhitespace('  a   b  \n  c  ')).toBe('a b\nc');
  });

  it('collapses three or more newlines to a paragraph break', () => {
    expect(normaliseWhitespace('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normaliseWhitespace('\n\n  x  \n\n')).toBe('x');
  });
});

describe('codePointLength', () => {
  it('counts an emoji as one, unlike String.length', () => {
    expect('😀😀'.length).toBe(4);
    expect(codePointLength('😀😀')).toBe(2);
  });

  it('counts CJK characters one each', () => {
    expect(codePointLength('繁體中文新聞')).toBe(6);
  });

  it('agrees with String.length for ASCII', () => {
    expect(codePointLength('abc')).toBe(3);
  });

  it('is zero for the empty string', () => {
    expect(codePointLength('')).toBe(0);
  });
});

describe('normaliseText', () => {
  it('applies both stages', () => {
    expect(normaliseText('  a\u0000b   c  ')).toBe('ab c');
  });

  it('produces text whose code-point length is what the schema will store', () => {
    const input = '  多行\n\n\n\n內容\u0000  with   spaces  ';
    const output = normaliseText(input);
    expect(output).not.toContain('\u0000');
    expect(codePointLength(output)).toBe([...output].length);
  });
});
