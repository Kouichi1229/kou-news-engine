import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeProvider } from '../../../src/core/llm/fake.provider.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import {
  ArticleDerivationService,
  DERIVATION_LIMITS,
} from '../../../src/modules/derivation/derivation.service.js';
import { createDerivationHook } from '../../../src/modules/derivation/derivation.bootstrap.js';
import { SqliteArticleDerivedRepository } from '../../../src/modules/derivation/repository/sqlite-article-derived.repository.js';
import { MAX_ATTEMPTS } from '../../../src/modules/extraction/extraction.constants.js';
import { ExtractionService } from '../../../src/modules/extraction/extraction.service.js';
import { SqliteArticleContentRepository } from '../../../src/modules/extraction/repository/sqlite-article-content.repository.js';

/**
 * The vertical slice: extraction success → one provider call → `article_derived`.
 *
 * Everything below the provider is real — the migrations, both repositories and
 * the extraction service — so these tests cover the wiring rather than a stand-in
 * for it. The provider is the existing `FakeProvider`, scripted with the JSON a
 * real model is asked to return.
 */
let database: SqliteDatabase;
let contents: SqliteArticleContentRepository;
let derived: SqliteArticleDerivedRepository;

const BODY = 'A substantial paragraph of real article prose for testing. '.repeat(20);

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body><article><p>${body}</p></article></body></html>`;
}

function summaryOf(chars: number): string {
  return '這'.repeat(chars);
}

function modelReply(summaryChars = 120, titleZh = '繁體中文標題'): string {
  return JSON.stringify({ title_zh: titleZh, summary_zh: summaryOf(summaryChars) });
}

function insertArticle(id: string, order = 1, title = 'Original English Title'): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
      [id, title, `https://example.com/${id}`, `https://example.com/${id}`, order],
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

function derivation(provider: FakeProvider): ArticleDerivationService {
  return new ArticleDerivationService({
    provider,
    repository: derived,
    now: (): number => Date.parse('2026-02-01T00:00:00Z'),
  });
}

function runExtraction(provider: FakeProvider, body = BODY) {
  return new ExtractionService({
    repository: contents,
    urls: urlLookup(),
    clock: { now: () => 1_000 },
    fetchPage: async () => ({
      html: html(body),
      finalUrl: 'https://example.com/a1',
      status: 200,
    }),
    deriveArticle: async (articleId, text): Promise<void> => {
      await derivation(provider).derive(articleId, text);
    },
  }).run();
}

function derivedRows(): Array<Record<string, unknown>> {
  return database.query((connection) =>
    connection.all('SELECT * FROM article_derived ORDER BY article_id'),
  ) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  contents = new SqliteArticleContentRepository(database);
  derived = new SqliteArticleDerivedRepository(database);
});

afterEach(() => {
  database.close();
});

