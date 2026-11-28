/**
 * Scheduled entry point for the Telegram notification run.
 *
 * Run it as:
 *
 *   npm run notify:scheduled [--category <category>]
 *
 * One invocation performs at most one publish and exits; the schedule belongs to
 * cron or a systemd timer, never to this process. The database path, the bot token,
 * the chat id and the log level all come from the environment, so the same command
 * works for every deployment and no path is hard-coded here. The only flag is the
 * optional `--category`, which narrows what is published. See `docs/notify-cron.md`.
 *
 * Import order follows the other entry points: the command line is settled first,
 * and only a real run evaluates `env.ts` (which validates `process.env`) or opens
 * a database. This file opens no database itself — the publish flow it hands off to
 * does, through `DATABASE_PATH`.
 */
const USAGE = `Usage: notify-scheduled [--category <category>]

  Publishes the newest derived article to Telegram once, then exits.

  Configuration comes from the environment:
    DATABASE_PATH         database to read (no default path in code)
    TELEGRAM_BOT_TOKEN    bot credential
    TELEGRAM_CHAT_ID      destination chat
    LOG_LEVEL             log verbosity

  Options:
    --help, -h             Show this message and exit. Opens no database.
    --category <category>  Publish only the newest article of this category:
                           國際, 政治, 財經, 科技, 社會, 生活, 健康, 娛樂, 體育
                           Without it, the newest derived article of any category
                           is published.

  Intended for a system scheduler (cron, systemd timer). Any other argument, or an
  unknown category, exits 2 without opening the database.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const { parseCategoryArgument } = await import('./category-argument.js');
  const taken = await parseCategoryArgument(args);

  if (taken.kind === 'error') {
    process.stderr.write(`${taken.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (taken.argument.rest.length > 0) {
    process.stderr.write(`notify-scheduled takes no arguments other than --category.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runScheduledNotification, scheduledConfigFromEnv } =
    await import('./scheduled-notify.cli.js');

  setLogLevel(env.LOG_LEVEL);
  process.exitCode = await runScheduledNotification({
    config: scheduledConfigFromEnv(env),
    ...(taken.argument.category === undefined ? {} : { category: taken.argument.category }),
  });
}

main().catch((error: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'Scheduled notification crashed before it could report an outcome',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
