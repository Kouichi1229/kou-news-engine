import { createHash } from 'node:crypto';

/**
 * Separates the fields inside the hashed payload.
 *
 * A NUL byte cannot appear in feed text, so `('ab', 'c')` and `('a', 'bc')`
 * hash differently instead of colliding through ambiguous concatenation.
 */
const FIELD_SEPARATOR = '\u0000';

export interface ContentHashInput {
  /** Normalized title key. */
  titleKey: string;
  /** Plain-text summary, when the feed supplies one. */
  summaryText?: string;
}

/**
 * SHA-256 hex digest of the normalized content.
 *
 * This is a comparator and tie-breaker only. It is never a merge rule: two
 * records with equal content are not automatically the same article.
 */
export function contentHash(input: ContentHashInput): string {
  const payload = `${input.titleKey}${FIELD_SEPARATOR}${input.summaryText ?? ''}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
