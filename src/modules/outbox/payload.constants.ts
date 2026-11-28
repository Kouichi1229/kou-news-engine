/**
 * Outbox payload limits and literals.
 *
 * `OUT-11` was `OPEN` in the M7.0 register: the specification fixed completeness
 * (`OUT-26`) but never a field list. These values are the Owner-frozen payload
 * MVP decisions of 2026-11-28, not a derivation from the specification — do not
 * read them as normative text. Individual field ceilings may be adjusted as the
 * data model settles; `MAX_PAYLOAD_BYTES` is the ceiling such an adjustment must
 * not raise.
 */

/** The only schema version this codec understands; others are rejected, never guessed. */
export const OUTBOX_PAYLOAD_SCHEMA_VERSION = 1;

/**
 * UTF-8 bytes of the complete serialised payload, shared by every event type.
 *
 * Enforced on write (refuse to create) and on read (refuse to parse): a stored
 * payload above this ceiling could only have come from outside this codec, and
 * handing it to a Delivery Worker would make every read expensive.
 */
export const MAX_PAYLOAD_BYTES = 65_536;

/**
 * Supported event types.
 *
 * `exhausted_alert` is the Owner-frozen MVP name. Appendix A.6 of the M7.0
 * register (non-normative) writes `alert`, and the literal `event_type` values
 * are still open (`SPEC-GAP-07`), so the two names are not interchangeable.
 */
export const OUTBOX_EVENT_TYPES = ['initial_success', 'exhausted_alert', 'correction'] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/** Per-field ceiling, in UTF-8 bytes. */
export const FIELD_BYTE_LIMITS = {
  lifecycle_id: 128,
  source_url: 4_096,
  headline: 2_048,
  summary: 16_384,
  terminal_reason: 128,
  failure_category: 128,
  fact_item: 1_024,
  previous_value: 4_096,
  corrected_value: 4_096,
  evidence_summary: 8_192,
} as const;
