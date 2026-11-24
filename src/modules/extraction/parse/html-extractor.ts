import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

import { MIN_CONTENT_LENGTH } from '../extraction.constants.js';

import { codePointLength, normaliseText } from './text-normaliser.js';

/** What parsing a document produced. */
export interface ParsedArticle {
  text: string;
  length: number;
}

/**
 * Extracts the main article body from an HTML document.
 *
 * ## Safety properties
 *
 * - `runScripts` is left at its default (`undefined`), so no page script runs.
 * - `resources` is left undefined, so jsdom fetches nothing: no images, no
 *   stylesheets, no iframes, no subresources. A page therefore cannot make this
 *   process issue a request to a host the SSRF guard never saw.
 * - `VirtualConsole` is created and discarded so jsdom's own parse errors do not
 *   reach the process stdout as noise.
 *
 * Returns `null` when no usable article body was found, which the caller records
 * as `empty`/`NO_CONTENT` rather than as a failure.
 */
export function extractArticleBody(html: string, url: string): ParsedArticle | null {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url,
    virtualConsole,
  });

  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article === null) {
      return null;
    }

    const text = normaliseText(article.textContent ?? '');
    if (text === '') {
      return null;
    }

    return { text, length: codePointLength(text) };
  } finally {
    // Releases the window's timers and listeners; without it a long CLI run
    // accumulates one leaked window per article.
    dom.window.close();
  }
}

/** True when a parsed body is long enough to count as real content. */
export function meetsMinimumLength(length: number): boolean {
  return length >= MIN_CONTENT_LENGTH;
}
