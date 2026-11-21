import type { SignalHost } from '../../../src/core/lifecycle/signal-coordinator.js';
import type { FetchLike } from '../../../src/modules/ingestion/feed/feed.client.js';
import type { ArticleRepository } from '../../../src/modules/ingestion/repository/article.repository.js';
import type { FeedSource } from '../../../src/modules/ingestion/sources/source.schema.js';
import type { Article } from '../../../src/types/article.js';
import type { Runtime } from '../../../src/runtime.js';

/**
 * Test doubles for the CLI integration tests.
 *
 * These replace only the process boundary — the signal host, the exit call and
 * the fetch transport — never the code under test. The lifecycle, the signal
 * coordinator, the ingestion service and the outcome classification all run for
 * real.
 */

/** A host that records listeners so a test can deliver a signal on demand. */
export interface ControlledHost extends SignalHost {
  /** Delivers `signal` to every listener registered for it. */
  deliver: (signal: 'SIGINT' | 'SIGTERM') => void;
  /** How many listeners are currently attached, across both signals. */
  listenerCount: () => number;
}

export function createControlledHost(): ControlledHost {
  const listeners = new Map<string, Set<(signal: NodeJS.Signals) => void>>();

  return {
    on: (event, listener): unknown => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return undefined;
    },
    removeListener: (event, listener): unknown => {
      listeners.get(event)?.delete(listener);
      return undefined;
    },
    deliver: (signal): void => {
      for (const listener of [...(listeners.get(signal) ?? [])]) {
        listener(signal);
      }
    },
    listenerCount: (): number => {
      let total = 0;
      for (const set of listeners.values()) {
        total += set.size;
      }
      return total;
    },
  };
}

/** A repository that records calls and can be made to fail on write. */
export interface RecordingRepository extends ArticleRepository {
  saved: Article[];
  writes: number;
}

export function createRecordingRepository(
  options: { failOnSave?: Error } = {},
): RecordingRepository {
  const saved: Article[] = [];
  const byId = new Map<string, Article>();

  const repository: RecordingRepository = {
    saved,
    writes: 0,
    save: async (article: Article): Promise<void> => {
      repository.writes += 1;
      if (options.failOnSave !== undefined) {
        throw options.failOnSave;
      }
      byId.set(article.id, article);
      saved.push(article);
    },
    saveMany: async (articles: readonly Article[]): Promise<void> => {
      repository.writes += 1;
      if (options.failOnSave !== undefined) {
        throw options.failOnSave;
      }
      for (const article of articles) {
        byId.set(article.id, article);
        saved.push(article);
      }
    },
    findById: async (id: string): Promise<Article | undefined> => byId.get(id),
    findAll: async (): Promise<Article[]> => [...byId.values()],
    has: async (id: string): Promise<boolean> => byId.has(id),
    delete: async (id: string): Promise<void> => {
      byId.delete(id);
    },
    clear: async (): Promise<void> => {
      byId.clear();
      saved.length = 0;
    },
    count: async (): Promise<number> => byId.size,
  };

  return repository;
}

/** A runtime whose `dispose` counts calls, so exactly-once can be asserted. */
export interface CountingRuntime extends Runtime {
  disposeCalls: number;
}

/**
 * Builds a runtime stand-in with only what the CLI touches.
 *
 * `dispose` is the real subject of several tests, so it counts its own calls
 * rather than relying on a spy framework's bookkeeping.
 */
export function createCountingRuntime(repository: ArticleRepository): CountingRuntime {
  const runtime = {
    disposeCalls: 0,
    repository,
  } as unknown as CountingRuntime;

  runtime.dispose = async (): Promise<void> => {
    runtime.disposeCalls += 1;
  };

  return runtime;
}

/** A source fixture that never leaves the process. */
export function testSource(id: string): FeedSource {
  return {
    id,
    name: `Source ${id}`,
    url: `https://${id}.example.com/feed.xml`,
    homepage: `https://${id}.example.com`,
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['test'],
    reliability: 'high',
  };
}

/** A minimal RSS document with one item, so the parser produces one record. */
export function rssFor(sourceId: string, itemId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${sourceId}</title>
    <link>https://${sourceId}.example.com/</link>
    <description>fixture</description>
    <item>
      <title>${itemId}</title>
      <link>https://${sourceId}.example.com/${itemId}</link>
      <guid isPermaLink="false">${itemId}</guid>
    </item>
  </channel>
</rss>`;
}

/**
 * A fetch double keyed by URL.
 *
 * No network is involved. An unknown URL answers 404 rather than throwing: 404
 * is non-retryable, so a mistake in the routes fails immediately instead of
 * silently succeeding, and the test never waits on backoff delays.
 */
export function createFetchDouble(
  routes: Record<string, { status: number; body: string }>,
): FetchLike {
  return async (
    url: string,
  ): Promise<{
    status: number;
    headers: { get: () => string | null };
    body: ReadableStream<Uint8Array>;
  }> => {
    const route = routes[url];
    if (route === undefined) {
      const notFound = new TextEncoder().encode('not found');
      return {
        status: 404,
        headers: { get: (): string | null => null },
        body: new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(notFound);
            controller.close();
          },
        }),
      };
    }
    const bytes = new TextEncoder().encode(route.body);
    return {
      status: route.status,
      headers: { get: (): string | null => null },
      body: new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
}

/**
 * A fetch double where every request fails with 404.
 *
 * 404 is deliberately not in the retryable set (`429`, `5xx`), so it fails on
 * the first attempt with no backoff. A network *throw* would instead trigger the
 * retry loop and make the test depend on real backoff delays.
 */
export function failingFetch(): FetchLike {
  return async (): Promise<{
    status: number;
    headers: { get: () => string | null };
    body: ReadableStream<Uint8Array> | null;
  }> => ({
    status: 404,
    headers: { get: (): string | null => null },
    body: null,
  });
}
