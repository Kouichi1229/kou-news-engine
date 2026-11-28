/**
 * Outbox payload errors.
 *
 * One base class carries a stable `code`, so a caller can branch on the reason
 * without matching on message wording, and so structured logs record the same
 * vocabulary the tests assert on.
 *
 * Messages never echo field content or the serialised payload: a payload can
 * carry article-derived text, and an error string ends up in logs.
 */

export type OutboxPayloadErrorCode =
  | 'PAYLOAD_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNKNOWN_EVENT_TYPE'
  | 'PAYLOAD_PARSE_ERROR';

/**
 * Why a field was rejected.
 *
 * `missing_field` and `null_not_allowed` are separate because the Owner-frozen
 * rule distinguishes an absent key from an explicit `null`: they mean different
 * things to a producer, so they must not collapse into one error.
 */
export type PayloadValidationDetail = 'missing_field' | 'null_not_allowed' | 'invalid_field';

export class OutboxPayloadError extends Error {
  readonly code: OutboxPayloadErrorCode;
  /** Dotted path of the offending field, or `null` for whole-payload failures. */
  readonly path: string | null;

  constructor(code: OutboxPayloadErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'OutboxPayloadError';
    this.code = code;
    this.path = path;
  }
}

/** A field failed validation; `detail` says whether it was absent, `null`, or malformed. */
export class PayloadValidationError extends OutboxPayloadError {
  readonly detail: PayloadValidationDetail;

  constructor(detail: PayloadValidationDetail, path: string, message: string) {
    super('PAYLOAD_INVALID', message, path);
    this.name = 'PayloadValidationError';
    this.detail = detail;
  }
}

/** The serialised payload exceeded `MAX_PAYLOAD_BYTES`. Nothing is truncated. */
export class PayloadTooLargeError extends OutboxPayloadError {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super('PAYLOAD_TOO_LARGE', `Payload is ${actualBytes} bytes, above the ${maxBytes} byte limit`);
    this.name = 'PayloadTooLargeError';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

/** `schema_version` is absent from the supported set. */
export class UnsupportedSchemaVersionError extends OutboxPayloadError {
  readonly schemaVersion: unknown;

  constructor(schemaVersion: unknown, supported: number) {
    super(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Unsupported schema_version ${JSON.stringify(schemaVersion) ?? 'undefined'}; supported: ${supported}`,
      'schema_version',
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.schemaVersion = schemaVersion;
  }
}

/** `event_type` is not one of the supported types. */
export class UnknownEventTypeError extends OutboxPayloadError {
  readonly eventType: unknown;

  constructor(eventType: unknown, supported: readonly string[]) {
    super(
      'UNKNOWN_EVENT_TYPE',
      `Unknown event_type ${JSON.stringify(eventType) ?? 'undefined'}; supported: ${supported.join(', ')}`,
      'event_type',
    );
    this.name = 'UnknownEventTypeError';
    this.eventType = eventType;
  }
}

/** The stored payload is not valid JSON. */
export class PayloadParseError extends OutboxPayloadError {
  constructor(cause: unknown) {
    super('PAYLOAD_PARSE_ERROR', 'Stored payload is not valid JSON', null);
    this.name = 'PayloadParseError';
    this.cause = cause;
  }
}
