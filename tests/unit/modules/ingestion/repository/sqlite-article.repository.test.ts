import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../../../../src/core/persistence/sqlite.js';
import { SqliteArticleRepository } from '../../../../../src/modules/ingestion/repository/sqlite-article.repository.js';
import type { Article } from '../../../../../src/types/article.js';

/**
 * Every database a test opens, released in `afterEach` so a failing assertion
 * cannot strand a connection.
 */
const openDatabases: SqliteDatabase[] = [];

afterEach(() => {
  const databases = openDatabases.splice(0);
  const failures: unknown[] = [];

  for (const database of databases) {
    if (!database.isOpen) {
      continue;
    }
    try {
      database.close();
    } catch (error) {
      // Keep going so one bad handle cannot strand the rest, then rethrow below
      // so the failure stays visible instead of being swallowed.
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close one or more SQLite databases');
  }
});

/**
 * A fresh `:memory:` database per call, registered for cleanup before the
 * repository wraps it, so a failure during construction still releases it.
 */
function createRepository(): { repository: SqliteArticleRepository; database: SqliteDatabase } {
  const database = openDatabase({ path: ':memory:' });
  openDatabases.push(database);
  return { repository: new SqliteArticleRepository(database), database };
}

function makeArticle(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    publishedAt: '2026-11-19T10:00:00.000Z',
    publishedAtIsEstimated: false,
    fetchedAt: '2026-11-19T12:00:00.000Z',
    sources: [
      {
        sourceId: 'src-a',
        url: `https://example.com/${id}`,
        resolvedUrl: `https://example.com/${id}`,
        canonicalUrl: `https://example.com/${id}`,
      },
    ],
    ...overrides,
  };
}

/** Counts provenance rows directly, to prove nothing was left behind. */
function countSources(database: SqliteDatabase, articleId?: string): number {
  return database.query((connection) => {
    const row =
      articleId === undefined
        ? connection.get('SELECT COUNT(*) AS total FROM article_sources')
        : connection.get('SELECT COUNT(*) AS total FROM article_sources WHERE article_id = ?', [
            articleId,
          ]);
    return Number((row as { total: unknown }).total);
  });
}

describe('SqliteArticleRepository — basic CRUD', () => {
  it('starts empty', async () => {
    const { repository } = createRepository();

    await expect(repository.count()).resolves.toBe(0);
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  it('saves and retrieves an article by id', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:one');

    await repository.save(article);

    await expect(repository.findById('a1:one')).resolves.toEqual(article);
    await expect(repository.has('a1:one')).resolves.toBe(true);
    await expect(repository.count()).resolves.toBe(1);
  });

  it('returns undefined and false for an unknown id', async () => {
    const { repository } = createRepository();

    await expect(repository.findById('a1:missing')).resolves.toBeUndefined();
    await expect(repository.has('a1:missing')).resolves.toBe(false);
  });

  it('round-trips every optional field', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:full', {
      summaryRaw: '<p>raw</p>',
      summaryText: 'text',
      publishedAtRaw: 'Tue, 19 Nov 2026 10:00:00 GMT',
      guid: 'guid-1',
      author: 'Author',
      language: 'en',
      tags: ['ai', 'ai', 'lab'],
      imageUrl: 'https://example.com/img.png',
    });

    await repository.save(article);

    await expect(repository.findById('a1:full')).resolves.toEqual(article);
  });

  it('round-trips an article with no optional fields', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:bare');

    await repository.save(article);
    const stored = await repository.findById('a1:bare');

    expect(stored).toEqual(article);
    expect(stored?.summaryRaw).toBeUndefined();
    expect(stored?.tags).toBeUndefined();
    expect(stored?.guid).toBeUndefined();
  });

  it('preserves a null publishedAt and the estimated flag', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:est', {
      publishedAt: null,
      publishedAtIsEstimated: true,
    });

    await repository.save(article);
    const stored = await repository.findById('a1:est');

    expect(stored?.publishedAt).toBeNull();
    expect(stored?.publishedAtIsEstimated).toBe(true);
  });

  it('preserves tag order and duplicates', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:tags', { tags: ['zeta', 'alpha', 'zeta'] });

    await repository.save(article);

    await expect(repository.findById('a1:tags')).resolves.toEqual(article);
  });

  it('deletes an article and its provenance', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));
    expect(countSources(database)).toBe(1);

    await repository.delete('a1:one');

    await expect(repository.has('a1:one')).resolves.toBe(false);
    await expect(repository.count()).resolves.toBe(0);
    expect(countSources(database)).toBe(0);
  });

  it('ignores a delete for a missing id', async () => {
    const { repository } = createRepository();

    await expect(repository.delete('a1:missing')).resolves.toBeUndefined();
    await expect(repository.count()).resolves.toBe(0);
  });

  it('clears every article and every provenance row', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:two'));
    expect(countSources(database)).toBe(2);

    await repository.clear();

    await expect(repository.count()).resolves.toBe(0);
    await expect(repository.findAll()).resolves.toEqual([]);
    expect(countSources(database)).toBe(0);
  });

  it('keeps the schema usable after clear', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.clear();

    await repository.save(makeArticle('a1:after'));

    await expect(repository.count()).resolves.toBe(1);
  });
});