describe('extraction → derivation → article_derived', () => {
  it('stores the Chinese title and summary after a successful extraction', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, 'AI 模型發布') }],
    });

    const summary = await runExtraction(provider);

    expect(summary).toEqual({
      claimed: 1,
      extracted: 1,
      empty: 0,
      failed: 0,
      released: 0,
      lostClaims: 0,
      cancelled: false,
    });
    expect(derivedRows()).toEqual([
      {
        article_id: 'a1',
        title_zh: 'AI 模型發布',
        summary_zh: summaryOf(120),
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('sends the article title and extracted body to the provider', async () => {
    insertArticle('a1', 1, 'Gemini Releases A New Model');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply() }],
    });

    await runExtraction(provider);

    expect(provider.receivedRequests).toHaveLength(1);
    const request = provider.receivedRequests[0];
    expect(request?.prompt).toContain('Gemini Releases A New Model');
    expect(request?.prompt).toContain('A substantial paragraph of real article prose');
    expect(request?.systemInstruction).toContain('繁體中文');
    expect(request?.maxOutputTokens).toBe(DERIVATION_LIMITS.maxOutputTokens);
  });

  it('fails the attempt when the model answer is not JSON', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: '這裡是一段摘要，但不是 JSON。' }],
    });

    const service = new ExtractionService({
      repository: contents,
      urls: urlLookup(),
      clock: { now: () => 1_000 },
      fetchPage: async () => ({
        html: html(BODY),
        finalUrl: 'https://example.com/a1',
        status: 200,
      }),
      deriveArticle: async (articleId, text): Promise<void> => {
        await derivation(provider).derive(articleId, text);
      },
    });

    const summary = await service.run();

    expect(summary.extracted).toBe(0);
    expect(summary.failed).toBe(1);
    expect(derivedRows()).toEqual([]);
    expect(await contents.findById('a1')).toMatchObject({
      status: 'failed',
      failureCode: 'DERIVATION_FAILED',
    });
  });

  it('fails the attempt when the provider call fails', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({ responses: [{ kind: 'error', error: 'unavailable' }] });

    const summary = await runExtraction(provider);
    const row = await contents.findById('a1');

    expect(summary.extracted).toBe(0);
    expect(summary.failed).toBe(1);
    expect(row).toMatchObject({
      status: 'failed',
      failureCode: 'DERIVATION_FAILED',
      attempts: 1,
      leaseToken: null,
    });
    expect(derivedRows()).toEqual([]);
  });

  it('fails the attempt when the model output does not satisfy the contract', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, '   ') }],
    });

    const summary = await runExtraction(provider);
    const row = await contents.findById('a1');

    expect(summary.extracted).toBe(0);
    expect(summary.failed).toBe(1);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'DERIVATION_FAILED', attempts: 1 });
    expect(derivedRows()).toEqual([]);
  });

  it('completes the row only once the derived record is stored', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, '成功標題') }],
    });

    const summary = await runExtraction(provider);

    expect(summary.extracted).toBe(1);
    expect((await contents.findById('a1'))?.status).toBe('extracted');
    expect(derivedRows()).toHaveLength(1);
  });

  it('does not fetch the page again when the retry only has to derive', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [
        { kind: 'error', error: 'unavailable' },
        { kind: 'success', text: modelReply(120, '第二次才成功') },
      ],
    });
    const fetches: string[] = [];
    const service = new ExtractionService({
      repository: contents,
      urls: urlLookup(),
      clock: { now: () => 1_000 },
      fetchPage: async (url) => {
        fetches.push(url);
        return { html: html(BODY), finalUrl: 'https://example.com/a1', status: 200 };
      },
      deriveArticle: async (articleId, text): Promise<void> => {
        await derivation(provider).derive(articleId, text);
      },
    });

    const first = await service.run();
    const failedRow = await contents.findById('a1');
    const second = await service.run();
    const row = await contents.findById('a1');

    expect(first.failed).toBe(1);
    // The body survived the failed attempt, so the retry had nothing to fetch.
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.contentText).not.toBeNull();
    expect(second.extracted).toBe(1);
    expect(fetches).toEqual(['https://example.com/a1']);
    expect(row).toMatchObject({ status: 'extracted', attempts: 2 });
    expect(derivedRows()).toMatchObject([{ article_id: 'a1', title_zh: '第二次才成功' }]);
  });

  it('fetches again when the previous attempt produced no body', async () => {
    insertArticle('a1');
    // Only one derivation call happens: the first run never reaches the model.
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, '重試標題') }],
    });
    let attempts = 0;
    const service = new ExtractionService({
      repository: contents,
      urls: urlLookup(),
      clock: { now: () => 1_000 },
      fetchPage: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('network down');
        }
        return { html: html(BODY), finalUrl: 'https://example.com/a1', status: 200 };
      },
      deriveArticle: async (articleId, text): Promise<void> => {
        await derivation(provider).derive(articleId, text);
      },
    });

    const first = await service.run();
    const second = await service.run();

    expect(first.failed).toBe(1);
    expect(second.extracted).toBe(1);
    expect(attempts).toBe(2);
    expect((await contents.findById('a1'))?.contentText).not.toBeNull();
  });

  it('succeeds on a retry after a failing derivation', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [
        { kind: 'error', error: 'unavailable' },
        { kind: 'success', text: modelReply(120, '重試成功標題') },
      ],
    });

    const first = await runExtraction(provider);
    const second = await runExtraction(provider);
    const row = await contents.findById('a1');

    expect(first.failed).toBe(1);
    expect(second.extracted).toBe(1);
    expect(row).toMatchObject({ status: 'extracted', attempts: 2, failureCode: null });
    expect(derivedRows()).toMatchObject([{ article_id: 'a1', title_zh: '重試成功標題' }]);
  });

  it('stops retrying at the attempt ceiling and leaves the row failed', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({ responses: [{ kind: 'error', error: 'unavailable' }] });

    const runs = [
      await runExtraction(provider),
      await runExtraction(provider),
      await runExtraction(provider),
    ];
    const exhausted = await runExtraction(provider);
    const row = await contents.findById('a1');

    expect(runs.map((run) => run.failed)).toEqual([1, 1, 1]);
    expect(exhausted.claimed).toBe(0);
    expect(row).toMatchObject({
      status: 'failed',
      failureCode: 'DERIVATION_FAILED',
      attempts: MAX_ATTEMPTS,
    });
    expect(derivedRows()).toEqual([]);
  });

  it('does not call the model for an article whose body was not stored', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply() }],
    });

    const summary = await runExtraction(provider, 'too short');

    expect(summary.empty).toBe(1);
    expect(summary.extracted).toBe(0);
    expect(provider.receivedRequests).toEqual([]);
    expect(derivedRows()).toEqual([]);
  });
});

