/**
 * The single codec for Outbox payloads: validate, serialise, parse.
 *
 * Immutability contract. A payload is created once, serialised once and stored
 * as `TEXT`. The serialised string is the source of truth: a retry re-reads that
 * string instead of rebuilding a payload, and `parsePayload` returns a frozen
 * object so a worker cannot mutate its own view of what will be re-sent. Nothing
 * here re-derives, upgrades or normalises a stored payload — an unsupported
 * version is reported, never rewritten.
 *
 * Layering. This codec knows nothing about the Outbox envelope columns, delivery
 * status, leases or provider request bodies. Those are mutable state and stay
 * outside the payload; putting them here would break the frozen-payload rule.
 */
import {
  MAX_PAYLOAD_BYTES,
  OUTBOX_EVENT_TYPES,
  OUTBOX_PAYLOAD_SCHEMA_VERSION,
  type OutboxEventType,
} from './payload.constants.js';
import {
  PayloadParseError,
  PayloadTooLargeError,
  PayloadValidationError,
  UnknownEventTypeError,
  UnsupportedSchemaVersionError,
} from './payload.errors.js';
import { outboxPayloadSchema, REQUIRED_BODY_FIELDS, type OutboxPayload } from './payload.types.js';

const HEADER_FIELDS = ['schema_version', 'event_type', 'lifecycle_id', 'source_url'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedEventType(value: string): value is OutboxEventType {
  return (OUTBOX_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Rejects an absent key and an explicit `null` with different codes.
 *
 * Zod would report both as an invalid type, which is exactly the distinction the
 * Owner-frozen rule requires callers to be able to see.
 */
function requirePresent(container: Record<string, unknown>, field: string, path: string): unknown {
  if (!Object.hasOwn(container, field)) {
    throw new PayloadValidationError(
      'missing_field',
      path,
      `${path} is required but was not provided`,
    );
  }
  const value: unknown = container[field];
  if (value === null) {
    throw new PayloadValidationError('null_not_allowed', path, `${path} must not be null`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates an already-parsed payload value and returns a frozen copy.
 *
 * Unknown keys are dropped (the frozen rule is to ignore them), so the returned
 * object contains exactly the documented fields.
 */
export function validatePayload(input: unknown): OutboxPayload {
  if (!isRecord(input)) {
    throw new PayloadValidationError('invalid_field', '', 'payload must be a JSON object');
  }

  for (const field of HEADER_FIELDS) {
    requirePresent(input, field, field);
  }

  const rawVersion = input['schema_version'];
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    throw new PayloadValidationError(
      'invalid_field',
      'schema_version',
      'schema_version must be an integer',
    );
  }
  if (rawVersion !== OUTBOX_PAYLOAD_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(rawVersion, OUTBOX_PAYLOAD_SCHEMA_VERSION);
  }

  const rawEventType = input['event_type'];
  if (typeof rawEventType !== 'string') {
    throw new PayloadValidationError('invalid_field', 'event_type', 'event_type must be a string');
  }
  if (!isSupportedEventType(rawEventType)) {
    throw new UnknownEventTypeError(rawEventType, OUTBOX_EVENT_TYPES);
  }

  const rawBody = input['body'];
  if (!isRecord(rawBody)) {
    throw new PayloadValidationError('invalid_field', 'body', 'body must be a JSON object');
  }
  for (const field of REQUIRED_BODY_FIELDS[rawEventType]) {
    requirePresent(rawBody, field, `body.${field}`);
  }

  const result = outboxPayloadSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined ? '' : issue.path.map((segment) => String(segment)).join('.');
    const message = issue === undefined ? 'payload is invalid' : issue.message;
    throw new PayloadValidationError(
      'invalid_field',
      path,
      `${path === '' ? 'payload' : path}: ${message}`,
    );
  }

  return deepFreeze(result.data);
}

/**
 * Validates and serialises a payload.
 *
 * Refuses to create anything above `MAX_PAYLOAD_BYTES` rather than truncating:
 * a truncated notification would be sent as if it were complete.
 */
export function serializePayload(input: unknown): string {
  const payload = validatePayload(input);
  const serialized = JSON.stringify(payload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(bytes, MAX_PAYLOAD_BYTES);
  }
  return serialized;
}

/**
 * Reads a stored payload.
 *
 * The size guard is repeated here so a row written outside this codec cannot
 * make a worker parse an unbounded document.
 */
export function parsePayload(raw: string): OutboxPayload {
  if (typeof raw !== 'string') {
    throw new PayloadParseError(new TypeError('stored payload must be a string'));
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(bytes, MAX_PAYLOAD_BYTES);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new PayloadParseError(cause);
  }

  return validatePayload(parsed);
}
