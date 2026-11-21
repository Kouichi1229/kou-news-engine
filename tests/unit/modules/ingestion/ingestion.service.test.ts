import { describe, expect, it, vi } from 'vitest';

import type {
  FetchLike,
  FetchResponseLike,
} from '../../../../src/modules/ingestion/feed/feed.client.js';
import {
  DEFAULT_INGESTION_DEADLINE_MS,
  runIngestion,
  type RunIngestionOptions,
} from '../../../../src/modules/ingestion/ingestion.service.js';
import { createCancellationSignal } from '../../../../src/core/lifecycle/cancellation.js';
import type { ArticleRepository } from '../../../../src/modules/ingestion/repository/article.repository.js';
import { InMemoryArticleRepository } from '../../../../src/modules/ingestion/repository/in-memory-article.repository.js';
import type { FeedSource } from '../../../../src/modules/ingestion/sources/source.schema.js';
import type { Article } from '../../../../src/types/article.js';

const STARTED_AT = '2026-11-19T12:00:00.000Z';
const FINISHED_AT = '2026-11-19T12:00:05.000Z';

function source(id: string, overrides: Partial<FeedSource> = {}): FeedSource {
  return {
    id,
    name: `Source ${id}`,
    url: `https://${id}.example.com/feed.xml`,
    homepage: `https://${id}.example.com`,
    kind: 'auto',
    enabled: true,
    defaultLanguage: 'en',
    tags: [],
    reliability: 'high',
    ...overrides,
  };
}

function headers(map: Record<string, string> = {}): { get(name: string): string | null } {
  const lowered = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

function response(
  status: number,
  options: { body?: string; headerMap?: Record<string, string> } = {},
): FetchResponseLike {
  const encoder = new TextEncoder();
  return {
    status,
    headers: headers(options.headerMap),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(options.body ?? ''));
        controller.close();
      },
    }),
  };
}

interface Item {
  title?: string;
  link?: string;
  guid?: string;
}

function rss(items: Item[]): string {
  const body = items
    .map((item) => {
      const title = item.title === undefined ? '' : `<title>${item.title}</title>`;
      const link = item.link === undefined ? '' : `<link>${item.link}</link>`;
      const guid = item.guid === undefined ? '' : `<guid>${item.guid}</guid>`;
      return `<item>${title}${link}${guid}</item>`;
    })
    .join('');
  return `<rss version="2.0"><channel>${body}</channel></rss>`;
}

/** Maps a feed URL to a canned response, a thrown error, or a 404 default. */
function fetcher(byUrl: Record<string, FetchResponseLike | Error>): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const next = byUrl[url] ?? response(404);
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetchImpl, calls };
}

/** Returns STARTED_AT then FINISHED_AT, then keeps returning FINISHED_AT. */
function clock(): () => Date {
  let call = 0;
  return () => {
    const value = call === 0 ? STARTED_AT : FINISHED_AT;
    call += 1;
    return new Date(value);
  };
}

describe('runIngestion — happy path', () => {
  it('ingests a single entry from a single source', async () => {
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'Story', link: 'https://example.com/story' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository,
      fetchImpl,
      now: clock(),
    });

    expect(result.articleCount).toBe(1);
    await expect(repository.count()).resolves.toBe(1);
  });

  it('ingests every entry of a single source', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([
          { title: 'One', link: 'https://example.com/1' },
          { title: 'Two', link: 'https://example.com/2' },
          { title: 'Three', link: 'https://example.com/3' },
        ]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.articleCount).toBe(3);
  });

  it('merges the same story reported by two sources into one article', async () => {
    const repository = new InMemoryArticleRepository();
    const shared = rss([{ title: 'Shared Story', link: 'https://example.com/shared' }]);
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, { body: shared }),
      'https://src-b.example.com/feed.xml': response(200, { body: shared }),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository,
      fetchImpl,
      now: clock(),
    });

    // Cross-source merging only works because deduplication runs once over all records.
    expect(result.articleCount).toBe(1);
    const stored = await repository.findAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.sources).toHaveLength(2);
    expect(stored[0]?.sources.map((entry) => entry.sourceId)).toEqual(['src-a', 'src-b']);
  });

  it('keeps distinct stories from two sources as two articles', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.articleCount).toBe(2);
  });

  it('stamps every article with the run start time', async () => {
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([
          { title: 'One', link: 'https://example.com/1' },
          { title: 'Two', link: 'https://example.com/2' },
        ]),
      }),
    });

    await runIngestion({ sources: [source('src-a')], repository, fetchImpl, now: clock() });

    const stored = await repository.findAll();
    expect(stored).toHaveLength(2);
    for (const article of stored) {
      expect(article.fetchedAt).toBe(STARTED_AT);
    }
  });

  it('reports per-source counts and status', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'One', link: 'https://example.com/1' }, { title: 'No link here' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      sourceId: 'src-a',
      status: 'ok',
      itemCount: 2,
      recordCount: 1,
      skippedCount: 1,
    });
  });

  it('returns the documented run envelope', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'One', link: 'https://example.com/1' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result).toEqual({
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      sources: [expect.objectContaining({ sourceId: 'src-a', status: 'ok' })],
      articleCount: 1,
      possibleDuplicateCount: 0,
    });
  });
});

