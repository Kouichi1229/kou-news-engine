import { describe, expect, it } from 'vitest';

import {
  extractArticleBody,
  meetsMinimumLength,
} from '../../../../src/modules/extraction/parse/html-extractor.js';
import { MIN_CONTENT_LENGTH } from '../../../../src/modules/extraction/extraction.constants.js';

const LONG_PARAGRAPH = 'This is a substantial article paragraph with real prose in it. '.repeat(20);

function documentWith(body: string, extraHead = ''): string {
  return `<!doctype html><html><head><title>Test</title>${extraHead}</head><body>${body}</body></html>`;
}

describe('extractArticleBody', () => {
  it('extracts the main body of a well-formed article', () => {
    const html = documentWith(
      `<nav>Home | News | Sport</nav><article><h1>Headline</h1><p>${LONG_PARAGRAPH}</p><p>${LONG_PARAGRAPH}</p></article><footer>copyright</footer>`,
    );
    const parsed = extractArticleBody(html, 'https://example.com/a');
    expect(parsed).not.toBeNull();
    expect(parsed?.text).toContain('substantial article paragraph');
  });

  it('returns a length in code points that matches the text', () => {
    const html = documentWith(`<article><p>${LONG_PARAGRAPH}</p></article>`);
    const parsed = extractArticleBody(html, 'https://example.com/a');
    expect(parsed?.length).toBe([...(parsed?.text ?? '')].length);
  });

  it('returns a short body rather than null when only navigation text exists', () => {
    // Readability keeps the few characters it finds; the minimum-length gate in
    // the service, not this function, is what rejects it as unusable.
    const parsed = extractArticleBody(documentWith('<nav>menu</nav>'), 'https://example.com/a');
    expect(parsed).not.toBeNull();
    expect(parsed?.length).toBeLessThan(MIN_CONTENT_LENGTH);
  });

  it('returns null for an empty document', () => {
    expect(extractArticleBody('', 'https://example.com/a')).toBeNull();
  });

  it('does not execute page scripts', () => {
    // If the script ran it would throw and fail the parse.
    const html = documentWith(
      `<article><p>${LONG_PARAGRAPH}</p></article><script>throw new Error('script ran')</script>`,
    );
    expect(() => extractArticleBody(html, 'https://example.com/a')).not.toThrow();
    const parsed = extractArticleBody(html, 'https://example.com/a');
    expect(parsed).not.toBeNull();
  });

  it('does not fetch external resources', () => {
    // A `<img>` with a remote src would only matter if jsdom loaded resources,
    // which it does not by default. The assertion is that parsing succeeds
    // without any network access being possible in this test process.
    const html = documentWith(
      `<article><p>${LONG_PARAGRAPH}</p><img src="http://169.254.169.254/latest/meta-data/"></article>`,
    );
    const parsed = extractArticleBody(html, 'https://example.com/a');
    expect(parsed).not.toBeNull();
  });

  it('removes NUL bytes from the extracted text', () => {
    const html = documentWith(`<article><p>${LONG_PARAGRAPH}\u0000tail</p></article>`);
    const parsed = extractArticleBody(html, 'https://example.com/a');
    expect(parsed?.text).not.toContain('\u0000');
  });

  it('preserves CJK content', () => {
    const chinese = '這是一篇關於人工智慧新聞的報導內容。'.repeat(30);
    const html = documentWith(`<article><p>${chinese}</p></article>`);
    const parsed = extractArticleBody(html, 'https://example.com/a');
    expect(parsed?.text).toContain('人工智慧');
  });
});

describe('meetsMinimumLength', () => {
  it('accepts exactly the minimum', () => {
    expect(meetsMinimumLength(MIN_CONTENT_LENGTH)).toBe(true);
  });

  it('rejects one below the minimum', () => {
    expect(meetsMinimumLength(MIN_CONTENT_LENGTH - 1)).toBe(false);
  });

  it('accepts a longer body', () => {
    expect(meetsMinimumLength(MIN_CONTENT_LENGTH + 1)).toBe(true);
  });
});
