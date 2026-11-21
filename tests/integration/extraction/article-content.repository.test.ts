import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import {
  EXTRACTOR_VERSION,
  MAX_ATTEMPTS,
  PENDING_FAILURE_CODE,
} from '../../../src/modules/extraction/extraction.constants.js';
import { SqliteArticleContentRepository } from '../../../src/modules/extraction/repository/sqlite-article-content.repository.js';

let database: SqliteDatabase;
let repository: SqliteArticleContentRepository;

/** Inserts an article row, which `article_contents` references. */
function insertArticle(id: string, order: number): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
      [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, order],
    );
  });
}

/**
 * Deterministic token source.
 *
 * A claim's token is unique per row, which the schema's partial unique index
 * enforces. A counter gives that uniqueness while keeping a failure
 * reproducible; a random token would make a collision dependent on luck.
 */
let tokenSequence = 0;

function nextToken(): string {
  tokenSequence += 1;
  return `token-${String(tokenSequence)}`;
}

function claim(overrides: Partial<Parameters<SqliteArticleContentRepository['claim']>[0]> = {}) {
  return repository.claim({
    owner: 'worker-1',
    token: nextToken(),
    now: 1_000,
    leaseDurationMs: 180_000,
    extractorVersion: EXTRACTOR_VERSION,
    ...overrides,
  });
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  repository = new SqliteArticleContentRepository(database);
});

afterEach(() => {
  database.close();
});

describe('seed', () => {
  it('creates one row per article', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    expect(await repository.seed(EXTRACTOR_VERSION)).toBe(2);
    expect(await repository.count()).toBe(2);
  });

  it('is idempotent', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);
    expect(await repository.seed(EXTRACTOR_VERSION)).toBe(0);
    expect(await repository.count()).toBe(1);
  });

  it('does nothing when there are no articles', async () => {
    expect(await repository.seed(EXTRACTOR_VERSION)).toBe(0);
  });

  it('creates rows in the failed/PENDING state', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);
    const row = await repository.findById('a1');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe(PENDING_FAILURE_CODE);
    expect(row?.attempts).toBe(0);
  });
});

