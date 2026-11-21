/** The four terminal/transient states a row may hold. */
export type ExtractionStatus = 'in_progress' | 'extracted' | 'empty' | 'failed';

/**
 * A stored extraction row.
 *
 * `leaseExpiresAt` is epoch milliseconds, matching how it is compared in SQL
 * against `:now`. `extractedAt` is an ISO 8601 string because it is a record of
 * when extraction completed, not a value anything does arithmetic on.
 */
export interface ArticleContent {
  articleId: string;
  status: ExtractionStatus;
  contentText: string | null;
  contentLength: number;
  extractedAt: string | null;
  finalUrl: string | null;
  extractorVersion: string;
  failureCode: string | null;
  httpStatus: number | null;
  attempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
}

/** A claim taken by this worker. */
export interface ClaimedArticle {
  articleId: string;
  /** The fencing token every later write must present. */
  leaseToken: string;
  attempts: number;
  leaseExpiresAt: number;
}

/** What a successful extraction produced, before it is written. */
export interface ExtractionSuccess {
  text: string;
  finalUrl: string;
  httpStatus: number;
  /** ISO 8601 timestamp recorded as `extracted_at`. */
  extractedAt: string;
}

/**
 * Why a fetch or parse produced nothing.
 *
 * `code` is a member of `EMPTY_FAILURE_CODES` when the fetch succeeded but the
 * body was unusable, and any other code when the fetch itself failed. The
 * service uses that distinction to pick `EMPTY` over `FAIL`.
 */
export interface ExtractionFailure {
  code: string;
  httpStatus: number | null;
}

/** Result of one extraction attempt. */
export type ExtractionOutcome =
  | { kind: 'extracted'; value: ExtractionSuccess }
  | { kind: 'empty'; value: ExtractionFailure }
  | { kind: 'failed'; value: ExtractionFailure };

/**
 * Counters for one CLI run.
 *
 * `lostClaims` is tracked separately from `failed` because it means something
 * different: the row was taken over by another worker, so this attempt's result
 * was discarded rather than recorded. Treating it as a plain failure would hide
 * a real fencing event.
 */
export interface ExtractionRunSummary {
  claimed: number;
  extracted: number;
  empty: number;
  failed: number;
  released: number;
  lostClaims: number;
  /** True when a signal stopped the run before the queue was empty. */
  cancelled: boolean;
}
