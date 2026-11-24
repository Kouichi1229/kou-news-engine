import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IMPLEMENTATIONS,
  makeArticle,
  makeSource,
  sourceUrls,
  type RepositoryHarness,
} from '../../../../helpers/repository-harness.js';

/**
 * Contract every `ArticleRepository` must satisfy.
 *
 * Only behaviour observable through the interface is asserted: `provenance_id`,
 * `first_seen_at`, `is_primary` and `source_order` are storage details and are
 * never queried here. Every test states its own expected literal rather than
 * comparing the two implementations, so a bug shared by both still fails.
 *
 * C11 (saveMany non-atomicity) is deliberately absent: the in-memory store fails
 * on an uncloneable value while SQLite fails on a constraint, so no single
 * fixture can drive both. Each implementation keeps its own test for it.
 */
describe.each(IMPLEMENTATIONS)('%s — ArticleRepository contract', (_name, create) => {
  let harness: RepositoryHarness | undefined;

  beforeEach(() => {
    harness = create();
  });

  afterEach(() => {
    try {
      // `create()` can throw, in which case there is nothing to release. Guarding
      // here keeps that original failure visible instead of a TypeError from
      // dereferencing undefined.
      harness?.cleanup();
    } finally {
      // Reset even when cleanup throws, so the next test never inherits a stale
      // harness. The cleanup error still propagates to Vitest.
      harness = undefined;
    }
  });

  describe('article CRUD and ordering', () => {
    it('C01 stores an article and reads it back by id', async () => {
      const article = makeArticle('a1:x', {
        title: 'Stored title',
        summaryRaw: '<p>raw</p>',
        summaryText: 'raw',
        author: 'Ada',
        language: 'en',
        tags: ['ai', 'lab'],
        imageUrl: 'https://example.com/x.png',
      });

      await harness!.repository.save(article);
      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.id).toBe('a1:x');
      expect(stored?.title).toBe('Stored title');
      expect(stored?.url).toBe('https://example.com/a1:x');
      expect(stored?.canonicalUrl).toBe('https://example.com/a1:x');
      expect(stored?.publishedAt).toBe('2026-11-19T10:00:00.000Z');
      expect(stored?.publishedAtIsEstimated).toBe(false);
      expect(stored?.fetchedAt).toBe('2026-11-19T12:00:00.000Z');
      expect(stored?.summaryRaw).toBe('<p>raw</p>');
      expect(stored?.summaryText).toBe('raw');
      expect(stored?.author).toBe('Ada');
      expect(stored?.language).toBe('en');
      expect(stored?.tags).toEqual(['ai', 'lab']);
      expect(stored?.imageUrl).toBe('https://example.com/x.png');
      expect(stored?.sources).toHaveLength(1);
    });

    it('C02 returns undefined for an unknown id and reports has() as false', async () => {
      await harness!.repository.save(makeArticle('a1:known'));

      await expect(harness!.repository.findById('a1:missing')).resolves.toBeUndefined();
      await expect(harness!.repository.has('a1:missing')).resolves.toBe(false);
      await expect(harness!.repository.has('a1:known')).resolves.toBe(true);
    });

    it('C03 updates the non-provenance fields on a repeated save', async () => {
      await harness!.repository.save(makeArticle('a1:x', { title: 'Before' }));

      await harness!.repository.save(
        makeArticle('a1:x', {
          title: 'After',
          publishedAt: null,
          publishedAtIsEstimated: true,
          fetchedAt: '2026-11-20T00:00:00.000Z',
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.title).toBe('After');
      expect(stored?.publishedAt).toBeNull();
      expect(stored?.publishedAtIsEstimated).toBe(true);
      expect(stored?.fetchedAt).toBe('2026-11-20T00:00:00.000Z');
      await expect(harness!.repository.count()).resolves.toBe(1);
    });

    it('C04 keeps the first-insertion order in findAll', async () => {
      await harness!.repository.save(makeArticle('a1:c'));
      await harness!.repository.save(makeArticle('a1:a'));
      await harness!.repository.save(makeArticle('a1:b'));

      const all = await harness!.repository.findAll();

      expect(all.map((article) => article.id)).toEqual(['a1:c', 'a1:a', 'a1:b']);
    });

    it('C05 keeps an article position when it is updated', async () => {
      await harness!.repository.save(makeArticle('a1:one'));
      await harness!.repository.save(makeArticle('a1:two'));
      await harness!.repository.save(makeArticle('a1:one', { title: 'Updated' }));

      const all = await harness!.repository.findAll();

      expect(all.map((article) => article.id)).toEqual(['a1:one', 'a1:two']);
      expect(all[0]?.title).toBe('Updated');
    });

    it('C06 deletes an article and reports has() as false', async () => {
      await harness!.repository.save(makeArticle('a1:x'));
      await harness!.repository.save(makeArticle('a1:y'));

      await harness!.repository.delete('a1:x');

      await expect(harness!.repository.has('a1:x')).resolves.toBe(false);
      await expect(harness!.repository.has('a1:y')).resolves.toBe(true);
      await expect(harness!.repository.count()).resolves.toBe(1);
      expect((await harness!.repository.findAll()).map((article) => article.id)).toEqual(['a1:y']);
    });

    it('C07 clears every article', async () => {
      await harness!.repository.save(makeArticle('a1:x'));
      await harness!.repository.save(makeArticle('a1:y'));

      await harness!.repository.clear();

      await expect(harness!.repository.count()).resolves.toBe(0);
      expect(await harness!.repository.findAll()).toEqual([]);
      await expect(harness!.repository.has('a1:x')).resolves.toBe(false);
    });

    it('C08 counts the stored articles', async () => {
      await expect(harness!.repository.count()).resolves.toBe(0);

      await harness!.repository.save(makeArticle('a1:x'));
      await expect(harness!.repository.count()).resolves.toBe(1);

      await harness!.repository.save(makeArticle('a1:y'));
      await expect(harness!.repository.count()).resolves.toBe(2);

      await harness!.repository.delete('a1:x');
      await expect(harness!.repository.count()).resolves.toBe(1);
    });

    it('C09 saves every article of a batch in input order', async () => {
      await harness!.repository.saveMany([
        makeArticle('a1:c'),
        makeArticle('a1:a'),
        makeArticle('a1:b'),
      ]);

      const all = await harness!.repository.findAll();

      expect(all.map((article) => article.id)).toEqual(['a1:c', 'a1:a', 'a1:b']);
    });

    it('C10 lets a later duplicate id in a batch win', async () => {
      await harness!.repository.saveMany([
        makeArticle('a1:x', { title: 'First' }),
        makeArticle('a1:x', { title: 'Second' }),
      ]);

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.title).toBe('Second');
      await expect(harness!.repository.count()).resolves.toBe(1);
    });
  });

  describe('deep-copy and field semantics', () => {
    it('C12 isolates the store from later mutation of the saved input', async () => {
      const article = makeArticle('a1:x', {
        sources: [makeSource({ canonicalUrl: 'https://example.com/keep' })],
      });

      await harness!.repository.save(article);
      article.sources[0]!.url = 'https://example.com/mutated';
      article.sources.push(makeSource({ canonicalUrl: 'https://example.com/added' }));

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.sources).toHaveLength(1);
      expect(stored?.sources[0]?.url).toBe('https://example.com/a');
      expect(sourceUrls(stored)).toEqual(['https://example.com/keep']);
    });

    it('C13 isolates the store from mutation of a returned sources array', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/keep' })],
        }),
      );

      const first = await harness!.repository.findById('a1:x');
      first!.sources[0]!.url = 'https://example.com/mutated';
      first!.sources.push(makeSource({ canonicalUrl: 'https://example.com/added' }));

      const second = await harness!.repository.findById('a1:x');

      expect(second?.sources).toHaveLength(1);
      expect(second?.sources[0]?.url).toBe('https://example.com/a');
      expect(sourceUrls(second)).toEqual(['https://example.com/keep']);
    });

    it('C14 isolates the store from mutation of a returned tags array', async () => {
      await harness!.repository.save(makeArticle('a1:x', { tags: ['ai', 'lab'] }));

      const first = await harness!.repository.findById('a1:x');
      first!.tags!.push('mutated');
      first!.tags![0] = 'changed';

      const second = await harness!.repository.findById('a1:x');

      expect(second?.tags).toEqual(['ai', 'lab']);
    });

    it('C15 distinguishes absent tags from an empty array', async () => {
      await harness!.repository.save(makeArticle('a1:none'));
      await harness!.repository.save(makeArticle('a1:empty', { tags: [] }));

      const absent = await harness!.repository.findById('a1:none');
      const empty = await harness!.repository.findById('a1:empty');

      expect(absent === undefined ? true : Object.hasOwn(absent, 'tags')).toBe(false);
      expect(empty?.tags).toEqual([]);
    });
  });

  describe('provenance identity and history', () => {
    it('C16 keeps provenance that a later save no longer names', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/s1' }),
            makeSource({ canonicalUrl: 'https://example.com/s2' }),
          ],
        }),
      );

      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/s1' })],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(sourceUrls(stored)).toEqual(['https://example.com/s1', 'https://example.com/s2']);
    });

    it('C17 keeps provenance and the primary when a save carries no sources', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/s1' }),
            makeSource({ canonicalUrl: 'https://example.com/s2' }),
          ],
        }),
      );

      // Promote S2 first. Without this step the expected order and the
      // primary-cleared order are both [s1, s2], so a lost primary would pass.
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/s2' })],
        }),
      );

      await harness!.repository.save(makeArticle('a1:x', { sources: [], title: 'No sources' }));

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.title).toBe('No sources');
      // S2 leads only while it is still primary; clearing the flag would fall
      // back to sourceOrder and yield [s1, s2].
      expect(sourceUrls(stored)).toEqual(['https://example.com/s2', 'https://example.com/s1']);
    });

    it('C18 merges same-batch duplicates keeping first position and last values', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({
              canonicalUrl: 'https://example.com/dup',
              guid: 'g1',
              url: 'https://example.com/first',
              resolvedUrl: 'https://example.com/first',
            }),
            makeSource({ canonicalUrl: 'https://example.com/other' }),
            makeSource({
              canonicalUrl: 'https://example.com/dup',
              guid: 'g1',
              url: 'https://example.com/last',
              resolvedUrl: 'https://example.com/last',
            }),
          ],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      // Two identities, not three: the duplicate occupies the first slot.
      expect(sourceUrls(stored)).toEqual(['https://example.com/dup', 'https://example.com/other']);
      expect(stored?.sources[0]?.url).toBe('https://example.com/last');
      expect(stored?.sources[0]?.resolvedUrl).toBe('https://example.com/last');
      expect(stored?.sources[0]?.guid).toBe('g1');
    });

    it('C19 keeps two rows for one URL carrying different GUIDs', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/shared', guid: 'g1' }),
            makeSource({ canonicalUrl: 'https://example.com/shared', guid: 'g2' }),
          ],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.sources).toHaveLength(2);
      expect(stored?.sources.map((source) => source.canonicalUrl)).toEqual([
        'https://example.com/shared',
        'https://example.com/shared',
      ]);
      expect(stored?.sources.map((source) => source.guid)).toEqual(['g1', 'g2']);
    });

    it('C20 keeps two rows for an absent GUID and an empty GUID', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/shared' }),
            makeSource({ canonicalUrl: 'https://example.com/shared', guid: '' }),
          ],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.sources).toHaveLength(2);
      expect(stored?.sources[0]?.guid).toBeUndefined();
      expect(stored?.sources[1]?.guid).toBe('');
      expect(Object.hasOwn(stored!.sources[0]!, 'guid')).toBe(false);
      expect(Object.hasOwn(stored!.sources[1]!, 'guid')).toBe(true);
    });

    it('C21 refreshes url and resolvedUrl for an existing identity only', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/keep' }),
            makeSource({
              canonicalUrl: 'https://example.com/mutable',
              guid: 'g1',
              url: 'https://example.com/old',
              resolvedUrl: 'https://example.com/old',
            }),
          ],
        }),
      );

      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/keep' }),
            makeSource({
              canonicalUrl: 'https://example.com/mutable',
              guid: 'g1',
              url: 'https://example.com/new',
              resolvedUrl: 'https://example.com/new',
            }),
          ],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.sources).toHaveLength(2);
      expect(stored?.sources[1]?.url).toBe('https://example.com/new');
      expect(stored?.sources[1]?.resolvedUrl).toBe('https://example.com/new');
      expect(stored?.sources[1]?.guid).toBe('g1');
    });

    it('C22 keeps the old identity when the canonical URL changes', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/old', guid: 'g1' })],
        }),
      );

      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/new', guid: 'g1' })],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(sourceUrls(stored)).toEqual(['https://example.com/new', 'https://example.com/old']);
    });

    it('C23 reads the primary source first after the primary changes', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/a' }),
            makeSource({ canonicalUrl: 'https://example.com/b' }),
          ],
        }),
      );

      // The first source of a save becomes primary, so this promotes B.
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/b' })],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(stored?.sources).toHaveLength(2);
      expect(sourceUrls(stored)).toEqual(['https://example.com/b', 'https://example.com/a']);
    });

    it('C24 orders non-primary sources by their historical position', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/a' }),
            makeSource({ canonicalUrl: 'https://example.com/b' }),
            makeSource({ canonicalUrl: 'https://example.com/c' }),
          ],
        }),
      );

      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [makeSource({ canonicalUrl: 'https://example.com/c' })],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(sourceUrls(stored)).toEqual([
        'https://example.com/c',
        'https://example.com/a',
        'https://example.com/b',
      ]);
    });

    it('C25 keeps the assigned positions when the input order changes', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/a' }),
            makeSource({ canonicalUrl: 'https://example.com/b' }),
            makeSource({ canonicalUrl: 'https://example.com/c' }),
          ],
        }),
      );

      // Full reversal: C becomes primary, but A stays at position 1 and B at 2.
      // Renumbering by input order would yield [C, B, A] instead.
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/c' }),
            makeSource({ canonicalUrl: 'https://example.com/b' }),
            makeSource({ canonicalUrl: 'https://example.com/a' }),
          ],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      expect(sourceUrls(stored)).toEqual([
        'https://example.com/c',
        'https://example.com/a',
        'https://example.com/b',
      ]);
    });

    it('C26 gives a new identity the next position, after the existing ones', async () => {
      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/a' }),
            makeSource({ canonicalUrl: 'https://example.com/b' }),
          ],
        }),
      );

      await harness!.repository.save(
        makeArticle('a1:x', {
          sources: [
            makeSource({ canonicalUrl: 'https://example.com/new' }),
            makeSource({ canonicalUrl: 'https://example.com/a' }),
          ],
        }),
      );

      const stored = await harness!.repository.findById('a1:x');

      // NEW is primary; A keeps position 1 and B keeps position 2, so B is last.
      expect(sourceUrls(stored)).toEqual([
        'https://example.com/new',
        'https://example.com/a',
        'https://example.com/b',
      ]);
    });
  });
});
