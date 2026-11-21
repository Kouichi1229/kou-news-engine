/**
 * Text normalisation applied to every extracted body before it is stored.
 *
 * ## Why NUL removal is not optional
 *
 * SQLite's `length()` on TEXT stops counting at the first U+0000. The frozen
 * schema asserts `content_length = length(content_text)`, so a body containing a
 * NUL byte would either be rejected (if the application counted code points
 * honestly) or stored with a silently wrong length (if it deferred to SQLite).
 * Both outcomes are wrong. Removing U+0000 here — and enforcing its absence in
 * the schema — is what makes the length assertion trustworthy.
 *
 * A NUL byte in an HTML document is meaningless in the first place: the parser
 * replaces it with U+FFFD. Removing it loses nothing.
 */

/** Control characters kept as-is because they carry layout meaning in text. */
const KEPT_CONTROLS = new Set(['\t', '\n', '\r']);

/**
 * Removes U+0000 and turns other C0 controls into spaces.
 *
 * C1 controls (U+0080–U+009F) are left alone: they appear legitimately in
 * Windows-1252 text and removing them would corrupt the content rather than
 * clean it.
 */
export function stripControlCharacters(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x00) {
      continue;
    }
    if (code < 0x20 && !KEPT_CONTROLS.has(char)) {
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Collapses runs of horizontal whitespace and trims each line.
 *
 * Newlines are preserved because paragraph structure is the main signal the
 * summariser uses; only intra-line spacing is normalised.
 */
export function normaliseWhitespace(input: string): string {
  return input
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Length in Unicode code points.
 *
 * Not `String.length`, which counts UTF-16 code units: an emoji or a rare CJK
 * character would count as 2 and make `MIN_CONTENT_LENGTH` depend on the script
 * rather than on how much text there is.
 */
export function codePointLength(input: string): number {
  return [...input].length;
}

/** The full pipeline: strip controls, normalise whitespace. */
export function normaliseText(input: string): string {
  return normaliseWhitespace(stripControlCharacters(input));
}
