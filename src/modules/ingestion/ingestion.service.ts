import { logger } from '../../core/logger.js';
import type { CancellationSignal } from '../../core/lifecycle/cancellation.js';
import { dedupeRecords } from './dedupe/dedupe.js';
import { FeedFetchError, fetchFeed, type FetchLike } from './feed/feed.client.js';
import { mapFeedToRecords } from './feed/feed.mapper.js';
import { FeedParseError, parseFeed } from './feed/feed.parser.js';
import type {
  IngestionRunResult,
  IngestionStoppedReason,
  NormalizedRecord,
  SourceRunResult,
} from './ingestion.types.js';
import type { ArticleRepository } from './repository/article.repository.js';
import { enabledSources } from './sources/source.config.js';
import type { FeedSource } from './sources/source.schema.js';

/**
 * Default budget for one run, in milliseconds.
 *
 * This is a budget for the whole batch, not a promise that every source will be
 * reached. The theoretical worst case is far larger than this value: six sources,
 * three attempts each, a 10s timeout per attempt and up to 30s `Retry-After`
 * between attempts, gives 6 × (3 × 10s + 2 × 30s) = 540s.
 *
 * 300s therefore cannot guarantee that all six sources complete. When the budget
 * is spent, every source that has not started yet is reported as `skipped` with
 * `skipReason: 'deadline'`; a fetch already in flight is allowed to finish and
 * its articles are kept. That is the intended trade — a bounded run with partial
 * coverage and an explicit reason is preferable to one that can block for
 * unbounded time.
 */
export const DEFAULT_INGESTION_DEADLINE_MS = 300_000;

/**
 * Elapsed-time source. Injectable so a test can advance time without waiting.
 *
 * Must be monotonic. `Date.now()` is not: a wall-clock step — NTP correction, a
 * VM resume — would move the deadline backwards and extend the run, or forwards
 * and end it instantly.
 */
export type MonotonicClock = () => number;

const defaultMonotonicClock: MonotonicClock = () => performance.now();

/**
 * Rejects a deadline that cannot describe a duration.
 *
 * A negative, zero, NaN or infinite budget is a configuration mistake, not a
 * run to attempt: treating `NaN` as "no limit" or `Infinity` as "never stop"
 * would hide the mistake and silently remove the guard the caller asked for.
 */
function resolveDeadlineMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_INGESTION_DEADLINE_MS;
  }
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `deadlineMs must be a positive finite number of milliseconds, received ${String(value)}`,
    );
  }
  return value;
}

