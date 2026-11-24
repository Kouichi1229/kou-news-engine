import iconv from 'iconv-lite';

/**
 * Charset detection and decoding for article responses.
 *
 * ## Priority order
 *
 * 1. BOM
 * 2. HTTP `Content-Type` `charset` parameter
 * 3. HTML `<meta>` declaration (first 1024 bytes only)
 * 4. UTF-8
 *
 * This matches the WHATWG "determining the character encoding" algorithm, which
 * sniffs the byte order mark before consulting the transport layer. The BOM wins
 * because it is a byte-level fact about how the document was encoded, while the
 * header is only a claim about it. A header that says `utf-8` over bytes that
 * carry a UTF-16 BOM is a misconfiguration, and trusting the header there
 * decodes the whole body into U+FFFD replacement characters.
 *
 * With no BOM the header outranks `<meta>`: the header describes this specific
 * response, whereas `<meta>` is a claim inside the document — and the `<meta>`
 * scan itself assumes an ASCII-compatible encoding, so it cannot be trusted
 * before the encoding is known.
 *
 * `iconv-lite` is used rather than `TextDecoder` because `TextDecoder` only
 * implements the encodings the WHATWG spec requires, which excludes GBK, Big5
 * and Shift_JIS in some Node builds — and Chinese and Japanese news sites still
 * serve those.
 */

/**
 * The encodings this service will decode. Anything else falls back to UTF-8.
 *
 * UTF-16 is listed because the BOM path can select it; listing it here keeps the
 * header path and the BOM path agreeing on what is decodable. A body that
 * declares `charset=utf-16le` must not be rejected by the header path while the
 * identical encoding is accepted via its BOM.
 */
const SUPPORTED = new Set([
  'utf-8',
  'utf8',
  'utf-16le',
  'utf-16be',
  'gbk',
  'gb2312',
  'gb18030',
  'big5',
  'big5-hkscs',
  'shift_jis',
  'shift-jis',
  'sjis',
  'euc-jp',
  'euc-kr',
  'iso-8859-1',
  'latin1',
  'windows-1252',
  'us-ascii',
  'ascii',
]);

function normaliseLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
}

function isSupported(label: string): boolean {
  return SUPPORTED.has(normaliseLabel(label));
}

/**
 * Extracts `charset` from a `Content-Type` header value.
 *
 * Returns `null` rather than guessing when the parameter is absent, so the next
 * source in the priority order gets its turn.
 */
export function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) {
    return null;
  }
  const match = /;\s*charset\s*=\s*("?)([^";]+)\1/i.exec(contentType);
  const label = match?.[2];
  if (label === undefined) {
    return null;
  }
  return isSupported(label) ? normaliseLabel(label) : null;
}

/**
 * Extracts `charset` from an HTML `<meta>` declaration.
 *
 * Only the first 1024 bytes are scanned, which is the range the HTML spec
 * requires user agents to honour; a declaration after that point is not
 * authoritative and is ignored deliberately rather than by accident.
 */
export function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = iconv.decode(bytes.subarray(0, 1024), 'latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head);
  const label = meta?.[1];
  if (label === undefined) {
    return null;
  }
  return isSupported(label) ? normaliseLabel(label) : null;
}

/** Returns the encoding named by a BOM, or `null`. */
export function charsetFromBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }
  return null;
}

/** Where the winning charset came from. Recorded for diagnostics. */
export type CharsetSource = 'bom' | 'content-type' | 'meta' | 'fallback';

export interface DecodedBody {
  text: string;
  charset: string;
  source: CharsetSource;
}

/**
 * Decodes a response body using the WHATWG priority order.
 *
 * `iconv-lite` replaces undecodable byte sequences with U+FFFD rather than
 * throwing. That is the right behaviour here: one bad byte in a long article
 * must not discard the whole page, and U+FFFD is a visible marker that the
 * downstream normaliser keeps rather than silently dropping.
 *
 * `iconv.decode` strips a leading BOM for the encoding it was handed, so the
 * returned `text` never starts with U+FEFF when a BOM selected the encoding.
 * That was verified against the installed version rather than assumed, and a
 * test pins it. U+FEFF elsewhere in the body is left alone: it may be a
 * legitimate zero-width no-break space, and removing it is not this module's job.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): DecodedBody {
  const fromBom = charsetFromBom(bytes);
  if (fromBom !== null) {
    return { text: iconv.decode(Buffer.from(bytes), fromBom), charset: fromBom, source: 'bom' };
  }

  const fromHeader = charsetFromContentType(contentType);
  if (fromHeader !== null) {
    return {
      text: iconv.decode(Buffer.from(bytes), fromHeader),
      charset: fromHeader,
      source: 'content-type',
    };
  }

  const fromMeta = charsetFromMeta(bytes);
  if (fromMeta !== null) {
    return { text: iconv.decode(Buffer.from(bytes), fromMeta), charset: fromMeta, source: 'meta' };
  }

  return { text: iconv.decode(Buffer.from(bytes), 'utf-8'), charset: 'utf-8', source: 'fallback' };
}

/**
 * Fraction of U+FFFD above which a decode is treated as having failed.
 *
 * Chosen from the observed failure mode rather than a guess: decoding UTF-16LE
 * bytes as UTF-8 replaced 6 of 14 characters (~43%) in a short Chinese sample,
 * because every other byte is a NUL-adjacent high byte. A single genuinely
 * corrupt byte in a long article stays far below this. The threshold only needs
 * to separate "wrong encoding" from "a few bad bytes", so a coarse value is
 * enough; it is deliberately not tuned to any particular corpus.
 */
const MOJIBAKE_REPLACEMENT_RATIO = 0.1;

/**
 * True when a decoded body is mostly replacement characters.
 *
 * Used to keep a wrong-encoding decode from being stored as if it were article
 * text. Deliberately a ratio over the whole string rather than a count: a long
 * article with a handful of corrupt bytes is normal, while a mis-decoded body is
 * corrupt throughout.
 */
export function looksMisDecoded(text: string): boolean {
  if (text === '') {
    return false;
  }
  let replacements = 0;
  for (const char of text) {
    if (char === '\uFFFD') {
      replacements += 1;
    }
  }
  return replacements / [...text].length > MOJIBAKE_REPLACEMENT_RATIO;
}

/** True when the content type may be parsed as HTML. */
export function isHtmlContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}
