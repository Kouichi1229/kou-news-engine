import type { SqliteDatabase } from '../../../core/persistence/sqlite.js';
import {
  EMPTY_FAILURE_CODES,
  MAX_ATTEMPTS,
  PENDING_FAILURE_CODE,
  PERMANENT_FAILURE_CODES,
} from '../extraction.constants.js';
import type {
  ArticleContent,
  ClaimedArticle,
  ExtractionFailure,
  ExtractionSuccess,
} from '../extraction.types.js';

import type { ArticleContentRepository } from './article-content.repository.js';

const PERMANENT_LIST = PERMANENT_FAILURE_CODES.map((code) => `'${code}'`).join(',');

/**
 * The slice of the database handle this repository needs.
 *
 * Narrowed to `query` so the same repository can be built over a read-only
 * connection for the CLI preview. `SqliteDatabase` satisfies it structurally, so
 * the writable path is unchanged.
 */
export type SqliteQueryable = Pick<SqliteDatabase, 'query'>;

/**
 * SQLite-backed extraction state.
 *
 * ## The six templates
 *
 * `SEED`, `CLAIM`, `COMPLETE`, `EMPTY`, `FAIL`, and one shared
 * `CANCEL`/`RELEASE` template. The last pair is one template because both do the
 * same thing to the row — return it to `failed/PENDING` and refund one attempt —
 * and differ only in why the service called them.
 *
 * ## Fencing
 *
 * Every write after `CLAIM` is gated on `status = 'in_progress' AND
 * lease_token = ?`. A write that affects no rows means another worker took the
 * row while this one was working, so the result must be discarded. The methods
 * return `false` in that case; they never report success for a write that did
 * not happen.
 *
 * ## Why the claim is its own `BEGIN IMMEDIATE`
 *
 * The handle's `transaction()` issues a deferred `BEGIN`, which takes the write
 * lock only at the first write. Two processes could then both read the same
 * candidate and both believe they won. `BEGIN IMMEDIATE` takes the write lock
 * up front, so the `SELECT` that chooses a row and the `UPDATE` that claims it
 * cannot interleave with another process.
 *
 * Positional `?` parameters are used throughout because the handle spreads the
 * parameter array into the driver, which does not accept a named-parameter
 * object.
 */
export class SqliteArticleContentRepository implements ArticleContentRepository {
  private readonly database: SqliteQueryable;

  constructor(database: SqliteQueryable) {
    this.database = database;
  }

  /**
   * Runs `fn` inside an explicit `BEGIN IMMEDIATE` … `COMMIT`.
   *
   * Rollback is attempted on any throw; a rollback failure is swallowed so the
   * original error survives, matching the handle's own policy.
   */
  private immediate<T>(fn: () => T): T {
    this.database.query((connection) => {
      connection.get('BEGIN IMMEDIATE');
    });
    try {
      const result = fn();
      this.database.query((connection) => {
        connection.get('COMMIT');
      });
      return result;
    } catch (error) {
      try {
        this.database.query((connection) => {
          connection.get('ROLLBACK');
        });
      } catch {
        // The original failure is the one worth reporting.
      }
      throw error;
    }
  }

  /**
   * `SEED`: creates a `failed/PENDING` row for every article that lacks one.
   *
   * `NOT EXISTS` makes it idempotent. Runs inside the claim transaction so a
   * concurrent claimer sees a consistent queue.
   */
  private seedSql(): string {
    return `INSERT INTO article_contents
              (article_id, status, attempts, extractor_version, failure_code)
            SELECT a.id, 'failed', 0, ?, ?
              FROM articles a
             WHERE NOT EXISTS (
                     SELECT 1 FROM article_contents c WHERE c.article_id = a.id)`;
  }

  /**
   * The eligibility rule, shared by `CLAIM` and `COUNT_CLAIMABLE`.
   *
   * Claimable means: no live lease, and either a different extractor version,
   * an expired `in_progress` lease with attempts left, or a `failed` row that is
   * not permanently failed and has attempts left.
   *
   * `empty` and `extracted` rows are never re-claimed at the same version: the
   * work is done, and repeating it would either find the same nothing or
   * overwrite a good body.
   *
   * One definition on purpose: a preview that counted by a different rule than
   * the claim would report a number the next run could not honour, and the two
   * would drift the first time the rule changed. `COUNT_CLAIMABLE` reuses this
   * string verbatim, so the predicate cannot be edited in one place only.
   *
   * Expects `lease_expires_at < ?` and `extractor_version <> ?` as its two
   * parameters, in that order, after any exclusion placeholders.
   */
  private eligibilitySql(excludeCount: number): string {
    const exclusion =
      excludeCount === 0
        ? ''
        : `AND article_id NOT IN (${Array.from({ length: excludeCount }, () => '?').join(', ')})`;

    return `(lease_owner IS NULL OR lease_expires_at < ?)
              ${exclusion}
              AND (
                    extractor_version <> ?
                 OR (status = 'in_progress' AND attempts < ${MAX_ATTEMPTS})
                 OR (status = 'failed'
                     AND failure_code NOT IN (${PERMANENT_LIST})
                     AND attempts < ${MAX_ATTEMPTS})
              )`;
  }

