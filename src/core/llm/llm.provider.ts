import type { LlmModelRef, LlmRequest, LlmResponse } from './llm.types.js';

/**
 * The provider contract every adapter implements.
 *
 * Vendor-free by design: this file names no SDK and no transport, so business
 * modules can depend on it without ever seeing a vendor type.
 */
export interface LlmProvider {
  /** Stable identifier for logs and diagnostics: 'gemini', 'fake'. */
  readonly id: string;

  /** The logical model this instance is bound to. */
  readonly model: LlmModelRef;

  /**
   * Generates one completion.
   *
   * Rejects with an `LlmError` subclass for every failure mode. Never resolves
   * with empty text: an empty or whitespace-only completion is an
   * `LlmEmptyResponseError`.
   */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
