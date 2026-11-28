import { LlmError } from '../../core/llm/llm.errors.js';
import type { LlmProvider } from '../../core/llm/llm.provider.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { DEFAULT_LLM_CALL_INTERVAL_MS } from '../../config/constants.js';
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
  /**
   * Called once when the provider reports a rate limit (HTTP 429).
   *
   * The extraction loop reads the flag this sets before its next claim, so one
   * exhausted quota ends the run instead of being paid for once per article. The
   * failing call still throws, because its derived record was never stored.
   */
  readonly onRateLimit?: (() => void) | undefined;
  /** Pause between two real calls. Defaults to 4000 ms; tests pass 0. */
  readonly cooldownMs?: number | undefined;
  /** Injected by tests so the pause is observable without real waiting. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
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
  const provider = deps.provider ?? (await buildDerivationProviderFromEnv(deps.log));
  if (provider === undefined) {
    return {};
  }

  const derivation = new ArticleDerivationService({
    provider,
    repository: new SqliteArticleDerivedRepository(deps.database),
    now: deps.now,
  });

  const cooldownMs = deps.cooldownMs ?? DEFAULT_LLM_CALL_INTERVAL_MS;
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  // Epoch ms at which the previous call returned. Pacing is measured call-to-call
  // rather than fixed at the start, so a slow response shortens the next wait
  // instead of adding to it.
  let previousCallFinishedAt: number | undefined;

  return {
    deriveArticle: async (articleId: string, text: string): Promise<void> => {
      try {
        if (previousCallFinishedAt !== undefined) {
          const remaining = cooldownMs - (deps.now() - previousCallFinishedAt);
          if (remaining > 0) {
            await sleep(remaining);
          }
        }

        const draft = await derivation.derive(articleId, text);
        deps.log.info('Article derivation stored', {
          articleId,
          summaryChars: [...draft.summaryZh].length,
        });
      } catch (error) {
        if (error instanceof LlmError && error.kind === 'rate_limit') {
          // Warned here as well as handled by the loop, so the operator sees the
          // cause even when the run only processed this one article.
          deps.log.warn(
            'LLM rate limit reached; no further derivation calls will be made in this run',
            { articleId, statusCode: error.statusCode },
          );
          deps.onRateLimit?.();
        }
        // Reported here and re-thrown: the job is not complete until the derived
        // record is stored, so the extraction service records this against the
        // attempt and the existing retry budget decides what follows.
        deps.log.warn('Article derivation failed', {
          articleId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        previousCallFinishedAt = deps.now();
      }
    },
  };
}

/**
 * Builds the provider from `LLM_PROVIDER` / `LLM_MODEL` / `GEMINI_API_KEY`.
 *
 * A missing or rejected credential disables derivation with a warning rather
 * than aborting the run: extraction does not depend on the model.
 *
 * Exported so the regeneration CLI builds a provider through the same wiring
 * rather than a second copy of it. `undefined` means "no usable model": the
 * extraction hook runs without one, while that CLI reports an error because it
 * has nothing else to do.
 */
export async function buildDerivationProviderFromEnv(
  log: DerivationHookLogger,
): Promise<LlmProvider | undefined> {
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
