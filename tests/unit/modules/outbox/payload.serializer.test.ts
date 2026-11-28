import { describe, expect, it } from 'vitest';

import {
  FIELD_BYTE_LIMITS,
  MAX_PAYLOAD_BYTES,
  OUTBOX_EVENT_TYPES,
  OUTBOX_PAYLOAD_SCHEMA_VERSION,
} from '../../../../src/modules/outbox/payload.constants.js';
import {
  OutboxPayloadError,
  PayloadParseError,
  PayloadTooLargeError,
  PayloadValidationError,
  UnknownEventTypeError,
  UnsupportedSchemaVersionError,
} from '../../../../src/modules/outbox/payload.errors.js';
import {
  parsePayload,
  serializePayload,
  validatePayload,
} from '../../../../src/modules/outbox/payload.serializer.js';

const LIFECYCLE_ID = '0f3a0b7e-6a55-4b3e-9f4e-2a5c1d7c9b11';
const SOURCE_URL = 'https://example.com/article';

function initialSuccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    event_type: 'initial_success',
    lifecycle_id: LIFECYCLE_ID,
    source_url: SOURCE_URL,
    body: { headline: 'AI 模型發布', summary: '摘要內容' },
    ...overrides,
  };
}

function exhaustedAlert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    event_type: 'exhausted_alert',
    lifecycle_id: LIFECYCLE_ID,
    source_url: SOURCE_URL,
    body: {
      processing_version: 2,
      terminal_reason: 'max_attempts_exhausted',
      failure_category: 'extraction_failure',
      attempts_consumed: 3,
      max_attempts: 3,
    },
    ...overrides,
  };
}

function correction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    event_type: 'correction',
    lifecycle_id: LIFECYCLE_ID,
    source_url: SOURCE_URL,
    body: {
      fact_item: 'funding_amount',
      previous_value: '100M USD',
      corrected_value: '120M USD',
      evidence_summary: 'AI 生成摘要說明金額已由 100M 更正為 120M USD。',
    },
    ...overrides,
  };
}

describe('serializePayload: the three event types', () => {
  it('serialises an initial_success payload to the documented shape', () => {
    const serialized = serializePayload(initialSuccess());

    expect(JSON.parse(serialized)).toEqual({
      schema_version: 1,
      event_type: 'initial_success',
      lifecycle_id: LIFECYCLE_ID,
      source_url: SOURCE_URL,
      body: { headline: 'AI 模型發布', summary: '摘要內容' },
    });
  });

  it('serialises an exhausted_alert payload, keeping the frozen MVP event type name', () => {
    const serialized = serializePayload(exhaustedAlert());

    expect(JSON.parse(serialized)).toEqual({
      schema_version: 1,
      event_type: 'exhausted_alert',
      lifecycle_id: LIFECYCLE_ID,
      source_url: SOURCE_URL,
      body: {
        processing_version: 2,
        terminal_reason: 'max_attempts_exhausted',
        failure_category: 'extraction_failure',
        attempts_consumed: 3,
        max_attempts: 3,
      },
    });
  });

  it('serialises a correction payload with the full evidence inline', () => {
    const serialized = serializePayload(correction());

    expect(JSON.parse(serialized)).toEqual({
      schema_version: 1,
      event_type: 'correction',
      lifecycle_id: LIFECYCLE_ID,
      source_url: SOURCE_URL,
      body: {
        fact_item: 'funding_amount',
        previous_value: '100M USD',
        corrected_value: '120M USD',
        evidence_summary: 'AI 生成摘要說明金額已由 100M 更正為 120M USD。',
      },
    });
  });

  it('carries no correction-record identifier, so delivery cannot depend on that row', () => {
    const body = JSON.parse(serializePayload(correction())).body as Record<string, unknown>;

    expect(Object.keys(body)).not.toContain('correction_event_id');
    expect(Object.keys(body)).toEqual([
      'fact_item',
      'previous_value',
      'corrected_value',
      'evidence_summary',
    ]);
  });
});

