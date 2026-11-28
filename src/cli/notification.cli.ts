import { logger as defaultLogger } from '../core/logger.js';
import { openDatabase, type SqliteDatabase } from '../core/persistence/sqlite.js';
import type { TelegramArticleInput } from '../modules/notification/telegram.formatter.js';
import { SqliteNotificationDeliveryRepository } from '../modules/notification/repository/sqlite-notification-delivery.repository.js';
import {
  createTelegramProvider,
  TelegramSendError,
  type TelegramTransport,
} from '../modules/notification/telegram.provider.js';

import { EXIT_FAILURE, EXIT_SUCCESS } from './exit-codes.js';

/**
 * The one row this CLI publishes: the most recently updated derived article that
 * still has its source row.
 *
 * The link comes from `articles.url` — the stored original — because
 * `article_derived` holds no URL and nothing here may synthesize one. The inner
 * join also excludes a derivation whose article row was already purged by
 * retention: publishing it would need a link that no longer exists.
 */
const LATEST_DERIVED_SQL = `SELECT d.article_id, d.title_zh, d.summary_zh, d.updated_at, a.url
   FROM article_derived AS d
   JOIN articles AS a ON a.id = d.article_id
  ORDER BY d.updated_at DESC, d.article_id ASC
  LIMIT 1`;

function findLatestDerivedArticle(database: SqliteDatabase): TelegramArticleInput | undefined {
  const row = database.query((connection) => connection.get(LATEST_DERIVED_SQL)) as
    | { article_id: string; title_zh: string; summary_zh: string; updated_at: string; url: string }
    | undefined;

  if (row === undefined) {
    return undefined;
  }

  return {
    articleId: row.article_id,
    titleZh: row.title_zh,
    summaryZh: row.summary_zh,
    at: row.updated_at,
    sourceUrl: row.url,
  };
}

export interface NotificationCliDependencies {
  /** Defaults to the production `openDatabase()` reading `env.DATABASE_PATH`. */
  openDatabase?: () => SqliteDatabase;
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

/**
 * Publishes the newest derived article, one message, one outcome.
 *
 * No batch is walked and nothing is scheduled: this process handles at most one
 * article and exits. Delivery is deduplicated by `notification_delivery`, written
 * only after Telegram confirms the send — so a run over an already-announced
 * article reports `skipped` instead of sending it again, and a run whose send
 * failed leaves no row behind and retries next time.
 *
 * An empty database is a success, matching the other one-shot CLIs: there is
 * nothing to publish is the steady state, not a failure. Every other outcome —
 * unreadable database, missing credential, Telegram refusal — exits `1` with the
 * reason in the document, so a supervisor never has to parse prose.
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

  let database: SqliteDatabase | undefined;
  try {
    database = open();
    const article = findLatestDerivedArticle(database);

    if (article === undefined) {
      writeStdout(JSON.stringify({ status: 'no-article' }));
      log.info('Notification run found no derived article to publish');
      return EXIT_SUCCESS;
    }

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
      return EXIT_SUCCESS;
    }

    const provider = createTelegramProvider(
      { botToken: dependencies.botToken, chatId: dependencies.chatId },
      dependencies.transport,
    );
    const { messageId } = await provider.send(article);

    // Written after the send, never before: a row is the record of a message
    // Telegram accepted, so a failed send cannot leave one behind.
    await deliveries.recordSent({
      articleId: article.articleId,
      messageId,
      createdAt: new Date().toISOString(),
    });

    writeStdout(JSON.stringify({ status: 'sent', articleId: article.articleId, messageId }));
    log.info('Notification run published one article', {
      articleId: article.articleId,
      messageId,
    });
    return EXIT_SUCCESS;
  } catch (error) {
    const reason = error instanceof TelegramSendError ? error.reason : 'unexpected-error';
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(JSON.stringify({ status: 'failed', reason, error: message }));
    log.error('Notification run failed', { reason, error: message });
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
  }
}
