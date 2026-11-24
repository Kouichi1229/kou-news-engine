/**
 * Executable entry point for the one-shot extraction CLI.
 *
 * Run it as:
 *
 *   npm run extract                # dry-run preview
 *   npm run extract -- --execute   # real extraction
 *
 * A separate entry point from `src/index.ts` on purpose: the HTTP server must
 * never start extraction, and this process must never start a server.
 *
 * ## Ordering
 *
 * The command line is parsed before anything else. `--help` is answered and the
 * process exits without importing `env.ts` (which validates `process.env` on
 * evaluation) and without opening a database (which creates the file and runs
 * migrations). Everything below that point runs only for a real mode.
 */
import { parseCliArgs } from './args.js';
import { EXIT_USAGE } from './extraction-exit-codes.js';
import { usageFor } from './usage.js';

const USAGE = usageFor('extract', 'Extract one batch of article bodies.');

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

  // Imported here rather than at module scope. `env.ts` validates `process.env`
  // as soon as it is evaluated, so a static import would throw before this
  // file's `main().catch` exists — leaving the failure to Node's uncaught
  // module-evaluation path, with no structured diagnostic.
  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runExtractionCli } = await import('./extraction.cli.js');

  setLogLevel(env.LOG_LEVEL);
  process.exitCode = await runExtractionCli({ execute: parsed.mode === 'execute' });
}

main().catch((error: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'Extraction CLI crashed before it could report an outcome',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
