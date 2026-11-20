import type { Article } from '../../types/article.js';

/**
 * A single feed entry after normalization, before cross-entry merging.
 *
 * `fetchedAt` is deliberately absent: it is a property of the ingestion run,
 * not of an individual record.
 */
export interface NormalizedRecord {
  sourceId: string;
  /** Original URL exactly as supplied by the feed entry; may be relative. */
  url: string;
  /** Absolute URL resolved against the feed's own URL. */
  resolvedUrl: string;
  /** Canonical form of `resolvedUrl`. */
  canonicalUrl: string;
  guid?: string;
  title: string;
  summaryRaw?: string;
  summaryText?: string;
  publishedAt: string | null;
  publishedAtIsEstimated: boolean;
  publishedAtRaw?: string;
  author?: string;
  language?: string;
  /** Sorted ascending by UTF-16 code unit; duplicates preserved. */
  tags?: string[];
  imageUrl?: string;
}

/** Articles that share a normalized title key but were not merged. */
export interface PossibleDuplicate {
  titleKey: string;
  articleIds: string[];
  sourceIds: string[];
}

export interface DedupeResult {
  articles: Article[];
  possibleDuplicates: PossibleDuplicate[];
}

export type SourceRunStatus = 'ok' | 'error';

export interface SourceRunResult {
  sourceId: string;
  status: SourceRunStatus;
  /** Entries the feed yielded. */
  itemCount: number;
  /** Records that produced a usable http(s) URL and were kept. */
  recordCount: number;
  /** Entries skipped because they had no usable http(s) link. */
  skippedCount: number;
  error?: { code: string; message: string };
}

export interface IngestionRunResult {
  startedAt: string;
  finishedAt: string;
  sources: SourceRunResult[];
  articleCount: number;
  possibleDuplicateCount: number;
}
