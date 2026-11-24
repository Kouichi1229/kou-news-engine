import type { SignalHost } from '../core/lifecycle/signal-coordinator.js';
import type { ArticleRepository } from '../modules/ingestion/repository/article.repository.js';
import type { Article } from '../types/article.js';

import type { CancellingSignal } from './exit-codes.js';

/**
 * Remembers which signal asked for the stop.
 *
 * `CancellationSignal` records only *that* a signal arrived, not which one, and
 * the exit code differs between them (130 vs 143). Rather than widen the shared
 * cancellation type — which every existing caller depends on and which has no
 * business knowing about exit codes — this wrapper observes the `host.on`
 * registration and remembers the first signal name it is told about.
 *
 * Wrapping the host rather than adding a listener is deliberate: the coordinator
 * stays the only owner of subscription and teardown, so signal handling is not
 * duplicated. Only the first signal is kept, because a second forces termination
 * and never changes the graceful exit code.
 */
export interface SignalRecorder {
  /** The host to hand to `createSignalCoordinator`. */
  host: SignalHost;
  /** The first signal observed, or `undefined` if none arrived. */
  received(): CancellingSignal | undefined;
}

export function createSignalRecorder(base: SignalHost): SignalRecorder {
  let first: CancellingSignal | undefined;

  // The coordinator registers one listener per signal and later removes it by
  // reference. Because this wrapper registers a *different* function with the
  // base host, removal must be translated back: without this map the base host
  // is asked to remove a listener it never saw, silently fails, and the real
  // listener stays attached — a leak that keeps the process alive.
  const wrappers = new Map<
    string,
    Map<(signal: NodeJS.Signals) => void, (signal: NodeJS.Signals) => void>
  >();

  const host: SignalHost = {
    on: (event, listener): unknown => {
      // The event name is the signal identity, so no payload inspection is
      // needed. Recorded before the coordinator's listener runs, so the value is
      // already visible when cancellation is observed.
      const wrapper = (received: NodeJS.Signals): void => {
        first ??= event;
        listener(received);
      };

      const forEvent = wrappers.get(event) ?? new Map();
      forEvent.set(listener, wrapper);
      wrappers.set(event, forEvent);

      return base.on(event, wrapper);
    },
    removeListener: (event, listener): unknown => {
      const forEvent = wrappers.get(event);
      const wrapper = forEvent?.get(listener);
      if (forEvent === undefined || wrapper === undefined) {
        // Never registered through this recorder: pass it through unchanged so
        // the base host's own bookkeeping stays authoritative.
        return base.removeListener(event, listener);
      }
      forEvent.delete(listener);
      return base.removeListener(event, wrapper);
    },
  };

  return { host, received: (): CancellingSignal | undefined => first };
}

/**
 * A repository that records whether a write threw.
 *
 * `runIngestion` rejects on a persistence failure, so the CLI already learns
 * about it. This wrapper exists for the distinction the exit code needs: a
 * rejected run is reported as `persistence-failure`, which is a different code
 * path from a run that finished with failed sources. Recording the fact at the
 * boundary keeps the CLI from having to match error messages or classes.
 *
 * Every other method is delegated unchanged, so behaviour is identical to the
 * wrapped repository.
 */
export interface PersistenceTracker {
  repository: ArticleRepository;
  /** Whether any write attempt threw. */
  failed(): boolean;
}

export function trackPersistence(inner: ArticleRepository): PersistenceTracker {
  let failed = false;

  const record = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      failed = true;
      throw error;
    }
  };

  const repository: ArticleRepository = {
    save: (article: Article): Promise<void> => record(() => inner.save(article)),
    saveMany: (articles: readonly Article[]): Promise<void> =>
      record(() => inner.saveMany(articles)),
    findById: (id: string): Promise<Article | undefined> => inner.findById(id),
    findAll: (): Promise<Article[]> => inner.findAll(),
    has: (id: string): Promise<boolean> => inner.has(id),
    delete: (id: string): Promise<void> => inner.delete(id),
    clear: (): Promise<void> => inner.clear(),
    count: (): Promise<number> => inner.count(),
  };

  return { repository, failed: (): boolean => failed };
}
