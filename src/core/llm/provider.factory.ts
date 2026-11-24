import { FakeProvider } from './fake.provider.js';
import { LlmConfigurationError } from './llm.errors.js';
import type { LlmProvider } from './llm.provider.js';
import type { GeminiTransport } from './providers/gemini.transport.js';

/**
 * Provider-wide settings only.
 *
 * `maxOutputTokens` is deliberately absent: it is a per-request budget on
 * `LlmRequest`, so a factory that accepted and then dropped it would lose the
 * setting silently.
 */
export interface LlmProviderConfig {
  readonly provider: 'gemini' | 'fake';
  /** Logical model name; the adapter maps it to a vendor id. */
  readonly model: string;
  /** Undefined for 'fake'. Validated only on the 'gemini' branch. */
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
}

/** Seams the caller supplies rather than reads from configuration. */
export interface LlmProviderDeps {
  /**
   * Resolves the transport for the selected adapter. Never called for 'fake'.
   * Async so the production implementation can load its module lazily.
   */
  readonly createTransport?: () => Promise<GeminiTransport>;
}

/** Text the factory-built fake returns, marked so it cannot pass for real output. */
const FACTORY_FAKE_TEXT = '[fake provider] No scripted response is configured.';

/**
 * Selects and constructs a provider. Performs no network I/O.
 *
 * The order is the point: the provider name is validated, then the credential
 * for the selected provider, then the transport seam. Validating the credential
 * before the seam is what makes a missing key unable to resolve a transport.
 */
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<LlmProvider> {
  if (config.provider === 'fake') {
    // Credential stage skipped entirely: a fake deployment needs no secret.
    return new FakeProvider({
      responses: [{ kind: 'success', text: FACTORY_FAKE_TEXT }],
      model: { name: config.model, vendorModelId: 'fake-model' },
    });
  }

  if (config.provider === 'gemini') {
    if (config.apiKey === undefined || config.apiKey.trim() === '') {
      throw new LlmConfigurationError('GEMINI_API_KEY is required when LLM_PROVIDER=gemini', {
        providerId: 'gemini',
      });
    }

    if (deps.createTransport === undefined) {
      throw new LlmConfigurationError(
        'A createTransport callback is required when LLM_PROVIDER=gemini',
        { providerId: 'gemini' },
      );
    }

    // Stage 5: load the adapter lazily, so a process that never selects Gemini
    // never pays for the module.
    const { GeminiProvider } = await import('./providers/gemini.provider.js');

    // Stage 6a: build a fresh config rather than forwarding `config`. The adapter
    // type omits `apiKey`, but structural typing lets a full `LlmProviderConfig`
    // satisfy it, so narrowing by annotation alone would still hand over the live
    // key at runtime (Section 11.1.4, Section 9.5.4).
    const adapterConfig = {
      provider: config.provider,
      model: config.model,
      timeoutMs: config.timeoutMs,
    };

    // Stage 6b: resolve the transport exactly once, and only after stage 4.
    const transport = await deps.createTransport();

    return new GeminiProvider(adapterConfig, { transport });
  }

  // Unreachable through `Env`, but `LlmProviderConfig` can be built by hand, so
  // the boundary defends itself. A typo must not silently select a default.
  throw new LlmConfigurationError(`Unknown provider: ${String(config.provider)}`);
}