describe('header validation', () => {
  it('requires every header field', () => {
    for (const field of ['schema_version', 'event_type', 'lifecycle_id', 'source_url']) {
      const input = initialSuccess();
      delete input[field];

      expect(() => validatePayload(input)).toThrow(PayloadValidationError);
      try {
        validatePayload(input);
      } catch (error) {
        expect((error as PayloadValidationError).path).toBe(field);
        expect((error as PayloadValidationError).detail).toBe('missing_field');
      }
    }
  });

  it('distinguishes a null header field from a missing one', () => {
    expect(() => validatePayload(initialSuccess({ source_url: null }))).toThrow(
      PayloadValidationError,
    );
    try {
      validatePayload(initialSuccess({ source_url: null }));
    } catch (error) {
      expect((error as PayloadValidationError).detail).toBe('null_not_allowed');
      expect((error as PayloadValidationError).path).toBe('source_url');
    }
  });

  it('rejects a non-object payload', () => {
    for (const input of [null, [], 'text', 42]) {
      expect(() => validatePayload(input)).toThrow(PayloadValidationError);
    }
  });
});

describe('event type and schema version', () => {
  it('rejects an unknown event type', () => {
    expect(() => serializePayload(initialSuccess({ event_type: 'alert' }))).toThrow(
      UnknownEventTypeError,
    );
    try {
      serializePayload(initialSuccess({ event_type: 'alert' }));
    } catch (error) {
      expect((error as UnknownEventTypeError).code).toBe('UNKNOWN_EVENT_TYPE');
      expect((error as UnknownEventTypeError).eventType).toBe('alert');
    }
  });

  it('rejects an unsupported schema version', () => {
    expect(() => serializePayload(initialSuccess({ schema_version: 2 }))).toThrow(
      UnsupportedSchemaVersionError,
    );
    try {
      serializePayload(initialSuccess({ schema_version: 2 }));
    } catch (error) {
      expect((error as UnsupportedSchemaVersionError).schemaVersion).toBe(2);
    }
  });

  it('rejects a non-integer schema version as invalid rather than unsupported', () => {
    for (const version of ['1', 1.5, true]) {
      try {
        serializePayload(initialSuccess({ schema_version: version }));
        throw new Error('expected a rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(PayloadValidationError);
        expect((error as PayloadValidationError).detail).toBe('invalid_field');
      }
    }
  });

  it('supports exactly the three frozen event types', () => {
    expect(OUTBOX_EVENT_TYPES).toEqual(['initial_success', 'exhausted_alert', 'correction']);
  });
});

describe('body validation', () => {
  it('requires each body field for its own event type', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ body: { summary: 'x' } }, 'body.headline'],
      [{ body: { headline: 'x' } }, 'body.summary'],
      [
        {
          body: {
            processing_version: 1,
            terminal_reason: 'r',
            failure_category: 'c',
            attempts_consumed: 1,
          },
        },
        'body.max_attempts',
      ],
      [
        {
          body: {
            fact_item: 'f',
            previous_value: 'p',
            corrected_value: 'c',
          },
        },
        'body.evidence_summary',
      ],
    ];

    for (const [override, path] of cases) {
      const base =
        path.startsWith('body.summary') || path === 'body.headline'
          ? initialSuccess()
          : path === 'body.max_attempts'
            ? exhaustedAlert()
            : correction();
      const input = { ...base, ...override };

      try {
        validatePayload(input);
        throw new Error(`expected a rejection for ${path}`);
      } catch (error) {
        expect(error).toBeInstanceOf(PayloadValidationError);
        expect((error as PayloadValidationError).path).toBe(path);
        expect((error as PayloadValidationError).detail).toBe('missing_field');
      }
    }
  });

  it('distinguishes null from missing inside the body', () => {
    try {
      validatePayload(initialSuccess({ body: { headline: 'x', summary: null } }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadValidationError);
      expect((error as PayloadValidationError).detail).toBe('null_not_allowed');
      expect((error as PayloadValidationError).path).toBe('body.summary');
    }
  });

  it('rejects a null or non-object body', () => {
    expect(() => validatePayload(initialSuccess({ body: null }))).toThrow(PayloadValidationError);
    expect(() => validatePayload(initialSuccess({ body: 'text' }))).toThrow(PayloadValidationError);
  });

  it('rejects an empty string field', () => {
    expect(() => validatePayload(initialSuccess({ lifecycle_id: '' }))).toThrow(
      PayloadValidationError,
    );
  });

  it('rejects wrong types', () => {
    expect(() => validatePayload(initialSuccess({ lifecycle_id: 123 }))).toThrow(
      PayloadValidationError,
    );
    expect(() =>
      validatePayload(
        exhaustedAlert({
          body: {
            processing_version: '2',
            terminal_reason: 'r',
            failure_category: 'c',
            attempts_consumed: 1,
            max_attempts: 3,
          },
        }),
      ),
    ).toThrow(PayloadValidationError);
  });

  it('rejects out-of-range numeric fields', () => {
    const cases: Array<Record<string, unknown>> = [
      { processing_version: 0 },
      { processing_version: -1 },
      { attempts_consumed: -1 },
      { attempts_consumed: 1.5 },
      { max_attempts: 0 },
    ];

    for (const bodyOverride of cases) {
      const input = exhaustedAlert({
        body: {
          processing_version: 2,
          terminal_reason: 'r',
          failure_category: 'c',
          attempts_consumed: 1,
          max_attempts: 3,
          ...bodyOverride,
        },
      });
      expect(() => validatePayload(input)).toThrow(PayloadValidationError);
    }
  });
});

