import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { MAX_PROCESSING_ATTEMPTS } from '../../../src/modules/processing/processing.constants.js';
import { SqliteProcessingJobRepository } from '../../../src/modules/processing/repository/sqlite-processing-job.repository.js';

let database: SqliteDatabase;
let repository: SqliteProcessingJobRepository;

const NOW = 1_000_000;
const LEASE_MS = 60_000;
const UPDATED_AT = '2026-11-27T00:00:00Z';

let tokenSequence = 0;

function nextToken(): string {
  tokenSequence += 1;
  return `token-${String(tokenSequence)}`;
}

function openLifecycle(
  lifecycleId: string,
  articleId: string,
  overrides: {
    publishedVersion?: number;
    closedAt?: string | null;
    abandonedAt?: string | null;
  } = {},
): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO processing_lifecycle
         (lifecycle_id, article_id, published_version, opened_at, closed_at, abandoned_at)
       VALUES (?, ?, ?, '2026-11-27T00:00:00Z', ?, ?)`,
      [
        lifecycleId,
        articleId,
        overrides.publishedVersion ?? 0,
        overrides.closedAt ?? null,
        overrides.abandonedAt ?? null,
      ],
    );
  });
}

function createJob(lifecycleId: string, version: number): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO processing_job
         (lifecycle_id, processing_version, state, attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')`,
      [lifecycleId, version],
    );
  });
}

