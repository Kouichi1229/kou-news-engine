/**
 * Deterministic key used to report articles that look alike but were not merged.
 *
 * This is a *reporting* signal only. It must never be used as a merge rule:
 * merging on title similarity would destroy distinct articles.
 *
 * Punctuation and symbols are replaced with spaces so that `GPT-5` and `GPT 5`
 * produce the same key. `toLowerCase()` is used rather than `toLocaleLowerCase()`
 * so the result does not depend on the host locale (Turkish dotless i).
 *
 * Combining marks (`\p{M}`) are kept: they are part of the letter, not
 * punctuation. Dropping them would silently change text written in decomposed
 * form, so `e` + U+0301 stays intact instead of collapsing to `e`.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