  private claimSql(excludeCount: number): string {
    return `UPDATE article_contents
               SET attempts = CASE
                                WHEN extractor_version <> ? THEN 1
                                ELSE attempts + 1
                              END,
                   extractor_version = ?,
                   status = 'in_progress',
                   content_text = NULL,
                   content_length = 0,
                   extracted_at = NULL,
                   final_url = NULL,
                   failure_code = ?,
                   http_status = NULL,
                   lease_owner = ?,
                   lease_token = ?,
                   lease_expires_at = ? + ?
             WHERE article_id = (
                     SELECT article_id FROM article_contents
                      WHERE ${this.eligibilitySql(excludeCount)}
                      ORDER BY article_id
                      LIMIT 1)
               RETURNING article_id, attempts, lease_expires_at`;
  }

  private terminalGuard(): string {
    return `article_id = ? AND status = 'in_progress' AND lease_token = ?`;
  }

  /** `COMPLETE`: a successful extraction. */
  private completeSql(): string {
    return `UPDATE article_contents
               SET status = 'extracted',
                   content_text = ?,
                   content_length = length(?),
                   extracted_at = ?,
                   final_url = ?,
                   failure_code = NULL,
                   http_status = ?,
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL
             WHERE ${this.terminalGuard()}
             RETURNING article_id`;
  }

  /** `EMPTY`: fetched successfully, no usable body. */
  private emptySql(): string {
    return `UPDATE article_contents
               SET status = 'empty',
                   content_text = NULL,
                   content_length = 0,
                   extracted_at = ?,
                   final_url = ?,
                   failure_code = ?,
                   http_status = ?,
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL
             WHERE ${this.terminalGuard()}
             RETURNING article_id`;
  }

  /** `FAIL`: the attempt did not produce a body. */
  private failSql(): string {
    return `UPDATE article_contents
               SET status = 'failed',
                   content_text = NULL,
                   content_length = 0,
                   extracted_at = NULL,
                   final_url = NULL,
                   failure_code = ?,
                   http_status = ?,
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL
             WHERE ${this.terminalGuard()}
             RETURNING article_id`;
  }

  /** `CANCEL` / `RELEASE`: back to the queue, refunding the attempt. */
  private releaseSql(): string {
    return `UPDATE article_contents
               SET status = 'failed',
                   content_text = NULL,
                   content_length = 0,
                   extracted_at = NULL,
                   final_url = NULL,
                   failure_code = ?,
                   http_status = NULL,
                   attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL
             WHERE ${this.terminalGuard()}
             RETURNING article_id`;
  }

  async seed(extractorVersion: string): Promise<number> {
    return this.immediate(() => {
      const before = this.countSync();
      this.database.query((connection) => {
        connection.all(this.seedSql(), [extractorVersion, PENDING_FAILURE_CODE]);
      });
      return this.countSync() - before;
    });
  }

  private countSync(): number {
    const row = this.database.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM article_contents'),
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async claim(input: {
    owner: string;
    token: string;
    now: number;
    leaseDurationMs: number;
    extractorVersion: string;
    excludeArticleIds?: readonly string[];
  }): Promise<ClaimedArticle | null> {
    const excluded = input.excludeArticleIds ?? [];

    return this.immediate(() => {
      this.database.query((connection) => {
        connection.all(this.seedSql(), [input.extractorVersion, PENDING_FAILURE_CODE]);
      });

      const rows = this.database.query((connection) =>
        connection.all(this.claimSql(excluded.length), [
          input.extractorVersion,
          input.extractorVersion,
          PENDING_FAILURE_CODE,
          input.owner,
          input.token,
          input.now,
          input.leaseDurationMs,
          input.now,
          ...excluded,
          input.extractorVersion,
        ]),
      ) as Array<{ article_id: string; attempts: number; lease_expires_at: number }>;

      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        articleId: row.article_id,
        leaseToken: input.token,
        attempts: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
      };
    });
  }