function insertTerminalJob(lifecycleId: string, version: number, reason: string): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO processing_job
         (lifecycle_id, processing_version, state, attempts, terminal_reason,
          created_at, updated_at)
       VALUES (?, ?, 'terminal', 3, ?,
               '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')`,
      [lifecycleId, version, reason],
    );
  });
}

function publishVersion(lifecycleId: string, version: number): void {
  database.query((connection) => {
    connection.all('UPDATE processing_lifecycle SET published_version = ? WHERE lifecycle_id = ?', [
      version,
      lifecycleId,
    ]);
  });
}

function abandonLifecycle(lifecycleId: string): void {
  database.query((connection) => {
    connection.all('UPDATE processing_lifecycle SET abandoned_at = ? WHERE lifecycle_id = ?', [
      '2026-11-27T00:00:00Z',
      lifecycleId,
    ]);
  });
}

function closeLifecycle(lifecycleId: string): void {
  database.query((connection) => {
    connection.all('UPDATE processing_lifecycle SET closed_at = ? WHERE lifecycle_id = ?', [
      '2026-11-27T00:00:00Z',
      lifecycleId,
    ]);
  });
}

function claim(
  lifecycleId: string,
  processingVersion: number,
  overrides: Partial<Parameters<SqliteProcessingJobRepository['claim']>[0]> = {},
) {
  return repository.claim({
    lifecycleId,
    processingVersion,
    owner: 'worker-1',
    token: nextToken(),
    now: NOW,
    leaseDurationMs: LEASE_MS,
    updatedAt: UPDATED_AT,
    ...overrides,
  });
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  repository = new SqliteProcessingJobRepository(database);
});

afterEach(() => {
  database.close();
});

describe('claim targeting', () => {
  it('claims the explicitly named job', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);

    const claimed = await claim('lc-1', 1, { token: 'token-a' });

    expect(claimed).toEqual({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      attempts: 1,
      leaseExpiresAt: NOW + LEASE_MS,
    });

    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.leaseToken).toBe('token-a');
    expect(job?.leaseOwner).toBe('worker-1');
    expect(job?.terminalReason).toBeNull();
  });

  it('does not prefer a lifecycle whose identifier sorts lower', async () => {
    openLifecycle('lc-a', 'a1:article-a');
    openLifecycle('lc-z', 'a1:article-z');
    createJob('lc-a', 1);
    createJob('lc-z', 1);

    const claimed = await claim('lc-z', 1);

    expect(claimed?.lifecycleId).toBe('lc-z');
    expect((await repository.findJob('lc-a', 1))?.state).toBe('pending');
  });

  it('claims a higher version when that is the named target', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);

    const claimed = await claim('lc-1', 2);

    expect(claimed?.processingVersion).toBe(2);
    expect((await repository.findJob('lc-1', 1))?.state).toBe('pending');
  });

  it('returns undefined for a job that does not exist', async () => {
    openLifecycle('lc-1', 'a1:article-1');

    expect(await claim('lc-1', 1)).toBeUndefined();
    expect(await claim('lc-missing', 1)).toBeUndefined();
  });

  it('returns undefined for an ineligible target', async () => {
    openLifecycle('lc-abandoned', 'a1:article-a', { abandonedAt: '2026-11-27T00:00:00Z' });
    createJob('lc-abandoned', 1);

    openLifecycle('lc-closed', 'a1:article-c', { closedAt: '2026-11-27T00:00:00Z' });
    createJob('lc-closed', 1);

    openLifecycle('lc-terminal', 'a1:article-t');
    insertTerminalJob('lc-terminal', 1, 'failed_terminal');

    expect(await claim('lc-abandoned', 1)).toBeUndefined();
    expect(await claim('lc-closed', 1)).toBeUndefined();
    expect(await claim('lc-terminal', 1)).toBeUndefined();
  });

  it('refuses a second claim carrying a token that is already live (CLM-12)', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);

    await claim('lc-1', 1, { token: 'token-shared' });
    await expect(claim('lc-1', 2, { token: 'token-shared' })).rejects.toThrow();
  });

  it('stops at the three-attempt ceiling (CLM-10)', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);

    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt += 1) {
      const claimed = await claim('lc-1', 1);
      expect(claimed?.attempts).toBe(attempt);
      if (attempt < MAX_PROCESSING_ATTEMPTS) {
        const token = (await repository.findJob('lc-1', 1))?.leaseToken ?? '';
        expect(
          await repository.requeue({
            lifecycleId: 'lc-1',
            processingVersion: 1,
            token,
            failureCode: 'empty_response',
            updatedAt: UPDATED_AT,
          }),
        ).toBe(true);
      }
    }

    expect(await claim('lc-1', 1)).toBeUndefined();
    expect((await repository.findJob('lc-1', 1))?.attempts).toBe(MAX_PROCESSING_ATTEMPTS);
  });
});

describe('CLM-19 claim-time retirement', () => {
  it('retires a pending stale job as superseded without consuming an attempt', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);

    await claim('lc-1', 2);

    const retired = await repository.findJob('lc-1', 1);
    expect(retired?.state).toBe('terminal');
    expect(retired?.terminalReason).toBe('superseded');
    expect(retired?.attempts).toBe(0);
    expect(retired?.failureCode).toBeNull();
  });

  it('retires a running stale job and invalidates its lease', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-stale-worker' });
    expect((await repository.findJob('lc-1', 1))?.state).toBe('running');

    publishVersion('lc-1', 2);
    createJob('lc-1', 2);
    await claim('lc-1', 2);

    const retired = await repository.findJob('lc-1', 1);
    expect(retired?.state).toBe('terminal');
    expect(retired?.terminalReason).toBe('superseded');
    expect(retired?.leaseOwner).toBeNull();
    expect(retired?.leaseToken).toBeNull();
    expect(retired?.leaseExpiresAt).toBeNull();
    expect(retired?.attempts).toBe(1);
  });

  it('rejects writes from the invalidated Worker token', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-stale-worker' });

    publishVersion('lc-1', 2);
    createJob('lc-1', 2);
    await claim('lc-1', 2);

    expect(
      await repository.requeue({
        lifecycleId: 'lc-1',
        processingVersion: 1,
        token: 'token-stale-worker',
        failureCode: 'timeout',
        updatedAt: UPDATED_AT,
      }),
    ).toBe(false);

    expect(
      await repository.markTerminal({
        lifecycleId: 'lc-1',
        processingVersion: 1,
        token: 'token-stale-worker',
        terminalReason: 'failed_terminal',
        updatedAt: UPDATED_AT,
      }),
    ).toBe(false);

    expect((await repository.findJob('lc-1', 1))?.terminalReason).toBe('superseded');
  });

  it('never rewrites an outcome that already committed (CLM-19 non-retroactivity)', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    insertTerminalJob('lc-1', 1, 'failed_terminal');
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);

    await claim('lc-1', 2);

    const committed = await repository.findJob('lc-1', 1);
    expect(committed?.terminalReason).toBe('failed_terminal');
    expect(committed?.attempts).toBe(3);
  });

  it('leaves the current-version job claimable while retiring the stale one', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);

    const claimed = await claim('lc-1', 2);

    expect(claimed?.processingVersion).toBe(2);
    expect(claimed?.attempts).toBe(1);
    expect((await repository.findJob('lc-1', 2))?.state).toBe('running');
    expect((await repository.findJob('lc-1', 1))?.state).toBe('terminal');
  });

  it('does not retire a stale job in an abandoned lifecycle (L-01 left open)', async () => {
    openLifecycle('lc-abandoned', 'a1:article-a', { abandonedAt: '2026-11-27T00:00:00Z' });
    createJob('lc-abandoned', 1);
    publishVersion('lc-abandoned', 2);

    expect(await claim('lc-abandoned', 1)).toBeUndefined();

    const untouched = await repository.findJob('lc-abandoned', 1);
    expect(untouched?.state).toBe('pending');
    expect(untouched?.terminalReason).toBeNull();
  });

  it('does not retire a stale job in a closed lifecycle (L-01 left open)', async () => {
    openLifecycle('lc-closed', 'a1:article-c', { closedAt: '2026-11-27T00:00:00Z' });
    createJob('lc-closed', 1);
    publishVersion('lc-closed', 2);

    expect(await claim('lc-closed', 1)).toBeUndefined();

    const untouched = await repository.findJob('lc-closed', 1);
    expect(untouched?.state).toBe('pending');
    expect(untouched?.terminalReason).toBeNull();
  });

  it('rolls the retirement back when the claim itself fails', async () => {
    openLifecycle('lc-holder', 'a1:article-h');
    createJob('lc-holder', 1);
    await claim('lc-holder', 1, { token: 'token-shared' });

    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);

    await expect(claim('lc-1', 2, { token: 'token-shared' })).rejects.toThrow();

    const stale = await repository.findJob('lc-1', 1);
    expect(stale?.state).toBe('pending');
    expect(stale?.terminalReason).toBeNull();
    expect((await repository.findJob('lc-1', 2))?.state).toBe('pending');
  });
});

describe('CLM-19 at Worker writes', () => {
  it('retires a stale job instead of requeueing it', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-stale' });
    publishVersion('lc-1', 2);

    const requeued = await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-stale',
      failureCode: 'empty_response',
      updatedAt: UPDATED_AT,
    });

    expect(requeued).toBe(false);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('terminal');
    expect(job?.terminalReason).toBe('superseded');
    expect(job?.leaseOwner).toBeNull();
    expect(job?.leaseToken).toBeNull();
    expect(job?.leaseExpiresAt).toBeNull();
    expect(job?.attempts).toBe(1);
    expect(job?.failureCode).toBeNull();
  });

  it('retires a stale job instead of terminalizing it', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-stale' });
    publishVersion('lc-1', 2);

    const written = await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-stale',
      terminalReason: 'failed_terminal',
      failureCode: 'timeout',
      updatedAt: UPDATED_AT,
    });

    expect(written).toBe(false);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('terminal');
    expect(job?.terminalReason).toBe('superseded');
    expect(job?.leaseOwner).toBeNull();
    expect(job?.leaseToken).toBeNull();
    expect(job?.leaseExpiresAt).toBeNull();
    expect(job?.attempts).toBe(1);
    expect(job?.failureCode).toBeNull();
  });

  it('requeues a current-version job exactly as before', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);
    await claim('lc-1', 2, { token: 'token-current' });

    const requeued = await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 2,
      token: 'token-current',
      failureCode: 'empty_response',
      updatedAt: UPDATED_AT,
    });

    expect(requeued).toBe(true);
    const job = await repository.findJob('lc-1', 2);
    expect(job?.state).toBe('pending');
    expect(job?.terminalReason).toBeNull();
    expect(job?.attempts).toBe(1);
  });

  it('terminalizes a current-version job exactly as before', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);
    await claim('lc-1', 2, { token: 'token-current' });

    const written = await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 2,
      token: 'token-current',
      terminalReason: 'lease_expired',
      updatedAt: UPDATED_AT,
    });

    expect(written).toBe(true);
    const job = await repository.findJob('lc-1', 2);
    expect(job?.state).toBe('terminal');
    expect(job?.terminalReason).toBe('lease_expired');
    expect(job?.attempts).toBe(1);
  });

  it('does not mistake a token mismatch for a retirement', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    const requeued = await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-wrong',
      failureCode: 'timeout',
      updatedAt: UPDATED_AT,
    });

    expect(requeued).toBe(false);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.terminalReason).toBeNull();
    expect(job?.leaseToken).toBe('token-a');
    expect(job?.attempts).toBe(1);
  });

  it('does not rewrite a committed outcome when the job is stale', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    insertTerminalJob('lc-1', 1, 'failed_terminal');
    publishVersion('lc-1', 2);

    const written = await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-any',
      terminalReason: 'cancelled',
      updatedAt: UPDATED_AT,
    });

    expect(written).toBe(false);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.terminalReason).toBe('failed_terminal');
    expect(job?.attempts).toBe(3);
  });

  it('does not retire a stale job in an abandoned lifecycle from a Worker write', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    abandonLifecycle('lc-1');
    publishVersion('lc-1', 2);

    // The abandonment write guard is CLM-18 work (Batch 7); this asserts only
    // that the CLM-19 pass does not label the job, which is L-01 territory.
    await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-a',
      failureCode: 'timeout',
      updatedAt: UPDATED_AT,
    });

    const job = await repository.findJob('lc-1', 1);
    expect(job?.terminalReason).toBeNull();
    expect(job?.state).toBe('pending');
  });

  it('does not retire a stale job in a closed lifecycle from a Worker write', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    closeLifecycle('lc-1');
    publishVersion('lc-1', 2);

    await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-a',
      terminalReason: 'lease_expired',
      updatedAt: UPDATED_AT,
    });

    const job = await repository.findJob('lc-1', 1);
    expect(job?.terminalReason).toBe('lease_expired');
  });

  it('rolls the retirement back when the fenced write throws', async () => {
    openLifecycle('lc-stale', 'a1:article-stale');
    createJob('lc-stale', 1);
    await claim('lc-stale', 1, { token: 'token-stale' });

    openLifecycle('lc-current', 'a1:article-current');
    createJob('lc-current', 1);
    await claim('lc-current', 1, { token: 'token-current' });

    publishVersion('lc-stale', 2);

    // `terminal_reason` is NOT NULL in the schema, so a null marker makes the
    // fenced UPDATE fail after the retirement pass has already run. That is the
    // only way to abort the transaction at that point, and it proves the two
    // statements commit or roll back together.
    const invalidReason = null as unknown as string;

    await expect(
      repository.markTerminal({
        lifecycleId: 'lc-current',
        processingVersion: 1,
        token: 'token-current',
        terminalReason: invalidReason,
        updatedAt: UPDATED_AT,
      }),
    ).rejects.toThrow();

    const stale = await repository.findJob('lc-stale', 1);
    expect(stale?.state).toBe('running');
    expect(stale?.terminalReason).toBeNull();
    expect(stale?.leaseToken).toBe('token-stale');

    const current = await repository.findJob('lc-current', 1);
    expect(current?.state).toBe('running');
  });
});

describe('requeue', () => {
  it('keeps the spent attempt — there is no refund (CLM-7)', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    const claimed = await claim('lc-1', 1, { token: 'token-a' });

    const requeued = await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-a',
      failureCode: 'empty_response',
      updatedAt: UPDATED_AT,
    });

    expect(requeued).toBe(true);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(claimed?.attempts);
    expect(job?.leaseToken).toBeNull();
    expect(job?.failureCode).toBe('empty_response');

    const reclaimed = await claim('lc-1', 1);
    expect(reclaimed?.attempts).toBe(2);
  });

  it('rejects a stale token and leaves the row untouched', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    const requeued = await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-stale',
      failureCode: 'timeout',
      updatedAt: UPDATED_AT,
    });

    expect(requeued).toBe(false);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.leaseToken).toBe('token-a');
  });

  it('refuses to requeue at the ceiling, leaving the job for terminalization', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);

    let token = '';
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt += 1) {
      const claimed = await claim('lc-1', 1);
      token = (await repository.findJob('lc-1', 1))?.leaseToken ?? '';
      expect(claimed?.attempts).toBe(attempt);
      if (attempt < MAX_PROCESSING_ATTEMPTS) {
        await repository.requeue({
          lifecycleId: 'lc-1',
          processingVersion: 1,
          token,
          failureCode: 'empty_response',
          updatedAt: UPDATED_AT,
        });
      }
    }

    const refused = await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token,
      failureCode: 'empty_response',
      updatedAt: UPDATED_AT,
    });

    expect(refused).toBe(false);
    expect((await repository.findJob('lc-1', 1))?.state).toBe('running');
  });
});

describe('markTerminal', () => {
  it('records the marker, clears the lease, and excludes the job from Claim', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    const written = await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-a',
      terminalReason: 'lease_expired',
      failureCode: 'timeout',
      updatedAt: UPDATED_AT,
    });

    expect(written).toBe(true);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('terminal');
    expect(job?.terminalReason).toBe('lease_expired');
    expect(job?.failureCode).toBe('timeout');
    expect(job?.leaseToken).toBeNull();
    expect(job?.leaseOwner).toBeNull();
    expect(job?.leaseExpiresAt).toBeNull();

    expect(await claim('lc-1', 1)).toBeUndefined();
  });

  it('rejects a stale token', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    const written = await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-stale',
      terminalReason: 'lease_expired',
      updatedAt: UPDATED_AT,
    });

    expect(written).toBe(false);
    expect((await repository.findJob('lc-1', 1))?.terminalReason).toBeNull();
  });

  it('cannot rewrite an outcome that already committed (CLM-19)', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-a',
      terminalReason: 'failed_terminal',
      updatedAt: UPDATED_AT,
    });

    const second = await repository.markTerminal({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-a',
      terminalReason: 'cancelled',
      updatedAt: UPDATED_AT,
    });

    expect(second).toBe(false);
    expect((await repository.findJob('lc-1', 1))?.terminalReason).toBe('failed_terminal');
  });
});

describe('reopenExpired (CLM-13)', () => {
  const EXPIRED = NOW + LEASE_MS + 1;

  it('reopens an expired running job that still has attempts', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    expect((await repository.findJob('lc-1', 1))?.state).toBe('running');

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(1);
    expect((await repository.findJob('lc-1', 1))?.state).toBe('pending');
  });

  it('clears every lease field when reopening', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    const job = await repository.findJob('lc-1', 1);
    expect(job?.leaseOwner).toBeNull();
    expect(job?.leaseToken).toBeNull();
    expect(job?.leaseExpiresAt).toBeNull();
  });

  it('preserves the attempts count', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect((await repository.findJob('lc-1', 1))?.attempts).toBe(1);
  });

  it('preserves existing failure metadata', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-1' });
    await repository.requeue({
      lifecycleId: 'lc-1',
      processingVersion: 1,
      token: 'token-1',
      failureCode: 'timeout',
      updatedAt: UPDATED_AT,
    });
    await claim('lc-1', 1, { token: 'token-2' });

    await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(2);
    expect(job?.failureCode).toBe('timeout');
    expect(job?.terminalReason).toBeNull();
  });

  it('does not reopen a lease that expires exactly at now', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    const reopened = await repository.reopenExpired({
      now: NOW + LEASE_MS,
      updatedAt: UPDATED_AT,
    });

    expect(reopened).toBe(0);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.leaseToken).toBe('token-a');
  });

  it('does not reopen a lease that has not expired', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });

    const reopened = await repository.reopenExpired({ now: NOW, updatedAt: UPDATED_AT });

    expect(reopened).toBe(0);
    expect((await repository.findJob('lc-1', 1))?.state).toBe('running');
  });

  it('leaves an exhausted expired job untouched', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);

    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt += 1) {
      await claim('lc-1', 1);
      if (attempt < MAX_PROCESSING_ATTEMPTS) {
        const token = (await repository.findJob('lc-1', 1))?.leaseToken ?? '';
        await repository.requeue({
          lifecycleId: 'lc-1',
          processingVersion: 1,
          token,
          failureCode: 'empty_response',
          updatedAt: UPDATED_AT,
        });
      }
    }

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(0);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.attempts).toBe(MAX_PROCESSING_ATTEMPTS);
    expect(job?.terminalReason).toBeNull();
  });

  it('does not rewrite a committed terminal job', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    insertTerminalJob('lc-1', 1, 'failed_terminal');

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(0);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('terminal');
    expect(job?.terminalReason).toBe('failed_terminal');
    expect(job?.attempts).toBe(3);
  });

  it('retires a stale unfinished job instead of reopening it', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    publishVersion('lc-1', 2);

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(0);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('terminal');
    expect(job?.terminalReason).toBe('superseded');
    expect(job?.leaseToken).toBeNull();
  });

  it('reopens a current-version job whose lifecycle has advanced', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    createJob('lc-1', 2);
    publishVersion('lc-1', 2);
    await claim('lc-1', 2, { token: 'token-current' });

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(1);
    expect((await repository.findJob('lc-1', 2))?.state).toBe('pending');
    expect((await repository.findJob('lc-1', 1))?.terminalReason).toBe('superseded');
  });

  it('does not reopen jobs in an abandoned lifecycle', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    abandonLifecycle('lc-1');

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(0);
    const job = await repository.findJob('lc-1', 1);
    expect(job?.state).toBe('running');
    expect(job?.leaseToken).toBe('token-a');
  });

  it('does not reopen jobs in a closed lifecycle', async () => {
    openLifecycle('lc-1', 'a1:article-1');
    createJob('lc-1', 1);
    await claim('lc-1', 1, { token: 'token-a' });
    closeLifecycle('lc-1');

    const reopened = await repository.reopenExpired({ now: EXPIRED, updatedAt: UPDATED_AT });

    expect(reopened).toBe(0);
    expect((await repository.findJob('lc-1', 1))?.state).toBe('running');
  });

  it('rolls back retirement and reopening together when the transaction fails', async () => {
    openLifecycle('lc-stale', 'a1:article-stale');
    createJob('lc-stale', 1);

    openLifecycle('lc-expired', 'a1:article-expired');
    createJob('lc-expired', 1);
    await claim('lc-expired', 1, { token: 'token-expired' });

    publishVersion('lc-stale', 2);

    // An object is not a bindable SQLite value, so the reopen statement throws
    // after the retirement pass has already run inside the transaction.
    const unbindableNow = {} as unknown as number;
    const RETRY_UPDATED_AT = '2026-11-28T00:00:00Z';

    await expect(
      repository.reopenExpired({ now: unbindableNow, updatedAt: RETRY_UPDATED_AT }),
    ).rejects.toThrow();

    // The retirement write would have stamped this row; an unchanged timestamp
    // is what proves it was rolled back rather than committed.
    const stale = await repository.findJob('lc-stale', 1);
    expect(stale?.state).toBe('pending');
    expect(stale?.terminalReason).toBeNull();
    expect(stale?.updatedAt).toBe('2026-11-27T00:00:00Z');

    const expired = await repository.findJob('lc-expired', 1);
    expect(expired?.state).toBe('running');
    expect(expired?.leaseToken).toBe('token-expired');
  });
});

describe('schema invariants', () => {
  it('allows at most one open lifecycle per article (A.1)', async () => {
    await repository.openLifecycle({
      lifecycleId: 'lc-1',
      articleId: 'a1:article-1',
      openedAt: '2026-11-27T00:00:00Z',
    });

    await expect(
      repository.openLifecycle({
        lifecycleId: 'lc-2',
        articleId: 'a1:article-1',
        openedAt: '2026-11-27T00:00:00Z',
      }),
    ).rejects.toThrow();
  });

  it('accepts a new lifecycle once the previous one is closed', async () => {
    openLifecycle('lc-1', 'a1:article-1', { closedAt: '2026-11-27T00:00:00Z' });

    await expect(
      repository.openLifecycle({
        lifecycleId: 'lc-2',
        articleId: 'a1:article-1',
        openedAt: '2026-11-27T00:00:00Z',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a job whose lifecycle does not exist', async () => {
    await expect(
      repository.createJob({
        lifecycleId: 'lc-missing',
        processingVersion: 1,
        createdAt: '2026-11-27T00:00:00Z',
      }),
    ).rejects.toThrow();
  });

  it('refuses a terminal row without a marker (CLM-1)', async () => {
    openLifecycle('lc-1', 'a1:article-1');

    expect(() =>
      database.query((connection) => {
        connection.all(
          `INSERT INTO processing_job
             (lifecycle_id, processing_version, state, attempts, created_at, updated_at)
           VALUES ('lc-1', 1, 'terminal', 3,
                   '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')`,
        );
      }),
    ).toThrow();
  });

  it('refuses a fractional attempt count (typeof guard)', async () => {
    openLifecycle('lc-1', 'a1:article-1');

    expect(() =>
      database.query((connection) => {
        connection.all(
          `INSERT INTO processing_job
             (lifecycle_id, processing_version, state, attempts, created_at, updated_at)
           VALUES ('lc-1', 1, 'pending', 1.5,
                   '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')`,
        );
      }),
    ).toThrow();
  });
});