describe('unknown fields', () => {
  it('ignores unknown header and body fields instead of failing', () => {
    const input = {
      ...initialSuccess(),
      tenant: 'opaque',
      body: { headline: 'x', summary: 'y', trace_id: 'ignored' },
    };

    const serialized = serializePayload(input);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(
      ['schema_version', 'event_type', 'lifecycle_id', 'source_url', 'body'].sort(),
    );
    expect(Object.keys(parsed['body'] as Record<string, unknown>).sort()).toEqual([
      'headline',
      'summary',
    ]);
  });
});

describe('UTF-8 byte limits', () => {
  it('accepts a field exactly at its byte limit and rejects one byte more', () => {
    const atLimit = 'A'.repeat(FIELD_BYTE_LIMITS.headline);
    expect(() =>
      serializePayload(initialSuccess({ body: { headline: atLimit, summary: 's' } })),
    ).not.toThrow();

    const overLimit = 'A'.repeat(FIELD_BYTE_LIMITS.headline + 1);
    expect(() =>
      serializePayload(initialSuccess({ body: { headline: overLimit, summary: 's' } })),
    ).toThrow(PayloadValidationError);
  });

  it('measures bytes rather than characters', () => {
    // 682 CJK characters are 2,046 UTF-8 bytes; 683 are 2,049 and exceed 2,048.
    const fits = '新'.repeat(682);
    const exceeds = '新'.repeat(683);

    expect(() =>
      serializePayload(initialSuccess({ body: { headline: fits, summary: 's' } })),
    ).not.toThrow();
    expect(() =>
      serializePayload(initialSuccess({ body: { headline: exceeds, summary: 's' } })),
    ).toThrow(PayloadValidationError);
  });

  it('applies the lifecycle_id and source_url ceilings', () => {
    expect(() =>
      serializePayload(
        initialSuccess({ lifecycle_id: 'a'.repeat(FIELD_BYTE_LIMITS.lifecycle_id) }),
      ),
    ).not.toThrow();
    expect(() =>
      serializePayload(
        initialSuccess({ lifecycle_id: 'a'.repeat(FIELD_BYTE_LIMITS.lifecycle_id + 1) }),
      ),
    ).toThrow(PayloadValidationError);
    expect(() =>
      serializePayload(
        initialSuccess({ source_url: 'u'.repeat(FIELD_BYTE_LIMITS.source_url + 1) }),
      ),
    ).toThrow(PayloadValidationError);
  });
});