describe('ArticleDerivationService — output contract', () => {
  it('rejects a summary outside 100-150 characters', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(99) }],
    });

    await expect(derivation(provider).derive('a1', BODY)).rejects.toMatchObject({
      reason: 'summary-length',
    });
    expect(derivedRows()).toEqual([]);
  });

  it('writes no row when the model returns a blank title', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, '   \n ') }],
    });

    await expect(derivation(provider).derive('a1', BODY)).rejects.toMatchObject({
      reason: 'invalid-output',
    });
    expect(derivedRows()).toEqual([]);
  });

  it('writes no row when the model returns a blank summary', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [
        { kind: 'success', text: JSON.stringify({ title_zh: '標題', summary_zh: '   ' }) },
      ],
    });

    await expect(derivation(provider).derive('a1', BODY)).rejects.toMatchObject({
      reason: 'invalid-output',
    });
    expect(derivedRows()).toEqual([]);
  });

  it('writes no row when the model omits the summary field', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: JSON.stringify({ title_zh: '標題' }) }],
    });

    await expect(derivation(provider).derive('a1', BODY)).rejects.toMatchObject({
      reason: 'invalid-output',
    });
    expect(derivedRows()).toEqual([]);
  });

  it('stores the trimmed title and summary, not the padded ones', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, '  人工智慧監管新規  ') }],
    });

    await derivation(provider).derive('a1', BODY);

    const rows = derivedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['title_zh']).toBe('人工智慧監管新規');
  });

  it('accepts both ends of the range', async () => {
    insertArticle('a1');
    insertArticle('a2', 2);
    const provider = new FakeProvider({
      responses: [
        { kind: 'success', text: modelReply(DERIVATION_LIMITS.minSummaryChars) },
        { kind: 'success', text: modelReply(DERIVATION_LIMITS.maxSummaryChars) },
      ],
    });
    const service = derivation(provider);

    await service.derive('a1', BODY);
    await service.derive('a2', BODY);

    expect(derivedRows().map((row) => (row['summary_zh'] as string).length)).toEqual([100, 150]);
  });

  it('replaces an earlier record and keeps created_at', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [
        { kind: 'success', text: modelReply(110, '第一版標題') },
        { kind: 'success', text: modelReply(110, '第二版標題') },
      ],
    });

    const first = new ArticleDerivationService({
      provider,
      repository: derived,
      now: () => Date.parse('2026-02-01T00:00:00Z'),
    });
    await first.derive('a1', BODY);

    const second = new ArticleDerivationService({
      provider,
      repository: derived,
      now: () => Date.parse('2026-03-01T00:00:00Z'),
    });
    await second.derive('a1', BODY);

    expect(derivedRows()).toEqual([
      {
        article_id: 'a1',
        title_zh: '第二版標題',
        summary_zh: summaryOf(110),
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
      },
    ]);
  });

  it('reports a missing article row instead of calling the model', async () => {
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply() }],
    });

    await expect(derivation(provider).derive('ghost', BODY)).rejects.toMatchObject({
      reason: 'article-missing',
    });
    expect(provider.receivedRequests).toEqual([]);
  });
});

describe('createDerivationHook — the wiring the extraction CLI uses', () => {
  const silent = { info: () => undefined, warn: () => undefined };

  it('provides no hook when the environment selects the unscripted fake provider', async () => {
    // The test environment leaves `LLM_PROVIDER` unset, which defaults to `fake`.
    const hook = await createDerivationHook({ database, now: () => 0, log: silent });

    expect(hook.deriveArticle).toBeUndefined();
  });

  it('builds a hook that stores a record through an injected provider', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: modelReply(120, '注入的標題') }],
    });

    const hook = await createDerivationHook({
      database,
      now: () => Date.parse('2026-02-01T00:00:00Z'),
      log: silent,
      provider,
    });
    await hook.deriveArticle?.('a1', BODY);

    expect(derivedRows()).toEqual([
      {
        article_id: 'a1',
        title_zh: '注入的標題',
        summary_zh: summaryOf(120),
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('propagates a provider failure so extraction records the attempt', async () => {
    insertArticle('a1');
    const provider = new FakeProvider({ responses: [{ kind: 'error', error: 'unavailable' }] });

    const hook = await createDerivationHook({ database, now: () => 0, log: silent, provider });

    await expect(hook.deriveArticle?.('a1', BODY)).rejects.toThrow();
    expect(derivedRows()).toEqual([]);
  });
});
