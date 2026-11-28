import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../../src/app.js';
import { openDatabase, type SqliteDatabase } from '../../../src/core/persistence/sqlite.js';
import { SqliteArticleDerivedRepository } from '../../../src/modules/derivation/repository/sqlite-article-derived.repository.js';

/**
 * The derived-record endpoint, exercised through the real router, the real error
 * envelope and the real SQLite repository.
 *
 * A stub repository would prove the handler's shape but not that the query and
 * the columns line up, which is the part of this endpoint that can actually break.
 */
let database: SqliteDatabase;
let app: ReturnType<typeof createApp>;

function insertArticle(id: string, order = 1): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
      [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, order],
    );
  });
}

function insertDerived(
  articleId: string,
  titleZh: string,
  summaryZh: string,
  at: string,
  category: string | null = '財經',
): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO article_derived
         (article_id, title_zh, summary_zh, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [articleId, titleZh, summaryZh, category, at, at],
    );
  });
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  app = createApp({ derivedArticles: new SqliteArticleDerivedRepository(database) });
});

afterEach(() => {
  database.close();
});

describe('GET /api/articles/:articleId/derived', () => {
  it('returns the stored record', async () => {
    insertArticle('a1');
    insertDerived(
      'a1',
      '繁體中文標題',
      '這是一段繁體中文摘要，長度符合契約要求。',
      '2026-02-01T00:00:00.000Z',
    );

    const response = await request(app).get('/api/articles/a1/derived');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      articleId: 'a1',
      titleZh: '繁體中文標題',
      summaryZh: '這是一段繁體中文摘要，長度符合契約要求。',
      category: '財經',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('reports a null category for a record derived before categories existed', async () => {
    insertArticle('a1');
    insertDerived('a1', '舊標題', '舊摘要內容。', '2026-02-01T00:00:00.000Z', null);

    const response = await request(app).get('/api/articles/a1/derived');

    expect(response.status).toBe(200);
    // Null, not a made-up label: nobody classified this record.
    expect(response.body.category).toBeNull();
  });

  it('answers with the latest write, not the first one', async () => {
    insertArticle('a1');
    insertDerived('a1', '第一版標題', '第一版摘要內容。', '2026-02-01T00:00:00.000Z');
    database.query((connection) => {
      connection.all(
        `UPDATE article_derived
            SET title_zh = ?, summary_zh = ?, updated_at = ?
          WHERE article_id = ?`,
        ['第二版標題', '第二版摘要內容。', '2026-03-01T00:00:00.000Z', 'a1'],
      );
    });

    const response = await request(app).get('/api/articles/a1/derived');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      titleZh: '第二版標題',
      summaryZh: '第二版摘要內容。',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('serves one article without leaking another', async () => {
    insertArticle('a1', 1);
    insertArticle('a2', 2);
    insertDerived('a1', '第一篇文章', '第一篇摘要。', '2026-02-01T00:00:00.000Z');
    insertDerived('a2', '第二篇文章', '第二篇摘要。', '2026-02-02T00:00:00.000Z');

    const response = await request(app).get('/api/articles/a2/derived');

    expect(response.status).toBe(200);
    expect(response.body.articleId).toBe('a2');
    expect(response.body.titleZh).toBe('第二篇文章');
  });

  it('answers 404 when the article has no derived record', async () => {
    insertArticle('a1');

    const response = await request(app).get('/api/articles/a1/derived');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'No derived article for a1' },
    });
  });

  it('answers 404 for an article id that does not exist', async () => {
    const response = await request(app).get('/api/articles/ghost/derived');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('is not mounted when the app was built without a derived reader', async () => {
    const bare = createApp();

    const response = await request(bare).get('/api/articles/a1/derived');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