describe('SqliteArticleRepository — insertion order', () => {
  it('returns articles in insertion order', async () => {
    const { repository } = createRepository();

    await repository.save(makeArticle('a1:c'));
    await repository.save(makeArticle('a1:a'));
    await repository.save(makeArticle('a1:b'));

    const ids = (await repository.findAll()).map((article) => article.id);
    expect(ids).toEqual(['a1:c', 'a1:a', 'a1:b']);
  });

  it('keeps the position of an updated article', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:first'));
    await repository.save(makeArticle('a1:second'));

    await repository.save(makeArticle('a1:first', { title: 'Updated' }));

    const articles = await repository.findAll();
    expect(articles.map((article) => article.id)).toEqual(['a1:first', 'a1:second']);
    expect(articles[0]?.title).toBe('Updated');
  });

  it('keeps the remaining order after deleting a middle article', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:two'));
    await repository.save(makeArticle('a1:three'));

    await repository.delete('a1:two');

    const ids = (await repository.findAll()).map((article) => article.id);
    expect(ids).toEqual(['a1:one', 'a1:three']);
  });

  it('assigns a fresh order after clear', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.clear();

    await repository.save(makeArticle('a1:x'));
    await repository.save(makeArticle('a1:y'));

    const ids = (await repository.findAll()).map((article) => article.id);
    expect(ids).toEqual(['a1:x', 'a1:y']);
  });

  it('does not collide with the DEFAULT 0 of the inserted_order column', async () => {
    const { repository } = createRepository();

    // Without an explicit value the first insert would take 0 and the second
    // would fail on the unique index.
    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:two'));
    await repository.save(makeArticle('a1:three'));

    await expect(repository.count()).resolves.toBe(3);
  });

  it('gives a new article an order above every existing one', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:two'));

    await repository.save(makeArticle('a1:three'));

    const orders = database.query((connection) =>
      connection.all('SELECT id, inserted_order FROM articles ORDER BY inserted_order'),
    ) as Array<{ id: string; inserted_order: number }>;
    expect(orders.map((row) => row.inserted_order)).toEqual([1, 2, 3]);
  });
});

