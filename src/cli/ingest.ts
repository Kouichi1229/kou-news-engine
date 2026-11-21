/**
 * Executable entry point for the one-shot ingestion CLI.
 *
 * Run it as:
 *
 *   npm run ingest          # via tsx, for development
 *   node dist/cli/ingest.js # from a build, in production
 *
 * It is a separate entry point from `src/index.ts` on purpose: the HTTP server
 * must never start ingestion, and this process must never start a server. The
 * only shared code is the runtime composition root.
 *
 * The process exits with the code the CLI decides — see `exit-codes.ts` for the
 * contract — so a supervisor can tell a clean pass, a failed pass and a
 * cancellation apart without parsing logs.
 */
import { setLogLevel } from '../core/logger.js';

import { runCli } from './ingestion.cli.js';

async function main(): Promise<void> {
  // Loaded here rather than at module scope. `env.ts` validates `process.env`
  // as soon as it is evaluated, so a static import would throw before this
  // file's `main().catch` exists — leaving the failure to Node's uncaught
  // module-evaluation path, with no structured diagnostic. Importing inside
  // `main` makes that throw an ordinary rejection the handler below can report.
  const { env } = await import('../config/env.js');

  setLogLevel(env.LOG_LEVEL);
  await runCli();
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
