/**
 * Scheduled entry point for the Telegram notification run.
 *
 * Run it as:
 *
 *   npm run notify:scheduled
 *
 * One invocation performs at most one publish and exits; the schedule belongs to
 * cron or a systemd timer, never to this process. There are no arguments and no
 * flags: the database path, the bot token, the chat id and the log level all come
 * from the environment, so the same command works for every deployment and no
 * path is hard-coded here. See `docs/notify-cron.md`.
 *
 * Import order follows the other entry points: the command line is settled first,
 * and only a real run evaluates `env.ts` (which validates `process.env`) or opens
 * a database.
 */
const USAGE = `Usage: notify-scheduled

Publishes the newest derived article to Telegram once, then exits.

Takes no arguments. Configuration comes from the environment:
  DATABASE_PATH         database to read (no default path in code)
  TELEGRAM_BOT_TOKEN    bot credential
  TELEGRAM_CHAT_ID      destination chat
  LOG_LEVEL             log verbosity

Intended for a system scheduler (cron, systemd timer). Any argument exits 2
without opening the database.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  if (args.length > 0) {
    process.stderr.write(`notify-scheduled takes no arguments.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runScheduledNotification, scheduledConfigFromEnv } =
    await import('./scheduled-notify.cli.js');

  setLogLevel(env.LOG_LEVEL);
  process.exitCode = await runScheduledNotification({ config: scheduledConfigFromEnv(env) });
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
