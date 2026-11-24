import { createHash } from 'node:crypto';

import type { Article, ArticleSourceReference } from '../../../types/article.js';
import type { DedupeResult, NormalizedRecord, PossibleDuplicate } from '../ingestion.types.js';
import { contentHash } from './content-hash.js';
import { titleKey } from './title-key.js';

type Cmp = -1 | 0 | 1;

/** UTF-16 code-unit order. Never `localeCompare`, which is locale-dependent. */
function cmpString(a: string, b: string): Cmp {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Absent sorts before present. */
function cmpOptionalString(a: string | undefined, b: string | undefined): Cmp {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  return cmpString(a, b);
}

/** `null` is distinct from `''`: absent sorts before present-but-empty. */
function cmpNullableString(a: string | null, b: string | null): Cmp {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  return cmpString(a, b);
}

/** `false` sorts before `true`. */
function cmpBool(a: boolean, b: boolean): Cmp {
  return a === b ? 0 : a ? 1 : -1;
}

/** Element-wise; a shorter array that is a prefix sorts first; absent sorts first. */
function cmpTags(a: readonly string[] | undefined, b: readonly string[] | undefined): Cmp {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }

  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const result = cmpString(a[index] as string, b[index] as string);
    if (result !== 0) {
      return result;
    }
  }

  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function parseInstant(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * D1 date ordering: earliest valid instant first, null and invalid values last.
 *
 * Two valid dates are equal exactly when their instants are equal, regardless of
 * how the same instant is spelled (`...T10:00:00Z` vs `...T11:00:00+01:00`).
 * Returning 0 lets the next D1 field decide; raw representations are compared
 * only in the fallback.
 */
function cmpPublishedAt(a: string | null, b: string | null): Cmp {
  const left = a === null ? null : parseInstant(a);
  const right = b === null ? null : parseInstant(b);

  if (left === null && right === null) {
    // Both in the last tier: null before an invalid string, then raw order.
    return cmpNullableString(a, b);
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }

  return left === right ? 0 : left < right ? -1 : 1;
}

interface Prepared {
  record: NormalizedRecord;
  hash: string;
}

function hashOf(record: NormalizedRecord): string {
  const key = titleKey(record.title);
  return record.summaryText === undefined
    ? contentHash({ titleKey: key })
    : contentHash({ titleKey: key, summaryText: record.summaryText });
}

/**
 * Total order over records: the D1 primary ordering, then a deterministic
 * fallback covering every remaining field.
 *
 * Two records compare equal only when all fields are equal, which makes them
 * interchangeable — so output never depends on input order and never relies on
 * sort stability.
 */
function comparePrimary(a: Prepared, b: Prepared): Cmp {
  const left = a.record;
  const right = b.record;

  // D1 primary ordering.
  let result = cmpPublishedAt(left.publishedAt, right.publishedAt);
  if (result !== 0) {
    return result;
  }
  result = cmpString(left.sourceId, right.sourceId);
  if (result !== 0) {
    return result;
  }
  result = cmpString(left.canonicalUrl, right.canonicalUrl);
  if (result !== 0) {
    return result;
  }
  result = cmpString(left.url, right.url);
  if (result !== 0) {
    return result;
  }
  result = cmpString(a.hash, b.hash);
  if (result !== 0) {
    return result;
  }

  // Deterministic fallback: only reached when every D1 field ties.
  result = cmpNullableString(left.publishedAt, right.publishedAt);
  if (result !== 0) {
    return result;
  }
  result = cmpString(left.resolvedUrl, right.resolvedUrl);
  if (result !== 0) {
    return result;
  }
  result = cmpString(left.title, right.title);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.guid, right.guid);
  if (result !== 0) {
    return result;
  }
  result = cmpBool(left.publishedAtIsEstimated, right.publishedAtIsEstimated);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.publishedAtRaw, right.publishedAtRaw);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.author, right.author);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.language, right.language);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.summaryRaw, right.summaryRaw);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.summaryText, right.summaryText);
  if (result !== 0) {
    return result;
  }
  result = cmpOptionalString(left.imageUrl, right.imageUrl);
  if (result !== 0) {
    return result;
  }
  return cmpTags(left.tags, right.tags);
}

/** Disjoint-set forest with path compression and union by size. */
class UnionFind {
  private readonly parent: number[];

  private readonly size: number[];

  constructor(count: number) {
    this.parent = Array.from({ length: count }, (_, index) => index);
    this.size = new Array<number>(count).fill(1);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) {
      root = this.parent[root] as number;
    }
    let cursor = index;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor] as number;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) {
      return;
    }

    // Attach the smaller tree under the larger; tie keeps the lower index as root.
    const sizeA = this.size[rootA] as number;
    const sizeB = this.size[rootB] as number;
    if (sizeA < sizeB) {
      this.parent[rootA] = rootB;
      this.size[rootB] = sizeA + sizeB;
    } else {
      this.parent[rootB] = rootA;
      this.size[rootA] = sizeA + sizeB;
    }
  }
}

