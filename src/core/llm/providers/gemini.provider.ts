import {
  LlmConfigurationError,
  LlmEmptyResponseError,
  LlmError,
  LlmTimeoutError,
  type LlmErrorKind,
} from '../llm.errors.js';
import type { LlmProvider } from '../llm.provider.js';
import type { LlmModelRef, LlmRequest, LlmResponse, LlmUsage } from '../llm.types.js';
import type { LlmProviderConfig } from '../provider.factory.js';
import type { GeminiTransport } from './gemini.transport.js';

/**
 * The Gemini adapter for the Interactions API.
 *
 * Vendor-free above this file: it implements `LlmProvider` and speaks only
 * `LlmRequest` / `LlmResponse` / `LlmError` to its callers. It opens no socket —
 * every request goes through the injected `GeminiTransport` (Section 9.5).
 *
 * The API key is deliberately outside this module's reach: the config type below
 * omits it, so the compiler prevents the adapter from ever holding a credential
 * (Section 11.1.4). The key lives only inside the transport's send boundary.
 */

/** Adapter configuration: provider-wide settings, with the credential excluded. */
export type GeminiProviderConfig = Omit<LlmProviderConfig, 'apiKey'>;

/** The one dependency this adapter has, and it is required (Section 9.5.4). */
export interface GeminiProviderDeps {
  readonly transport: GeminiTransport;
}

const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
const GEMINI_INTERACTIONS_PATH = '/v1/interactions';
const GEMINI_INTERACTIONS_URL = `${GEMINI_ORIGIN}${GEMINI_INTERACTIONS_PATH}`;

/**
 * Ratified logical-name → vendor-id table (O-1, Section 11.1.1).
 *
 * Private on purpose: not exported, not configurable, not in the factory. Aliases
 * are application vocabulary and never reach the vendor; only the mapped id does.
 */
const MODEL_IDS: Readonly<Record<string, string>> = {
  default: 'gemini-3.8-flash',
  fast: 'gemini-3.5-flash-lite',
  'high-quality': 'gemini-4-argon',
};

/**
 * Vendor `error.code` → `LlmError` kind (Section 11.6.6).
 *
 * A documented lookup rather than status-code guessing. Codes outside this table
 * fall back to the HTTP status, which is the vendor's own documented fallback.
 */
const KIND_BY_VENDOR_CODE: Readonly<Record<string, LlmErrorKind>> = {
  authentication: 'authentication',
  permission_denied: 'authentication',
  invalid_request: 'invalid_request',
  failed_precondition: 'invalid_request',
  parameter_unknown: 'invalid_request',
  out_of_range: 'invalid_request',
  not_found: 'invalid_request',
  model_not_found: 'invalid_request',
  already_exists: 'invalid_request',
  aborted: 'timeout',
  rate_limit_exceeded: 'rate_limit',
  quota_exceeded: 'rate_limit',
  too_many_requests: 'rate_limit',
  cancelled: 'timeout',
  api_error: 'unavailable',
  unimplemented: 'invalid_request',
  service_unavailable: 'unavailable',
  deadline_exceeded: 'timeout',
  safety: 'invalid_response',
  recitation: 'invalid_response',
  language: 'invalid_response',
  prohibited_content: 'invalid_response',
  spii: 'invalid_response',
  blocklist: 'invalid_response',
  malformed_function_call: 'invalid_response',
  unexpected_tool_call: 'invalid_response',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count, or `null` when the vendor did not report it. Never estimated. */
function tokenOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function kindFromStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  return 'invalid_request';
}

/** Reads the documented `error.code` from a failure body, if present. */
function extractErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !isRecord(parsed['error'])) return undefined;
    const code = parsed['error']['code'];
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps a non-2xx response to an `LlmError`.
 *
 * Only the documented `code` and the status are surfaced. The vendor `message` and
 * the raw body are never forwarded, because Google's messages can quote request
 * content (Section 11.6.6).
 */
function classifyHttpFailure(status: number, body: string): LlmError {
  const code = extractErrorCode(body);
  const kind =
    (code === undefined ? undefined : KIND_BY_VENDOR_CODE[code]) ?? kindFromStatus(status);
  const detail = code === undefined ? '' : ` (${code})`;
  return new LlmError(kind, `Gemini request failed with HTTP ${status}${detail}`, {
    providerId: 'gemini',
    statusCode: status,
  });
}

/**
 * Builds the Interactions request body (Section 11.6.4.1).
 *
 * `temperature` is dropped by policy, never transmitted (Section 11.1.2).
 * `system_instruction` is omitted rather than sent as `undefined`.
 */
