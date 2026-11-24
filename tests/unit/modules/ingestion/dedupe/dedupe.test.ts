import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { dedupeRecords } from '../../../../../src/modules/ingestion/dedupe/dedupe.js';
import { mapFeedToRecords } from '../../../../../src/modules/ingestion/feed/feed.mapper.js';
import { parseFeed } from '../../../../../src/modules/ingestion/feed/feed.parser.js';
import type { NormalizedRecord } from '../../../../../src/modules/ingestion/ingestion.types.js';
import type { FeedSource } from '../../../../../src/modules/ingestion/sources/source.schema.js';

const FETCHED_AT = '2026-11-19T12:00:00.000Z';

function record(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  const canonicalUrl = overrides.canonicalUrl ?? 'https://example.com/a';
  return {
    sourceId: 'src-a',
    url: canonicalUrl,
    resolvedUrl: canonicalUrl,
    canonicalUrl,
    title: 'A Title',
    publishedAt: '2026-11-19T10:00:00.000Z',
    publishedAtIsEstimated: false,
    ...overrides,
  };
}

function expectedId(canonicalUrl: string): string {
  return `a1:${createHash('sha256').update(canonicalUrl, 'utf8').digest('hex')}`;
}

describe('dedupeRecords — structure', () => {
  it('returns empty results for no input', () => {
    expect(dedupeRecords([], FETCHED_AT)).toEqual({ articles: [], possibleDuplicates: [] });
  });

  it('builds one article from one record', () => {
    const result = dedupeRecords([record()], FETCHED_AT);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.id).toBe(expectedId('https://example.com/a'));
    expect(result.possibleDuplicates).toEqual([]);
  });

  it('derives the id from the primary canonical URL as a1: plus sha256', () => {
    const [article] = dedupeRecords([record()], FETCHED_AT).articles;

    expect(article?.id).toMatch(/^a1:[0-9a-f]{64}$/);
  });

  it('propagates fetchedAt verbatim', () => {
    const [article] = dedupeRecords([record()], FETCHED_AT).articles;

    expect(article?.fetchedAt).toBe(FETCHED_AT);
  });

  it('sorts articles by id', () => {
    const result = dedupeRecords(
      [
        record({ canonicalUrl: 'https://example.com/z' }),
        record({ canonicalUrl: 'https://example.com/a' }),
      ],
      FETCHED_AT,
    );

    const ids = result.articles.map((article) => article.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('produces unique ids across articles', () => {
    const result = dedupeRecords(
      [
        record({ canonicalUrl: 'https://example.com/a' }),
        record({ canonicalUrl: 'https://example.com/b' }),
        record({ canonicalUrl: 'https://example.com/c' }),
      ],
      FETCHED_AT,
    );

    const ids = result.articles.map((article) => article.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('dedupeRecords — merge rules', () => {
  it('merges records that share a canonical URL across sources', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/a' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.sources).toHaveLength(2);
  });

  it('merges records that share a source-scoped GUID', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/b' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(1);
  });

  it('does not merge an identical GUID from different sources', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-b', guid: 'g1', canonicalUrl: 'https://example.com/b' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(2);
  });

  it('never merges on title equality', () => {
    const result = dedupeRecords(
      [
        record({ canonicalUrl: 'https://example.com/a', title: 'Same Title' }),
        record({ canonicalUrl: 'https://example.com/b', title: 'Same Title' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(2);
  });

  it('never merges on content equality', () => {
    const result = dedupeRecords(
      [
        record({ canonicalUrl: 'https://example.com/a', title: 'T', summaryText: 'S' }),
        record({ canonicalUrl: 'https://example.com/b', title: 'T', summaryText: 'S' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(2);
  });

  it('merges transitively across both rules', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-a', guid: 'g2', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-a', guid: 'g2', canonicalUrl: 'https://example.com/c' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.sources).toHaveLength(3);
  });
});

describe('dedupeRecords — primary selection', () => {
  it('picks the earliest valid publishedAt', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', publishedAt: '2026-11-19T12:00:00.000Z' }),
        record({ sourceId: 'src-b', publishedAt: '2026-11-19T08:00:00.000Z' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-b');
  });

  it('sorts a null date after every valid date', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', publishedAt: null, publishedAtIsEstimated: true }),
        record({ sourceId: 'src-b', publishedAt: '2026-11-19T23:00:00.000Z' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-b');
  });

  it('breaks a date tie by sourceId', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-z', publishedAt: '2026-11-19T10:00:00.000Z' }),
        record({ sourceId: 'src-a', publishedAt: '2026-11-19T10:00:00.000Z' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-a');
  });

  it('breaks a sourceId tie by canonicalUrl', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/z' }),
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/a' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.canonicalUrl).toBe('https://example.com/a');
  });

  it('breaks a canonicalUrl tie by raw url', () => {
    const result = dedupeRecords(
      [
        record({
          sourceId: 'src-a',
          guid: 'g1',
          canonicalUrl: 'https://example.com/a',
          url: 'https://example.com/a?z=1',
        }),
        record({
          sourceId: 'src-a',
          guid: 'g1',
          canonicalUrl: 'https://example.com/a',
          url: 'https://example.com/a?a=1',
        }),
      ],
      FETCHED_AT,
    );

    // The raw url lives on the source reference; `article.url` is the primary's
    // resolvedUrl, which is identical for both fixtures.
    expect(result.articles[0]?.sources[0]?.url).toBe('https://example.com/a?a=1');
  });

  it('breaks a raw url tie by contentHash', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', guid: 'g1', title: 'Zebra', summaryText: 'same' }),
        record({ sourceId: 'src-a', guid: 'g1', title: 'Apple', summaryText: 'same' }),
      ],
      FETCHED_AT,
    );

    // Title is not a merge key, but the GUID merges these; the hash tie-break decides.
    expect(result.articles[0]?.title).toBe('Apple');
  });
});

describe('dedupeRecords — equal instants (D1 tie semantics)', () => {
  it('treats equal instants written with different offsets as a tie', () => {
    const utc = record({ sourceId: 'src-a', publishedAt: '2026-11-19T10:00:00.000Z' });
    const offset = record({ sourceId: 'src-a', publishedAt: '2026-11-19T11:00:00+01:00' });

    // Fixture guard: these really are the same instant.
    expect(Date.parse(utc.publishedAt as string)).toBe(Date.parse(offset.publishedAt as string));

    const result = dedupeRecords([utc, record({ sourceId: 'src-a', guid: 'g1' })], FETCHED_AT);
    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-a');
  });

  it('lets sourceId decide when equal instants have different offsets', () => {
    const early = record({
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/a',
      publishedAt: '2026-11-19T10:00:00.000Z',
      publishedAtRaw: '2026-11-19T10:00:00Z',
    });
    const late = record({
      sourceId: 'src-b',
      canonicalUrl: 'https://example.com/a',
      publishedAt: '2026-11-19T11:00:00+01:00',
      publishedAtRaw: '2026-11-19T11:00:00+01:00',
    });

    const result = dedupeRecords([late, early], FETCHED_AT);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-a');
    expect(result.articles[0]?.publishedAt).toBe('2026-11-19T10:00:00.000Z');
  });

  it('mirrors the sourceIds to prove lexical date order is not used', () => {
    // Same two date strings, but the lexically later string now belongs to src-a.
    const lexicallyLater = record({
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/a',
      publishedAt: '2026-11-19T11:00:00+01:00',
      publishedAtRaw: '2026-11-19T11:00:00+01:00',
    });
    const lexicallyEarlier = record({
      sourceId: 'src-b',
      canonicalUrl: 'https://example.com/a',
      publishedAt: '2026-11-19T10:00:00.000Z',
      publishedAtRaw: '2026-11-19T10:00:00Z',
    });

    const result = dedupeRecords([lexicallyEarlier, lexicallyLater], FETCHED_AT);

    // A lexical-date comparator would pick src-b in both fixtures; sourceId must win.
    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-a');
    expect(result.articles[0]?.publishedAt).toBe('2026-11-19T11:00:00+01:00');
  });

  it('uses the raw representation only after every D1 field ties', () => {
    const withMillis = record({
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/a',
      url: 'https://example.com/a',
      publishedAt: '2026-11-19T10:00:00.000Z',
    });
    const withoutMillis = record({
      sourceId: 'src-a',
      canonicalUrl: 'https://example.com/a',
      url: 'https://example.com/a',
      publishedAt: '2026-11-19T10:00:00Z',
    });

    expect(Date.parse(withMillis.publishedAt as string)).toBe(
      Date.parse(withoutMillis.publishedAt as string),
    );

    const forward = dedupeRecords([withMillis, withoutMillis], FETCHED_AT);
    const reversed = dedupeRecords([withoutMillis, withMillis], FETCHED_AT);

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.articles[0]?.publishedAt).toBe('2026-11-19T10:00:00.000Z');
  });
});

describe('dedupeRecords — dates', () => {
  it('sorts an invalid date after every valid date', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', publishedAt: 'not-a-date', publishedAtIsEstimated: true }),
        record({ sourceId: 'src-b', publishedAt: '2026-11-19T23:00:00.000Z' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-b');
  });

  it('sorts null before an invalid date string in the last tier', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', publishedAt: 'not-a-date', publishedAtIsEstimated: true }),
        record({ sourceId: 'src-b', publishedAt: null, publishedAtIsEstimated: true }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-b');
  });

  it('preserves an invalid date verbatim without normalizing it', () => {
    const [article] = dedupeRecords(
      [record({ publishedAt: 'not-a-date', publishedAtIsEstimated: true })],
      FETCHED_AT,
    ).articles;

    expect(article?.publishedAt).toBe('not-a-date');
    expect(article?.publishedAtIsEstimated).toBe(true);
  });

  it('never recomputes publishedAtIsEstimated', () => {
    const [article] = dedupeRecords(
      [record({ publishedAt: '2026-11-19T10:00:00.000Z', publishedAtIsEstimated: true })],
      FETCHED_AT,
    ).articles;

    expect(article?.publishedAtIsEstimated).toBe(true);
  });

  it('preserves publishedAtRaw verbatim', () => {
    const [article] = dedupeRecords(
      [record({ publishedAtRaw: 'Wed, 19 Nov 2026 10:00:00 GMT' })],
      FETCHED_AT,
    ).articles;

    expect(article?.publishedAtRaw).toBe('Wed, 19 Nov 2026 10:00:00 GMT');
  });
});

describe('dedupeRecords — provenance and fields', () => {
  it('puts the primary source first', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources.map((source) => source.sourceId)).toEqual([
      'src-a',
      'src-b',
    ]);
  });

  it('keeps two records from the same source', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', guid: 'g1', canonicalUrl: 'https://example.com/a' }),
        record({ sourceId: 'src-a', guid: 'g2', canonicalUrl: 'https://example.com/a' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.sources).toHaveLength(2);
    expect(result.articles[0]?.sources.every((source) => source.sourceId === 'src-a')).toBe(true);
  });

  it('preserves each source reference URL fields', () => {
    const result = dedupeRecords(
      [
        record({
          sourceId: 'src-a',
          canonicalUrl: 'https://example.com/a',
          url: '/a',
          resolvedUrl: 'https://example.com/a',
          guid: 'g1',
        }),
        record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/a' }),
      ],
      FETCHED_AT,
    );

    const reference = result.articles[0]?.sources.find((source) => source.sourceId === 'src-a');
    expect(reference).toEqual({
      sourceId: 'src-a',
      url: '/a',
      resolvedUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      guid: 'g1',
    });
  });

  it('takes tags from the primary record only', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', tags: ['ai', 'ai', 'lab'] }),
        record({ sourceId: 'src-b', tags: ['other'] }),
      ],
      FETCHED_AT,
    );

    expect(result.articles[0]?.tags).toEqual(['ai', 'ai', 'lab']);
  });

  it('omits tags entirely when the primary has none', () => {
    const [article] = dedupeRecords([record()], FETCHED_AT).articles;

    expect('tags' in (article as object)).toBe(false);
  });

  it('omits optional fields that are absent', () => {
    const [article] = dedupeRecords([record()], FETCHED_AT).articles;

    expect('guid' in (article as object)).toBe(false);
    expect('author' in (article as object)).toBe(false);
    expect('imageUrl' in (article as object)).toBe(false);
    expect('summaryRaw' in (article as object)).toBe(false);
  });

  it('copies primary fields onto the article', () => {
    const [article] = dedupeRecords(
      [
        record({
          title: 'Title',
          summaryRaw: '<p>Raw</p>',
          summaryText: 'Raw',
          author: 'Alice',
          language: 'en',
          imageUrl: 'https://example.com/i.png',
          guid: 'g1',
        }),
      ],
      FETCHED_AT,
    ).articles;

    expect(article).toMatchObject({
      title: 'Title',
      summaryRaw: '<p>Raw</p>',
      summaryText: 'Raw',
      author: 'Alice',
      language: 'en',
      imageUrl: 'https://example.com/i.png',
      guid: 'g1',
    });
  });
});

describe('dedupeRecords — determinism', () => {
  const base: NormalizedRecord[] = [
    record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', guid: 'g1' }),
    record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/a' }),
    record({ sourceId: 'src-c', canonicalUrl: 'https://example.com/b' }),
    record({ sourceId: 'src-d', canonicalUrl: 'https://example.com/b', title: 'Other' }),
    record({ sourceId: 'src-e', canonicalUrl: 'https://example.com/c', title: 'Same Title' }),
    record({ sourceId: 'src-f', canonicalUrl: 'https://example.com/d', title: 'Same Title' }),
  ];

  function permutations<T>(items: readonly T[], count: number): T[][] {
    const results: T[][] = [items.slice()];
    for (let seed = 1; seed < count; seed += 1) {
      const copy = items.slice();
      // Deterministic Fisher-Yates driven by the seed.
      let state = seed * 2654435761;
      for (let index = copy.length - 1; index > 0; index -= 1) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const swap = state % (index + 1);
        const a = copy[index] as T;
        const b = copy[swap] as T;
        copy[index] = b;
        copy[swap] = a;
      }
      results.push(copy);
    }
    return results;
  }

  it('is permutation invariant', () => {
    const expected = JSON.stringify(dedupeRecords(base, FETCHED_AT));

    for (const permutation of permutations(base, 20)) {
      expect(JSON.stringify(dedupeRecords(permutation, FETCHED_AT))).toBe(expected);
    }
  });

  it('is invariant for a full-tie pair', () => {
    const a = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a' });
    const b = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a' });

    expect(JSON.stringify(dedupeRecords([a, b], FETCHED_AT))).toBe(
      JSON.stringify(dedupeRecords([b, a], FETCHED_AT)),
    );
  });

  it('is stable for a pair differing only in author', () => {
    const a = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', author: 'Alice' });
    const b = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', author: 'Bob' });

    const forward = dedupeRecords([a, b], FETCHED_AT);
    const reversed = dedupeRecords([b, a], FETCHED_AT);

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.articles[0]?.author).toBe('Alice');
  });

  it.each([
    ['resolvedUrl', { resolvedUrl: 'https://example.com/zzz' }],
    ['title', { title: 'ZZZ' }],
    ['guid', { guid: 'g1' }],
    ['publishedAtIsEstimated', { publishedAtIsEstimated: true }],
    ['publishedAtRaw', { publishedAtRaw: 'raw-z' }],
    ['author', { author: 'Zed' }],
    ['language', { language: 'zz' }],
    ['summaryRaw', { summaryRaw: 'z-raw' }],
    ['summaryText', { summaryText: 'z-text' }],
    ['imageUrl', { imageUrl: 'https://example.com/z.png' }],
    ['tags', { tags: ['z'] }],
  ] satisfies Array<[string, Partial<NormalizedRecord>]>)(
    'is deterministic for a pair differing only in %s',
    (_field, override) => {
      const plain = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a' });
      const altered = record({
        sourceId: 'src-a',
        canonicalUrl: 'https://example.com/a',
        ...override,
      });

      const forward = dedupeRecords([plain, altered], FETCHED_AT);
      const reversed = dedupeRecords([altered, plain], FETCHED_AT);

      expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    },
  );

  it('orders sources deterministically for a full-tie pair', () => {
    const a = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', guid: 'g1' });
    const b = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', guid: 'g2' });

    const forward = dedupeRecords([a, b], FETCHED_AT).articles[0]?.sources;
    const reversed = dedupeRecords([b, a], FETCHED_AT).articles[0]?.sources;

    expect(forward).toEqual(reversed);
  });

  it('compares non-ASCII strings by UTF-16 code unit, not locale', () => {
    const a = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', title: 'Zebra' });
    const b = record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', title: 'Äpfel' });

    // 'Z' (U+005A) sorts before 'Ä' (U+00C4) in code-unit order; a locale-aware
    // comparison would place 'Äpfel' first.
    const result = dedupeRecords([b, a], FETCHED_AT);
    expect(result.articles[0]?.title).toBe('Zebra');
  });
});

describe('dedupeRecords — possibleDuplicates', () => {
  it('reports articles sharing a title key that were not merged', () => {
    const result = dedupeRecords(
      [
        record({
          sourceId: 'src-a',
          canonicalUrl: 'https://example.com/a',
          title: 'GPT-5 Released',
        }),
        record({
          sourceId: 'src-b',
          canonicalUrl: 'https://example.com/b',
          title: 'GPT 5 released',
        }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(2);
    expect(result.possibleDuplicates).toHaveLength(1);
    expect(result.possibleDuplicates[0]?.titleKey).toBe('gpt 5 released');
    expect(result.possibleDuplicates[0]?.articleIds).toHaveLength(2);
    expect(result.possibleDuplicates[0]?.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('does not report a single article', () => {
    const result = dedupeRecords([record({ title: 'Unique' })], FETCHED_AT);

    expect(result.possibleDuplicates).toEqual([]);
  });

  it('ignores an empty title key', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', title: '!!!' }),
        record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/b', title: '???' }),
      ],
      FETCHED_AT,
    );

    expect(result.articles).toHaveLength(2);
    expect(result.possibleDuplicates).toEqual([]);
  });

  it('sorts articleIds and deduplicates sourceIds', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', title: 'Same' }),
        record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/b', title: 'Same' }),
        record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/c', title: 'Same' }),
      ],
      FETCHED_AT,
    );

    const duplicate = result.possibleDuplicates[0];
    expect(duplicate?.articleIds).toEqual([...(duplicate?.articleIds ?? [])].sort());
    expect(duplicate?.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('sorts possibleDuplicates by titleKey', () => {
    const result = dedupeRecords(
      [
        record({ sourceId: 'src-a', canonicalUrl: 'https://example.com/a', title: 'Zeta' }),
        record({ sourceId: 'src-b', canonicalUrl: 'https://example.com/b', title: 'Zeta' }),
        record({ sourceId: 'src-c', canonicalUrl: 'https://example.com/c', title: 'Alpha' }),
        record({ sourceId: 'src-d', canonicalUrl: 'https://example.com/d', title: 'Alpha' }),
      ],
      FETCHED_AT,
    );

    expect(result.possibleDuplicates.map((entry) => entry.titleKey)).toEqual(['alpha', 'zeta']);
  });
});

describe('dedupeRecords — real mapper pipeline', () => {
  const sourceA: FeedSource = {
    id: 'src-a',
    name: 'Source A',
    url: 'https://a.example.com/feed.xml',
    homepage: 'https://a.example.com',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: [],
    reliability: 'high',
  };

  const sourceB: FeedSource = {
    ...sourceA,
    id: 'src-b',
    name: 'Source B',
    url: 'https://b.example.com/feed.xml',
  };

  function feedWith(pubDate: string): string {
    return (
      '<rss version="2.0"><channel><item>' +
      '<title>Same Story</title>' +
      '<link>https://example.com/story</link>' +
      `<pubDate>${pubDate}</pubDate>` +
      '</item></channel></rss>'
    );
  }

  it('picks the lower sourceId for equal instants written differently', () => {
    const fromA = mapFeedToRecords(
      parseFeed(feedWith('Thu, 19 Nov 2026 10:00:00 GMT'), 'auto'),
      sourceA,
    );
    const fromB = mapFeedToRecords(
      parseFeed(feedWith('Thu, 19 Nov 2026 11:00:00 +0100'), 'auto'),
      sourceB,
    );

    const records = [...fromA.records, ...fromB.records];
    expect(records).toHaveLength(2);
    // The mapper canonicalizes both to the same instant, so sourceId decides.
    expect(records[0]?.publishedAt).toBe(records[1]?.publishedAt);

    const result = dedupeRecords(records, FETCHED_AT);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.sources[0]?.sourceId).toBe('src-a');
    expect(result.articles[0]?.sources).toHaveLength(2);
  });
});
