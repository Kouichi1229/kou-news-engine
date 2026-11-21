/**
 * A fetch or parse failed in a way that maps to a stored `failure_code`.
 *
 * Carrying the code on the error rather than deriving it from the message keeps
 * the stored value independent of wording: a test asserting `SSRF_BLOCKED` does
 * not break when a message is rephrased.
 */
export class ExtractionFailureError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(code: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'ExtractionFailureError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * A URL was rejected before any request was sent.
 *
 * Separate from `ExtractionFailureError` so callers can tell "we refused to
 * try" from "the attempt failed": the former is permanent and must never be
 * retried, the latter may be.
 */
export class UnsafeUrlError extends ExtractionFailureError {
  constructor(code: string, message: string) {
    super(code, message, null);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * The lease token no longer matches, so this worker lost the claim.
 *
 * Never retried and never treated as success: another worker owns the row and
 * may already have written a real result.
 */
export class LostClaimError extends Error {
  readonly articleId: string;

  constructor(articleId: string) {
    super(`Lost the claim on article ${articleId}; another worker owns it`);
    this.name = 'LostClaimError';
    this.articleId = articleId;
  }
}

/** The response body exceeded `MAX_RESPONSE_BYTES`. */
export class ResponseTooLargeError extends ExtractionFailureError {
  constructor(maxBytes: number) {
    super('RESPONSE_TOO_LARGE', `Response exceeded the ${maxBytes} byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

/** The request exceeded `REQUEST_TIMEOUT_MS`. */
export class RequestTimeoutError extends ExtractionFailureError {
  constructor(timeoutMs: number) {
    super('TIMEOUT', `Request exceeded the ${timeoutMs} ms timeout`);
    this.name = 'RequestTimeoutError';
  }
}