export interface RunIngestionOptions {
  /** Sources to ingest. Defaults to the enabled configured sources. */
  sources?: readonly FeedSource[];
  /**
   * Storage boundary. Mandatory so no run can silently write to a throwaway
   * in-memory store: the caller states where articles land.
   */
  repository: ArticleRepository;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Whole-run budget. Defaults to `DEFAULT_INGESTION_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Injected for tests; defaults to `performance.now()`. */
  clock?: MonotonicClock;
  /**
   * Optional cooperative stop request, checked between sources.
   *
   * The signal is not wired into the fetch: a request already in flight is
   * allowed to finish and its articles are still saved. See `runIngestion`.
   */
  signal?: CancellationSignal;
}

/** Used for unexpected errors so internal details never reach the run result. */
const GENERIC_ERROR_MESSAGE = 'Unexpected error while ingesting source';

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof FeedFetchError || error instanceof FeedParseError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: GENERIC_ERROR_MESSAGE };
}

/**
 * Runs one ingestion pass: fetch, parse and map every source, merge all records
 * in a single deduplication pass, then persist the resulting articles.
 *
 * A source that fails is recorded as `status: 'error'` and does not abort the
 * run; the remaining sources still contribute. A persistence failure is not
 * swallowed — it rejects, because `saveMany` is not atomic and a partial write
 * must not be reported as a successful run.
 *
 * `repository` is mandatory: requiring it guarantees the caller decides where
 * articles are stored, but it does not by itself guarantee durability. Only the
 * caller passing a durable repository makes a run persistent.
 *
 * ## Stopping early
 *
 * The deadline and the cancellation signal are both checked **between sources**,
 * never inside one. A source whose fetch is already running is awaited to
 * completion and its articles are kept: an abort mid-request would discard work
 * that was nearly done and leave a partial batch behind, which is the opposite
 * of what a graceful stop is for. Consequently the run can overrun its deadline
 * by at most one source.
 *
 * Sources never attempted are reported as `skipped` with the reason, so a run
 * that stopped early cannot be mistaken for one that covered every source.
 * Deduplication and persistence still run over whatever was collected.
 */
export async function runIngestion(options: RunIngestionOptions): Promise<IngestionRunResult> {
  // The type system already makes `repository` mandatory. This guard covers
  // callers that bypass it (`any`, plain JS, a stale build): without it the run
  // would fetch every source first and only fail at `saveMany`, which hides the
  // real mistake behind six network requests. `options?.` is deliberate: an
  // untyped caller may omit the argument entirely, and that must produce this
  // message rather than a property-read error on `undefined`.
  if (options?.repository === undefined) {
    throw new TypeError('runIngestion requires an explicit repository');
  }

  const clock = options.clock ?? defaultMonotonicClock;
  const deadlineMs = resolveDeadlineMs(options.deadlineMs);
  const deadlineAt = clock() + deadlineMs;

  // Filtering applies to injected sources too, not just `enabledSources()`:
  // a caller passing a disabled source must not trigger a fetch.
  const sources = (options.sources ?? enabledSources()).filter((source) => source.enabled);
  const { repository, signal } = options;
  const now = options.now ?? ((): Date => new Date());
  const fetchOptions = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };

  // One timestamp for the whole run: every article in a run shares `fetchedAt`,
  // so the output is reproducible when `now` is injected.
  const startedAt = now().toISOString();
  logger.info('Ingestion run started', { sourceCount: sources.length, startedAt, deadlineMs });

  const records: NormalizedRecord[] = [];
  const sourceResults: SourceRunResult[] = [];
  let stoppedReason: IngestionStoppedReason | undefined;

  for (const source of sources) {
    // Checked before the fetch, never during it: see the doc comment.
    const stop = signal?.reason();
    if (stop !== undefined) {
      stoppedReason = stop;
      break;
    }
    if (clock() >= deadlineAt) {
      stoppedReason = 'deadline';
      break;
    }

    try {
      const response = await fetchFeed(source.url, fetchOptions);
      const feed = parseFeed(response.body, source.kind);
      const mapped = mapFeedToRecords(feed, source);

      records.push(...mapped.records);
      sourceResults.push({
        sourceId: source.id,
        status: 'ok',
        itemCount: feed.entries.length,
        recordCount: mapped.records.length,
        skippedCount: mapped.skippedCount,
      });
    } catch (error) {
      const described = describeError(error);
      if (described.code === 'INTERNAL_ERROR') {
        // Keep the real message in the log only; the result stays generic.
        logger.error('Feed source failed unexpectedly', {
          sourceId: source.id,
          code: described.code,
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        logger.warn('Feed source failed', {
          sourceId: source.id,
          code: described.code,
          message: described.message,
        });
      }

      sourceResults.push({
        sourceId: source.id,
        status: 'error',
        itemCount: 0,
        recordCount: 0,
        skippedCount: 0,
        error: described,
      });
    }
  }

  if (stoppedReason !== undefined) {
    const attempted = new Set(sourceResults.map((result) => result.sourceId));
    for (const source of sources) {
      if (attempted.has(source.id)) {
        continue;
      }
      sourceResults.push({
        sourceId: source.id,
        status: 'skipped',
        itemCount: 0,
        recordCount: 0,
        skippedCount: 0,
        skipReason: stoppedReason,
      });
    }
    logger.warn('Ingestion run stopped before every source', {
      stoppedReason,
      attemptedCount: attempted.size,
      skippedCount: sourceResults.length - attempted.size,
    });
  }

  // Deduplication runs once over every source's records, so the same story
  // reported by two sources collapses into one article with two sources.
  const { articles, possibleDuplicates } = dedupeRecords(records, startedAt);

  try {
    await repository.saveMany(articles);
  } catch (error) {
    logger.error('Ingestion persistence failed', {
      articleCount: articles.length,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const finishedAt = now().toISOString();
  const failedCount = sourceResults.filter((result) => result.status === 'error').length;

  // Only a run that attempted every source and failed on each one is "failed for
  // every source". A run that stopped early has `skipped` entries, which are not
  // failures, so it is reported through `stoppedReason` instead.
  if (
    stoppedReason === undefined &&
    sourceResults.length > 0 &&
    failedCount === sourceResults.length
  ) {
    logger.error('Ingestion run failed for every source', {
      sourceCount: sourceResults.length,
      finishedAt,
    });
  } else {
    logger.info('Ingestion run finished', {
      sourceCount: sourceResults.length,
      failedCount,
      articleCount: articles.length,
      finishedAt,
    });
  }

  return {
    startedAt,
    finishedAt,
    sources: sourceResults,
    articleCount: articles.length,
    possibleDuplicateCount: possibleDuplicates.length,
    ...(stoppedReason === undefined ? {} : { stoppedReason }),
  };
}
