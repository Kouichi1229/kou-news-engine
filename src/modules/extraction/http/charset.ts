import iconv from 'iconv-lite';

/**
 * Charset detection and decoding for article responses.
 *
 * The priority order is fixed by the I7-1a spec: HTTP `Content-Type` → HTML
 * `<meta>` → BOM → UTF-8. The order matters because each source has a different
 * trust level — the header is the server's claim about this response, `<meta>`
 * is a claim written into the document body, and the BOM is a byte-level fact.
 *
 * `iconv-lite` is used rather than `TextDecoder` because `TextDecoder` only
 * implements the encodings the WHATWG spec requires, which excludes GBK, Big5
 * and Shift_JIS in some Node builds — and Chinese and Japanese news sites still
 * serve those.
 */

/** The encodings this service will decode. Anything else falls back to UTF-8. */
const SUPPORTED = new Set([
  'utf-8',
  'utf8',
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
export type CharsetSource = 'content-type' | 'meta' | 'bom' | 'fallback';

export interface DecodedBody {
  text: string;
  charset: string;
  source: CharsetSource;
}

/**
 * Decodes a response body using the fixed priority order.
 *
 * `iconv-lite` replaces undecodable byte sequences with U+FFFD rather than
 * throwing. That is the right behaviour here: one bad byte in a long article
 * must not discard the whole page, and U+FFFD is a visible marker that the
 * downstream normaliser keeps rather than silently dropping.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): DecodedBody {
  const fromHeader = charsetFromContentType(contentType);
  if (fromHeader !== null) {
    return {
      text: iconv.decode(Buffer.from(bytes), fromHeader),
      charset: fromHeader,
      source: 'content-type',
    };
  }

  const fromBom = charsetFromBom(bytes);
  if (fromBom !== null) {
    return { text: iconv.decode(Buffer.from(bytes), fromBom), charset: fromBom, source: 'bom' };
  }

  const fromMeta = charsetFromMeta(bytes);
  if (fromMeta !== null) {
    return { text: iconv.decode(Buffer.from(bytes), fromMeta), charset: fromMeta, source: 'meta' };
  }

  return { text: iconv.decode(Buffer.from(bytes), 'utf-8'), charset: 'utf-8', source: 'fallback' };
}

/** True when the content type may be parsed as HTML. */
export function isHtmlContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}
