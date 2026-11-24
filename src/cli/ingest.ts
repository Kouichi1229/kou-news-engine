/**
 * Executable entry point for the one-shot ingestion CLI.
 *
 * Run it as:
 *
 *   npm run ingest                # dry-run preview
 *   npm run ingest -- --execute   # real ingestion
 *
 * It is a separate entry point from `src/index.ts` on purpose: the HTTP server
 * must never start ingestion, and this process must never start a server. The
 * only shared code is the runtime composition root.
 *
 * The process exits with the code the CLI decides — see `exit-codes.ts` for the
 * contract — so a supervisor can tell a clean pass, a failed pass and a
 * cancellation apart without parsing logs.
 *
 * ## Ordering
 *
 * The command line is parsed before anything else. `--help` is answered and the
 * process exits without importing `env.ts` (which validates `process.env` on
 * evaluation) and without opening a database (which creates the file and runs
 * migrations).
 */
import { parseCliArgs } from './args.js';
import { EXIT_USAGE } from './exit-codes.js';
import { usageFor } from './usage.js';

const USAGE = usageFor('ingest', 'Run one ingestion pass over the configured feeds.');

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

  // Loaded here rather than at module scope. `env.ts` validates `process.env`
  // as soon as it is evaluated, so a static import would throw before this
  // file's `main().catch` exists — leaving the failure to Node's uncaught
  // module-evaluation path, with no structured diagnostic.
  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runCli } = await import('./ingestion.cli.js');

  setLogLevel(env.LOG_LEVEL);
  await runCli({ execute: parsed.mode === 'execute' });
}

main().catch((error: unknown): void => {
  // `runCli` reports its own failures and exits; reaching here means something
  // outside its control broke — a bad import, an unreadable environment. Report
  // it and exit nonzero so the failure is never mistaken for a clean pass.
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'Ingestion CLI crashed before it could report an outcome',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
