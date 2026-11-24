/**
 * LLM error taxonomy and retryability classification.
 *
 * One base class, carrying the kind on the error rather than deriving it from the
 * message, mirroring `ExtractionFailureError`: a test asserting `rate_limit` does
 * not break when a message is rephrased.
 *
 * The provider classifies; the caller decides how many attempts. Retrying is never
 * implemented here, so a retry cannot duplicate a side effect the caller already
 * committed.
 */

export type LlmErrorKind =
  /** Bad or missing config; not retryable. */
  | 'configuration'
  /** Key rejected; not retryable. */
  | 'authentication'
  /** Quota/429; retryable after a delay. */
  | 'rate_limit'
  /** Exceeded the deadline; retryable. */
  | 'timeout'
  /** 5xx or connection failure; retryable. */
  | 'unavailable'
  /** Vendor rejected the request; not retryable. */
  | 'invalid_request'
  /** Vendor returned nothing usable; retryable once. */
  | 'empty_response'
  /** Could not parse what came back; not retryable. */
  | 'invalid_response';

/**
 * The single retryability table.
 *
 * Stored on the error, not derived at the call site, so the classification lives
 * in one place rather than in every caller.
 */
const RETRYABLE_BY_KIND: Readonly<Record<LlmErrorKind, boolean>> = {
  configuration: false,
  authentication: false,
  rate_limit: true,
  timeout: true,
  unavailable: true,
  invalid_request: false,
  empty_response: true,
  invalid_response: false,
};

/** Whether a kind is retryable, from the one authoritative table. */
export function isRetryableKind(kind: LlmErrorKind): boolean {
  return RETRYABLE_BY_KIND[kind];
}

export interface LlmErrorOptions {
  /** The provider that produced the failure, for diagnostics. Never a secret. */
  readonly providerId?: string;
  /** The vendor HTTP status, when there was one. */
  readonly statusCode?: number | null;
  /** The underlying cause, preserved for logging. */
  readonly cause?: unknown;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly providerId: string;
  readonly statusCode: number | null;

  constructor(kind: LlmErrorKind, message: string, options: LlmErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.kind = kind;
    this.retryable = isRetryableKind(kind);
    this.providerId = options.providerId ?? 'unknown';
    this.statusCode = options.statusCode ?? null;
  }
}

/**
 * Bad or missing provider configuration.
 *
 * Thrown by the factory (provider-name and credential stages), never by the env
 * schema: the schema must accept a `gemini` deployment with no key so that a
 * process which never builds a Gemini provider still boots.
 */
export class LlmConfigurationError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super('configuration', message, options);
  }
}

/** The call exceeded its deadline. The adapter must also abort the request. */
export class LlmTimeoutError extends LlmError {
  constructor(message = 'LLM request timed out', options: LlmErrorOptions = {}) {
    super('timeout', message, options);
  }
}

/**
 * The provider returned empty or whitespace-only text.
 *
 * An error rather than an empty response: a caller that wants to accept an empty
 * answer must say so explicitly, so the default is never "silently return
 * nothing".
 */
export class LlmEmptyResponseError extends LlmError {
  constructor(message = 'LLM returned an empty response', options: LlmErrorOptions = {}) {
    super('empty_response', message, options);
  }
}
