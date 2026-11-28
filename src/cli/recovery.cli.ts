import { logger as defaultLogger } from '../core/logger.js';
import { openDatabase, type SqliteDatabase } from '../core/persistence/sqlite.js';
import { SqliteProcessingJobRepository } from '../modules/processing/repository/sqlite-processing-job.repository.js';

import { EXIT_FAILURE, EXIT_SUCCESS } from './exit-codes.js';

/**
 * Execution logic for the one-shot Recovery CLI (`D-3`, `D-4`).
 *
 * One transaction, one outcome: the run reports how many expired jobs it
 * reopened, or it reports a failure. There is no preview mode (`D-4b`), no
 * retry (`D-4c`) and no cancellation machinery (`D-4d`) — Recovery is a single
 * synchronous `BEGIN IMMEDIATE` transaction, so an interrupted process leaves
 * the uncommitted work to SQLite's rollback.
 */
export interface RecoveryCliDependencies {
  /** Defaults to the production `openDatabase()` reading `env.DATABASE_PATH`. */
  openDatabase?: () => SqliteDatabase;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to the application logger. */
  logger?: Pick<typeof defaultLogger, 'info' | 'error'>;
}

/**
 * Reopens expired jobs and returns the process exit code.
 *
 * An empty result is a success: nothing to reopen is the steady state of a
 * scheduler-invoked sweep, not a failure. Every database failure — including
 * `SQLITE_BUSY` — is reported as `EXIT_FAILURE` without a retry; whether to try
 * again is the scheduler's decision, not this process's.
 */
export async function runRecoveryCli(dependencies: RecoveryCliDependencies = {}): Promise<number> {
  const log = dependencies.logger ?? defaultLogger;
  // Read once: `now` and `updated_at` must describe the same instant.
  const now = (dependencies.now ?? Date.now)();
  const open = dependencies.openDatabase ?? ((): SqliteDatabase => openDatabase());

  let database: SqliteDatabase | undefined;
  try {
    database = open();
    const repository = new SqliteProcessingJobRepository(database);
    const reopened = await repository.reopenExpired({
      now,
      updatedAt: new Date(now).toISOString(),
    });
    log.info('Recovery run finished', { reopened });
    return EXIT_SUCCESS;
  } catch (error) {
    log.error('Recovery run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return EXIT_FAILURE;
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (closeError) {
        // The outcome above is already decided; teardown must not replace it.
        log.error('Recovery database could not be closed', {
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      }
    }
  }
}
