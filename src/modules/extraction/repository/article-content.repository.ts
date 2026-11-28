import type {
  ArticleContent,
  ClaimedArticle,
  ExtractionFailure,
  ExtractionSuccess,
} from '../extraction.types.js';

/**
 * Storage boundary for extraction state.
 *
 * Every mutating method is fenced by the lease token the caller was given at
 * claim time. A method that affects no rows means the claim was lost — another
 * worker took the row after the lease expired — and must be reported as such
 * rather than as success. Implementations signal that by returning `false`;
 * they never silently ignore it.
 *
 * The interface is promise-based so a different backend could replace SQLite
 * without changing callers, matching the existing `ArticleRepository`.
 */
export interface ArticleContentRepository {
  /**
   * Creates a `failed/PENDING` row for every article that has none.
   *
   * Lazy rather than a backfill migration: existing articles gain a row the
   * first time extraction considers them, so the migration itself stays a pure
   * schema change with no data rewrite.
   *
   * @param extractorVersion version stamped on the created rows.
   * @returns how many rows were created.
   */
  seed(extractorVersion: string): Promise<number>;

  /**
   * Takes the next claimable article.
   *
   * Atomic across processes: the seed and the claim run in one
   * `BEGIN IMMEDIATE` transaction, so two processes cannot both select the same
   * row and both believe they own it.
   *
   * @param input.excludeArticleIds articles already attempted in this run.
   *   A run makes at most one attempt per article: without this, a failing
   *   article would be re-claimed immediately and consume every allowed attempt
   *   back-to-back, hammering a host that is already failing. Attempts
   *   accumulate across runs instead, which is what the `MAX_ATTEMPTS` bound is
   *   meant to measure.
   * A row that already holds a body at the same extractor version hands it back
   * as `savedBody`, and the claim keeps it: an earlier attempt fetched that page
   * and failed afterwards, so re-deriving is cheaper than re-fetching. A version
   * change clears it, because the body then belongs to a parser that no longer
   * runs.
   *
   * @returns the claim, or `null` when nothing is claimable.
   */
  claim(input: {
    owner: string;
    token: string;
    now: number;
    leaseDurationMs: number;
    extractorVersion: string;
    excludeArticleIds?: readonly string[];
  }): Promise<ClaimedArticle | null>;

  /** Records a successful extraction. `false` when the claim was lost. */
  complete(input: {
    articleId: string;
    token: string;
    success: ExtractionSuccess;
  }): Promise<boolean>;

  /**
   * Records the body while the claim is still running.
   *
   * The body is the expensive half of the work: a derivation failure afterwards
   * must not throw it away, because the retry would pay for the same request
   * again. It writes the body columns only, so the row keeps its `in_progress`
   * shape until a terminal write decides the outcome.
   *
   * `false` when the claim was lost.
   */
  saveBody(input: {
    articleId: string;
    token: string;
    success: ExtractionSuccess;
  }): Promise<boolean>;

  /**
   * Records "fetched successfully, no usable body".
   *
   * `extractedAt` and `finalUrl` are required because `empty` is a completed
   * extraction: it records when it finished and where it ended up, exactly like
   * `extracted` does.
   *
   * `false` when the claim was lost.
   */
  markEmpty(input: {
    articleId: string;
    token: string;
    failure: ExtractionFailure;
    extractedAt: string;
    finalUrl: string;
  }): Promise<boolean>;

  /**
   * Records a failed attempt. `false` when the claim was lost.
   *
   * A derivation failure keeps the body the row holds (see `saveBody`), so the
   * retry does not repeat the request. Any other failure clears it.
   */
  markFailed(input: {
    articleId: string;
    token: string;
    failure: ExtractionFailure;
  }): Promise<boolean>;

  /**
   * Returns a claim without consuming the attempt.
   *
   * Only valid before the HTTP request is issued: after that point the work may
   * already have reached the remote server, so refunding would let a failing
   * host be hit more than `MAX_ATTEMPTS` times.
   *
   * A body the claim carried is left in place, so cancelling hands the stored
   * work back rather than discarding it.
   *
   * `false` when the claim was lost.
   */
  release(input: { articleId: string; token: string }): Promise<boolean>;

  /** Reads one row, for tests and diagnostics. */
  findById(articleId: string): Promise<ArticleContent | undefined>;

  /** Counts rows, for tests and diagnostics. */
  count(): Promise<number>;

  /**
   * Counts rows in `articles`, without touching extraction state.
   *
   * Lets the preview tell an empty database apart from one whose articles have
   * simply never been seeded — a distinction `countClaimable` cannot make,
   * because it only sees `article_contents`.
   */
  countArticles(): Promise<number>;

  /**
   * Counts articles that have no `article_contents` row yet.
   *
   * Non-zero means `seed()` has not run for those articles, so the next real
   * run would create work that the preview's `claimable` figure does not
   * include. Read-only: a `NOT EXISTS` count, never a seed.
   */
  countUnseededArticles(): Promise<number>;

  /**
   * Counts the rows the next claim could take, without claiming anything.
   *
   * Backs the CLI's dry-run preview. Must be read-only: no seeding, no lease, no
   * attempt increment. Must also share its eligibility rule with `claim` rather
   * than restating it, or the preview will disagree with the run it previews.
   *
   * An estimate, not a promise: state can change between the preview and the
   * run, and rows that do not exist yet are not counted.
   */
  countClaimable(input: { now: number; extractorVersion: string }): Promise<number>;
}