function buildRequestBody(vendorModelId: string, request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: vendorModelId,
    input: request.prompt,
    generation_config: { max_output_tokens: request.maxOutputTokens },
    store: false,
  };
  if (request.systemInstruction !== undefined) {
    body['system_instruction'] = request.systemInstruction;
  }
  return body;
}

/** Composes the per-call deadline with the caller's signal (Section 9.5, 11.6.7). */
function buildSignal(request: LlmRequest, config: GeminiProviderConfig): AbortSignal {
  const timeoutMs = request.timeoutMs ?? config.timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return request.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([request.signal, timeoutSignal]);
}

/** Joins text across `model_output` steps only; every other step type is ignored. */
function extractText(steps: readonly unknown[]): string {
  let text = '';
  for (const step of steps) {
    if (!isRecord(step) || step['type'] !== 'model_output') continue;
    const content = step['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && typeof part['text'] === 'string') text += part['text'];
    }
  }
  return text;
}

/**
 * Three-valued truncation from the documented `status` (Section 11.6.4.3).
 *
 * Absent or unrecognised yields `null`, never `false`: an unknown must not be read
 * as a complete translation.
 */
function truncatedFromStatus(status: unknown): boolean | null {
  if (status === 'completed') return false;
  if (status === 'incomplete') return true;
  return null;
}

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini';
  readonly model: LlmModelRef;

  private readonly config: GeminiProviderConfig;
  private readonly transport: GeminiTransport;

  constructor(config: GeminiProviderConfig, deps: GeminiProviderDeps) {
    // An unknown alias fails here, before any socket could open (Section 11.1.1).
    const vendorModelId = MODEL_IDS[config.model];
    if (vendorModelId === undefined) {
      throw new LlmConfigurationError(
        `Unknown logical model '${config.model}'; expected one of: ${Object.keys(MODEL_IDS).join(', ')}`,
        { providerId: 'gemini' },
      );
    }

    this.config = config;
    this.transport = deps.transport;
    this.model = { name: config.model, vendorModelId };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();

    const { status, body } = await this.transport.send(GEMINI_INTERACTIONS_URL, {
      body: JSON.stringify(buildRequestBody(this.model.vendorModelId, request)),
      headers: { 'content-type': 'application/json' },
      signal: buildSignal(request, this.config),
    });

    if (status < 200 || status >= 300) {
      throw classifyHttpFailure(status, body);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new LlmError('invalid_response', 'Gemini response was not valid JSON', {
        providerId: 'gemini',
        statusCode: status,
      });
    }

    if (!isRecord(parsed)) {
      throw new LlmError('invalid_response', 'Gemini response was not an object', {
        providerId: 'gemini',
        statusCode: status,
      });
    }

    const interactionStatus = parsed['status'];

    // A failed generation is an error, never a response with fabricated text
    // (Section 11.1.3). The documented code is named; the vendor message is not.
    if (interactionStatus === 'failed') {
      const code = isRecord(parsed['error']) ? parsed['error']['code'] : undefined;
      const detail = typeof code === 'string' ? ` (${code})` : '';
      throw new LlmError('invalid_response', `Gemini interaction failed${detail}`, {
        providerId: 'gemini',
        statusCode: status,
      });
    }

    // Phase 4 declares no tools and never requests long decode, so either state
    // means the service did not get what it asked for (Section 11.6.4.3).
    if (interactionStatus === 'requires_action' || interactionStatus === 'requires_continuation') {
      throw new LlmError(
        'invalid_response',
        `Gemini interaction requires follow-up (${String(interactionStatus)})`,
        { providerId: 'gemini', statusCode: status },
      );
    }

    if (interactionStatus === 'cancelled') {
      throw new LlmTimeoutError('Gemini interaction was cancelled', {
        providerId: 'gemini',
        statusCode: status,
      });
    }

    const steps = parsed['steps'];
    if (!Array.isArray(steps)) {
      throw new LlmError('invalid_response', 'Gemini response was missing steps', {
        providerId: 'gemini',
        statusCode: status,
      });
    }

    const text = extractText(steps);
    if (text.trim() === '') {
      throw new LlmEmptyResponseError('Gemini returned no model output text', {
        providerId: 'gemini',
        statusCode: status,
      });
    }

    const rawUsage = parsed['usage'];
    const usage: LlmUsage = isRecord(rawUsage)
      ? {
          inputTokens: tokenOrNull(rawUsage['total_input_tokens']),
          outputTokens: tokenOrNull(rawUsage['total_output_tokens']),
          totalTokens: tokenOrNull(rawUsage['total_tokens']),
        }
      : { inputTokens: null, outputTokens: null, totalTokens: null };

    return {
      text,
      model: this.model.name,
      usage,
      truncated: truncatedFromStatus(interactionStatus),
      durationMs: Date.now() - startedAt,
    };
  }
}
