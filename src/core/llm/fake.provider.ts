import {
  LlmEmptyResponseError,
  LlmError,
  LlmTimeoutError,
  type LlmErrorKind,
} from './llm.errors.js';
import type { LlmProvider } from './llm.provider.js';
import type { LlmModelRef, LlmRequest, LlmResponse, LlmUsage } from './llm.types.js';

/**
 * One scripted result. Consumed in order; the last one repeats.
 *
 * There is deliberately no separate `text` option at the options level: a plain
 * fixed answer is expressed through the `success` variant, so exactly one
 * construct says "return this string" and no two options can disagree about
 * which one wins.
 */
export type FakeOutcome =
  | {
      readonly kind: 'success';
      readonly text: string;
      readonly usage?: LlmUsage | undefined;
      /** Defaults to `false`. Use `null` to exercise the "unknown" branch. */
      readonly truncated?: boolean | null | undefined;
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: LlmErrorKind }
  | { readonly kind: 'timeout' };

export interface FakeProviderOptions {
  /** Scripted results, consumed in order; the last one repeats. Must be non-empty. */
  readonly responses: readonly FakeOutcome[];
  /** Delay before resolving, to exercise timeout paths with a fake clock. */
  readonly delayMs?: number | undefined;
  /** The model identity to report. Defaults to a fake model ref. */
  readonly model?: LlmModelRef | undefined;
}

const DEFAULT_MODEL: LlmModelRef = { name: 'fake', vendorModelId: 'fake-model' };

/** Usage reported when an outcome does not carry any: "not reported", never zero. */
const UNREPORTED_USAGE: LlmUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};

/**
 * An in-process provider for testing callers without a network.
 *
 * It implements the same `LlmProvider` interface as a real adapter, so a caller
 * tested against it keeps working when the vendor is swapped. It never imports a
 * networking module, never imports a vendor SDK, and never reads a credential or
 * any environment configuration.
 */
export class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  readonly model: LlmModelRef;

  private readonly options: FakeProviderOptions;
  private readonly requests: LlmRequest[] = [];
  private callIndex = 0;

  constructor(options: FakeProviderOptions) {
    if (options.responses.length === 0) {
      throw new Error('FakeProvider requires at least one scripted response');
    }
    this.options = options;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  /** Every request this provider received, in call order. */
  get receivedRequests(): readonly LlmRequest[] {
    return this.requests;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Recorded on invocation, before any abort check: the caller did issue this
    // request, and a diagnostics log that hid aborted attempts would misreport
    // what the provider was asked to do.
    this.requests.push(request);

    const startedAt = Date.now();

    // Caller-initiated cancellation is not a provider failure. Reject with the
    // platform's own reason so its identity survives and a caller using the
    // project's `name === 'AbortError'` idiom recognises it. Checked before the
    // script is advanced so an aborted call does not consume an outcome.
    if (request.signal?.aborted === true) {
      throw request.signal.reason;
    }

    if (this.options.delayMs !== undefined) {
      await this.delay(this.options.delayMs, request.signal);
    }

    // Advanced only once the call is certain to produce a result, so a cancelled
    // call consumes no outcome on either abort path.
    const outcome = this.nextOutcome();

    switch (outcome.kind) {
      case 'success': {
        if (outcome.text.trim() === '') {
          throw new LlmEmptyResponseError('FakeProvider was scripted with empty text', {
            providerId: this.id,
          });
        }
        return {
          text: outcome.text,
          model: this.model.name,
          usage: outcome.usage ?? UNREPORTED_USAGE,
          // `??` would collapse an explicit `null` to `false`; only an absent
          // field defaults. `null` must survive as "provider cannot tell".
          truncated: outcome.truncated === undefined ? false : outcome.truncated,
          durationMs: Date.now() - startedAt,
        };
      }
      case 'empty':
        throw new LlmEmptyResponseError('FakeProvider was scripted with an empty response', {
          providerId: this.id,
        });
      case 'error':
        throw new LlmError(outcome.error, `FakeProvider scripted error: ${outcome.error}`, {
          providerId: this.id,
        });
      case 'timeout':
        throw new LlmTimeoutError('FakeProvider was scripted to time out', {
          providerId: this.id,
        });
    }
  }

  private nextOutcome(): FakeOutcome {
    const responses = this.options.responses;
    const index = Math.min(this.callIndex, responses.length - 1);
    this.callIndex += 1;
    // Bounded by construction: the constructor rejects an empty script.
    return responses[index] as FakeOutcome;
  }

  private delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      // Rejects with the platform's own reason, not a wrapped LlmError: this is
      // the caller withdrawing, not the provider failing.
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
