import { describe, expect, it } from 'vitest';

import { InMemoryArticleRepository } from '../../../../../src/modules/ingestion/repository/in-memory-article.repository.js';
import type { Article } from '../../../../../src/types/article.js';

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

describe('InMemoryArticleRepository', () => {
  it('starts empty', async () => {
    const repository = new InMemoryArticleRepository();

    await expect(repository.count()).resolves.toBe(0);
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  it('saves and retrieves an article by id', async () => {
    const repository = new InMemoryArticleRepository();
    const article = makeArticle('a1:one');

    await repository.save(article);

    await expect(repository.findById('a1:one')).resolves.toEqual(article);
    await expect(repository.has('a1:one')).resolves.toBe(true);
  });

  it('returns undefined for an unknown id', async () => {
    const repository = new InMemoryArticleRepository();

    await expect(repository.findById('a1:missing')).resolves.toBeUndefined();
    await expect(repository.has('a1:missing')).resolves.toBe(false);
  });

  it('replaces an existing article on save', async () => {
    const repository = new InMemoryArticleRepository();

    await repository.save(makeArticle('a1:one', { title: 'First' }));
    await repository.save(makeArticle('a1:one', { title: 'Second' }));

    await expect(repository.count()).resolves.toBe(1);
    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Second');
  });

  it('preserves insertion order in findAll', async () => {
    const repository = new InMemoryArticleRepository();

    await repository.save(makeArticle('a1:c'));
    await repository.save(makeArticle('a1:a'));
    await repository.save(makeArticle('a1:b'));

    const ids = (await repository.findAll()).map((article) => article.id);
    expect(ids).toEqual(['a1:c', 'a1:a', 'a1:b']);
  });

  it('returns a copy so mutating the result cannot corrupt the store', async () => {
    const repository = new InMemoryArticleRepository();
    await repository.save(makeArticle('a1:one', { title: 'Original' }));

    const first = await repository.findById('a1:one');
    if (first !== undefined) {
      first.title = 'Mutated';
    }

    const second = await repository.findById('a1:one');
    expect(second?.title).toBe('Original');
  });

  it('clones on save so mutating the caller object cannot corrupt the store', async () => {
    const repository = new InMemoryArticleRepository();
    const article = makeArticle('a1:one', { title: 'Original' });

    await repository.save(article);
    article.title = 'Mutated after save';

    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Original');
  });

  it('deep-copies the nested sources array', async () => {
    const repository = new InMemoryArticleRepository();
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

  it('deep-copies the nested tags array', async () => {
    const repository = new InMemoryArticleRepository();
    await repository.save(makeArticle('a1:one', { tags: ['ai', 'ai', 'lab'] }));

    const stored = await repository.findById('a1:one');
    stored?.tags?.push('mutated');

    const reread = await repository.findById('a1:one');
    expect(reread?.tags).toEqual(['ai', 'ai', 'lab']);
  });

  it('deletes an article', async () => {
    const repository = new InMemoryArticleRepository();
    await repository.save(makeArticle('a1:one'));

    await repository.delete('a1:one');

    await expect(repository.has('a1:one')).resolves.toBe(false);
    await expect(repository.count()).resolves.toBe(0);
  });

  it('ignores a delete for a missing id', async () => {
    const repository = new InMemoryArticleRepository();

    await expect(repository.delete('a1:missing')).resolves.toBeUndefined();
    await expect(repository.count()).resolves.toBe(0);
  });

  it('clears the store', async () => {
    const repository = new InMemoryArticleRepository();
    await repository.save(makeArticle('a1:one'));
    await repository.save(makeArticle('a1:two'));

    await repository.clear();

    await expect(repository.count()).resolves.toBe(0);
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  it('saveMany applies every article in order', async () => {
    const repository = new InMemoryArticleRepository();

    await repository.saveMany([makeArticle('a1:one'), makeArticle('a1:two')]);

    const ids = (await repository.findAll()).map((article) => article.id);
    expect(ids).toEqual(['a1:one', 'a1:two']);
  });

  it('saveMany lets a later duplicate id win', async () => {
    const repository = new InMemoryArticleRepository();

    await repository.saveMany([
      makeArticle('a1:one', { title: 'First' }),
      makeArticle('a1:one', { title: 'Second' }),
    ]);

    await expect(repository.count()).resolves.toBe(1);
    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Second');
  });

  it('saveMany clones its inputs', async () => {
    const repository = new InMemoryArticleRepository();
    const article = makeArticle('a1:one', { title: 'Original' });

    await repository.saveMany([article]);
    article.title = 'Mutated after saveMany';

    const stored = await repository.findById('a1:one');
    expect(stored?.title).toBe('Original');
  });

  it('saveMany is not atomic: earlier items stay saved when a later one fails', async () => {
    const repository = new InMemoryArticleRepository();
    // A function is not cloneable, so structuredClone throws. This documents the
    // absence of a rollback guarantee; Article values never contain functions.
    const uncloneable = { ...makeArticle('a1:bad'), bogus: () => undefined } as unknown as Article;

    await expect(repository.saveMany([makeArticle('a1:good'), uncloneable])).rejects.toThrow();

    await expect(repository.has('a1:good')).resolves.toBe(true);
    await expect(repository.has('a1:bad')).resolves.toBe(false);
  });
});