describe('SqliteArticleRepository — upsert', () => {
  it('updates the stored article on a repeated save', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one', { title: 'First' }));

    await repository.save(makeArticle('a1:one', { title: 'Second' }));

    await expect(repository.count()).resolves.toBe(1);
    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Second');
  });

  it('does not change inserted_order on update', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));
    const before = database.query((connection) =>
      connection.get("SELECT inserted_order FROM articles WHERE id = 'a1:one'"),
    ) as { inserted_order: number };

    await repository.save(makeArticle('a1:one', { title: 'Updated' }));

    const after = database.query((connection) =>
      connection.get("SELECT inserted_order FROM articles WHERE id = 'a1:one'"),
    ) as { inserted_order: number };
    expect(after.inserted_order).toBe(before.inserted_order);
  });

  it('does not duplicate provenance on a repeated save', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));

    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:one'));

    expect(countSources(database, 'a1:one')).toBe(1);
  });

  it('does not shrink provenance when a later save carries fewer sources', async () => {
    const { repository, database } = createRepository();
    const both = makeArticle('a1:one', {
      sources: [
        {
          sourceId: 'src-a',
          url: 'https://example.com/a',
          resolvedUrl: 'https://example.com/a',
          canonicalUrl: 'https://example.com/a',
        },
        {
          sourceId: 'src-b',
          url: 'https://example.com/b',
          resolvedUrl: 'https://example.com/b',
          canonicalUrl: 'https://example.com/b',
        },
      ],
    });

    await repository.save(both);
    await repository.save(
      makeArticle('a1:one', {
        sources: [
          {
            sourceId: 'src-a',
            url: 'https://example.com/a',
            resolvedUrl: 'https://example.com/a',
            canonicalUrl: 'https://example.com/a',
          },
        ],
      }),
    );

    expect(countSources(database, 'a1:one')).toBe(2);
    const stored = await repository.findById('a1:one');
    expect(stored?.sources.map((source) => source.sourceId).sort()).toEqual(['src-a', 'src-b']);
  });
});

describe('SqliteArticleRepository — canonical URL uniqueness', () => {
  it('rejects a different id reusing a canonical url', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one', { canonicalUrl: 'https://example.com/shared' }));

    const conflicting = makeArticle('a1:two', {
      canonicalUrl: 'https://example.com/shared',
      sources: [
        {
          sourceId: 'src-b',
          url: 'https://example.com/shared',
          resolvedUrl: 'https://example.com/shared',
          canonicalUrl: 'https://example.com/shared',
        },
      ],
    });

    await expect(repository.save(conflicting)).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('leaves the original article untouched after a rejected save', async () => {
    const { repository, database } = createRepository();
    const original = makeArticle('a1:one', {
      canonicalUrl: 'https://example.com/shared',
      title: 'Original',
    });
    await repository.save(original);

    await expect(
      repository.save(
        makeArticle('a1:two', {
          canonicalUrl: 'https://example.com/shared',
          title: 'Intruder',
        }),
      ),
    ).rejects.toThrow();

    await expect(repository.findById('a1:one')).resolves.toEqual(original);
    await expect(repository.count()).resolves.toBe(1);
    expect(countSources(database, 'a1:two')).toBe(0);
  });

  it('leaves no partial provenance behind after a rejected save', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one', { canonicalUrl: 'https://example.com/shared' }));

    await expect(
      repository.save(
        makeArticle('a1:two', {
          canonicalUrl: 'https://example.com/shared',
          sources: [
            {
              sourceId: 'src-x',
              url: 'https://example.com/x',
              resolvedUrl: 'https://example.com/x',
              canonicalUrl: 'https://example.com/x',
            },
          ],
        }),
      ),
    ).rejects.toThrow();

    expect(countSources(database)).toBe(1);
    await expect(repository.has('a1:two')).resolves.toBe(false);
  });
});

