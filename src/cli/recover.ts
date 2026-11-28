/**
 * Executable entry point for the one-shot Recovery CLI.
 *
 * Run it as:
 *
 *   npm run recover -- --execute
 *
 * A separate entry point on purpose (`D-3`): Recovery is triggered by an
 * external scheduler, never by the HTTP server, a long-running poller or a
 * Worker claim.
 *
 * ## Ordering
 *
 * The command line is parsed before anything else. Only `--execute` reaches
 * `env.ts` (which validates `process.env` on evaluation) and the database.
 * `--help`, a rejected command line and the shared parser's default dry-run all
 * end without opening a database, because Recovery has no preview mode (`D-4b`)
 * and a silent no-op would be indistinguishable from a completed run (`D-4a`).
 */
import { parseCliArgs } from './args.js';
import { EXIT_USAGE } from './exit-codes.js';
import { usageFor } from './usage.js';

const USAGE = usageFor('recover', 'Reopen processing jobs whose lease expired.', {
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
    process.stderr.write(`Recovery has no preview mode; pass --execute.\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  // Imported here rather than at module scope. `env.ts` validates `process.env`
  // as soon as it is evaluated, so a static import would throw before this
  // file's `main().catch` exists — leaving the failure to Node's uncaught
  // module-evaluation path, with no structured diagnostic.
  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runRecoveryCli } = await import('./recovery.cli.js');

  setLogLevel(env.LOG_LEVEL);
  process.exitCode = await runRecoveryCli();
}

main().catch((error: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'Recovery CLI crashed before it could report an outcome',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
