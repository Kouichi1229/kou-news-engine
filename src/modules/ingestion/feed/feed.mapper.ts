import { canonicalizeUrl } from '../dedupe/canonical-url.js';
import type { FeedSource } from '../sources/source.schema.js';
import type { NormalizedRecord } from '../ingestion.types.js';
import type { ParsedFeed, ParsedFeedEntry } from './feed.parser.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export { canonicalizeUrl };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * XML 1.0 legal character ranges (production: Char).
 *
 * Code points outside these ranges are not representable in a well-formed XML
 * document, so a numeric reference to one is left untouched rather than being
 * turned into a malformed or unprintable JavaScript string.
 */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Decodes the five XML predefined entities plus valid numeric character
 * references.
 *
 * The parser runs with `processEntities: false` so that DOCTYPE-declared
 * entities (the XXE / billion-laughs vector) can never be expanded. Decoding is
 * therefore limited to references that are safe by construction. Entity names
 * are case-sensitive, as XML requires: `&AMP;` is not a predefined entity and
 * is left unchanged. HTML entities such as `&nbsp;` are deliberately not
 * supported.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const digits = isHex ? body.slice(2) : body.slice(1);
        const codePoint = Number.parseInt(digits, isHex ? 16 : 10);

        if (!Number.isFinite(codePoint) || !isXmlChar(codePoint)) {
          return match;
        }
        return String.fromCodePoint(codePoint);
      }

      return NAMED_ENTITIES[body] ?? match;
    },
  );
}

/**
 * Converts an HTML fragment to plain text.
 *
 * Entities are decoded before tags are stripped, so entity-encoded markup is
 * removed rather than left as visible text. The result is data, never markup:
 * it is returned to callers as a string and is not rendered as HTML anywhere
 * in this service.
 */
export function stripHtml(value: string): string {
  return decodeXmlEntities(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves an entry link against the configured feed URL.
 *
 * Returns `undefined` when the link is missing, unresolvable, or not http(s) —
 * a feed must never be able to introduce a `javascript:` or `data:` URL.
 */
export function resolveEntryUrl(link: string | undefined, feedUrl: string): string | undefined {
  if (link === undefined || link.trim() === '') {
    return undefined;
  }

  let resolved: URL;
  try {
    resolved = new URL(link.trim(), feedUrl);
  } catch {
    return undefined;
  }

  if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) {
    return undefined;
  }

  return resolved.href;
}

/** Sorts ascending by UTF-16 code unit. `localeCompare` is locale-dependent. */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface MappedFeed {
  records: NormalizedRecord[];
  /** Entries dropped because they had no usable http(s) link. */
  skippedCount: number;
}

function mapEntry(
  entry: ParsedFeedEntry,
  source: FeedSource,
  feedLanguage: string | undefined,
): NormalizedRecord | undefined {
  // The parser leaves entities literal (`processEntities: false`) so DOCTYPE
  // entities can never expand. Only the predefined and numeric references can
  // survive the DOCTYPE ban, so decoding them here restores the real text.
  const originalUrl = entry.link === undefined ? undefined : decodeXmlEntities(entry.link);
  const resolvedUrl = resolveEntryUrl(originalUrl, source.url);
  if (originalUrl === undefined || resolvedUrl === undefined) {
    return undefined;
  }

  const title = entry.title === undefined ? undefined : decodeXmlEntities(entry.title).trim();
  if (title === undefined || title === '') {
    return undefined;
  }

  const record: NormalizedRecord = {
    sourceId: source.id,
    url: originalUrl,
    resolvedUrl,
    canonicalUrl: canonicalizeUrl(resolvedUrl),
    title,
    publishedAt: null,
    publishedAtIsEstimated: true,
  };

  if (entry.guid !== undefined) {
    record.guid = decodeXmlEntities(entry.guid);
  }

  if (entry.summary !== undefined) {
    const raw = decodeXmlEntities(entry.summary);
    record.summaryRaw = raw;
    const text = stripHtml(raw);
    if (text !== '') {
      record.summaryText = text;
    }
  }

  if (entry.publishedRaw !== undefined) {
    record.publishedAtRaw = entry.publishedRaw;
    const timestamp = Date.parse(entry.publishedRaw);
    if (!Number.isNaN(timestamp)) {
      record.publishedAt = new Date(timestamp).toISOString();
      record.publishedAtIsEstimated = false;
    }
  }

  if (entry.author !== undefined) {
    record.author = decodeXmlEntities(entry.author);
  }

  const language = feedLanguage ?? source.defaultLanguage;
  if (language !== '') {
    record.language = language;
  }

  if (entry.categories !== undefined && entry.categories.length > 0) {
    record.tags = normalizeTags(entry.categories.map((tag) => decodeXmlEntities(tag)));
  }

  if (entry.imageUrl !== undefined) {
    const resolvedImage = resolveEntryUrl(decodeXmlEntities(entry.imageUrl), source.url);
    if (resolvedImage !== undefined) {
      record.imageUrl = resolvedImage;
    }
  }

  return record;
}

/**
 * Maps a parsed feed into normalized records for one source.
 *
 * Entries without a usable http(s) link or without a title are skipped
 * individually; one bad entry never fails the whole feed.
 */
export function mapFeedToRecords(feed: ParsedFeed, source: FeedSource): MappedFeed {
  const records: NormalizedRecord[] = [];
  let skippedCount = 0;

  for (const entry of feed.entries) {
    const record = mapEntry(entry, source, feed.language);
    if (record === undefined) {
      skippedCount += 1;
      continue;
    }
    records.push(record);
  }

  return { records, skippedCount };
}
