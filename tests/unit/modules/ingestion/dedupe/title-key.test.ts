import { describe, expect, it } from 'vitest';

import { titleKey } from '../../../../../src/modules/ingestion/dedupe/title-key.js';

describe('titleKey', () => {
  it('lowercases the title', () => {
    expect(titleKey('OpenAI Announces GPT')).toBe('openai announces gpt');
  });

  it('replaces punctuation with spaces so hyphenated and spaced forms agree', () => {
    expect(titleKey('GPT-5')).toBe(titleKey('GPT 5'));
    expect(titleKey('GPT-5')).toBe('gpt 5');
  });

  it('collapses runs of whitespace to a single space', () => {
    expect(titleKey('a   b\t\nc')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(titleKey('  hello world  ')).toBe('hello world');
  });

  it('strips surrounding punctuation', () => {
    expect(titleKey('“Hello, World!”')).toBe('hello world');
  });

  it('preserves digits', () => {
    expect(titleKey('GPT-5 released in 2026')).toBe('gpt 5 released in 2026');
  });

  it('preserves non-ASCII letters', () => {
    expect(titleKey('Über Künstliche Intelligenz')).toBe('über künstliche intelligenz');
  });

  it('preserves CJK text', () => {
    expect(titleKey('人工智慧新聞')).toBe('人工智慧新聞');
  });

  it('returns an empty string for empty input', () => {
    expect(titleKey('')).toBe('');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(titleKey('   \t\n ')).toBe('');
  });

  it('returns an empty string when the title is only punctuation', () => {
    expect(titleKey('--- !!! ???')).toBe('');
  });

  it('treats a case-only difference as the same key', () => {
    expect(titleKey('Breaking News')).toBe(titleKey('BREAKING NEWS'));
  });

  it('distinguishes titles whose words differ', () => {
    expect(titleKey('AI wins')).not.toBe(titleKey('AI loses'));
  });

  it('distinguishes titles whose word order differs', () => {
    expect(titleKey('model release')).not.toBe(titleKey('release model'));
  });

  it('is idempotent', () => {
    const once = titleKey('GPT-5: The Next Model!');

    expect(titleKey(once)).toBe(once);
  });

  it('is not locale-sensitive for the letter I', () => {
    // A Turkish locale would map 'I' to a dotless 'ı'; code-unit lowercasing must not.
    expect(titleKey('I')).toBe('i');
    expect(titleKey('II')).toBe('ii');
  });

  it('keeps a combining acute accent instead of deleting it', () => {
    // 'e' + U+0301 COMBINING ACUTE ACCENT. The mark is part of the letter, so
    // dropping it as punctuation would silently rewrite the text.
    const key = titleKey('cafe\u0301');

    expect(key).toBe('cafe\u0301');
    expect(key).toContain('\u0301');
  });

  it('does not normalize a decomposed form into its precomposed form', () => {
    // No NFC/NFKC is applied, so the two encodings stay distinguishable.
    const precomposed = titleKey('caf\u00e9');
    const decomposed = titleKey('cafe\u0301');

    expect(precomposed).toBe('caf\u00e9');
    expect(decomposed).toBe('cafe\u0301');
    expect(precomposed).not.toBe(decomposed);
    expect([...precomposed]).toHaveLength(4);
    expect([...decomposed]).toHaveLength(5);
  });

  it('keeps combining marks attached to non-Latin base letters', () => {
    // Devanagari 'क' + U+093F vowel sign, and Hebrew 'א' + U+05B7.
    expect(titleKey('\u0915\u093f')).toBe('\u0915\u093f');
    expect(titleKey('\u05d0\u05b7')).toBe('\u05d0\u05b7');
  });

  it('keeps combining marks while still splitting adjacent punctuation', () => {
    expect(titleKey('cafe\u0301, au lait')).toBe('cafe\u0301 au lait');
  });

  it('keeps a mark-only string, which is no longer an empty key', () => {
    // Behavior change from adding \p{M}: combining marks alone are retained, so
    // such a title now produces a non-empty key and can be reported as a
    // possible duplicate. Punctuation-only titles remain empty (tested above).
    expect(titleKey('\u0301\u0301')).toBe('\u0301\u0301');
    expect(titleKey('\u0301\u0301')).not.toBe('');
  });
});