describe('SqliteArticleRepository — provenance', () => {
  it('stores several sources', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:one', {
      sources: [
        {
          sourceId: 'src-a',
          url: 'https://example.com/a',
          resolvedUrl: 'https://example.com/a',
          canonicalUrl: 'https://example.com/a',
          guid: 'guid-a',
        },
        {
          sourceId: 'src-b',
          url: 'https://example.com/b',
          resolvedUrl: 'https://example.com/b',
          canonicalUrl: 'https://example.com/b',
        },
      ],
    });

    await repository.save(article);
    const stored = await repository.findById('a1:one');

    expect(stored?.sources).toHaveLength(2);
    expect(stored?.sources.map((source) => source.sourceId)).toEqual(['src-a', 'src-b']);
    expect(stored?.sources[0]?.guid).toBe('guid-a');
  });

  it('marks the first source as primary and the rest as not', async () => {
    const { repository, database } = createRepository();
    await repository.save(
      makeArticle('a1:one', {
        sources: [
          {
            sourceId: 'src-a',
            url: 'https://example.com/a',
            resolvedUrl: 'https://example.com/a',
            canonicalUrl: 'https://example.com/a',
          },
          {
            sourceId: 'src-b',
            url: 'https://example.com/b',
            resolvedUrl: 'https://example.com/b',
            canonicalUrl: 'https://example.com/b',
          },
        ],
      }),
    );

    const rows = database.query((connection) =>
      connection.all(
        "SELECT source_id, is_primary FROM article_sources WHERE article_id = 'a1:one' ORDER BY rowid",
      ),
    ) as Array<{ source_id: string; is_primary: number }>;

    expect(rows).toEqual([
      { source_id: 'src-a', is_primary: 1 },
      { source_id: 'src-b', is_primary: 0 },
    ]);
  });

  it('never leaves two primaries for one article', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));

    // A second save promoting a different source must move the flag, not add one.
    await repository.save(
      makeArticle('a1:one', {
        sources: [
          {
            sourceId: 'src-b',
            url: 'https://example.com/b',
            resolvedUrl: 'https://example.com/b',
            canonicalUrl: 'https://example.com/b',
          },
          {
            sourceId: 'src-a',
            url: 'https://example.com/a',
            resolvedUrl: 'https://example.com/a',
            canonicalUrl: 'https://example.com/a',
          },
        ],
      }),
    );

    const primaries = database.query((connection) =>
      connection.get(
        "SELECT COUNT(*) AS total FROM article_sources WHERE article_id = 'a1:one' AND is_primary = 1",
      ),
    ) as { total: number };
    expect(Number(primaries.total)).toBe(1);
  });

  it('reads provenance primary-first', async () => {
    const { repository } = createRepository();
    await repository.save(
      makeArticle('a1:one', {
        sources: [
          {
            sourceId: 'src-b',
            url: 'https://example.com/b',
            resolvedUrl: 'https://example.com/b',
            canonicalUrl: 'https://example.com/b',
          },
        ],
      }),
    );

    await repository.save(
      makeArticle('a1:one', {
        sources: [
          {
            sourceId: 'src-a',
            url: 'https://example.com/a',
            resolvedUrl: 'https://example.com/a',
            canonicalUrl: 'https://example.com/a',
          },
        ],
      }),
    );

    const stored = await repository.findById('a1:one');
    expect(stored?.sources[0]?.sourceId).toBe('src-a');
  });

  it('keeps A and B when a later save only carries A', async () => {
    const { repository } = createRepository();
    const sourceA = {
      sourceId: 'src-a',
      url: 'https://example.com/a',
      resolvedUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
    };
    const sourceB = {
      sourceId: 'src-b',
      url: 'https://example.com/b',
      resolvedUrl: 'https://example.com/b',
      canonicalUrl: 'https://example.com/b',
    };

    await repository.save(makeArticle('a1:one', { sources: [sourceA, sourceB] }));
    await repository.save(makeArticle('a1:one', { sources: [sourceA] }));

    const stored = await repository.findById('a1:one');
    expect(stored?.sources.map((source) => source.sourceId).sort()).toEqual(['src-a', 'src-b']);
  });

  it('keeps the existing primary when a save carries no sources', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one'));

    await repository.save(makeArticle('a1:one', { sources: [] }));

    const primaries = database.query((connection) =>
      connection.get(
        "SELECT COUNT(*) AS total FROM article_sources WHERE article_id = 'a1:one' AND is_primary = 1",
      ),
    ) as { total: number };
    expect(Number(primaries.total)).toBe(1);
    expect(countSources(database, 'a1:one')).toBe(1);
  });

  it('does not invent a primary for rows that predate the column', async () => {
    const { repository, database } = createRepository();
    // Simulate data written before v2, where every is_primary stayed 0.
    await repository.save(makeArticle('a1:one'));
    database.transaction((connection) => {
      connection.run("UPDATE article_sources SET is_primary = 0 WHERE article_id = 'a1:one'");
    });

    const stored = await repository.findById('a1:one');

    expect(stored?.sources).toHaveLength(1);
    const primaries = database.query((connection) =>
      connection.get(
        "SELECT COUNT(*) AS total FROM article_sources WHERE article_id = 'a1:one' AND is_primary = 1",
      ),
    ) as { total: number };
    expect(Number(primaries.total)).toBe(0);
  });
});

