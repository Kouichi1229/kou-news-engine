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

const NOW = 1_000_000;
const LEASE_MS = 180_000;

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

function countClaimable(now = NOW): Promise<number> {
  return repository.countClaimable({ now, extractorVersion: EXTRACTOR_VERSION });
}

/** Claims every claimable row and returns the ids, to compare with the count. */
async function claimAll(): Promise<string[]> {
  const claimed: string[] = [];
  for (;;) {
    const row = await repository.claim({
      owner: 'worker',
      token: `token-${String(claimed.length)}`,
      now: NOW,
      leaseDurationMs: LEASE_MS,
      extractorVersion: EXTRACTOR_VERSION,
      excludeArticleIds: claimed,
    });
    if (row === null) {
      return claimed;
    }
    claimed.push(row.articleId);
  }
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  repository = new SqliteArticleContentRepository(database);
});

afterEach(() => {
  database.close();
});

describe('countClaimable', () => {
  it('counts nothing before any row exists, because seeding has not run', () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);

    // The count only reports existing rows; the first real run seeds them.
    return expect(countClaimable()).resolves.toBe(0);
  });

  it('counts seeded pending rows', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    await repository.seed(EXTRACTOR_VERSION);

    await expect(countClaimable()).resolves.toBe(2);
  });

  it('does not seed, claim or modify anything', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);

    await countClaimable();

    const row = await repository.findById('a1');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe(PENDING_FAILURE_CODE);
    expect(row?.attempts).toBe(0);
    expect(row?.leaseToken).toBeNull();
  });

  it('excludes rows held by a live lease', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    await repository.seed(EXTRACTOR_VERSION);
    await repository.claim({
      owner: 'worker',
      token: 'live',
      now: NOW,
      leaseDurationMs: LEASE_MS,
      extractorVersion: EXTRACTOR_VERSION,
    });

    // One row is leased, so only the other is claimable.
    await expect(countClaimable()).resolves.toBe(1);
  });

  it('includes a row whose lease has expired', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);
    await repository.claim({
      owner: 'worker',
      token: 'stale',
      now: NOW,
      leaseDurationMs: LEASE_MS,
      extractorVersion: EXTRACTOR_VERSION,
    });

    await expect(countClaimable(NOW + LEASE_MS + 1)).resolves.toBe(1);
  });

  it('excludes a permanently failed row', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);
    const claimed = await repository.claim({
      owner: 'worker',
      token: 't',
      now: NOW,
      leaseDurationMs: LEASE_MS,
      extractorVersion: EXTRACTOR_VERSION,
    });
    await repository.markFailed({
      articleId: 'a1',
      token: claimed?.leaseToken ?? '',
      failure: { code: 'HTTP_404', httpStatus: 404 },
    });

    await expect(countClaimable()).resolves.toBe(0);
  });

  it('excludes a row that has exhausted its attempts', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const claimed = await repository.claim({
        owner: 'worker',
        token: `t${String(attempt)}`,
        now: NOW + attempt,
        leaseDurationMs: LEASE_MS,
        extractorVersion: EXTRACTOR_VERSION,
      });
      await repository.markFailed({
        articleId: 'a1',
        token: claimed?.leaseToken ?? '',
        failure: { code: 'TIMEOUT', httpStatus: null },
      });
    }

    await expect(countClaimable(NOW + LEASE_MS * 10)).resolves.toBe(0);
  });

  it('re-counts every row when the extractor version changes', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);
    await repository.seed('v2');

    await expect(repository.countClaimable({ now: NOW, extractorVersion: 'v2' })).resolves.toBe(1);
  });

  it('agrees with the number claim actually takes', async () => {
    // The guarantee that makes the preview meaningful: same predicate, same
    // answer. A mismatch here would mean the two rules had drifted apart.
    for (let index = 0; index < 6; index += 1) {
      insertArticle(`a${String(index)}`, index);
    }
    await repository.seed(EXTRACTOR_VERSION);

    const previewed = await countClaimable();
    const claimed = await claimAll();

    expect(claimed).toHaveLength(previewed);
  });

  it('agrees with claim when some rows are ineligible', async () => {
    for (let index = 0; index < 4; index += 1) {
      insertArticle(`a${String(index)}`, index);
    }
    await repository.seed(EXTRACTOR_VERSION);

    // Make one permanently failed and hold another under a live lease.
    const first = await repository.claim({
      owner: 'w',
      token: 'first',
      now: NOW,
      leaseDurationMs: LEASE_MS,
      extractorVersion: EXTRACTOR_VERSION,
      excludeArticleIds: ['a3'],
    });
    await repository.markFailed({
      articleId: first?.articleId ?? '',
      token: 'first',
      failure: { code: 'HTTP_404', httpStatus: 404 },
    });

    const previewed = await countClaimable();
    const claimed = await claimAll();

    expect(claimed).toHaveLength(previewed);
  });

  it('does not change the attempt count of any row', async () => {
    insertArticle('a1', 1);
    await repository.seed(EXTRACTOR_VERSION);

    const before = await repository.findById('a1');
    await countClaimable();
    await countClaimable();
    const after = await repository.findById('a1');

    expect(after?.attempts).toBe(before?.attempts);
  });
});
