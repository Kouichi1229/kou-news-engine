import type { LlmProvider } from '../../core/llm/llm.provider.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import type { SqliteDatabase } from '../../core/persistence/sqlite.js';

import { ArticleDerivationService } from './derivation.service.js';
import { SqliteArticleDerivedRepository } from './repository/sqlite-article-derived.repository.js';

/**
 * Provider name as this module exposes it.
 *
 * The extraction CLI may not name a provider module (a static guarantee, tested
 * in `tests/integration/cli/dry-run.test.ts`), so it receives this alias instead
 * and stays free of the LLM layer's specifiers.
 */
export type DerivationProvider = LlmProvider;

export interface DerivationHookLogger {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
}

export interface DerivationHookDeps {
  readonly database: SqliteDatabase;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly log: DerivationHookLogger;
  /** Injected by tests; otherwise built from the environment. */
  readonly provider?: DerivationProvider | undefined;
}

/**
 * Builds the post-extraction hook, or nothing when there is no usable provider.
 *
 * The hook's contract is "store the record or throw". Extraction treats a throw
 * as a failed attempt, so a model failure is retried by the existing attempt
 * budget rather than leaving a completed row without a Chinese title.
 *
 * The provider is built from the same factory and the same Gemini adapter the
 * HTTP runtime uses; only the construction site differs, because this process
 * has none. `fake` yields no hook: the unscripted fake can only reply with a
 * placeholder string, which would log one parse failure per article.
 */
export async function createDerivationHook(
  deps: DerivationHookDeps,
): Promise<{ deriveArticle?: (articleId: string, text: string) => Promise<void> }> {
  const provider = deps.provider ?? (await buildProviderFromEnv(deps.log));
  if (provider === undefined) {
    return {};
  }

  const derivation = new ArticleDerivationService({
    provider,
    repository: new SqliteArticleDerivedRepository(deps.database),
    now: deps.now,
  });

  return {
    deriveArticle: async (articleId: string, text: string): Promise<void> => {
      try {
        const draft = await derivation.derive(articleId, text);
        deps.log.info('Article derivation stored', {
          articleId,
          summaryChars: [...draft.summaryZh].length,
        });
      } catch (error) {
        // Reported here and re-thrown: the job is not complete until the derived
        // record is stored, so the extraction service records this against the
        // attempt and the existing retry budget decides what follows.
        deps.log.warn('Article derivation failed', {
          articleId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

/**
 * Builds the provider from `LLM_PROVIDER` / `LLM_MODEL` / `GEMINI_API_KEY`.
 *
 * A missing or rejected credential disables derivation with a warning rather
 * than aborting the run: extraction does not depend on the model.
 */
async function buildProviderFromEnv(log: DerivationHookLogger): Promise<LlmProvider | undefined> {
  const { env } = await import('../../config/env.js');

  if (env.LLM_PROVIDER === 'fake') {
    log.info('Article derivation skipped: LLM_PROVIDER=fake returns no real model output');
    return undefined;
  }

  try {
    return await createProvider(
      {
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL,
        timeoutMs: env.LLM_TIMEOUT_MS,
        apiKey: env.GEMINI_API_KEY,
      },
      {
        createTransport: async () => {
          const { createGeminiTransport } =
            await import('../../core/llm/providers/gemini.transport.js');
          return createGeminiTransport({
            apiKey: env.GEMINI_API_KEY ?? '',
            timeoutMs: env.LLM_TIMEOUT_MS,
          });
        },
      },
    );
  } catch (error) {
    log.warn('Article derivation disabled: the LLM provider could not be built', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
