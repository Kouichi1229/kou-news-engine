/**
 * Executable entry point for the one-shot Telegram notification CLI.
 *
 * Run it as:
 *
 *   npm run notify -- --execute
 *
 * A separate entry point on purpose: the HTTP server never publishes, and this
 * process never starts a server. Sending is triggered by an external scheduler,
 * which is why `--execute` is mandatory — there is no preview mode, and a silent
 * no-op would be indistinguishable from a completed run.
 *
 * ## Ordering
 *
 * The command line is parsed before anything else. Only `--execute` reaches
 * `env.ts` (which validates `process.env` on evaluation) and the database.
 */
import { parseCliArgs } from './args.js';
import { EXIT_USAGE } from './exit-codes.js';
import { usageFor } from './usage.js';

const USAGE = usageFor('notify', 'Publish the newest derived article to Telegram.', {
  executeRequired: true,
});

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.mode === 'usage-error') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  if (parsed.mode === 'help') {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  if (parsed.mode !== 'execute') {
    process.stderr.write(`Notification has no preview mode; pass --execute.\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  // Imported here rather than at module scope. `env.ts` validates `process.env`
  // as soon as it is evaluated, so a static import would throw before this
  // file's `main().catch` exists — leaving the failure to Node's uncaught
  // module-evaluation path, with no structured diagnostic.
  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runNotificationCli } = await import('./notification.cli.js');

  setLogLevel(env.LOG_LEVEL);
  process.exitCode = await runNotificationCli({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  });
}

main().catch((error: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'Notification CLI crashed before it could report an outcome',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
