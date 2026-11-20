import type { ArticleSourceReference } from '../../../types/article.js';

/**
 * Provenance identity, as used by `article_sources`.
 *
 * Identity is `(article_id, source_id, canonical_url, guid_key)`; the article
 * id scopes every row, so it is not repeated here. Two references with the same
 * identity describe the same stored row.
 */

/**
 * Encodes a GUID so that "no GUID" and "empty GUID" stay distinguishable while
 * remaining comparable as a single column.
 *
 * A nullable `guid` column cannot carry this: SQL treats `NULL != NULL`, so a
 * unique index over it accepts unlimited rows for the no-GUID case. The `N:`
 * sentinel is unreachable from a real GUID because every supplied value is
 * prefixed with `V:`, which keeps the mapping injective.
 *
 * The GUID itself is never trimmed or normalised — feeds treat it as an opaque
 * token, and rewriting it would silently merge identities the feed reports as
 * distinct.
 */
export function toGuidKey(guid: string | undefined): string {
  return guid === undefined ? 'N:' : `V:${guid}`;
}

/**
 * Stable identity key for a source reference.
 *
 * `JSON.stringify` of a tuple is used rather than delimiter concatenation: a
 * joined string is ambiguous whenever a field can contain the delimiter, and
 * `sourceId` / `canonicalUrl` are arbitrary text. JSON escaping makes the
 * encoding injective for every string, including ones containing NUL.
 */
export function sourceIdentityKey(source: ArticleSourceReference): string {
  return JSON.stringify([source.sourceId, source.canonicalUrl, toGuidKey(source.guid)]);
}

/**
 * Collapses references that share an identity, keeping first position and last
 * value.
 *
 * The ingestion layer can legitimately emit the same identity twice — two feed
 * entries with one canonical URL and one GUID, differing only in a tracking
 * parameter. Storing both would violate the identity index and leave a gap in
 * `source_order`, so they are merged here instead.
 *
 * Position comes from the first occurrence, which keeps the primary reference
 * (index 0) and the overall order stable. Values come from the last occurrence,
 * matching the "later record wins" behaviour of the upsert. `first_seen_at` is
 * not part of `ArticleSourceReference` and is assigned by the repository, so
 * normalisation cannot disturb it.
 *
 * The inputs are not mutated, and a fresh object is returned for every kept
 * reference so callers cannot observe aliasing.
 */
export function normalizeSourceReferences(
  sources: readonly ArticleSourceReference[],
): ArticleSourceReference[] {
  const positions = new Map<string, number>();
  const merged: ArticleSourceReference[] = [];

  for (const source of sources) {
    const key = sourceIdentityKey(source);
    const existing = positions.get(key);

    if (existing === undefined) {
      positions.set(key, merged.length);
      merged.push(copyReference(source));
      continue;
    }

    // Same identity: keep the earlier slot, take this record's values.
    merged[existing] = copyReference(source);
  }

  return merged;
}

/** Copies every present field, preserving the absent/present distinction on `guid`. */
function copyReference(source: ArticleSourceReference): ArticleSourceReference {
  const copy: ArticleSourceReference = {
    sourceId: source.sourceId,
    url: source.url,
    resolvedUrl: source.resolvedUrl,
    canonicalUrl: source.canonicalUrl,
  };
  if (source.guid !== undefined) {
    copy.guid = source.guid;
  }
  return copy;
}
