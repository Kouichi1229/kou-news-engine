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

/**
 * Outcome of one source in a run.
 *
 * `skipped` exists so a source that was never attempted — because the run was
 * cancelled at a source boundary — cannot be reported as `ok`. Reporting it as
 * `error` would be equally wrong: nothing failed. The distinction matters when
 * reading a run summary, where "no article from this source" needs a cause.
 */
export type SourceRunStatus = 'ok' | 'error' | 'skipped';

/** Why a source was never attempted. */
export type SourceSkipReason = 'deadline' | 'signal';

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
  /**
   * Present only when `status` is `skipped`.
   *
   * Optional so existing run summaries keep their exact shape; a completed
   * source carries no skip reason at all.
   */
  skipReason?: SourceSkipReason;
}

/**
 * Why a run stopped before reaching every source, when it did.
 *
 * Absent on a run that attempted every enabled source. `deadline` and `signal`
 * are reported separately because they call for different operator responses:
 * a repeatedly exhausted deadline means the budget is too small, a signal means
 * someone asked for the stop.
 */
export type IngestionStoppedReason = 'deadline' | 'signal';

export interface IngestionRunResult {
  startedAt: string;
  finishedAt: string;
  sources: SourceRunResult[];
  articleCount: number;
  possibleDuplicateCount: number;
  /** Absent when every enabled source was attempted. */
  stoppedReason?: IngestionStoppedReason;
}