describe('SqliteArticleRepository — transaction rollback', () => {
  it('rolls back the article row when a provenance write fails', async () => {
    const { repository, database } = createRepository();
    // The article row is written first, so a failure in the provenance loop
    // proves the whole save is atomic rather than two independent writes.
    // A NULL source_id violates NOT NULL on article_sources.
    const broken = makeArticle('a1:new');
    (broken.sources[0] as { sourceId: unknown }).sourceId = null;

    await expect(repository.save(broken)).rejects.toThrow(/NOT NULL constraint failed/);

    await expect(repository.has('a1:new')).resolves.toBe(false);
    expect(countSources(database, 'a1:new')).toBe(0);
  });

  it('rolls back the article row when a later source fails', async () => {
    const { repository, database } = createRepository();
    const broken = makeArticle('a1:new', {
      sources: [
        {
          sourceId: 'src-a',
          url: 'https://example.com/a',
          resolvedUrl: 'https://example.com/a',
          canonicalUrl: 'https://example.com/a',
        },
      ],
    });
    // The first source inserts cleanly; the second fails, so the first must not
    // survive the rollback.
    broken.sources.push({
      sourceId: null as unknown as string,
      url: 'https://example.com/b',
      resolvedUrl: 'https://example.com/b',
      canonicalUrl: 'https://example.com/b',
    });

    await expect(repository.save(broken)).rejects.toThrow(/NOT NULL constraint failed/);

    await expect(repository.has('a1:new')).resolves.toBe(false);
    expect(countSources(database)).toBe(0);
  });

  it('leaves inserted_order consistent after a failed save', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:one', { canonicalUrl: 'https://example.com/dup' }));

    await expect(
      repository.save(makeArticle('a1:two', { canonicalUrl: 'https://example.com/dup' })),
    ).rejects.toThrow();

    // The failed insert must not have consumed an order value.
    const orders = database.query((connection) =>
      connection.all('SELECT inserted_order FROM articles ORDER BY inserted_order'),
    ) as Array<{ inserted_order: number }>;
    expect(orders.map((row) => row.inserted_order)).toEqual([1]);

    await repository.save(makeArticle('a1:three'));
    const after = database.query((connection) =>
      connection.all('SELECT id, inserted_order FROM articles ORDER BY inserted_order'),
    ) as Array<{ id: string; inserted_order: number }>;
    expect(after.map((row) => row.id)).toEqual(['a1:one', 'a1:three']);
  });

  it('keeps working after a rolled-back transaction', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one', { canonicalUrl: 'https://example.com/dup' }));

    await expect(
      repository.save(makeArticle('a1:two', { canonicalUrl: 'https://example.com/dup' })),
    ).rejects.toThrow();

    await repository.save(makeArticle('a1:three'));

    await expect(repository.count()).resolves.toBe(2);
    await expect(repository.has('a1:three')).resolves.toBe(true);
  });
});

