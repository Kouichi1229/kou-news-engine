/**
 * Child-process worker for the cross-process contention test.
 *
 * Run as a separate OS process so the test exercises real SQLite file locking
 * rather than two callers sharing one connection. It claims as many articles as
 * it can and prints the IDs it won as JSON on stdout.
 *
 * Invoked by `tests/integration/extraction/cross-process-contention.test.ts`
 * through `tsx`, so it runs the same TypeScript sources as the application.
 */
import { openDatabase } from '../../src/core/persistence/sqlite.js';
import { EXTRACTOR_VERSION } from '../../src/modules/extraction/extraction.constants.js';
import { SqliteArticleContentRepository } from '../../src/modules/extraction/repository/sqlite-article-content.repository.js';

async function main(): Promise<void> {
  const databasePath = process.argv[2];
  const workerId = process.argv[3];

  if (databasePath === undefined || workerId === undefined) {
    throw new Error('usage: contention-worker <database-path> <worker-id>');
  }

  const database = openDatabase({ path: databasePath });
  const repository = new SqliteArticleContentRepository(database);

  const won: string[] = [];

  for (;;) {
    const claim = await repository.claim({
      owner: workerId,
      token: `${workerId}-${String(won.length)}`,
      now: Date.now(),
      leaseDurationMs: 180_000,
      extractorVersion: EXTRACTOR_VERSION,
    });

    if (claim === null) {
      break;
    }
    won.push(claim.articleId);
  }

  database.close();
  process.stdout.write(JSON.stringify({ workerId, won }));
}

main().catch((error: unknown): void => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
