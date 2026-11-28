import type { Env } from '../config/env.js';
import { logger as defaultLogger } from '../core/logger.js';
import { openDatabase, type SqliteDatabase } from '../core/persistence/sqlite.js';
import type { DerivationCategory } from '../modules/derivation/derivation.service.js';
import type { TelegramTransport } from '../modules/notification/telegram.provider.js';

import { runNotificationCli } from './notification.cli.js';

/**
 * The scheduled entry point's configuration, entirely from the environment.
 *
 * A plain object rather than a second settings module: three values, each of
 * which already has a home in `env.ts`. Nothing here has a default path of its
 * own, so no database location is baked into the code.
 */
export interface ScheduledNotificationConfig {
  readonly databasePath: string;
  readonly botToken: string | undefined;
  readonly chatId: string | undefined;
}

/** Projects the validated environment onto the scheduled entry's inputs. */
export function scheduledConfigFromEnv(env: Env): ScheduledNotificationConfig {
  return {
    databasePath: env.DATABASE_PATH,
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  };
}

export interface ScheduledNotificationDependencies {
  readonly config: ScheduledNotificationConfig;
  /**
   * Publishes only the newest article of this category.
   *
   * Comes from the command line, not from the environment: one deployment may run
   * several schedules, one per category, against the same database. Absent means no
   * filter, which is the unfiltered run this entry has always performed.
   */
  readonly category?: DerivationCategory | undefined;
  /** Defaults to the real HTTP transport. A fake here is how tests avoid the network. */
  transport?: TelegramTransport | undefined;
  /** Defaults to `openDatabase({ path: config.databasePath })`. */
  openDatabase?: (() => SqliteDatabase) | undefined;
  logger?: Pick<typeof defaultLogger, 'info' | 'error'> | undefined;
  writeStdout?: ((line: string) => void) | undefined;
  writeStderr?: ((line: string) => void) | undefined;
}

/**
 * One scheduled run: resolve the configuration, then hand off to the existing
 * publish flow.
 *
 * This entry owns no publishing logic of its own — formatting, deduplication,
 * record-failure reporting and exit codes all come from `runNotificationCli`. It
 * exists so a system scheduler has one stable command with no arguments: a cron
 * line cannot forget `--execute`, and a different database means a different
 * `DATABASE_PATH`, not a different script.
 *
 * There is no loop, no timer and no in-process scheduler. One invocation, one
 * article, then exit — which is what lets cron decide the frequency.
 *
 * `category` is the one thing this entry can be told on the command line. It is
 * forwarded, not interpreted: the repository filter and the deduplication that
 * decide what is actually published stay in the flow above.
 */
export async function runScheduledNotification(
  dependencies: ScheduledNotificationDependencies,
): Promise<number> {
  const { config } = dependencies;

  // Spread conditionally: the publisher's dependency type has no explicit
  // `undefined` for these, and an absent key is what selects its default.
  return runNotificationCli({
    openDatabase:
      dependencies.openDatabase ??
      ((): SqliteDatabase => openDatabase({ path: config.databasePath })),
    botToken: config.botToken,
    chatId: config.chatId,
    ...(dependencies.category === undefined ? {} : { category: dependencies.category }),
    ...(dependencies.transport === undefined ? {} : { transport: dependencies.transport }),
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    ...(dependencies.writeStdout === undefined ? {} : { writeStdout: dependencies.writeStdout }),
    ...(dependencies.writeStderr === undefined ? {} : { writeStderr: dependencies.writeStderr }),
  });
}