/** `a1:` plus the SHA-256 hex digest of the primary canonical URL. */
function articleId(canonicalUrl: string): string {
  return `a1:${createHash('sha256').update(canonicalUrl, 'utf8').digest('hex')}`;
}

function toSourceReference(record: NormalizedRecord): ArticleSourceReference {
  const reference: ArticleSourceReference = {
    sourceId: record.sourceId,
    url: record.url,
    resolvedUrl: record.resolvedUrl,
    canonicalUrl: record.canonicalUrl,
  };
  if (record.guid !== undefined) {
    reference.guid = record.guid;
  }
  return reference;
}

function buildArticle(
  primary: NormalizedRecord,
  sources: ArticleSourceReference[],
  fetchedAt: string,
): Article {
  const article: Article = {
    id: articleId(primary.canonicalUrl),
    title: primary.title,
    url: primary.resolvedUrl,
    canonicalUrl: primary.canonicalUrl,
    publishedAt: primary.publishedAt,
    publishedAtIsEstimated: primary.publishedAtIsEstimated,
    fetchedAt,
    sources,
  };

  if (primary.summaryRaw !== undefined) {
    article.summaryRaw = primary.summaryRaw;
  }
  if (primary.summaryText !== undefined) {
    article.summaryText = primary.summaryText;
  }
  if (primary.publishedAtRaw !== undefined) {
    article.publishedAtRaw = primary.publishedAtRaw;
  }
  if (primary.guid !== undefined) {
    article.guid = primary.guid;
  }
  if (primary.author !== undefined) {
    article.author = primary.author;
  }
  if (primary.language !== undefined) {
    article.language = primary.language;
  }
  if (primary.tags !== undefined) {
    article.tags = [...primary.tags];
  }
  if (primary.imageUrl !== undefined) {
    article.imageUrl = primary.imageUrl;
  }

  return article;
}

/**
 * Merges normalized records into articles.
 *
 * Two records join the same article only when they share a canonical URL, or
 * when they share a GUID within the same source. Title and content similarity
 * never merge records; they only feed the `possibleDuplicates` report.
 */
export function dedupeRecords(
  records: readonly NormalizedRecord[],
  fetchedAt: string,
): DedupeResult {
  const prepared: Prepared[] = records.map((record) => ({ record, hash: hashOf(record) }));
  const forest = new UnionFind(prepared.length);

  const firstByCanonicalUrl = new Map<string, number>();
  const firstBySourceGuid = new Map<string, number>();

  prepared.forEach((entry, index) => {
    const { record } = entry;

    const canonicalSeen = firstByCanonicalUrl.get(record.canonicalUrl);
    if (canonicalSeen === undefined) {
      firstByCanonicalUrl.set(record.canonicalUrl, index);
    } else {
      forest.union(canonicalSeen, index);
    }

    if (record.guid !== undefined) {
      const key = `${record.sourceId}\u0000${record.guid}`;
      const guidSeen = firstBySourceGuid.get(key);
      if (guidSeen === undefined) {
        firstBySourceGuid.set(key, index);
      } else {
        forest.union(guidSeen, index);
      }
    }
  });

  const groups = new Map<number, Prepared[]>();
  prepared.forEach((entry, index) => {
    const root = forest.find(index);
    const members = groups.get(root);
    if (members === undefined) {
      groups.set(root, [entry]);
    } else {
      members.push(entry);
    }
  });

  const articles: Article[] = [];
  for (const members of groups.values()) {
    const ordered = [...members].sort(comparePrimary);
    const primary = ordered[0] as Prepared;
    const sources = ordered.map((entry) => toSourceReference(entry.record));
    articles.push(buildArticle(primary.record, sources, fetchedAt));
  }

  articles.sort((a, b) => cmpString(a.id, b.id));

  return { articles, possibleDuplicates: findPossibleDuplicates(articles) };
}

/**
 * Reports articles that share a title key but were not merged.
 *
 * A single article per key is not a duplicate, and an empty key is ignored
 * because it carries no signal.
 */
function findPossibleDuplicates(articles: readonly Article[]): PossibleDuplicate[] {
  const byKey = new Map<string, Article[]>();

  for (const article of articles) {
    const key = titleKey(article.title);
    if (key === '') {
      continue;
    }
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, [article]);
    } else {
      group.push(article);
    }
  }

  const duplicates: PossibleDuplicate[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) {
      continue;
    }

    const articleIds = group.map((article) => article.id).sort(cmpString);
    const sourceIds = [
      ...new Set(group.flatMap((article) => article.sources.map((s) => s.sourceId))),
    ].sort(cmpString);

    duplicates.push({ titleKey: key, articleIds, sourceIds });
  }

  duplicates.sort((a, b) => cmpString(a.titleKey, b.titleKey));
  return duplicates;
}
