import { logger } from '../../core/logger.js';
import { dedupeRecords } from './dedupe/dedupe.js';
import { FeedFetchError, fetchFeed, type FetchLike } from './feed/feed.client.js';
import { mapFeedToRecords } from './feed/feed.mapper.js';
import { FeedParseError, parseFeed } from './feed/feed.parser.js';
import type { IngestionRunResult, NormalizedRecord, SourceRunResult } from './ingestion.types.js';
import type { ArticleRepository } from './repository/article.repository.js';
import { InMemoryArticleRepository } from './repository/in-memory-article.repository.js';
import { enabledSources } from './sources/source.config.js';
import type { FeedSource } from './sources/source.schema.js';

export interface RunIngestionOptions {
  /** Sources to ingest. Defaults to the enabled configured sources. */
  sources?: readonly FeedSource[];
  /** Storage boundary. Defaults to a fresh in-memory repository. */
  repository?: ArticleRepository;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to `new Date()`. */
  now?: () => Date;
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
 */
export async function runIngestion(options: RunIngestionOptions = {}): Promise<IngestionRunResult> {
  // Filtering applies to injected sources too, not just `enabledSources()`:
  // a caller passing a disabled source must not trigger a fetch.
  const sources = (options.sources ?? enabledSources()).filter((source) => source.enabled);
  const repository = options.repository ?? new InMemoryArticleRepository();
  const now = options.now ?? ((): Date => new Date());
  const fetchOptions = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };

  // One timestamp for the whole run: every article in a run shares `fetchedAt`,
  // so the output is reproducible when `now` is injected.
  const startedAt = now().toISOString();
  logger.info('Ingestion run started', { sourceCount: sources.length, startedAt });

  const records: NormalizedRecord[] = [];
  const sourceResults: SourceRunResult[] = [];

  for (const source of sources) {
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

  if (sourceResults.length > 0 && failedCount === sourceResults.length) {
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
  };
}
