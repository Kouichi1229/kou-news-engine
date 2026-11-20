/**
 * One preserved record of a feed entry that contributed to an article.
 *
 * There may be more than one record for the same `sourceId` — for example two
 * entries sharing a GUID but exposing different URLs, or records whose
 * canonical URLs collapse to the same article. Records are never overwritten
 * or discarded while merging.
 */
export interface ArticleSourceReference {
  /** Configured source that contributed this record. */
  sourceId: string;
  /** Original URL exactly as supplied by the feed entry; may be relative. */
  url: string;
  /** Absolute URL resolved against the feed's own URL. */
  resolvedUrl: string;
  /** Canonical form of `resolvedUrl`, used for deduplication. */
  canonicalUrl: string;
  /** The entry's `<guid>` / Atom `<id>`, verbatim, when the feed provides one. */
  guid?: string;
}

export interface Article {
  /** Derived from the primary record's `canonicalUrl` as `a1:<sha256 hex>`. */
  id: string;

  /** Original title, verbatim. Never translated or overwritten. */
  title: string;
  /** Feed summary field as yielded by the XML parser (CDATA already unwrapped). */
  summaryRaw?: string;
  /** Plain-text derivation of `summaryRaw`; the input for later translation. */
  summaryText?: string;

  /** Primary record's `resolvedUrl` — an absolute, usable URL. */
  url: string;
  /** Primary record's `canonicalUrl`. */
  canonicalUrl: string;

  /** ISO 8601 UTC, or `null` when the feed supplies no usable date. */
  publishedAt: string | null;
  /** True when no valid publication date could be parsed. */
  publishedAtIsEstimated: boolean;
  /** Raw publication date string, preserved for provenance. */
  publishedAtRaw?: string;
  /** ISO 8601 UTC timestamp of the ingestion run. */
  fetchedAt: string;

  /** Primary record's GUID, when present. */
  guid?: string;
  author?: string;
  language?: string;
  /** Sorted ascending by UTF-16 code unit; duplicates preserved. */
  tags?: string[];
  imageUrl?: string;

  /** Every contributing record, primary first. */
  sources: ArticleSourceReference[];
}