describe('runIngestion — error isolation', () => {
  it('keeps the run alive when one source fails', async () => {
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(500),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository,
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]?.status).toBe('error');
    expect(result.sources[1]?.status).toBe('ok');
    expect(result.articleCount).toBe(1);
    await expect(repository.count()).resolves.toBe(1);
  });

  it('passes through the fetch error code', async () => {
    const { fetchImpl } = fetcher({ 'https://src-a.example.com/feed.xml': response(404) });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]?.error?.code).toBe('HTTP_ERROR');
  });

  it('reports a malformed XML document', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: '<rss version="2.0"><channel><item></channel></rss>',
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]?.status).toBe('error');
    expect(result.sources[0]?.error?.code).toBe('INVALID_XML');
  });

  it('rejects a document that declares a DOCTYPE', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: '<!DOCTYPE rss><rss version="2.0"><channel></channel></rss>',
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]?.error?.code).toBe('DOCTYPE_NOT_ALLOWED');
  });

  it('reports a network failure after the client exhausts its retries', async () => {
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': new Error('socket hang up'),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]?.error?.code).toBe('NETWORK_ERROR');
    // One initial attempt plus the client's two retries.
    expect(calls).toHaveLength(3);
  });

  it('resolves with zero articles when every source fails', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(404),
      'https://src-b.example.com/feed.xml': response(500),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.articleCount).toBe(0);
    expect(result.sources.every((entry) => entry.status === 'error')).toBe(true);
  });

  it('zeroes the counters of a failed source', async () => {
    const { fetchImpl } = fetcher({ 'https://src-a.example.com/feed.xml': response(404) });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]).toMatchObject({
      itemCount: 0,
      recordCount: 0,
      skippedCount: 0,
    });
  });
});

