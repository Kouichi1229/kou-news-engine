import type { SqliteDatabase } from '../../../core/persistence/sqlite.js';
import { MAX_PROCESSING_ATTEMPTS } from '../processing.constants.js';
import type {
  ClaimedProcessingJob,
  ProcessingJob,
  ProcessingJobState,
  ProcessingLifecycle,
} from '../processing.types.js';

import type { ProcessingJobRepository } from './processing-job.repository.js';

/**
 * The slice of the database handle this repository needs.
 *
 * Narrowed to `query`, matching the extraction repository, so the same class can
 * be built over a read-only handle for inspection.
 */
export type SqliteQueryable = Pick<SqliteDatabase, 'query'>;

const JOB_COLUMNS = `lifecycle_id, processing_version, state, attempts,
                     lease_owner, lease_token, lease_expires_at, failure_code,
                     terminal_reason, created_at, updated_at`;

interface JobRow {
  lifecycle_id: string;
  processing_version: number;
  state: ProcessingJobState;
  attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  failure_code: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface LifecycleRow {
  lifecycle_id: string;
  article_id: string;
  published_version: number;
  published_revision: number;
  opened_at: string;
  closed_at: string | null;
  abandoned_at: string | null;
}

/**
 * SQLite-backed Processing State.
 *
 * ## Fencing
 *
 * `requeue` and `markTerminal` are both gated on
 * `state = 'running' AND lease_token = ?`. A write that matches no row means the
 * claim is gone — superseded, cancelled, recovered by another Worker, or already
 * terminal — so the result must be discarded. Both return `false`; neither
 * reports success for a write that did not happen.
 *
 * The token alone is not the guarantee. The `running` predicate is: a terminal
 * row has no token, so a late write cannot reach it even if it replays an old
 * token (`CLM-12`, `CLM-19`).
 *
 * ## Why claim is its own `BEGIN IMMEDIATE`
 *
 * The handle's `transaction()` issues a deferred `BEGIN`, which takes the write
 * lock at the first write. Two processes could then both act on the same row.
 * `BEGIN IMMEDIATE` takes the lock up front, so the retirement pass and the
 * claim cannot interleave with another process.
 *
 * ## Claim is targeted, never scheduled
 *
 * `claim` takes an explicit `(lifecycleId, processingVersion)` and does not scan
 * for "the next job". Any ordering across jobs would be a scheduling policy —
 * fairness, starvation, which lifecycle goes first — and that is `SPEC-GAP-08`,
 * still `OPEN`. The repository performs no such choice and returns `undefined`
 * when the named job is not claimable.
 */
export class SqliteProcessingJobRepository implements ProcessingJobRepository {
  private readonly database: SqliteQueryable;

  constructor(database: SqliteQueryable) {
    this.database = database;
  }

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
   * `CLM-19` retirement, at the Claim encounter point.
   *
   * An unfinished job whose version is below its lifecycle's high-water mark may
   * no longer publish, so it becomes terminal `superseded` — the outcome name
   * `CLM-19` itself uses. Retirement consumes no attempt (`CLM-19`: "consumes no
   * attempt and raises no alert") and creates no alert, so `attempts`,
   * `failure_code` and `terminal_reason` history are untouched except for the
   * marker this writes.
   *
   * `state IN ('pending','running')` is deliberate: a **running** stale job is
   * still unfinished, and leaving it `running` would keep a live lease and a
   * valid token. Clearing the three lease columns is what invalidates the claim,
   * so a stale Worker's later write matches no row (`CLM-12` fencing,
   * `CLM-19` "An active claim is invalidated when its job becomes superseded").
   *
   * `terminal_reason IS NULL` in the predicate is the history guard: a row that
   * already committed an outcome is never rewritten (`CLM-19` non-retroactivity).
   *
   * ## Why abandoned and closed lifecycles are excluded
   *
   * A stale job inside an abandoned lifecycle also qualifies for `cancelled`
   * (`CLM-18`), and one past the 168-hour window also qualifies for
   * `expired-unprocessed`. Which label wins is L-01, still `OPEN`. Retiring those
   * rows here would choose P-1 by implementation, so they are left untouched and
   * reported as an unresolved overlap rather than labelled by guess.
   */
  private retireSql(): string {
    return `UPDATE processing_job
               SET state = 'terminal',
                   terminal_reason = 'superseded',
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   updated_at = ?
             WHERE state IN ('pending','running')
               AND terminal_reason IS NULL
               AND processing_version < (
                     SELECT l.published_version
                       FROM processing_lifecycle l
                      WHERE l.lifecycle_id = processing_job.lifecycle_id)
               AND EXISTS (
                     SELECT 1
                       FROM processing_lifecycle l
                      WHERE l.lifecycle_id = processing_job.lifecycle_id
                        AND l.closed_at IS NULL
                        AND l.abandoned_at IS NULL)
             RETURNING lifecycle_id, processing_version`;
  }

