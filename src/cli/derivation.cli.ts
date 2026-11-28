import { LlmError } from '../core/llm/llm.errors.js';
import { logger as defaultLogger } from '../core/logger.js';
import { openDatabase, type SqliteDatabase } from '../core/persistence/sqlite.js';
import {
  buildDerivationProviderFromEnv,
  type DerivationProvider,
} from '../modules/derivation/derivation.bootstrap.js';
import {
  ArticleDerivationService,
  DerivationError,
} from '../modules/derivation/derivation.service.js';
import { SqliteArticleDerivedRepository } from '../modules/derivation/repository/sqlite-article-derived.repository.js';

import { EXIT_FAILURE, EXIT_SUCCESS } from './exit-codes.js';

/**
 * The stored body, read from the table rather than fetched again.
 *
 * `status = 'extracted'` is the only state that guarantees the text is the
 * complete article that was parsed and stored; any other status may hold no body
 * at all. Reading it here is the whole point of this CLI: regeneration costs one
 * model call and no network request to the publisher.
 */
const STORED_BODY_SQL = `SELECT content_text
   FROM article_contents
  WHERE article_id = ?
    AND status = 'extracted'
    AND content_text IS NOT NULL`;

export interface DerivationCliDependencies {
  readonly articleId: string;
  /** Defaults to the production `openDatabase()` reading `env.DATABASE_PATH`. */
  openDatabase?: () => SqliteDatabase;
  /** Injected by tests; otherwise built from the environment. */
  provider?: DerivationProvider;
  /** Epoch milliseconds; defaults to the system clock. */
  now?: () => number;
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

/** Why the run could not produce a record, in a form a supervisor can branch on. */
function failureReason(error: unknown): string {
  if (error instanceof DerivationError) {
    return error.reason;
  }
  if (error instanceof LlmError) {
    return error.kind;
  }
  return 'unexpected-error';
}

/**
 * Regenerates one article's stored derivation, one call, one outcome.
 *
 * Uses `ArticleDerivationService.regenerate`, so the existing-record short circuit
 * is deliberately skipped while every other guarantee of the ordinary path holds:
 * one model call, the same output contract, an upsert that keeps `created_at`, and
 * no write at all unless the answer was accepted. A failed call therefore leaves
 * the previous title, summary and `updated_at` exactly as they were.
 *
 * Nothing here touches `notification_delivery` and nothing here can reach
 * Telegram: the ledger is written by the notify CLI only, so regenerating an
 * article that was already announced does not announce it again.
 *
 * Two facts are distinguished before any model call, because they have different
 * fixes: an article row that does not exist (`article-missing`) and an article
 * whose body was never stored (`body-missing`).
 */
export async function runDerivationCli(dependencies: DerivationCliDependencies): Promise<number> {
  const log = dependencies.logger ?? defaultLogger;
  const writeStdout =
    dependencies.writeStdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const writeStderr =
    dependencies.writeStderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const open = dependencies.openDatabase ?? ((): SqliteDatabase => openDatabase());
  const { articleId } = dependencies;

  const fail = (reason: string, message: string): number => {
    writeStderr(JSON.stringify({ status: 'failed', reason, articleId, error: message }));
    log.error('Article derivation regeneration failed', { articleId, reason, error: message });
    return EXIT_FAILURE;
  };

  let database: SqliteDatabase | undefined;
  try {
    database = open();

    const articleRow = database.query((connection) =>
      connection.get('SELECT id FROM articles WHERE id = ?', [articleId]),
    ) as { id: string } | undefined;
    if (articleRow === undefined) {
      return fail('article-missing', `No article row for ${articleId}`);
    }

    const bodyRow = database.query((connection) => connection.get(STORED_BODY_SQL, [articleId])) as
      { content_text: string } | undefined;
    if (bodyRow === undefined) {
      return fail('body-missing', `No extracted body stored for ${articleId}`);
    }

    const provider = dependencies.provider ?? (await buildDerivationProviderFromEnv(log));
    if (provider === undefined) {
      return fail(
        'provider-unavailable',
        'No usable LLM provider: check LLM_PROVIDER, LLM_MODEL and GEMINI_API_KEY',
      );
    }

    const draft = await new ArticleDerivationService({
      provider,
      repository: new SqliteArticleDerivedRepository(database),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    }).regenerate(articleId, bodyRow.content_text);

    writeStdout(
      JSON.stringify({
        articleId: draft.articleId,
        titleZh: draft.titleZh,
        summaryZh: draft.summaryZh,
        category: draft.category,
      }),
    );
    log.info('Article derivation regenerated', {
      articleId: draft.articleId,
      summaryChars: [...draft.summaryZh].length,
    });
    return EXIT_SUCCESS;
  } catch (error) {
    return fail(failureReason(error), error instanceof Error ? error.message : String(error));
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (closeError) {
        // The outcome above is already decided; teardown must not replace it.
        log.error('Derivation database could not be closed', {
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      }
    }
  }
}
