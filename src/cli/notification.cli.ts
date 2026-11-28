import { logger as defaultLogger } from '../core/logger.js';
import { openDatabase, type SqliteDatabase } from '../core/persistence/sqlite.js';
import type { DerivationCategory } from '../modules/derivation/derivation.service.js';
import { SqliteArticleDerivedRepository } from '../modules/derivation/repository/sqlite-article-derived.repository.js';
import type { TelegramArticleInput } from '../modules/notification/telegram.formatter.js';
import { SqliteNotificationDeliveryRepository } from '../modules/notification/repository/sqlite-notification-delivery.repository.js';
import {
  createTelegramProvider,
  TelegramSendError,
  type TelegramTransport,
} from '../modules/notification/telegram.provider.js';

import { EXIT_FAILURE, EXIT_SUCCESS } from './exit-codes.js';

/**
 * How many of the newest records are considered before giving up.
 *
 * The chosen record also has to still have its `articles` row, because the message
 * links to the stored original. Retention removes both together, so the first
 * candidate is normally the answer and the ceiling only bounds the search if that
 * ever stops being true.
 */
const NOTIFICATION_CANDIDATE_LIMIT = 50;

/** The stored original link, or `undefined` when the article row is gone. */
function findArticleUrl(database: SqliteDatabase, articleId: string): string | undefined {
  const row = database.query((connection) =>
    connection.get('SELECT url FROM articles WHERE id = ?', [articleId]),
  ) as { url: string } | undefined;
  return row?.url;
}

/**
 * The one row this CLI publishes: the most recently updated derived article that
 * still has its source row, optionally of one category.
 *
 * The category filter is the repository's own predicate — the same `category = ?`
 * that serves `GET /api/articles/derived?category=` — rather than a second copy of
 * the SQL kept in step here. The link comes from `articles.url`, the stored
 * original, because `article_derived` holds no URL and nothing here may synthesize
 * one; a derivation whose article row was purged is skipped, since publishing it
 * would need a link that no longer exists.
 *
 * A record derived before categories existed has a null category, so a filtered run
 * never selects it. An unfiltered run still can, which is the behaviour it had
 * before the filter existed.
 */
async function findLatestDerivedArticle(
  database: SqliteDatabase,
  category: DerivationCategory | undefined,
): Promise<TelegramArticleInput | undefined> {
  const drafts = await new SqliteArticleDerivedRepository(database).listRecent(
    NOTIFICATION_CANDIDATE_LIMIT,
    category,
  );

  for (const draft of drafts) {
    const sourceUrl = findArticleUrl(database, draft.articleId);
    if (sourceUrl !== undefined) {
      return {
        articleId: draft.articleId,
        titleZh: draft.titleZh,
        summaryZh: draft.summaryZh,
        at: draft.at,
        sourceUrl,
      };
    }
  }

  return undefined;
}

export interface NotificationCliDependencies {
  /** Defaults to the production `openDatabase()` reading `env.DATABASE_PATH`. */
  openDatabase?: () => SqliteDatabase;
  /**
   * Publishes only the newest article of this category.
   *
   * Absent means no filter: the newest derived article of any category, as before.
   * The entry point validates the value, so an unknown label never reaches a run.
   */
  category?: DerivationCategory;
  /** Defaults to `env.TELEGRAM_BOT_TOKEN`, supplied by the entry point. */
  botToken?: string | undefined;
  /** Defaults to `env.TELEGRAM_CHAT_ID`, supplied by the entry point. */
  chatId?: string | undefined;
  /** Defaults to the real HTTP transport. A fake here is how tests avoid the network. */
  transport?: TelegramTransport;
  /** Defaults to the application logger. */
  logger?: Pick<typeof defaultLogger, 'info' | 'error'>;
  /** Where the outcome document is written. Defaults to `process.stdout`. */
  writeStdout?: (line: string) => void;
  /** Where the failure document is written. Defaults to `process.stderr`. */
  writeStderr?: (line: string) => void;
}

/** One article's outcome, as the end-of-run summary counts it. */
export interface NotificationRunResult {
  /** Absent only when the run failed before an article could be chosen. */
  readonly articleId: string | undefined;
  readonly outcome: 'sent' | 'skipped' | 'failed';
  /** Why it failed. Present exactly when `outcome` is `failed`. */
  readonly reason?: string;
}

/** The document written as the last line of every run. */
export interface NotificationRunSummary {
  readonly summary: { readonly sent: number; readonly skipped: number; readonly failed: number };
  readonly results: readonly NotificationRunResult[];
}

/** Counts the results. Exported so a test can assert the shape without a run. */
export function summarizeNotificationRun(
  results: readonly NotificationRunResult[],
): NotificationRunSummary {
  const counts = { sent: 0, skipped: 0, failed: 0 };
  for (const result of results) {
    counts[result.outcome] += 1;
  }
  return { summary: counts, results };
}

