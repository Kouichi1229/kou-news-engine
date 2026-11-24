import type { Article } from '../../../types/article.js';

/**
 * Storage boundary for deduplicated articles.
 *
 * Methods return promises so a durable implementation (SQLite, Prisma) can
 * replace the in-memory one without changing any caller. The in-memory
 * implementation resolves immediately.
 *
 * ## `canonicalUrl` uniqueness is not part of this contract
 *
 * This interface does not promise that two different article ids cannot share a
 * `canonicalUrl`. The two implementations differ here, and callers must not rely
 * on either behaviour:
 *
 * - `SqliteArticleRepository` declares `articles.canonical_url UNIQUE`, so a
 *   second id reusing a URL is rejected by the driver. That is a storage-level
 *   integrity safeguard, not a shared guarantee.
 * - `InMemoryArticleRepository` keys articles by id only and accepts such a
 *   pair, because nothing in this interface forbids it.
 *
 * Callers are expected to supply articles produced by the ingestion
 * deduplication pipeline, which derives each id from the primary canonical URL
 * (`sha256(canonicalUrl)`). Under that rule two articles can never share a
 * canonical URL, so the divergence is unreachable in production today. It stays
 * documented because it is observable through this interface.
 */
export interface ArticleRepository {
  /** Inserts the article, or replaces the existing one with the same `id`. */
  save(article: Article): Promise<void>;

  /**
   * Saves each article in order.
   *
   * Sequential upserts with no batch atomicity: if an item fails, earlier items
   * remain saved. Deliberately not transactional.
   */
  saveMany(articles: readonly Article[]): Promise<void>;

  /** Returns a copy of the stored article, or `undefined` when absent. */
  findById(id: string): Promise<Article | undefined>;

  /** Returns copies of every stored article, in insertion order. */
  findAll(): Promise<Article[]>;

  has(id: string): Promise<boolean>;

  /** Removes the article; a missing id is not an error. */
  delete(id: string): Promise<void>;

  clear(): Promise<void>;

  count(): Promise<number>;
}
