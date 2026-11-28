/**
 * Outbox payload shape.
 *
 * Two layers, deliberately separate from the 18-column Outbox envelope
 * (`OUT-1`/`P-5`) and from a provider request body:
 *
 *   common header   schema_version, event_type, lifecycle_id, source_url
 *   typed body      one shape per `event_type`
 *
 * Every field is carried inside the payload because `OUT-26` requires the event
 * to be deliverable after the article, lifecycle and correction rows are gone.
 * Nothing here is a foreign key: `lifecycle_id` and `source_url` are values, and
 * a reader must never resolve them against another table to build a message.
 *
 * All fields are required and non-nullable in this version. The validator still
 * distinguishes "missing" from "null" so that a later optional or nullable field
 * cannot be added without deciding which one it is.
 */
import { z } from 'zod';

import {
  FIELD_BYTE_LIMITS,
  OUTBOX_PAYLOAD_SCHEMA_VERSION,
  type OutboxEventType,
} from './payload.constants.js';

/**
 * A non-empty string within a UTF-8 byte ceiling.
 *
 * Measured in bytes, not characters: the ceilings exist to bound storage and log
 * lines, and a Traditional Chinese character costs three bytes while a Latin one
 * costs one.
 */
function byteLimited(limit: number): z.ZodString {
  return z
    .string()
    .min(1, { message: 'must not be empty' })
    .refine((value) => Buffer.byteLength(value, 'utf8') <= limit, {
      message: `must be at most ${limit} UTF-8 bytes`,
    });
}

const headerShape = {
  schema_version: z.literal(OUTBOX_PAYLOAD_SCHEMA_VERSION),
  lifecycle_id: byteLimited(FIELD_BYTE_LIMITS.lifecycle_id),
  source_url: byteLimited(FIELD_BYTE_LIMITS.source_url),
};

export const initialSuccessBodySchema = z.object({
  headline: byteLimited(FIELD_BYTE_LIMITS.headline),
  summary: byteLimited(FIELD_BYTE_LIMITS.summary),
});

export const exhaustedAlertBodySchema = z.object({
  processing_version: z.int().min(1),
  terminal_reason: byteLimited(FIELD_BYTE_LIMITS.terminal_reason),
  /**
   * Left as free text on purpose.
   *
   * The M7.0 register fixes an `LlmErrorKind` vocabulary for processing failures
   * (`CLM-4`), but the Owner-frozen MVP example carries `extraction_failure`,
   * which is not one of those values. Closing the set here would either reject
   * the frozen example or invent policy, so only length and non-emptiness are
   * enforced until the vocabulary is settled.
   */
  failure_category: byteLimited(FIELD_BYTE_LIMITS.failure_category),
  attempts_consumed: z.int().min(0),
  max_attempts: z.int().min(1),
});

export const correctionBodySchema = z.object({
  fact_item: byteLimited(FIELD_BYTE_LIMITS.fact_item),
  previous_value: byteLimited(FIELD_BYTE_LIMITS.previous_value),
  corrected_value: byteLimited(FIELD_BYTE_LIMITS.corrected_value),
  /**
   * `OUT-22`: an AI-generated summary is the only permitted correction evidence.
   * A verbatim excerpt is a producer error this schema cannot detect, so the
   * producers must not source this field from article text.
   */
  evidence_summary: byteLimited(FIELD_BYTE_LIMITS.evidence_summary),
});

/**
 * Unknown keys are stripped, not rejected: the frozen rule is that unknown
 * fields are ignored, so a producer adding a field must not break a reader.
 */
export const outboxPayloadSchema = z.discriminatedUnion('event_type', [
  z.object({
    ...headerShape,
    event_type: z.literal('initial_success'),
    body: initialSuccessBodySchema,
  }),
  z.object({
    ...headerShape,
    event_type: z.literal('exhausted_alert'),
    body: exhaustedAlertBodySchema,
  }),
  z.object({
    ...headerShape,
    event_type: z.literal('correction'),
    body: correctionBodySchema,
  }),
]);

export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;
export type InitialSuccessPayload = Extract<OutboxPayload, { event_type: 'initial_success' }>;
export type ExhaustedAlertPayload = Extract<OutboxPayload, { event_type: 'exhausted_alert' }>;
export type CorrectionPayload = Extract<OutboxPayload, { event_type: 'correction' }>;
export type OutboxPayloadBody = OutboxPayload['body'];

/** Required keys per event type, used by the presence pre-check. */
export const REQUIRED_BODY_FIELDS: Readonly<Record<OutboxEventType, readonly string[]>> = {
  initial_success: ['headline', 'summary'],
  exhausted_alert: [
    'processing_version',
    'terminal_reason',
    'failure_category',
    'attempts_consumed',
    'max_attempts',
  ],
  correction: ['fact_item', 'previous_value', 'corrected_value', 'evidence_summary'],
};