describe('claim', () => {
  it('claims a seeded article and increments attempts', async () => {
    insertArticle('a1', 1);
    const claimed = await claim();
    expect(claimed?.articleId).toBe('a1');
    expect(claimed?.attempts).toBe(1);
  });

  it('returns null when the queue is empty', async () => {
    expect(await claim()).toBeNull();
  });

  it('records the lease owner, token and expiry', async () => {
    insertArticle('a1', 1);
    await claim({ owner: 'w1', token: 'tok', now: 5_000, leaseDurationMs: 1_000 });
    const row = await repository.findById('a1');
    expect(row?.status).toBe('in_progress');
    expect(row?.leaseOwner).toBe('w1');
    expect(row?.leaseToken).toBe('tok');
    expect(row?.leaseExpiresAt).toBe(6_000);
  });

  it('does not hand out a second article while one is leased', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    await claim({ token: 'tok1' });
    const second = await claim({ token: 'tok2' });
    // a1 is leased and unexpired, so a2 is next.
    expect(second?.articleId).toBe('a2');
  });

  it('returns null when every row is leased and unexpired', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    expect(await claim({ token: 'tok2' })).toBeNull();
  });

  it('takes over a row whose lease has expired', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1', now: 1_000, leaseDurationMs: 1_000 });
    const takeover = await claim({ token: 'tok2', now: 10_000 });
    expect(takeover?.articleId).toBe('a1');
    expect(takeover?.attempts).toBe(2);
  });

  it('does not take over an unexpired lease', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1', now: 1_000, leaseDurationMs: 100_000 });
    expect(await claim({ token: 'tok2', now: 1_500 })).toBeNull();
  });

  it('does not re-claim an extracted row at the same version', async () => {
    insertArticle('a1', 1);
    const first = await claim({ token: 'tok1' });
    await repository.complete({
      articleId: 'a1',
      token: 'tok1',
      success: {
        text: 'x'.repeat(300),
        finalUrl: 'https://example.com/a1',
        httpStatus: 200,
        extractedAt: '2026-01-01T00:00:00Z',
      },
    });
    expect(first).not.toBeNull();
    expect(await claim({ token: 'tok2', now: 1_000_000 })).toBeNull();
  });

  it('does not re-claim an empty row at the same version', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.markEmpty({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'NO_CONTENT', httpStatus: 200 },
      extractedAt: '2026-01-01T00:00:00Z',
      finalUrl: 'https://example.com/a1',
    });
    expect(await claim({ token: 'tok2', now: 1_000_000 })).toBeNull();
  });

  it('re-queues an extracted row when the extractor version changes', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.complete({
      articleId: 'a1',
      token: 'tok1',
      success: {
        text: 'x'.repeat(300),
        finalUrl: 'https://example.com/a1',
        httpStatus: 200,
        extractedAt: '2026-01-01T00:00:00Z',
      },
    });
    const reclaimed = await claim({ token: 'tok2', now: 2_000, extractorVersion: 'v2' });
    expect(reclaimed?.articleId).toBe('a1');
    // A version bump restarts the attempt count rather than continuing it.
    expect(reclaimed?.attempts).toBe(1);
  });

  it(`stops re-claiming a failed row after ${String(MAX_ATTEMPTS)} attempts`, async () => {
    insertArticle('a1', 1);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claimed = await claim({ token: `tok${String(attempt)}` });
      expect(claimed?.attempts).toBe(attempt);
      await repository.markFailed({
        articleId: 'a1',
        token: `tok${String(attempt)}`,
        failure: { code: 'TIMEOUT', httpStatus: null },
      });
    }
    expect(await claim({ token: 'tok-final', now: 9_999_999 })).toBeNull();
  });

  it('never re-claims a permanently failed row at the same version', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.markFailed({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'HTTP_404', httpStatus: 404 },
    });
    expect(await claim({ token: 'tok2', now: 9_999_999 })).toBeNull();
  });

  it('re-queues a permanently failed row after a version bump', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.markFailed({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'HTTP_404', httpStatus: 404 },
    });
    const reclaimed = await claim({ token: 'tok2', now: 9_999_999, extractorVersion: 'v2' });
    expect(reclaimed?.articleId).toBe('a1');
  });

  it('never re-claims a DECODE_FAILED row at the same version', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.markFailed({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'DECODE_FAILED', httpStatus: 200 },
    });
    expect(await claim({ token: 'tok2', now: 9_999_999 })).toBeNull();
  });

  it('re-queues a DECODE_FAILED row after a version bump, resetting attempts', async () => {
    insertArticle('a1', 1);
    const first = await claim({ token: 'tok1' });
    await repository.markFailed({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'DECODE_FAILED', httpStatus: 200 },
    });

    const reclaimed = await claim({ token: 'tok2', now: 9_999_999, extractorVersion: 'v2' });

    expect(reclaimed?.articleId).toBe('a1');
    // A new version starts its own attempt budget rather than inheriting the
    // previous one's count.
    expect(reclaimed?.attempts).toBe(1);
    // The fencing rule holds: a new claim must carry a token no earlier lease had.
    expect(reclaimed?.leaseToken).toBe('tok2');
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
  });
});