describe('payload size ceiling', () => {
  it('keeps a maximal legal payload well below the 64 KiB ceiling', () => {
    const serialized = serializePayload(
      initialSuccess({
        lifecycle_id: 'a'.repeat(FIELD_BYTE_LIMITS.lifecycle_id),
        source_url: 'u'.repeat(FIELD_BYTE_LIMITS.source_url),
        body: {
          headline: 'h'.repeat(FIELD_BYTE_LIMITS.headline),
          summary: 's'.repeat(FIELD_BYTE_LIMITS.summary),
        },
      }),
    );

    const bytes = Buffer.byteLength(serialized, 'utf8');
    expect(bytes).toBeGreaterThan(20_000);
    expect(bytes).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it('refuses to read a stored payload above the ceiling, without truncating it', () => {
    const oversized = JSON.stringify({
      ...initialSuccess(),
      padding: 'x'.repeat(MAX_PAYLOAD_BYTES),
    });
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(MAX_PAYLOAD_BYTES);

    try {
      parsePayload(oversized);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadTooLargeError);
      expect((error as PayloadTooLargeError).maxBytes).toBe(MAX_PAYLOAD_BYTES);
      expect((error as PayloadTooLargeError).actualBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    }
  });

  it('accepts a stored payload exactly at the ceiling', () => {
    const empty = JSON.stringify({ ...initialSuccess(), padding: '' });
    const padding = MAX_PAYLOAD_BYTES - Buffer.byteLength(empty, 'utf8');
    const atCeiling = JSON.stringify({ ...initialSuccess(), padding: 'x'.repeat(padding) });

    expect(Buffer.byteLength(atCeiling, 'utf8')).toBe(MAX_PAYLOAD_BYTES);
    expect(() => parsePayload(atCeiling)).not.toThrow();
  });
});

describe('parsePayload', () => {
  it('rejects a payload that is not JSON', () => {
    expect(() => parsePayload('not json')).toThrow(PayloadParseError);
    try {
      parsePayload('not json');
    } catch (error) {
      expect((error as OutboxPayloadError).code).toBe('PAYLOAD_PARSE_ERROR');
    }
  });

  it('rejects JSON that is not a payload object', () => {
    for (const raw of ['[]', 'null', '"text"', '{}']) {
      expect(() => parsePayload(raw)).toThrow(PayloadValidationError);
    }
  });

  it('round-trips every event type', () => {
    for (const input of [initialSuccess(), exhaustedAlert(), correction()]) {
      const serialized = serializePayload(input);
      expect(parsePayload(serialized)).toEqual(validatePayload(input));
    }
  });
});

describe('immutability and retry reuse', () => {
  it('returns a deep-frozen view from parsePayload', () => {
    const parsed = parsePayload(serializePayload(correction()));

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.body)).toBe(true);
  });

  it('returns a deep-frozen view from validatePayload', () => {
    const validated = validatePayload(exhaustedAlert());

    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.body)).toBe(true);
  });

  it('prevents mutation of the parsed payload', () => {
    const parsed = parsePayload(serializePayload(initialSuccess()));
    if (parsed.event_type !== 'initial_success') {
      throw new Error('expected an initial_success payload');
    }

    expect(() => {
      (parsed as unknown as Record<string, unknown>)['lifecycle_id'] = 'other';
    }).toThrow(TypeError);
    expect(() => {
      (parsed.body as unknown as Record<string, unknown>)['headline'] = 'other';
    }).toThrow(TypeError);
    expect(parsed.body.headline).toBe('AI 模型發布');
  });

  it('re-serialises a stored payload to the identical string, so a retry re-sends it unchanged', () => {
    const stored = serializePayload(exhaustedAlert());
    const retry = serializePayload(parsePayload(stored));

    expect(retry).toBe(stored);
  });

  it('produces identical bytes for identical input, independent of key order in the input', () => {
    const reordered = {
      body: { summary: '摘要內容', headline: 'AI 模型發布' },
      source_url: SOURCE_URL,
      lifecycle_id: LIFECYCLE_ID,
      event_type: 'initial_success',
      schema_version: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    };

    expect(serializePayload(reordered)).toBe(serializePayload(initialSuccess()));
  });
});