describe('SqliteArticleRepository — saveMany is not atomic', () => {
  it('saves every article when all succeed', async () => {
    const { repository } = createRepository();

    await repository.saveMany([makeArticle('a1:one'), makeArticle('a1:two')]);

    const ids = (await repository.findAll()).map((article) => article.id);
    expect(ids).toEqual(['a1:one', 'a1:two']);
  });

  it('keeps earlier articles when a later one fails', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:occupied', { canonicalUrl: 'https://example.com/dup' }));

    await expect(
      repository.saveMany([
        makeArticle('a1:good'),
        makeArticle('a1:bad', { canonicalUrl: 'https://example.com/dup' }),
      ]),
    ).rejects.toThrow();

    await expect(repository.has('a1:good')).resolves.toBe(true);
    await expect(repository.has('a1:bad')).resolves.toBe(false);
  });

  it('rolls back only the failing article, keeping prior and skipping later ones', async () => {
    const { repository, database } = createRepository();
    await repository.save(makeArticle('a1:occupied', { canonicalUrl: 'https://example.com/dup' }));

    await expect(
      repository.saveMany([
        makeArticle('a1:first'),
        makeArticle('a1:bad', {
          canonicalUrl: 'https://example.com/dup',
          sources: [
            {
              sourceId: 'src-bad',
              url: 'https://example.com/bad',
              resolvedUrl: 'https://example.com/bad',
              canonicalUrl: 'https://example.com/bad',
            },
          ],
        }),
        makeArticle('a1:never'),
      ]),
    ).rejects.toThrow();

    await expect(repository.has('a1:first')).resolves.toBe(true);
    await expect(repository.has('a1:bad')).resolves.toBe(false);
    await expect(repository.has('a1:never')).resolves.toBe(false);
    expect(countSources(database, 'a1:bad')).toBe(0);
    expect(countSources(database, 'a1:first')).toBe(1);
  });

  it('does not swallow the error', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:occupied', { canonicalUrl: 'https://example.com/dup' }));

    await expect(
      repository.saveMany([makeArticle('a1:bad', { canonicalUrl: 'https://example.com/dup' })]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('lets a later duplicate id win', async () => {
    const { repository } = createRepository();

    await repository.saveMany([
      makeArticle('a1:one', { title: 'First' }),
      makeArticle('a1:one', { title: 'Second' }),
    ]);

    await expect(repository.count()).resolves.toBe(1);
    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Second');
  });
});

describe('SqliteArticleRepository — data isolation', () => {
  it('returns a fresh object so mutating it cannot corrupt the store', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one', { title: 'Original' }));

    const first = await repository.findById('a1:one');
    if (first !== undefined) {
      first.title = 'Mutated';
    }

    const second = await repository.findById('a1:one');
    expect(second?.title).toBe('Original');
  });

  it('returns a fresh sources array', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one'));

    const stored = await repository.findById('a1:one');
    const source = stored?.sources[0];
    if (source !== undefined) {
      source.sourceId = 'mutated';
      stored?.sources.push(source);
    }

    const reread = await repository.findById('a1:one');
    expect(reread?.sources).toHaveLength(1);
    expect(reread?.sources[0]?.sourceId).toBe('src-a');
  });

  it('returns a fresh tags array', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one', { tags: ['ai', 'ai', 'lab'] }));

    const stored = await repository.findById('a1:one');
    stored?.tags?.push('mutated');

    const reread = await repository.findById('a1:one');
    expect(reread?.tags).toEqual(['ai', 'ai', 'lab']);
  });

  it('isolates findAll results from each other', async () => {
    const { repository } = createRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:two'));

    const first = await repository.findAll();
    first[0]?.sources.push({
      sourceId: 'mutated',
      url: 'u',
      resolvedUrl: 'r',
      canonicalUrl: 'c',
    });

    const second = await repository.findAll();
    expect(second[0]?.sources).toHaveLength(1);
  });

  it('clones on save so mutating the caller object cannot corrupt the store', async () => {
    const { repository } = createRepository();
    const article = makeArticle('a1:one', { title: 'Original' });

    await repository.save(article);
    article.title = 'Mutated after save';

    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Original');
  });

  it('includes full provenance in findAll', async () => {
    const { repository } = createRepository();
    await repository.save(
      makeArticle('a1:one', {
        sources: [
          {
            sourceId: 'src-a',
            url: 'https://example.com/a',
            resolvedUrl: 'https://example.com/a',
            canonicalUrl: 'https://example.com/a',
          },
          {
            sourceId: 'src-b',
            url: 'https://example.com/b',
            resolvedUrl: 'https://example.com/b',
            canonicalUrl: 'https://example.com/b',
          },
        ],
      }),
    );
    await repository.save(makeArticle('a1:two'));

    const articles = await repository.findAll();

    expect(articles[0]?.sources).toHaveLength(2);
    expect(articles[1]?.sources).toHaveLength(1);
  });
});
