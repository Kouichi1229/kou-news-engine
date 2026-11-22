/**
 * Shared request, response and model-identity types for the LLM layer.
 *
 * These are vendor-free on purpose: nothing here names Gemini, an SDK or a
 * transport. Business modules depend on this file and never on `providers/*`.
 */

/** Which model to call. A logical name, not a vendor model string. */
export interface LlmModelRef {
  /** Logical model name, e.g. 'default', 'fast', 'high-quality'. */
  readonly name: string;
  /** Vendor model id resolved by the adapter, e.g. 'gemini-2.0-flash'. */
  readonly vendorModelId: string;
}

export interface LlmRequest {
  /** The full prompt. The provider adds no framing of its own. */
  readonly prompt: string;
  /** Optional system instruction, sent as such when the vendor supports it. */
  readonly systemInstruction?: string | undefined;
  /**
   * Upper bound on generated tokens for this call. Required: the caller always
   * states its budget. It is a per-request parameter, not a provider-wide
   * setting, because different callers legitimately want different caps
   * (a one-line summary vs. a full article translation). The adapter maps it to
   * the vendor's field.
   */
  readonly maxOutputTokens: number;
  /** 0..1 where supported; adapters that cannot honour it ignore it. */
  readonly temperature?: number | undefined;
  /**
   * Cancels an in-flight call.
   *
   * Deliberately `AbortSignal` rather than the project's cooperative
   * `isCancelled()` convention: an LLM call leaves no partial state behind, so a
   * hard abort is safe, and `fetch` accepts this signal directly. The existing
   * cancellation mechanism is not rewritten.
   */
  readonly signal?: AbortSignal | undefined;
  /** Per-call timeout. Falls back to the provider's configured default. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Token counts, or all-null when the vendor did not report them.
 *
 * Null rather than 0 so "not reported" is never mistaken for "used nothing".
 * No count is ever estimated to fill a gap.
 */
export interface LlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface LlmResponse {
  /** The generated text. Guaranteed non-empty; empty output is an error. */
  readonly text: string;
  /**
   * The logical model name that served the request — the name the caller asked
   * for, not a vendor model id. Vendor ids never cross this boundary.
   */
  readonly model: string;
  /** Token counts, or all-null when the vendor did not report them. */
  readonly usage: LlmUsage;
  /**
   * Whether the output was cut off by the token limit.
   *
   * - `true`  — the provider explicitly reported a length stop.
   * - `false` — the provider explicitly reported a normal stop.
   * - `null`  — the provider gave no reliable truncation signal.
   *
   * `null` is not a synonym for `false`: an adapter that cannot tell must say so
   * rather than guess, because a caller treating an unknown as "complete" would
   * silently ship a cut-off translation. Equally, `null` must not collapse to
   * `true` — a false truncation warning is noise the caller cannot act on.
   */
  readonly truncated: boolean | null;
  /** Wall-clock duration measured by the adapter, for observability. */
  readonly durationMs: number;
}
