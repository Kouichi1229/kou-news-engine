import { createCancellationSignal } from '../core/lifecycle/cancellation.js';
import { createSignalCoordinator } from '../core/lifecycle/signal-coordinator.js';
import type { SignalHost } from '../core/lifecycle/signal-coordinator.js';
import { logger as defaultLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/persistence/sqlite.js';
import { openDatabase } from '../core/persistence/sqlite.js';
import {
  DatabaseNotAvailableError,
  openReadOnlyDatabase,
  type ReadOnlyDatabase,
} from '../core/persistence/read-only.js';
import type { DerivationProvider } from '../modules/derivation/derivation.bootstrap.js';
import { systemClock, type Clock } from '../modules/extraction/clock.js';
import { EXTRACTOR_VERSION } from '../modules/extraction/extraction.constants.js';
import { ExtractionService } from '../modules/extraction/extraction.service.js';
import { SqliteArticleContentRepository } from '../modules/extraction/repository/sqlite-article-content.repository.js';

import {
  classifyExtractionRun,
  exitCodeForExtractionOutcome,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  type CancellingSignal,
} from './extraction-exit-codes.js';

/** Reads article URLs from the existing `articles` table. */
class SqliteArticleUrlLookup {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  async findUrlById(articleId: string): Promise<string | undefined> {
    const row = this.database.query((connection) =>
      connection.get('SELECT url FROM articles WHERE id = ?', [articleId]),
    ) as { url: string } | undefined;
    return row?.url;
  }
}

export interface ExtractionCliDependencies {
  /** Defaults to a database at `env.DATABASE_PATH`. */
  openDatabase?: () => SqliteDatabase;
  /**
   * Opens the database read-only for the preview. Defaults to
   * `openReadOnlyDatabase(env.DATABASE_PATH)`.
   *
   * Separate from `openDatabase` because the two must not be interchangeable:
   * the writable path creates the file and runs migrations, which a preview may
   * never do.
   */
  openReadOnly?: (path: string) => ReadOnlyDatabase;
  /** Database path used by the preview. Defaults to `env.DATABASE_PATH`. */
  databasePath?: string;
  clock?: Clock;
  /** Defaults to the global `process`. */
  signalHost?: SignalHost;
  /** Called instead of `process.exit`, so tests can observe the code. */
  exit?: (code: number) => void;
  /** Defaults to the application logger. */
  logger?: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
  /** Where the preview line is written. Defaults to `process.stdout`. */
  writeStdout?: (line: string) => void;
  /**
   * The provider the derivation hook calls. Defaults to one built from the
   * environment (`LLM_PROVIDER`, `LLM_MODEL`, `GEMINI_API_KEY`).
   *
   * Injected rather than read here so a test can script completions without a
   * network or a credential.
   */
  provider?: DerivationProvider;
  /**
   * Set only by the entry point, and only for `--execute`.
   *
   * Absent or `false` means preview. Making the write path an explicit opt-in at
   * this level too means a caller that forgets to pass it cannot start real
   * extraction by accident.
   */
  execute?: boolean;
}

/**
 * One-shot extraction CLI.
 *
 * Claims and extracts until the queue is empty, then exits. There is no
 * scheduler: an external timer invokes the process, matching how ingestion runs.
 *
 * ## Nothing runs unless asked
 *
 * `runExtractionCli` only extracts when its caller says so. The entry point
 * resolves the mode from the command line first and never reaches this function
 * for `--help` or a rejected invocation. Without `--execute` the CLI previews
 * instead: it opens the database read-only and reports how many rows are
 * claimable, without seeding, claiming, writing or issuing a request.
 *
 * ## Signal handling
 *
 * Reuses `createSignalCoordinator` rather than registering listeners here, so
 * the graceful/forced split, the exactly-once teardown and the
 * second-signal-terminates behaviour are identical to ingestion's.
 *
 * The first signal cancels cooperatively: the service stops claiming and lets
 * any in-flight request finish. The second terminates immediately, executing no
 * SQL — the row keeps its lease and its consumed attempt, and becomes claimable
 * again when the lease expires.
 */
export async function runExtractionCli(
  dependencies: ExtractionCliDependencies = {},
): Promise<number> {
  return dependencies.execute === true
    ? runExtraction(dependencies)
    : runExtractionPreview(dependencies);
}

/**
 * Stable preview notes. Exported so tests assert the contract by name rather
 * than by matching prose that may be reworded.
 */
export const PREVIEW_NOTES = {
  unavailable: 'database unavailable; counts not performed',
  noArticles: 'no articles available',
  unseeded: 'articles exist but extraction lifecycle records have not been seeded',
  claimable: 'claimable count is an estimate; state may change before execute',
  noneClaimable:
    'no currently claimable articles; completed, exhausted, or leased records may exist',
} as const;

/** The dry-run document. Fixed shape: every field is always present. */
export interface PreviewPayload {
  mode: 'dry-run';
  database: 'available' | 'unavailable';
  articles: number | null;
  seeded: boolean | null;
  claimable: number | null;
  note: string;
}

/**
 * Classifies a readable database into one of the four distinguishable states.
 *
 * `seeded` is `null` for an empty database: with no articles there is nothing
 * to have seeded, so claiming `false` would be a statement the data cannot
 * support. Otherwise the anti-join against `article_contents` decides it.
 *
 * `claimable` is passed through untouched. It counts existing lifecycle rows
 * only, so it is `0` both before seeding and after everything is done; `seeded`
 * is what tells those apart.
 */
function classifyPreview(
  articles: number,
  unseeded: number,
  claimable: number,
): Pick<PreviewPayload, 'seeded' | 'note'> {
  if (articles === 0) {
    return { seeded: null, note: PREVIEW_NOTES.noArticles };
  }
  if (unseeded > 0) {
    return { seeded: false, note: PREVIEW_NOTES.unseeded };
  }
  return {
    seeded: true,
    note: claimable > 0 ? PREVIEW_NOTES.claimable : PREVIEW_NOTES.noneClaimable,
  };
}

/** The document used whenever the counts could not be taken. */
function unavailablePayload(): PreviewPayload {
  return {
    mode: 'dry-run',
    database: 'unavailable',
    articles: null,
    seeded: null,
    claimable: null,
    note: PREVIEW_NOTES.unavailable,
  };
}

/**
 * Reports how much work the next run would find, without doing any of it.
 *
 * Uses the read-only connection rather than the writable one, so a preview can
 * never create the database or migrate it. A missing or unopenable database is
 * reported as an unavailable count rather than repaired, and still exits `0`:
 * the preview itself succeeded, it simply had nothing to read.
 *
 * Every outcome writes one schema-valid JSON document, including failures. A
 * caller that parses stdout therefore never sees an empty line: a database that
 * exists but cannot be queried reports `database: "unavailable"` and exits `1`,
 * which is the difference between "nothing to read" and "could not read it".
 */
async function runExtractionPreview(dependencies: ExtractionCliDependencies): Promise<number> {
  const log = dependencies.logger ?? defaultLogger;
  const writeStdout =
    dependencies.writeStdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const clock = dependencies.clock ?? systemClock;

  const openReadOnly =
    dependencies.openReadOnly ?? ((path: string): ReadOnlyDatabase => openReadOnlyDatabase(path));

  const emit = (payload: PreviewPayload): void => {
    writeStdout(JSON.stringify(payload));
  };

  let database: ReadOnlyDatabase | undefined;
  try {
    const path = dependencies.databasePath ?? (await import('../config/env.js')).env.DATABASE_PATH;
    database = openReadOnly(path);
    const repository = new SqliteArticleContentRepository(database);

    // Three separate `SELECT`s. None of them seeds, claims, takes a lease or
    // increments an attempt, so the preview leaves the database untouched.
    const articles = await repository.countArticles();
    const unseeded = await repository.countUnseededArticles();
    const claimable = await repository.countClaimable({
      now: clock.now(),
      extractorVersion: EXTRACTOR_VERSION,
    });

    // Emitted in the documented field order, so the contract is readable at a
    // glance and matches the table in the specification.
    const classification = classifyPreview(articles, unseeded, claimable);
    emit({
      mode: 'dry-run',
      database: 'available',
      articles,
      seeded: classification.seeded,
      claimable,
      note: classification.note,
    });
    return EXIT_SUCCESS;
  } catch (error) {
    if (error instanceof DatabaseNotAvailableError) {
      // Nothing to read: the file is absent, or could not be opened at all.
      // That is a successful preview of an empty world, so it exits `0`.
      emit(unavailablePayload());
      log.warn('Extraction preview could not read the database', { error: error.message });
      return EXIT_SUCCESS;
    }
    // The file exists but the counts could not be taken — a corrupt or
    // non-SQLite file, for instance. Still one valid document on stdout, but
    // the exit code must not claim success.
    emit(unavailablePayload());
    log.warn('Extraction preview failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Not `EXIT_USAGE`: the command line was fine, the preview itself broke.
    return EXIT_FAILURE;
  } finally {
    database?.close();
  }
}

/**
 * Runs real extraction.
 *
 * Reached only for `--execute`. Everything here may write to the database and
 * make outbound requests.
 */
async function runExtraction(dependencies: ExtractionCliDependencies): Promise<number> {
  const log = dependencies.logger ?? defaultLogger;
  const exit = dependencies.exit ?? ((code: number): void => process.exit(code));
  const clock = dependencies.clock ?? systemClock;

  const cancellation = createCancellationSignal();
  let observedSignal: CancellingSignal | undefined;

  const coordinator = createSignalCoordinator({
    signal: cancellation,
    terminate: () => {
      exit(observedSignal === 'SIGINT' ? 130 : 143);
    },
    ...(dependencies.signalHost === undefined ? {} : { host: dependencies.signalHost }),
    logger: log,
  });

  // Installed before the database opens, so a signal arriving during startup is
  // recorded rather than lost.
  coordinator.install();

  const wrapHost = dependencies.signalHost ?? (process as unknown as SignalHost);
  const recordSignal = (signal: NodeJS.Signals): void => {
    observedSignal = signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
  };
  wrapHost.on('SIGINT', recordSignal);
  wrapHost.on('SIGTERM', recordSignal);

  let database: SqliteDatabase | undefined;
  try {
    database = (dependencies.openDatabase ?? ((): SqliteDatabase => openDatabase()))();

    const repository = new SqliteArticleContentRepository(database);
    const { createDerivationHook } = await import('../modules/derivation/derivation.bootstrap.js');
    const derivationOption = await createDerivationHook({
      database,
      now: (): number => clock.now(),
      log,
      ...(dependencies.provider === undefined ? {} : { provider: dependencies.provider }),
    });

    const service = new ExtractionService({
      repository,
      urls: new SqliteArticleUrlLookup(database),
      clock,
      isCancelled: (): boolean => cancellation.isCancelled(),
      ...derivationOption,
    });

    const summary = await service.run();
    const outcome = classifyExtractionRun(summary, observedSignal);

    log.info('Extraction run finished', {
      ...summary,
      outcome: outcome.kind,
    });

    return exitCodeForExtractionOutcome(outcome);
  } catch (error) {
    log.warn('Extraction run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    wrapHost.removeListener('SIGINT', recordSignal);
    wrapHost.removeListener('SIGTERM', recordSignal);
    try {
      coordinator.uninstall();
    } catch {
      // Teardown failures must not mask the run's own result.
    }
    database?.close();
  }
}