  /**
   * The claim, for one explicitly named job.
   *
   * `state = 'pending'` is the claimability test: a `running` row has a live
   * claim and a `terminal` row has a marker, and neither may be claimed
   * (`CLM-2`). `attempts < MAX` restates the ceiling so a row that reached it is
   * refused even before recovery terminalizes it (`CLM-10`).
   *
   * The `EXISTS` clause repeats the two ways work stops (`CLM-18`) and the
   * retirement rule (`CLM-19`). The retirement pass above already removed stale
   * rows, but the predicate stays here: eligibility must not depend on another
   * statement having run first.
   */
  private claimSql(): string {
    return `UPDATE processing_job
               SET state = 'running',
                   attempts = attempts + 1,
                   lease_owner = ?,
                   lease_token = ?,
                   lease_expires_at = ? + ?,
                   updated_at = ?
             WHERE lifecycle_id = ?
               AND processing_version = ?
               AND state = 'pending'
               AND attempts < ${MAX_PROCESSING_ATTEMPTS}
               AND EXISTS (
                     SELECT 1
                       FROM processing_lifecycle l
                      WHERE l.lifecycle_id = processing_job.lifecycle_id
                        AND l.closed_at IS NULL
                        AND l.abandoned_at IS NULL
                        AND processing_job.processing_version >= l.published_version)
             RETURNING lifecycle_id, processing_version, attempts, lease_expires_at`;
  }

  /**
   * Runs the retirement pass. One call site per transaction, so `claim`,
   * `requeue` and `markTerminal` cannot drift into three slightly different
   * retirement rules.
   *
   * The pass is store-wide on purpose (`CLM-19`: "wherever it is encountered"),
   * and it is idempotent: a second call inside the same transaction matches
   * nothing, because retired rows are already `terminal` with a marker.
   */
  private retireSuperseded(updatedAt: string): void {
    this.database.query((connection) => {
      connection.all(this.retireSql(), [updatedAt]);
    });
  }

  private requeueSql(): string {
    return `UPDATE processing_job
               SET state = 'pending',
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   failure_code = ?,
                   updated_at = ?
             WHERE lifecycle_id = ?
               AND processing_version = ?
               AND state = 'running'
               AND lease_token = ?
               AND attempts < ${MAX_PROCESSING_ATTEMPTS}
             RETURNING attempts`;
  }

  private markTerminalSql(): string {
    return `UPDATE processing_job
               SET state = 'terminal',
                   terminal_reason = ?,
                   failure_code = COALESCE(?, failure_code),
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   updated_at = ?
             WHERE lifecycle_id = ?
               AND processing_version = ?
               AND state = 'running'
               AND lease_token = ?
             RETURNING attempts`;
  }

  /**
   * Reopen predicate. `lease_expires_at < ?` is strict: a lease that expires
   * exactly at `now` is still live for this tick.
   *
   * `attempts < MAX` and `terminal_reason IS NULL` mirror the Claim predicate,
   * so Recovery can only return a job to a state Claim would accept. Exhausted
   * jobs are deliberately absent: `CLM-8` terminalization needs the alert
   * sequencing question (D-1) settled, so those rows are left alone here.
   */
  private reopenExpiredSql(): string {
    return `UPDATE processing_job
               SET state = 'pending',
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   updated_at = ?
             WHERE state = 'running'
               AND lease_expires_at < ?
               AND attempts < ${MAX_PROCESSING_ATTEMPTS}
               AND terminal_reason IS NULL
               AND EXISTS (
                     SELECT 1
                       FROM processing_lifecycle l
                      WHERE l.lifecycle_id = processing_job.lifecycle_id
                        AND l.closed_at IS NULL
                        AND l.abandoned_at IS NULL
                        AND processing_job.processing_version >= l.published_version)
             RETURNING attempts`;
  }

  async openLifecycle(input: {
    lifecycleId: string;
    articleId: string;
    openedAt: string;
  }): Promise<void> {
    this.database.query((connection) => {
      connection.all(
        `INSERT INTO processing_lifecycle (lifecycle_id, article_id, opened_at)
         VALUES (?, ?, ?)`,
        [input.lifecycleId, input.articleId, input.openedAt],
      );
    });
  }

  async createJob(input: {
    lifecycleId: string;
    processingVersion: number;
    createdAt: string;
  }): Promise<void> {
    this.database.query((connection) => {
      connection.all(
        `INSERT INTO processing_job
           (lifecycle_id, processing_version, state, attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?)`,
        [input.lifecycleId, input.processingVersion, input.createdAt, input.createdAt],
      );
    });
  }

