/**
 * Frozen extraction constants for I7-1a.
 *
 * These are deliberately not environment variables. Each is a property of the
 * extraction protocol rather than of a deployment: changing `MAX_ATTEMPTS`
 * would change how much traffic this service sends to a third-party site, and
 * changing `EXTRACTOR_VERSION` silently re-queues every stored article. Both
 * belong in code review, not in an operator's `.env`.
 */

/**
 * How long a claim is valid before another worker may take it over.
 *
 * The lease must outlive a single extraction attempt, otherwise a live worker's
 * lease expires while it is still fetching and a second worker starts on the
 * same article.
 *
 * It is **not** derived from a proven upper bound. `REQUEST_TIMEOUT_MS`
 * configures a socket inactivity timeout per request hop, not a strict
 * end-to-end deadline: a server that keeps sending data can hold a request open
 * well past that value. With up to six hops (`MAX_REDIRECTS + 1`), total
 * execution time is therefore not strictly bounded by `6 × REQUEST_TIMEOUT_MS`.
 * The 180 s value is a deliberately generous margin, not a computed worst case.
 *
 * If a stricter bound is ever needed, it must come from an end-to-end deadline
 * in the fetch layer — not from tightening this comment's arithmetic.
 */
export const LEASE_MS = 180_000;

/**
 * Attempts allowed per `(article, extractor_version)` pair.
 *
 * Counted at claim time, so a crash still consumes one: a process that dies
 * mid-request cannot be distinguished from a hostile one, and refunding on
 * crash would make the bound unenforceable.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Version of the extraction pipeline.
 *
 * Bumping this re-queues every article whose row carries an older value.
 * Increment by hand whenever the parser or the normaliser changes enough that
 * previously stored content should be recomputed.
 */
export const EXTRACTOR_VERSION = 'v1';

/**
 * Shortest body, in Unicode code points, that counts as extracted content.
 *
 * Below this the article is recorded as `empty` rather than `extracted`: a
 * paywall stub or a cookie notice is not a useful article, and storing it would
 * make downstream summarisation produce noise.
 */
export const MIN_CONTENT_LENGTH = 200;

/** Per-request timeout, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Hard cap on a response body. Exceeding it aborts the read immediately. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Redirects followed per extraction.
 *
 * Articles commonly move, so redirects must be followed — unlike the feed
 * client, which refuses them. Every hop is re-validated in full.
 */
export const MAX_REDIRECTS = 5;

/** Articles extracted concurrently. One keeps the failure modes simple. */
export const CONCURRENCY = 1;

/** Ports an extraction request may target. */
export const ALLOWED_PORTS: readonly number[] = [80, 443];

/** `failure_code` written while a row is claimed and no outcome is known yet. */
export const PENDING_FAILURE_CODE = 'PENDING';

/**
 * Recorded when the stored body could not be turned into its Chinese title and
 * summary.
 *
 * Transient by design: it is absent from `PERMANENT_FAILURE_CODES`, so the same
 * attempt budget retries it, and a row that reaches `MAX_ATTEMPTS` stops being
 * claimable under the rule every other retryable failure follows.
 */
export const DERIVATION_FAILURE_CODE = 'DERIVATION_FAILED';

/**
 * Failure codes that mean "the fetch succeeded but produced no usable body".
 *
 * These are the only codes allowed on an `empty` row, and the only codes
 * forbidden on a `failed` row. Kept in one place because the schema CHECK and
 * the service both depend on the same set.
 */
export const EMPTY_FAILURE_CODES: readonly string[] = ['NO_CONTENT', 'CONTENT_TOO_SHORT'];

/**
 * Failure codes where retrying cannot help.
 *
 * A `failed` row carrying one of these is never retried at the same extractor
 * version; only a version bump re-queues it.
 */
export const PERMANENT_FAILURE_CODES: readonly string[] = [
  'HTTP_403',
  'HTTP_404',
  'HTTP_410',
  'RESPONSE_TOO_LARGE',
  'TOO_MANY_REDIRECTS',
  'HTTPS_DOWNGRADE',
  'SSRF_BLOCKED',
  'URL_HAS_CREDENTIALS',
  'BAD_PORT',
  'UNSUPPORTED_SCHEME',
  'UNSUPPORTED_CONTENT_TYPE',
  'INVALID_URL',
  'INVALID_REDIRECT',
  'DECODE_FAILED',
];
