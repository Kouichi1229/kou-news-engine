/**
 * Storage boundary for the AI-derived record.
 *
 * Two operations only: read the source title the prompt needs, and store the
 * result. There is no status column and no claim protocol, because derivation
 * runs inline in the extraction process rather than as a queue: the row either
 * exists or it does not.
 */
export interface ArticleDerivedDraft {
  readonly articleId: string;
  readonly titleZh: string;
  readonly summaryZh: string;
  /** ISO 8601. Written to `created_at` once and to `updated_at` on every write. */
  readonly at: string;
}

export interface ArticleDerivedRepository {
  /** The original article title, or `undefined` when the article row is gone. */
  findArticleTitle(articleId: string): Promise<string | undefined>;

  /**
   * The stored record for one article, or `undefined` when there is none.
   *
   * Presence is the whole validity question this boundary asks: the table's own
   * CHECK constraints refuse an empty title or summary, and this service is the
   * only writer, so a row that exists is a row that satisfied the contract. A
   * caller that finds one has nothing left to do.
   */
  findByArticleId(articleId: string): Promise<ArticleDerivedDraft | undefined>;

  /**
   * The most recently updated records, newest first, at most `limit` of them.
   *
   * Ordered by `updated_at`, tie-broken by `article_id`, so two records written in
   * the same millisecond still come back in a stable order. The limit is the
   * caller's: this boundary does not decide how much is too much.
   */
  listRecent(limit: number): Promise<readonly ArticleDerivedDraft[]>;

  /**
   * Stores the derived record, replacing an earlier one for the same article.
   *
   * Replacement rather than failure keeps `updated_at` meaningful while
   * `created_at` stays the first derivation. The article-to-record relation
   * remains 1:1 either way.
   */
  save(draft: ArticleDerivedDraft): Promise<void>;
}
