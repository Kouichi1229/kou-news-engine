/**
 * Executable entry point for the one-shot Telegram notification CLI.
 *
 * Run it as:
 *
 *   npm run notify -- --execute [--category <category>]
 *
 * A separate entry point on purpose: the HTTP server never publishes, and this
 * process never starts a server. Sending is triggered by an external scheduler,
 * which is why `--execute` is mandatory — there is no preview mode, and a silent
 * no-op would be indistinguishable from a completed run.
 *
 * ## Ordering
 *
 * The command line is settled before anything else, `--category` included. Only a
 * complete, valid command line reaches `env.ts` (which validates `process.env` on
 * evaluation) and the database, so a mistyped cron line fails without needing
 * configuration and without creating a database file.
 */
import { parseCliArgs } from './args.js';
import { parseCategoryArgument } from './category-argument.js';
import { EXIT_USAGE } from './exit-codes.js';
import { usageFor } from './usage.js';

const USAGE = usageFor(
  'notify',
  'Publish the newest derived article to Telegram, optionally of one category.',
  {
    executeRequired: true,
    usageSuffix: '[--category <category>]',
    extraFlags: `  --category <category>  Publish only the newest article of this category.
               Without it, the newest derived article of any category is
               published. An unknown category exits 2.`,
  },
);

async function main(): Promise<void> {
  const taken = await parseCategoryArgument(process.argv.slice(2));

  if (taken.kind === 'error') {
    process.stderr.write(`${taken.message}\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  const parsed = parseCliArgs(taken.argument.rest);

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
    ...(taken.argument.category === undefined ? {} : { category: taken.argument.category }),
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
