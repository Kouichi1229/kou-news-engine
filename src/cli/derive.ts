/**
 * Executable entry point for regenerating one article's stored derivation.
 *
 * Run it as:
 *
 *   npm run derive -- --regenerate <articleId>
 *
 * One article per invocation. The body comes from the database — the text
 * extraction already fetched and stored — so this command makes no request to the
 * publisher and no request to Telegram. It does make one model call, which is why
 * `--regenerate` and an article id are both mandatory: there is no default article
 * and no batch mode.
 *
 * The command line is settled before `env.ts` is evaluated or a database is
 * opened, following the other entry points.
 */
const USAGE = `Usage: derive --regenerate <articleId>

Regenerates the Traditional Chinese title and summary of one article, using the
body already stored by extraction. The publisher is not fetched again.

Options:
  --help, -h              Show this message and exit. Opens no database.
  --regenerate <id>       Required. The article to regenerate.

Success writes one JSON line: {"articleId","titleZh","summaryZh"}.
Failure writes one JSON line to stderr and exits 1.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const regenerateAt = args.indexOf('--regenerate');
  const articleId = regenerateAt === -1 ? undefined : args[regenerateAt + 1];
  if (regenerateAt !== 0 || args.length !== 2 || articleId === undefined || articleId === '') {
    process.stderr.write(`Expected exactly --regenerate <articleId>.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // Imported here rather than at module scope. `env.ts` validates `process.env`
  // as soon as it is evaluated, so a static import would throw before this
  // file's `main().catch` exists — leaving the failure to Node's uncaught
  // module-evaluation path, with no structured diagnostic.
  const { setLogLevel } = await import('../core/logger.js');
  const { env } = await import('../config/env.js');
  const { runDerivationCli } = await import('./derivation.cli.js');

  setLogLevel(env.LOG_LEVEL);
  process.exitCode = await runDerivationCli({ articleId });
}

main().catch((error: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'Derivation CLI crashed before it could report an outcome',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