describe('complete', () => {
  it('stores the text and computes the length', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    const text = '內容'.repeat(150);
    const ok = await repository.complete({
      articleId: 'a1',
      token: 'tok1',
      success: {
        text,
        finalUrl: 'https://example.com/a1',
        httpStatus: 200,
        extractedAt: '2026-01-01T00:00:00Z',
      },
    });
    expect(ok).toBe(true);
    const row = await repository.findById('a1');
    expect(row?.status).toBe('extracted');
    expect(row?.contentText).toBe(text);
    expect(row?.contentLength).toBe(300);
    expect(row?.leaseToken).toBeNull();
  });

  it('computes the length in code points for astral characters', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    const text = '😀'.repeat(250);
    await repository.complete({
      articleId: 'a1',
      token: 'tok1',
      success: { text, finalUrl: 'https://example.com/a1', httpStatus: 200, extractedAt: 't' },
    });
    const row = await repository.findById('a1');
    // SQLite's length() counts code points, matching the normaliser.
    expect(row?.contentLength).toBe(250);
  });

  it('rejects a write with a stale token and reports false', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    const ok = await repository.complete({
      articleId: 'a1',
      token: 'stale',
      success: { text: 'x'.repeat(300), finalUrl: 'u', httpStatus: 200, extractedAt: 't' },
    });
    expect(ok).toBe(false);
    // The original claim is untouched.
    expect((await repository.findById('a1'))?.status).toBe('in_progress');
  });

  it('rejects a write after another worker took over the expired lease', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1', now: 1_000, leaseDurationMs: 1_000 });
    await claim({ token: 'tok2', now: 10_000 });

    const stale = await repository.complete({
      articleId: 'a1',
      token: 'tok1',
      success: { text: 'x'.repeat(300), finalUrl: 'u', httpStatus: 200, extractedAt: 't' },
    });
    expect(stale).toBe(false);

    const current = await repository.complete({
      articleId: 'a1',
      token: 'tok2',
      success: { text: 'y'.repeat(300), finalUrl: 'u', httpStatus: 200, extractedAt: 't' },
    });
    expect(current).toBe(true);
  });
});

describe('markEmpty', () => {
  it('stores an empty row with its code and URL', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    const ok = await repository.markEmpty({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'CONTENT_TOO_SHORT', httpStatus: 200 },
      extractedAt: '2026-01-01T00:00:00Z',
      finalUrl: 'https://example.com/a1',
    });
    expect(ok).toBe(true);
    const row = await repository.findById('a1');
    expect(row?.status).toBe('empty');
    expect(row?.failureCode).toBe('CONTENT_TOO_SHORT');
    expect(row?.contentText).toBeNull();
    expect(row?.extractedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('refuses a code that is not an empty code', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await expect(
      repository.markEmpty({
        articleId: 'a1',
        token: 'tok1',
        failure: { code: 'TIMEOUT', httpStatus: null },
        extractedAt: 't',
        finalUrl: 'u',
      }),
    ).rejects.toThrow(/Not an empty failure code/);
  });
});

describe('markFailed', () => {
  it('stores the code and http status', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    const ok = await repository.markFailed({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'HTTP_500', httpStatus: 500 },
    });
    expect(ok).toBe(true);
    const row = await repository.findById('a1');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('HTTP_500');
    expect(row?.httpStatus).toBe(500);
    expect(row?.contentText).toBeNull();
  });

  it('stores a failure with no http status', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.markFailed({
      articleId: 'a1',
      token: 'tok1',
      failure: { code: 'TIMEOUT', httpStatus: null },
    });
    expect((await repository.findById('a1'))?.httpStatus).toBeNull();
  });
});

describe('release', () => {
  it('returns the row to the queue and refunds the attempt', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    const ok = await repository.release({ articleId: 'a1', token: 'tok1' });
    expect(ok).toBe(true);
    const row = await repository.findById('a1');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe(PENDING_FAILURE_CODE);
    expect(row?.attempts).toBe(0);
    expect(row?.leaseToken).toBeNull();
  });

  it('makes the row immediately claimable again', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.release({ articleId: 'a1', token: 'tok1' });
    const reclaimed = await claim({ token: 'tok2', now: 1_000 });
    expect(reclaimed?.articleId).toBe('a1');
    expect(reclaimed?.attempts).toBe(1);
  });

  it('refuses a stale token', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    expect(await repository.release({ articleId: 'a1', token: 'stale' })).toBe(false);
  });

  it('does not let repeated releases drive attempts negative', async () => {
    insertArticle('a1', 1);
    await claim({ token: 'tok1' });
    await repository.release({ articleId: 'a1', token: 'tok1' });
    // The row is no longer in_progress, so a second release affects no rows.
    await repository.release({ articleId: 'a1', token: 'tok1' });
    expect((await repository.findById('a1'))?.attempts).toBe(0);
  });
});
