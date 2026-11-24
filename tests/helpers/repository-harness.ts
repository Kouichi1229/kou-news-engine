import { openDatabase } from '../../src/core/persistence/sqlite.js';
import type { ArticleRepository } from '../../src/modules/ingestion/repository/article.repository.js';
import { InMemoryArticleRepository } from '../../src/modules/ingestion/repository/in-memory-article.repository.js';
import { SqliteArticleRepository } from '../../src/modules/ingestion/repository/sqlite-article.repository.js';
import type { Article, ArticleSourceReference } from '../../src/types/article.js';

/**
 * One isolated repository plus its teardown.
 *
 * The factory returns the cleanup handle instead of registering hooks itself, so
 * a contract test owns its own lifecycle and no hidden `afterEach` can leak
 * between suites.
 */
export interface RepositoryHarness {
  readonly repository: ArticleRepository;
  /** Releases whatever the factory acquired. Safe to call more than once. */
  cleanup(): void;
}

export type RepositoryFactory = () => RepositoryHarness;

/** A fresh in-memory store; nothing to release. */
export function createInMemoryHarness(): RepositoryHarness {
  return {
    repository: new InMemoryArticleRepository(),
    cleanup: () => undefined,
  };
}

/**
 * A fresh `:memory:` database, so no test can observe another's rows.
 *
 * `close()` is guarded by `isOpen` because the handle reports the real resource
 * state and closing twice is only a no-op after a *successful* close.
 */
export function createSqliteHarness(): RepositoryHarness {
  const database = openDatabase({ path: ':memory:' });
  return {
    repository: new SqliteArticleRepository(database),
    cleanup: () => {
      if (database.isOpen) {
        database.close();
      }
    },
  };
}

export const IMPLEMENTATIONS: ReadonlyArray<readonly [string, RepositoryFactory]> = [
  ['InMemoryArticleRepository', createInMemoryHarness],
  ['SqliteArticleRepository', createSqliteHarness],
];

/** Fixed timestamp; fixtures must not depend on the wall clock. */
const FIXED_PUBLISHED_AT = '2026-11-19T10:00:00.000Z';
const FIXED_FETCHED_AT = '2026-11-19T12:00:00.000Z';

/**
 * Deterministic source reference.
 *
 * `guid` is only assigned when supplied: `exactOptionalPropertyTypes` forbids an
 * explicit `undefined`, and the absent-versus-empty distinction is behaviour the
 * contract tests assert on.
 */
export function makeSource(
  overrides: Partial<ArticleSourceReference> = {},
): ArticleSourceReference {
  const source: ArticleSourceReference = {
    sourceId: 'src-a',
    url: 'https://example.com/a',
    resolvedUrl: 'https://example.com/a',
    canonicalUrl: 'https://example.com/a',
  };
  if (overrides.sourceId !== undefined) source.sourceId = overrides.sourceId;
  if (overrides.url !== undefined) source.url = overrides.url;
  if (overrides.resolvedUrl !== undefined) source.resolvedUrl = overrides.resolvedUrl;
  if (overrides.canonicalUrl !== undefined) source.canonicalUrl = overrides.canonicalUrl;
  if (overrides.guid !== undefined) source.guid = overrides.guid;
  return source;
}

/** Deterministic article; defaults are stable so assertions can be literal. */
export function makeArticle(id: string, overrides: Partial<Article> = {}): Article {
  const base: Article = {
    id,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    publishedAt: FIXED_PUBLISHED_AT,
    publishedAtIsEstimated: false,
    fetchedAt: FIXED_FETCHED_AT,
    sources: [makeSource({ canonicalUrl: `https://example.com/${id}` })],
  };
  return { ...base, ...overrides };
}

/** Canonical URLs of the sources, which is what most ordering assertions need. */
export function sourceUrls(article: Article | undefined): string[] {
  return article === undefined ? [] : article.sources.map((source) => source.canonicalUrl);
}