/**
 * Publishes the newest derived article, one message, one outcome.
 *
 * No batch is walked and nothing is scheduled: this process handles at most one
 * article and exits. Delivery is deduplicated by `notification_delivery`, written
 * only after Telegram confirms the send — so a run over an already-announced
 * article reports `skipped` instead of sending it again, and a run whose send
 * failed leaves no row behind and retries next time.
 *
 * ## Two failures that look alike and are not
 *
 * A send that Telegram refused and a send that succeeded but could not be
 * recorded are different facts, and the run reports them apart:
 *
 * - the send failed — nothing was delivered, nothing was written, the next run
 *   retries the same article (`reason` is the provider's own reason);
 * - the send succeeded but the record failed — the message exists in the chat and
 *   no row says so (`reason: 'delivery-not-recorded'`, with the `messageId` so an
 *   operator can reconcile). The run does not retry the write and does not claim
 *   success: the next run will announce the article again, which is the duplicate
 *   this ledger exists to prevent, and pretending otherwise would hide it.
 *
 * An empty database is a success, matching the other one-shot CLIs: there is
 * nothing to publish is the steady state, not a failure. Every other outcome —
 * unreadable database, missing credential, Telegram refusal — exits `1` with the
 * reason in the document, so a supervisor never has to parse prose.
 *
 * ## The summary line
 *
 * The last line on stdout is always a summary of the run, whatever the outcome:
 *
 *   {"summary":{"sent":0,"skipped":1,"failed":0},"results":[{"articleId":"a1","outcome":"skipped"}]}
 *
 * It exists so a scheduler can count runs without parsing the outcome documents,
 * which differ in shape per outcome. `results` carries the article id and, for a
 * failure, the reason — the two facts an operator needs to find the article again.
 * The summary is written to stdout even when the outcome document went to stderr,
 * because the summary is a statistic, not a failure. Counts are 0 or 1 today: one
 * invocation handles one article, and that is deliberately not changing.
 */
export async function runNotificationCli(
  dependencies: NotificationCliDependencies = {},
): Promise<number> {
  const log = dependencies.logger ?? defaultLogger;
  const writeStdout =
    dependencies.writeStdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const writeStderr =
    dependencies.writeStderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const open = dependencies.openDatabase ?? ((): SqliteDatabase => openDatabase());

  const results: NotificationRunResult[] = [];
  let database: SqliteDatabase | undefined;
  let articleId: string | undefined;

  try {
    database = open();
    const article = await findLatestDerivedArticle(database, dependencies.category);

    if (article === undefined) {
      writeStdout(JSON.stringify({ status: 'no-article' }));
      log.info('Notification run found no derived article to publish');
      return EXIT_SUCCESS;
    }

    articleId = article.articleId;
    const deliveries = new SqliteNotificationDeliveryRepository(database);
    const alreadySent = await deliveries.findSuccessful(article.articleId);

    if (alreadySent !== undefined) {
      writeStdout(
        JSON.stringify({
          status: 'skipped',
          articleId: article.articleId,
          messageId: alreadySent.messageId,
        }),
      );
      log.info('Notification run skipped an already-published article', {
        articleId: article.articleId,
        messageId: alreadySent.messageId,
      });
      results.push({ articleId: article.articleId, outcome: 'skipped' });
      return EXIT_SUCCESS;
    }

    const provider = createTelegramProvider(
      { botToken: dependencies.botToken, chatId: dependencies.chatId },
      dependencies.transport,
    );
    const { messageId } = await provider.send(article);

    // Written after the send, never before: a row is the record of a message
    // Telegram accepted, so a failed send cannot leave one behind.
    try {
      await deliveries.recordSent({
        articleId: article.articleId,
        messageId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      // The message is already in the chat. Reporting this as a failed send would
      // invite a retry that duplicates it, and reporting it as `sent` would claim
      // a record that does not exist. The message id is the only useful fact.
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(
        JSON.stringify({
          status: 'failed',
          reason: 'delivery-not-recorded',
          articleId: article.articleId,
          messageId,
          error: message,
        }),
      );
      log.error('Notification was sent but its delivery record could not be written', {
        articleId: article.articleId,
        messageId,
        error: message,
      });
      results.push({
        articleId: article.articleId,
        outcome: 'failed',
        reason: 'delivery-not-recorded',
      });
      return EXIT_FAILURE;
    }

    writeStdout(JSON.stringify({ status: 'sent', articleId: article.articleId, messageId }));
    log.info('Notification run published one article', {
      articleId: article.articleId,
      messageId,
    });
    results.push({ articleId: article.articleId, outcome: 'sent' });
    return EXIT_SUCCESS;
  } catch (error) {
    const reason = error instanceof TelegramSendError ? error.reason : 'unexpected-error';
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(JSON.stringify({ status: 'failed', reason, error: message }));
    log.error('Notification run failed', { reason, error: message });
    results.push({ articleId, outcome: 'failed', reason });
    return EXIT_FAILURE;
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (closeError) {
        // The outcome above is already decided; teardown must not replace it.
        log.error('Notification database could not be closed', {
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      }
    }
    writeStdout(JSON.stringify(summarizeNotificationRun(results)));
  }
}