  async claim(input: {
    lifecycleId: string;
    processingVersion: number;
    owner: string;
    token: string;
    now: number;
    leaseDurationMs: number;
    updatedAt: string;
  }): Promise<ClaimedProcessingJob | undefined> {
    return this.immediate(() => {
      // Retirement runs first, inside the same transaction, so the claim never
      // observes a stale row it would have had to exclude (CLM-19).
      this.retireSuperseded(input.updatedAt);

      const rows = this.database.query((connection) =>
        connection.all(this.claimSql(), [
          input.owner,
          input.token,
          input.now,
          input.leaseDurationMs,
          input.updatedAt,
          input.lifecycleId,
          input.processingVersion,
        ]),
      ) as Array<{
        lifecycle_id: string;
        processing_version: number;
        attempts: number;
        lease_expires_at: number;
      }>;

      const row = rows[0];
      if (row === undefined) {
        return undefined;
      }
      return {
        lifecycleId: row.lifecycle_id,
        processingVersion: row.processing_version,
        attempts: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
      };
    });
  }

  async requeue(input: {
    lifecycleId: string;
    processingVersion: number;
    token: string;
    failureCode: string;
    updatedAt: string;
  }): Promise<boolean> {
    return this.immediate(() => {
      // `CLM-19`: a Worker write is an encounter point. A stale job is retired
      // here, which clears its lease, so the fenced UPDATE below matches no row
      // and the caller's result is discarded (`false`) instead of being applied.
      this.retireSuperseded(input.updatedAt);

      const rows = this.database.query((connection) =>
        connection.all(this.requeueSql(), [
          input.failureCode,
          input.updatedAt,
          input.lifecycleId,
          input.processingVersion,
          input.token,
        ]),
      ) as Array<{ attempts: number }>;
      return rows.length > 0;
    });
  }

  async markTerminal(input: {
    lifecycleId: string;
    processingVersion: number;
    token: string;
    terminalReason: string;
    failureCode?: string | null;
    updatedAt: string;
  }): Promise<boolean> {
    return this.immediate(() => {
      // Same encounter point as `requeue` (`CLM-19`). A committed outcome is
      // never matched by the retirement pass, and a stale job never reaches the
      // fenced UPDATE, so history cannot be rewritten from here.
      this.retireSuperseded(input.updatedAt);

      const rows = this.database.query((connection) =>
        connection.all(this.markTerminalSql(), [
          input.terminalReason,
          input.failureCode ?? null,
          input.updatedAt,
          input.lifecycleId,
          input.processingVersion,
          input.token,
        ]),
      ) as Array<{ attempts: number }>;
      return rows.length > 0;
    });
  }

  async reopenExpired(input: { now: number; updatedAt: string }): Promise<number> {
    return this.immediate(() => {
      // `CLM-19` precedes Recovery: a job a newer publication has made
      // unpublishable is terminalized here and never handed back to a Worker.
      this.retireSuperseded(input.updatedAt);

      const rows = this.database.query((connection) =>
        connection.all(this.reopenExpiredSql(), [input.updatedAt, input.now]),
      ) as Array<{ attempts: number }>;
      return rows.length;
    });
  }

  async findJob(
    lifecycleId: string,
    processingVersion: number,
  ): Promise<ProcessingJob | undefined> {
    const row = this.database.query((connection) =>
      connection.get(
        `SELECT ${JOB_COLUMNS} FROM processing_job
          WHERE lifecycle_id = ? AND processing_version = ?`,
        [lifecycleId, processingVersion],
      ),
    ) as JobRow | undefined;

    return row === undefined ? undefined : toJob(row);
  }

  async findLifecycle(lifecycleId: string): Promise<ProcessingLifecycle | undefined> {
    const row = this.database.query((connection) =>
      connection.get(
        `SELECT lifecycle_id, article_id, published_version, published_revision,
                opened_at, closed_at, abandoned_at
           FROM processing_lifecycle
          WHERE lifecycle_id = ?`,
        [lifecycleId],
      ),
    ) as LifecycleRow | undefined;

    return row === undefined
      ? undefined
      : {
          lifecycleId: row.lifecycle_id,
          articleId: row.article_id,
          publishedVersion: row.published_version,
          publishedRevision: row.published_revision,
          openedAt: row.opened_at,
          closedAt: row.closed_at,
          abandonedAt: row.abandoned_at,
        };
  }
}

function toJob(row: JobRow): ProcessingJob {
  return {
    lifecycleId: row.lifecycle_id,
    processingVersion: row.processing_version,
    state: row.state,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    failureCode: row.failure_code,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
