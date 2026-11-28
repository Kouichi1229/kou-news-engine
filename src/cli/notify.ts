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

interface CategoryArgument {
  /** The remaining arguments, with the flag and its value removed. */
  readonly rest: readonly string[];
  /** Absent when `--category` was not given: the unfiltered run. */
  readonly category?: string;
}

/**
 * Lifts `--category <value>` out of the argument vector.
 *
 * Done here rather than in `parseCliArgs`, which rejects every flag it does not
 * know and deliberately imports nothing: the category's vocabulary lives in the
 * derivation module, which has to stay out of a parser that runs before `env.ts`
 * is evaluated. Returns a message instead of a result when the flag is malformed,
 * so the caller can print the usage and exit 2.
 */
function takeCategory(argv: readonly string[]): CategoryArgument | string {
  const at = argv.indexOf('--category');
  if (at === -1) {
    return { rest: argv };
  }

  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    return 'The --category flag needs a value.';
  }

  const rest = argv.filter((_, index) => index !== at && index !== at + 1);
  if (rest.includes('--category')) {
    return 'The --category flag may be given only once.';
  }
  return { rest, category: value };
}

async function main(): Promise<void> {
  const taken = takeCategory(process.argv.slice(2));

  if (typeof taken === 'string') {
    process.stderr.write(`${taken}\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  const parsed = parseCliArgs(taken.rest);

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

  // The category is settled before `env.ts` is evaluated, for the same reason the
  // arguments are: a run rejected for a bad flag must not depend on configuration
  // the operator has not supplied yet, and must not open a database either.
  const { DERIVATION_CATEGORIES } = await import('../modules/derivation/derivation.service.js');
  const category = taken.category;
  if (category !== undefined && !(DERIVATION_CATEGORIES as readonly string[]).includes(category)) {
    process.stderr.write(
      `Unknown category "${category}". Expected one of: ${DERIVATION_CATEGORIES.join(', ')}.\n\n${USAGE}`,
    );
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
    ...(category === undefined
      ? {}
      : { category: category as (typeof DERIVATION_CATEGORIES)[number] }),
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