describe('runIngestion — edge cases', () => {
  it('accepts a feed with no entries', async () => {
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, { body: rss([]) }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository,
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]).toMatchObject({ status: 'ok', itemCount: 0, recordCount: 0 });
    expect(result.articleCount).toBe(0);
    await expect(repository.count()).resolves.toBe(0);
  });

  it('skips an entry without a link', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'No link' }, { title: 'Has link', link: 'https://example.com/ok' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]).toMatchObject({ itemCount: 2, recordCount: 1, skippedCount: 1 });
  });

  it('skips an entry without a title', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ link: 'https://example.com/no-title' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.sources[0]).toMatchObject({ itemCount: 1, recordCount: 0, skippedCount: 1 });
    expect(result.articleCount).toBe(0);
  });

  it('does not fetch when there are no sources', async () => {
    const { fetchImpl, calls } = fetcher({});

    const result = await runIngestion({
      sources: [],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(calls).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.articleCount).toBe(0);
  });

  it('ignores a disabled source', async () => {
    const repository = new InMemoryArticleRepository();
    const { fetchImpl, calls } = fetcher({});

    const result = await runIngestion({
      sources: [source('src-a', { enabled: false })],
      repository,
      fetchImpl,
      now: clock(),
    });

    expect(calls).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.articleCount).toBe(0);
    await expect(repository.count()).resolves.toBe(0);
  });

  it('fetches only the enabled source when enabled and disabled are mixed', async () => {
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-off.example.com/feed.xml': response(200, {
        body: rss([{ title: 'Off', link: 'https://example.com/off' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-off', { enabled: false })],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(calls).toEqual(['https://src-a.example.com/feed.xml']);
    expect(result.sources.map((entry) => entry.sourceId)).toEqual(['src-a']);
    expect(result.articleCount).toBe(1);
  });

  it('reports possible duplicates that were not merged', async () => {
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'GPT-5 Released', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'GPT 5 released', link: 'https://example.com/b' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(result.articleCount).toBe(2);
    expect(result.possibleDuplicateCount).toBe(1);
  });
});

describe('runIngestion — determinism', () => {
  const sources = [source('src-a'), source('src-b')];

  function cannedFetcher(): FetchLike {
    return fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([
          { title: 'Shared', link: 'https://example.com/shared' },
          { title: 'Only A', link: 'https://example.com/a' },
        ]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([
          { title: 'Shared', link: 'https://example.com/shared' },
          { title: 'Only B', link: 'https://example.com/b' },
        ]),
      }),
    }).fetchImpl;
  }

  it('produces byte-identical output for identical inputs and clock', async () => {
    const run = async (): Promise<string> => {
      const repository = new InMemoryArticleRepository();
      const result = await runIngestion({
        sources,
        repository,
        fetchImpl: cannedFetcher(),
        now: clock(),
      });
      return JSON.stringify({ result, articles: await repository.findAll() });
    };

    expect(await run()).toBe(await run());
  });

  it('produces the same articles when the source order is reversed', async () => {
    const run = async (ordered: readonly FeedSource[]): Promise<Article[]> => {
      const repository = new InMemoryArticleRepository();
      await runIngestion({
        sources: ordered,
        repository,
        fetchImpl: cannedFetcher(),
        now: clock(),
      });
      return repository.findAll();
    };

    const forward = await run(sources);
    const reversed = await run([...sources].reverse());

    // Source order changes `sources[]` ordering but not the article set.
    expect(forward.map((article) => article.id).sort()).toEqual(
      reversed.map((article) => article.id).sort(),
    );
    expect(forward).toHaveLength(reversed.length);
  });

  it('fetches each source exactly once', async () => {
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    await runIngestion({
      sources,
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
    });

    expect(calls).toEqual([
      'https://src-a.example.com/feed.xml',
      'https://src-b.example.com/feed.xml',
    ]);
  });
});

describe('runIngestion — persistence', () => {
  it('stores exactly the articles counted in the result', async () => {
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([
          { title: 'One', link: 'https://example.com/1' },
          { title: 'Two', link: 'https://example.com/2' },
        ]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository,
      fetchImpl,
      now: clock(),
    });

    await expect(repository.count()).resolves.toBe(result.articleCount);
  });

  it('rejects when persistence fails and leaves the earlier writes in place', async () => {
    // Wraps the real repository and fails on the second save, so the assertion
    // covers the genuine non-atomic `saveMany` behaviour.
    class FailingSecondSaveRepository implements ArticleRepository {
      readonly inner = new InMemoryArticleRepository();

      private saved = 0;

      async save(article: Article): Promise<void> {
        await this.inner.save(article);
      }

      async saveMany(articles: readonly Article[]): Promise<void> {
        for (const article of articles) {
          if (this.saved === 1) {
            throw new Error('disk full');
          }
          await this.inner.save(article);
          this.saved += 1;
        }
      }

      async findById(id: string): Promise<Article | undefined> {
        return this.inner.findById(id);
      }

      async findAll(): Promise<Article[]> {
        return this.inner.findAll();
      }

      async has(id: string): Promise<boolean> {
        return this.inner.has(id);
      }

      async delete(id: string): Promise<void> {
        return this.inner.delete(id);
      }

      async clear(): Promise<void> {
        return this.inner.clear();
      }

      async count(): Promise<number> {
        return this.inner.count();
      }
    }

    const repository = new FailingSecondSaveRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([
          { title: 'One', link: 'https://example.com/1' },
          { title: 'Two', link: 'https://example.com/2' },
        ]),
      }),
    });

    await expect(
      runIngestion({ sources: [source('src-a')], repository, fetchImpl, now: clock() }),
    ).rejects.toThrow('disk full');

    // Non-atomic: the first article survived, the second never landed.
    await expect(repository.count()).resolves.toBe(1);
  });
});

