import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { parsePayload, serializePayload } from '../../../src/modules/outbox/payload.serializer.js';

/**
 * Persistence contract for the Outbox payload.
 *
 * The Outbox table itself is **not** created here. Its column set is still
 * `PROPOSED — NOT APPROVED` (P-5 §14), so this suite must not author it. What it
 * does verify is the part the payload codec owns and that a future repository
 * will depend on: a serialised payload survives a round trip through a real
 * SQLite `TEXT` column byte-for-byte, cannot drift on retry, and is committed or
 * rolled back together with the row that justifies it.
 *
 * The probe tables are throwaway fixtures inside a `:memory:` database. They are
 * deliberately generic (`event_id` + `payload`) and are not a schema proposal.
 */
const LIFECYCLE_ID = '0f3a0b7e-6a55-4b3e-9f4e-2a5c1d7c9b11';
const SOURCE_URL = 'https://example.com/article';

let database: SqliteDatabase;

function correctionPayload(): string {
  return serializePayload({
    schema_version: 1,
    event_type: 'correction',
    lifecycle_id: LIFECYCLE_ID,
    source_url: SOURCE_URL,
    body: {
      fact_item: 'funding_amount',
      previous_value: '100M USD',
      corrected_value: '120M USD',
      evidence_summary: 'AI 生成摘要：金額由 100M 更正為 120M USD。',
    },
  });
}

function initialSuccessPayload(): string {
  return serializePayload({
    schema_version: 1,
    event_type: 'initial_success',
    lifecycle_id: LIFECYCLE_ID,
    source_url: SOURCE_URL,
    body: { headline: 'AI 模型發布', summary: '摘要內容' },
  });
}

function createProbeTables(): void {
  database.transaction((connection) => {
    connection.run('CREATE TABLE payload_probe (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    connection.run(
      'CREATE TABLE correction_probe (correction_id TEXT PRIMARY KEY, evidence_summary TEXT NOT NULL)',
    );
  });
}

function readStoredPayload(eventId: string): string | undefined {
  const rows = database.query((connection) =>
    connection.all('SELECT payload FROM payload_probe WHERE event_id = ?', [eventId]),
  ) as Array<{ payload: string }>;
  return rows[0]?.payload;
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  createProbeTables();
});

afterEach(() => {
  if (database.isOpen) {
    database.close();
  }
});

describe('payload persistence round trip', () => {
  it('stores the serialised payload byte-for-byte in a TEXT column', () => {
    const stored = initialSuccessPayload();

    database.transaction((connection) => {
      connection.run('INSERT INTO payload_probe (event_id, payload) VALUES (?, ?)', [
        'evt-1',
        stored,
      ]);
    });

    expect(readStoredPayload('evt-1')).toBe(stored);
  });

  it('reuses the stored payload unchanged on every retry', () => {
    const stored = correctionPayload();

    database.transaction((connection) => {
      connection.run('INSERT INTO payload_probe (event_id, payload) VALUES (?, ?)', [
        'evt-2',
        stored,
      ]);
    });

    const firstAttempt = parsePayload(readStoredPayload('evt-2')!);
    const secondAttempt = parsePayload(readStoredPayload('evt-2')!);

    expect(secondAttempt).toEqual(firstAttempt);
    expect(serializePayload(secondAttempt)).toBe(stored);
    expect(readStoredPayload('evt-2')).toBe(stored);
  });

  it('keeps the payload deliverable after the correction row is deleted', () => {
    const stored = correctionPayload();

    database.transaction((connection) => {
      connection.run(
        'INSERT INTO correction_probe (correction_id, evidence_summary) VALUES (?, ?)',
        ['corr-1', 'AI 生成摘要：金額由 100M 更正為 120M USD。'],
      );
      connection.run('INSERT INTO payload_probe (event_id, payload) VALUES (?, ?)', [
        'evt-3',
        stored,
      ]);
    });

    database.transaction((connection) => {
      connection.run('DELETE FROM correction_probe WHERE correction_id = ?', ['corr-1']);
    });

    const rows = database.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM correction_probe'),
    ) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);

    // Nothing is re-read from the deleted row: every evidence field is inline.
    const recovered = parsePayload(readStoredPayload('evt-3')!);
    expect(recovered.event_type).toBe('correction');
    expect(recovered.body).toEqual({
      fact_item: 'funding_amount',
      previous_value: '100M USD',
      corrected_value: '120M USD',
      evidence_summary: 'AI 生成摘要：金額由 100M 更正為 120M USD。',
    });
  });
});

describe('transaction atomicity around payload writes', () => {
  it('commits the justifying row and the payload together', () => {
    database.transaction((connection) => {
      connection.run(
        'INSERT INTO correction_probe (correction_id, evidence_summary) VALUES (?, ?)',
        ['corr-2', 'summary'],
      );
      connection.run('INSERT INTO payload_probe (event_id, payload) VALUES (?, ?)', [
        'evt-4',
        correctionPayload(),
      ]);
    });

    const corrections = database.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM correction_probe'),
    ) as Array<{ n: number }>;
    const events = database.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM payload_probe'),
    ) as Array<{ n: number }>;

    expect(corrections[0]?.n).toBe(1);
    expect(events[0]?.n).toBe(1);
  });

  it('rolls back both writes when any step fails', () => {
    expect(() =>
      database.transaction((connection) => {
        connection.run(
          'INSERT INTO correction_probe (correction_id, evidence_summary) VALUES (?, ?)',
          ['corr-3', 'summary'],
        );
        connection.run('INSERT INTO payload_probe (event_id, payload) VALUES (?, ?)', [
          'evt-5',
          correctionPayload(),
        ]);
        throw new Error('simulated persistence failure');
      }),
    ).toThrow('simulated persistence failure');

    const corrections = database.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM correction_probe'),
    ) as Array<{ n: number }>;
    const events = database.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM payload_probe'),
    ) as Array<{ n: number }>;

    expect(corrections[0]?.n).toBe(0);
    expect(events[0]?.n).toBe(0);
  });

  it('leaves no partial event when serialisation fails before the write', () => {
    expect(() =>
      database.transaction((connection) => {
        connection.run(
          'INSERT INTO correction_probe (correction_id, evidence_summary) VALUES (?, ?)',
          ['corr-4', 'summary'],
        );
        connection.run('INSERT INTO payload_probe (event_id, payload) VALUES (?, ?)', [
          'evt-6',
          serializePayload({
            schema_version: 1,
            event_type: 'correction',
            lifecycle_id: LIFECYCLE_ID,
            source_url: SOURCE_URL,
            body: { fact_item: 'f', previous_value: 'p', corrected_value: 'c' },
          }),
        ]);
      }),
    ).toThrow();

    const corrections = database.query((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM correction_probe'),
    ) as Array<{ n: number }>;
    expect(corrections[0]?.n).toBe(0);
  });
});