  async complete(input: {
    articleId: string;
    token: string;
    success: ExtractionSuccess;
  }): Promise<boolean> {
    return this.terminal(this.completeSql(), [
      input.success.text,
      input.success.text,
      input.success.extractedAt,
      input.success.finalUrl,
      input.success.httpStatus,
      input.articleId,
      input.token,
    ]);
  }

  async markEmpty(input: {
    articleId: string;
    token: string;
    failure: ExtractionFailure;
    extractedAt: string;
    finalUrl: string;
  }): Promise<boolean> {
    if (!EMPTY_FAILURE_CODES.includes(input.failure.code)) {
      throw new Error(`Not an empty failure code: ${input.failure.code}`);
    }
    return this.terminal(this.emptySql(), [
      input.extractedAt,
      input.finalUrl,
      input.failure.code,
      input.failure.httpStatus,
      input.articleId,
      input.token,
    ]);
  }

  async markFailed(input: {
    articleId: string;
    token: string;
    failure: ExtractionFailure;
  }): Promise<boolean> {
    return this.terminal(this.failSql(), [
      input.failure.code,
      input.failure.httpStatus,
      input.articleId,
      input.token,
    ]);
  }

  async release(input: { articleId: string; token: string }): Promise<boolean> {
    return this.terminal(this.releaseSql(), [PENDING_FAILURE_CODE, input.articleId, input.token]);
  }

  private async terminal(
    sql: string,
    params: readonly (string | number | null)[],
  ): Promise<boolean> {
    return this.immediate(() => {
      const rows = this.database.query((connection) => connection.all(sql, params)) as Array<{
        article_id: string;
      }>;
      return rows.length > 0;
    });
  }

  async findById(articleId: string): Promise<ArticleContent | undefined> {
    const row = this.database.query((connection) =>
      connection.get('SELECT * FROM article_contents WHERE article_id = ?', [articleId]),
    ) as Record<string, unknown> | undefined;

    if (row === undefined) {
      return undefined;
    }
    return {
      articleId: row['article_id'] as string,
      status: row['status'] as ArticleContent['status'],
      contentText: row['content_text'] as string | null,
      contentLength: row['content_length'] as number,
      extractedAt: row['extracted_at'] as string | null,
      finalUrl: row['final_url'] as string | null,
      extractorVersion: row['extractor_version'] as string,
      failureCode: row['failure_code'] as string | null,
      httpStatus: row['http_status'] as number | null,
      attempts: row['attempts'] as number,
      leaseOwner: row['lease_owner'] as string | null,
      leaseToken: row['lease_token'] as string | null,
      leaseExpiresAt: row['lease_expires_at'] as number | null,
    };
  }

  async count(): Promise<number> {
    return this.countSync();
  }

  /**
   * `COUNT_ARTICLES`: how many articles exist at all.
   *
   * A bare `SELECT`, so it is safe on the preview's read-only connection. It
   * answers a question `countClaimable` cannot: a database with articles but no
   * `article_contents` rows has nothing claimable *yet*, and reporting `0`
   * without this figure would suggest there is no work to do.
   */
  async countArticles(): Promise<number> {
    const row = this.database.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM articles'),
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * `COUNT_UNSEEDED`: articles that have no `article_contents` row.
   *
   * `NOT EXISTS` mirrors the anti-join in `seedSql()`, so "unseeded" here means
   * exactly the set `seed()` would create rows for. Never writes: it is the
   * read-only half of the seed, used only to describe the database.
   */
  async countUnseededArticles(): Promise<number> {
    const row = this.database.query((connection) =>
      connection.get(
        `SELECT COUNT(*) AS n
           FROM articles a
          WHERE NOT EXISTS (
                  SELECT 1
                    FROM article_contents c
                   WHERE c.article_id = a.id)`,
      ),
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * `COUNT_CLAIMABLE`: how many rows the next run could claim.
   *
   * Read-only and side-effect free: it seeds nothing, takes no lease and
   * increments no attempt, so it is safe against a database that must not be
   * modified. The predicate comes from `eligibilitySql`, the same string
   * `claimSql` interpolates, so the number cannot disagree with the claim.
   *
   * It counts only rows that already exist. A run's first action is `seed()`,
   * which creates a row per article, so a database that has never been extracted
   * reports `0` here while the next real run would process every article. The
   * CLI therefore labels the figure an estimate rather than a prediction.
   */
  async countClaimable(input: { now: number; extractorVersion: string }): Promise<number> {
    const row = this.database.query((connection) =>
      connection.get(`SELECT COUNT(*) AS n FROM article_contents WHERE ${this.eligibilitySql(0)}`, [
        input.now,
        input.extractorVersion,
      ]),
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