describe('runIngestion — required repository', () => {
  it('rejects a call that omits the repository instead of writing to a throwaway store', async () => {
    const { fetchImpl, calls } = fetcher({});

    // Reaching the runtime guard the way an untyped caller would: the option
    // object is built as a wider record and cast, so the compiler cannot reject
    // it and only the guard stands between the caller and a network run.
    const untyped = {
      sources: [source('src-a')],
      fetchImpl,
      now: clock(),
    } as unknown as RunIngestionOptions;

    await expect(runIngestion(untyped)).rejects.toThrow(
      'runIngestion requires an explicit repository',
    );

    // The guard runs before any source is fetched: no network work is wasted.
    expect(calls).toEqual([]);
  });

  it('does not fall back to an implicit in-memory repository', async () => {
    // A missing repository must fail, not silently succeed against a store the
    // caller never saw. Success here would mean the fallback survived.
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const untyped = {
      sources: [source('src-a')],
      fetchImpl,
      now: clock(),
    } as unknown as RunIngestionOptions;

    await expect(runIngestion(untyped)).rejects.toThrow(TypeError);
  });

  it('writes only to the repository the caller supplies', async () => {
    const supplied = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: supplied,
      fetchImpl,
      now: clock(),
    });

    expect(result.articleCount).toBe(1);
    await expect(supplied.count()).resolves.toBe(1);
  });

  it('is a required parameter at the type level', () => {
    // Compile-time assertion: omitting `repository` must be a type error. If the
    // property ever became optional again, this directive would be unused and
    // `tsc` would fail the build.
    // @ts-expect-error repository is mandatory
    const options: RunIngestionOptions = { sources: [] };
    expect(options).toBeDefined();
  });

  it('rejects a call with no argument at all from an untyped runtime caller', async () => {
    // A plain-JavaScript caller can omit the argument entirely, so the function
    // receives `undefined` despite the TypeScript signature. `fetch` is stubbed
    // rather than observed: if the guard ever regressed, the call would fall
    // through to the enabled sources and hit the real network, which a unit test
    // must never do.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('network disabled in test')));

    try {
      const call = runIngestion as unknown as () => Promise<unknown>;
      const error = await call().catch((caught: unknown) => caught);

      // A TypeError, not a property-read error on `undefined`.
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe('runIngestion requires an explicit repository');

      // Rejecting here also means nothing was persisted: no repository was
      // reached, implicit or otherwise.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * A clock that advances only when told to, so deadline tests never wait.
 *
 * Injected wherever the service asks for elapsed time; each `advance` is what a
 * real `performance.now()` would have done between two sources.
 */
function fakeClock(start = 0): { clock: () => number; advance: (ms: number) => void } {
  let elapsed = start;
  return {
    clock: () => elapsed,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

describe('runIngestion — deadline', () => {
  it('defaults to 300000ms', async () => {
    // The clock jumps past the default only after the first source completed, so
    // the second source is skipped. A smaller default would skip the first.
    const fake = fakeClock();
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const tickingFetch: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      // Consume 299s on the first source: still inside the 300s default.
      fake.advance(299_000);
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: tickingFetch,
      now: clock(),
      clock: fake.clock,
    });

    expect(DEFAULT_INGESTION_DEADLINE_MS).toBe(300_000);
    // 299s < 300s, so the second source still runs and neither is skipped.
    expect(calls).toHaveLength(2);
    expect(result.stoppedReason).toBeUndefined();
  });

  it('accepts a custom deadline and stops before the next source once it is spent', async () => {
    const fake = fakeClock();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const slowFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      fake.advance(1_500);
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: slowFirst,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
    });

    // 1500ms spent against a 1000ms budget: the second source never starts.
    expect(result.stoppedReason).toBe('deadline');
    expect(result.sources.map((entry) => entry.status)).toEqual(['ok', 'skipped']);
  });

  it('starts a source while the deadline has not expired', async () => {
    const fake = fakeClock();
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
    });

    // Time never advances, so both sources run and nothing is skipped.
    expect(calls).toHaveLength(2);
    expect(result.stoppedReason).toBeUndefined();
    expect(result.sources.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('does not abort a fetch that is still running when the deadline passes', async () => {
    const fake = fakeClock();
    let completed = false;
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const slowFirst: FetchLike = async (url, init) => {
      // Time runs out *during* the fetch, not after it.
      fake.advance(5_000);
      const result = await fetchImpl(url, init);
      completed = true;
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: slowFirst,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
    });

    // The fetch ran to completion despite the deadline: it was never aborted.
    expect(calls).toEqual(['https://src-a.example.com/feed.xml']);
    expect(completed).toBe(true);
    expect(result.sources[0]).toMatchObject({ sourceId: 'src-a', status: 'ok', recordCount: 1 });
  });

  it('persists articles collected before the deadline expired', async () => {
    const fake = fakeClock();
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const slowFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      fake.advance(2_000);
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository,
      fetchImpl: slowFirst,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
    });

    // Deduplication and persistence still ran over the one collected record.
    expect(result.articleCount).toBe(1);
    await expect(repository.count()).resolves.toBe(1);
  });

  it('marks unexecuted sources as skipped with the deadline reason, never as errors', async () => {
    const fake = fakeClock();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const slowFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      fake.advance(2_000);
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b'), source('src-c')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: slowFirst,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
    });

    expect(result.sources).toEqual([
      { sourceId: 'src-a', status: 'ok', itemCount: 1, recordCount: 1, skippedCount: 0 },
      {
        sourceId: 'src-b',
        status: 'skipped',
        itemCount: 0,
        recordCount: 0,
        skippedCount: 0,
        skipReason: 'deadline',
      },
      {
        sourceId: 'src-c',
        status: 'skipped',
        itemCount: 0,
        recordCount: 0,
        skippedCount: 0,
        skipReason: 'deadline',
      },
    ]);
    // Nothing was reported as an error: the run was cut short, not broken.
    expect(result.sources.some((entry) => entry.status === 'error')).toBe(false);
  });

  it('skips the very first source when the budget is already spent by the first boundary check', async () => {
    // The deadline is measured from run start, so it cannot be "already expired"
    // before the run — `deadlineAt` is always `now + deadlineMs`. What is
    // reachable is a clock that advances between arming the deadline and the
    // first boundary check: a wall-clock step or a slow pre-run step. The first
    // source must then be skipped rather than started.
    let reads = 0;
    const steppingClock = (): number => {
      reads += 1;
      return reads === 1 ? 0 : 5_000;
    };
    const { fetchImpl, calls } = fetcher({});

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
      clock: steppingClock,
      deadlineMs: 1_000,
    });

    // 5000ms elapsed against a 1000ms budget before the first fetch was due.
    expect(calls).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: 'skipped', skipReason: 'deadline' });
    expect(result.stoppedReason).toBe('deadline');
  });

  it('rejects a deadline that cannot describe a duration', async () => {
    for (const invalid of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        runIngestion({
          sources: [],
          repository: new InMemoryArticleRepository(),
          deadlineMs: invalid,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('does not let a NaN deadline disable the guard silently', async () => {
    // Guards the specific failure mode where NaN comparisons are all false and
    // the run would behave as if it had unlimited time.
    const error = await runIngestion({
      sources: [],
      repository: new InMemoryArticleRepository(),
      deadlineMs: Number.NaN,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toContain('deadlineMs');
  });
});

describe('runIngestion — cancellation signal', () => {
  it('runs normally while the signal is untouched', async () => {
    const signal = createCancellationSignal();
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const result = await runIngestion({
      sources: [source('src-a')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
      signal,
    });

    expect(calls).toHaveLength(1);
    expect(result.stoppedReason).toBeUndefined();
    expect(result.sources[0]).toMatchObject({ status: 'ok' });
  });

  it('stops starting new sources once cancelled and keeps the completed ones', async () => {
    const signal = createCancellationSignal();
    const { fetchImpl, calls } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
      'https://src-b.example.com/feed.xml': response(200, {
        body: rss([{ title: 'B', link: 'https://example.com/b' }]),
      }),
    });

    const cancelAfterFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      signal.cancel('signal');
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: cancelAfterFirst,
      now: clock(),
      signal,
    });

    // The second source was never fetched; the first one's result survived.
    expect(calls).toEqual(['https://src-a.example.com/feed.xml']);
    expect(result.sources.map((entry) => entry.status)).toEqual(['ok', 'skipped']);
    expect(result.stoppedReason).toBe('signal');
  });

  it('saves the articles collected before cancellation', async () => {
    const signal = createCancellationSignal();
    const repository = new InMemoryArticleRepository();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const cancelAfterFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      signal.cancel('signal');
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository,
      fetchImpl: cancelAfterFirst,
      now: clock(),
      signal,
    });

    // Persistence is not skipped just because the run was cut short.
    expect(result.articleCount).toBe(1);
    await expect(repository.count()).resolves.toBe(1);
  });

  it('distinguishes a signal cancellation from a deadline expiry', async () => {
    const signal = createCancellationSignal();
    const fake = fakeClock();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const cancelAndSpendBudget: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      // Both conditions become true at once. The signal is checked first, so it
      // is the reason reported: an operator's request outranks a budget.
      signal.cancel('signal');
      fake.advance(9_999);
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: cancelAndSpendBudget,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
      signal,
    });

    expect(result.stoppedReason).toBe('signal');
    expect(result.sources[1]).toMatchObject({ status: 'skipped', skipReason: 'signal' });
  });

  it('reports a deadline expiry as deadline, not as a signal', async () => {
    const signal = createCancellationSignal();
    const fake = fakeClock();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const spendBudget: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      fake.advance(9_999);
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: spendBudget,
      now: clock(),
      clock: fake.clock,
      deadlineMs: 1_000,
      signal,
    });

    expect(signal.isCancelled()).toBe(false);
    expect(result.stoppedReason).toBe('deadline');
    expect(result.sources[1]).toMatchObject({ status: 'skipped', skipReason: 'deadline' });
  });

  it('still rejects when persistence fails after cancellation', async () => {
    const signal = createCancellationSignal();
    // Wraps a real repository so the failure comes from the save path itself.
    const inner = new InMemoryArticleRepository();
    const failing: ArticleRepository = {
      save: (article) => inner.save(article),
      saveMany: () => Promise.reject(new Error('disk full')),
      findById: (id) => inner.findById(id),
      findAll: () => inner.findAll(),
      has: (id) => inner.has(id),
      delete: (id) => inner.delete(id),
      clear: () => inner.clear(),
      count: () => inner.count(),
    };
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const cancelAfterFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      signal.cancel('signal');
      return result;
    };

    await expect(
      runIngestion({
        sources: [source('src-a')],
        repository: failing,
        fetchImpl: cancelAfterFirst,
        now: clock(),
        signal,
      }),
    ).rejects.toThrow('disk full');
  });

  it('does not report a cancelled run as every source having failed', async () => {
    const signal = createCancellationSignal();
    const { fetchImpl } = fetcher({
      'https://src-a.example.com/feed.xml': response(200, {
        body: rss([{ title: 'A', link: 'https://example.com/a' }]),
      }),
    });

    const cancelAfterFirst: FetchLike = async (url, init) => {
      const result = await fetchImpl(url, init);
      signal.cancel('signal');
      return result;
    };

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl: cancelAfterFirst,
      now: clock(),
      signal,
    });

    // `skipped` is not `error`: a cut-short run is not a failed one.
    expect(result.sources.filter((entry) => entry.status === 'error')).toEqual([]);
    expect(result.stoppedReason).toBe('signal');
  });

  it('does not fetch anything when the signal was already cancelled', async () => {
    const signal = createCancellationSignal();
    signal.cancel('signal');
    const { fetchImpl, calls } = fetcher({});

    const result = await runIngestion({
      sources: [source('src-a'), source('src-b')],
      repository: new InMemoryArticleRepository(),
      fetchImpl,
      now: clock(),
      signal,
    });

    expect(calls).toEqual([]);
    expect(result.stoppedReason).toBe('signal');
    expect(result.sources.every((entry) => entry.status === 'skipped')).toBe(true);
    expect(result.articleCount).toBe(0);
  });
});
