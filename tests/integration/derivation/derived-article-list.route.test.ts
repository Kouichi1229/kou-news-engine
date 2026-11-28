import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../../src/app.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { DERIVED_ARTICLE_LIST_LIMIT } from '../../../src/modules/derivation/derived-article.controller.js';
import { SqliteArticleDerivedRepository } from '../../../src/modules/derivation/repository/sqlite-article-derived.repository.js';

/**
 * `GET /api/articles/derived`, through the real router and the real schema.
 *
 * The seeded rows carry explicit `updated_at` values so the ordering assertion
 * tests the query rather than the clock.
 */
let database: SqliteDatabase;
let app: ReturnType<typeof createApp>;

const INSERT_DERIVED = `INSERT INTO article_derived
  (article_id, title_zh, summary_zh, category, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

function insertDerived(articleId: string, updatedAt: string, titleZh = `標題 ${articleId}`): void {
  database.query((connection) => {
    connection.all(INSERT_DERIVED, [
      articleId,
      titleZh,
      `${articleId} 的摘要內容。`,
      '財經',
      updatedAt,
      updatedAt,
    ]);
  });
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  app = createApp({ derivedArticles: new SqliteArticleDerivedRepository(database) });
});

afterEach(() => {
  database.close();
});

describe('GET /api/articles/derived', () => {
  it('answers 200 with an empty list when nothing has been derived', async () => {
    const response = await request(app).get('/api/articles/derived');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ articles: [] });
  });

  it('returns every derived record with its five fields', async () => {
    insertDerived('a1', '2026-02-01T00:00:00.000Z', '第一篇標題');
    insertDerived('a2', '2026-02-02T00:00:00.000Z', '第二篇標題');

    const response = await request(app).get('/api/articles/derived');

    expect(response.status).toBe(200);
    expect(response.body.articles).toHaveLength(2);
    expect(response.body.articles[1]).toEqual({
      articleId: 'a1',
      titleZh: '第一篇標題',
      summaryZh: 'a1 的摘要內容。',
      category: '財經',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('sorts by updatedAt, newest first, regardless of insert order', async () => {
    insertDerived('a1', '2026-02-02T00:00:00.000Z');
    insertDerived('a2', '2026-02-04T00:00:00.000Z');
    insertDerived('a3', '2026-02-03T00:00:00.000Z');
    insertDerived('a4', '2026-02-01T00:00:00.000Z');

    const response = await request(app).get('/api/articles/derived');

    expect(response.body.articles.map((item: { articleId: string }) => item.articleId)).toEqual([
      'a2',
      'a3',
      'a1',
      'a4',
    ]);
  });

  it('breaks a timestamp tie by article id so the order is stable', async () => {
    const same = '2026-02-02T00:00:00.000Z';
    insertDerived('b2', same);
    insertDerived('b1', same);

    const response = await request(app).get('/api/articles/derived');

    expect(response.body.articles.map((item: { articleId: string }) => item.articleId)).toEqual([
      'b1',
      'b2',
    ]);
  });

  it(`returns at most ${String(DERIVED_ARTICLE_LIST_LIMIT)} records, the newest ones`, async () => {
    const total = DERIVED_ARTICLE_LIST_LIMIT + 10;
    database.query((connection) => {
      for (let index = 0; index < total; index += 1) {
        // `a000`..`a059`, one minute apart so the newest is `a059`.
        const id = `a${String(index).padStart(3, '0')}`;
        const updatedAt = new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString();
        connection.all(INSERT_DERIVED, [
          id,
          `標題 ${id}`,
          `摘要 ${id}`,
          '財經',
          updatedAt,
          updatedAt,
        ]);
      }
    });

    const response = await request(app).get('/api/articles/derived');

    expect(response.status).toBe(200);
    expect(response.body.articles).toHaveLength(DERIVED_ARTICLE_LIST_LIMIT);
    expect(response.body.articles[0].articleId).toBe(`a${String(total - 1).padStart(3, '0')}`);
    expect(response.body.articles.at(-1).articleId).toBe(
      `a${String(total - DERIVED_ARTICLE_LIST_LIMIT).padStart(3, '0')}`,
    );
    // The ten oldest were dropped, not the ten newest.
    expect(
      response.body.articles.map((item: { articleId: string }) => item.articleId),
    ).not.toContain('a000');
  });

  it('is not mounted when the app was built without a derived reader', async () => {
    const response = await request(createApp()).get('/api/articles/derived');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
