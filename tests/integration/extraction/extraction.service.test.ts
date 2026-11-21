import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { ExtractionService } from '../../../src/modules/extraction/extraction.service.js';
import {
  MAX_ATTEMPTS,
  MIN_CONTENT_LENGTH,
} from '../../../src/modules/extraction/extraction.constants.js';
import { ExtractionFailureError } from '../../../src/modules/extraction/extraction.errors.js';
import { SqliteArticleContentRepository } from '../../../src/modules/extraction/repository/sqlite-article-content.repository.js';

let database: SqliteDatabase;
let repository: SqliteArticleContentRepository;

const LONG_BODY = 'A substantial paragraph of real article prose for testing. '.repeat(20);

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body><article><p>${body}</p></article></body></html>`;
}

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

function urlLookup(): { findUrlById: (id: string) => Promise<string | undefined> } {
  return {
    findUrlById: async (id: string): Promise<string | undefined> => {
      const row = database.query((connection) =>
        connection.get('SELECT url FROM articles WHERE id = ?', [id]),
      ) as { url: string } | undefined;
      return row?.url;
    },
  };
}

function service(overrides: Partial<ConstructorParameters<typeof ExtractionService>[0]> = {}) {
  return new ExtractionService({
    repository,
    urls: urlLookup(),
    clock: { now: () => 1_000 },
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

describe('ExtractionService — success path', () => {
  it('extracts an article and stores it', async () => {
    insertArticle('a1', 1);
    const summary = await service({
      fetchPage: async () => ({
        html: html(LONG_BODY),
        finalUrl: 'https://example.com/a1',
        status: 200,
      }),
    }).run();

    expect(summary).toEqual({
      claimed: 1,
      extracted: 1,
      empty: 0,
      failed: 0,
      released: 0,
      lostClaims: 0,
      cancelled: false,
    });

    const row = await repository.findById('a1');
    expect(row?.status).toBe('extracted');
    expect(row?.contentText).toContain('substantial paragraph');
    expect(row?.contentLength).toBeGreaterThan(MIN_CONTENT_LENGTH);
  });

  it('stores the final URL from a redirect', async () => {
    insertArticle('a1', 1);
    await service({
      fetchPage: async () => ({
        html: html(LONG_BODY),
        finalUrl: 'https://example.com/moved/a1',
        status: 200,
      }),
    }).run();

    expect((await repository.findById('a1'))?.finalUrl).toBe('https://example.com/moved/a1');
  });

  it('processes several articles in one run', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    insertArticle('a3', 3);

    const summary = await service({
      fetchPage: async () => ({
        html: html(LONG_BODY),
        finalUrl: 'https://example.com/x',
        status: 200,
      }),
    }).run();

    expect(summary.extracted).toBe(3);
    expect(await repository.count()).toBe(3);
  });

  it('returns a zero summary for an empty queue', async () => {
    const summary = await service({
      fetchPage: async () => {
        throw new Error('must not fetch');
      },
    }).run();
    expect(summary.claimed).toBe(0);
    expect(summary.extracted).toBe(0);
  });
});

describe('ExtractionService — empty outcomes', () => {
  it('records NO_CONTENT when Readability finds no article at all', async () => {
    insertArticle('a1', 1);
    await service({
      // Readability returns null for a document with no extractable content.
      fetchPage: async () => ({
        html: '<html><body></body></html>',
        finalUrl: 'https://example.com/a1',
        status: 200,
      }),
    }).run();

    const row = await repository.findById('a1');
    expect(row?.status).toBe('empty');
    expect(row?.failureCode).toBe('NO_CONTENT');
  });

  it('records CONTENT_TOO_SHORT when Readability returns a short body', async () => {
    insertArticle('a1', 1);
    await service({
      // A nav-only document yields a few characters, not nothing.
      fetchPage: async () => ({
        html: '<html><body><nav>menu</nav></body></html>',
        finalUrl: 'https://example.com/a1',
        status: 200,
      }),
    }).run();

    const row = await repository.findById('a1');
    expect(row?.status).toBe('empty');
    expect(row?.failureCode).toBe('CONTENT_TOO_SHORT');
  });

  it('records CONTENT_TOO_SHORT for a stub below the minimum', async () => {
    insertArticle('a1', 1);
    await service({
      fetchPage: async () => ({
        html: html('Too short.'),
        finalUrl: 'https://example.com/a1',
        status: 200,
      }),
    }).run();

    const row = await repository.findById('a1');
    expect(row?.status).toBe('empty');
    expect(row?.failureCode).toBe('CONTENT_TOO_SHORT');
  });

  it('keeps extracted_at on an empty row, because the extraction completed', async () => {
    insertArticle('a1', 1);
    await service({
      fetchPage: async () => ({
        html: '<html><body><nav>menu</nav></body></html>',
        finalUrl: 'https://example.com/a1',
        status: 200,
      }),
    }).run();

    const row = await repository.findById('a1');
    expect(row?.extractedAt).not.toBeNull();
    expect(row?.finalUrl).toBe('https://example.com/a1');
  });
});

describe('ExtractionService — failures', () => {
  it('records a fetch failure and retries on the next run', async () => {
    insertArticle('a1', 1);
    await service({
      fetchPage: async () => {
        throw new ExtractionFailureError('TIMEOUT', 'timed out');
      },
    }).run();

    const row = await repository.findById('a1');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('TIMEOUT');
    expect(row?.attempts).toBe(1);
  });

  it('makes only one attempt per article per run', async () => {
    insertArticle('a1', 1);
    const summary = await service({
      fetchPage: async () => {
        throw new ExtractionFailureError('NETWORK_ERROR', 'boom');
      },
    }).run();

    // The row is failed and would be claimable again, but a single run must not
    // retry it: that would hammer the host and spend the whole attempt budget.
    expect(summary.claimed).toBe(1);
    expect((await repository.findById('a1'))?.attempts).toBe(1);
  });

  it('accumulates attempts across runs and stops at the bound', async () => {
    insertArticle('a1', 1);
    const failing = service({
      fetchPage: async () => {
        throw new ExtractionFailureError('NETWORK_ERROR', 'boom');
      },
    });

    for (let run = 0; run < MAX_ATTEMPTS; run += 1) {
      const summary = await failing.run();
      expect(summary.claimed).toBe(1);
    }

    expect((await repository.findById('a1'))?.attempts).toBe(MAX_ATTEMPTS);

    const exhausted = await failing.run();
    expect(exhausted.claimed).toBe(0);
  });

  it('still processes other articles after one fails', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);

    const summary = await service({
      fetchPage: async (url: string) => {
        if (url.endsWith('a1')) {
          throw new ExtractionFailureError('NETWORK_ERROR', 'boom');
        }
        return { html: html(LONG_BODY), finalUrl: url, status: 200 };
      },
    }).run();

    expect(summary.claimed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.extracted).toBe(1);
  });

  it('records a permanent failure once and does not retry', async () => {
    insertArticle('a1', 1);
    const notFound = service({
      fetchPage: async () => {
        throw new ExtractionFailureError('HTTP_404', 'gone', 404);
      },
    });

    await notFound.run();
    const second = await notFound.run();

    expect(second.claimed).toBe(0);
    const row = await repository.findById('a1');
    expect(row?.failureCode).toBe('HTTP_404');
    expect(row?.httpStatus).toBe(404);
  });

  it('maps an unexpected error to UNEXPECTED_ERROR rather than losing the attempt', async () => {
    insertArticle('a1', 1);
    await service({
      fetchPage: async () => {
        throw new TypeError('something unexpected');
      },
    }).run();

    const row = await repository.findById('a1');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('UNEXPECTED_ERROR');
  });

  it('records ARTICLE_URL_MISSING when the article row has no URL', async () => {
    // A content row whose article was deleted mid-run cannot happen through the
    // foreign key, so this simulates the lookup returning nothing.
    insertArticle('a1', 1);
    await service({
      urls: { findUrlById: async () => undefined },
      fetchPage: async () => {
        throw new Error('must not fetch');
      },
    }).run();

    const row = await repository.findById('a1');
    expect(row?.failureCode).toBe('ARTICLE_URL_MISSING');
  });
});

describe('ExtractionService — cancellation', () => {
  it('releases the claim when cancelled before the request is issued', async () => {
    insertArticle('a1', 1);
    let checks = 0;
    let fetched = false;

    const summary = await service({
      // False at the top of the loop, true after the claim is taken.
      isCancelled: (): boolean => {
        checks += 1;
        return checks > 1;
      },
      fetchPage: async () => {
        fetched = true;
        return { html: html(LONG_BODY), finalUrl: 'https://example.com/a1', status: 200 };
      },
    }).run();

    expect(summary.cancelled).toBe(true);
    expect(summary.released).toBe(1);
    expect(fetched).toBe(false);

    const row = await repository.findById('a1');
    // The attempt is refunded: nothing reached the remote host.
    expect(row?.attempts).toBe(0);
    expect(row?.leaseToken).toBeNull();
  });

  it('finishes the in-flight article when cancellation arrives after the request', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    let cancelled = false;

    const summary = await service({
      isCancelled: (): boolean => cancelled,
      fetchPage: async () => {
        // Cancellation arrives while the request is in flight.
        cancelled = true;
        return { html: html(LONG_BODY), finalUrl: 'https://example.com/a1', status: 200 };
      },
    }).run();

    expect(summary.extracted).toBe(1);
    expect(summary.cancelled).toBe(true);

    const first = await repository.findById('a1');
    expect(first?.status).toBe('extracted');
    // The second article was never claimed.
    expect((await repository.findById('a2'))?.status).toBe('failed');
    expect((await repository.findById('a2'))?.attempts).toBe(0);
  });

  it('does not claim anything when already cancelled', async () => {
    insertArticle('a1', 1);
    const summary = await service({
      isCancelled: () => true,
      fetchPage: async () => {
        throw new Error('must not fetch');
      },
    }).run();

    expect(summary.cancelled).toBe(true);
    expect(summary.claimed).toBe(0);
  });
});

describe('ExtractionService — concurrency guard', () => {
  it('rejects a concurrency other than 1', async () => {
    await expect(service({ concurrency: 2 }).run()).rejects.toThrow(/CONCURRENCY = 1/);
  });
});
