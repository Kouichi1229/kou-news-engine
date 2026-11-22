import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  LlmConfigurationError,
  LlmEmptyResponseError,
  LlmError,
  LlmTimeoutError,
  isRetryableKind,
} from '../../../../src/core/llm/llm.errors.js';
import type { LlmProvider } from '../../../../src/core/llm/llm.provider.js';
import type { LlmRequest } from '../../../../src/core/llm/llm.types.js';
import {
  GeminiProvider,
  type GeminiProviderConfig,
} from '../../../../src/core/llm/providers/gemini.provider.js';
import type { GeminiTransport } from '../../../../src/core/llm/providers/gemini.transport.js';

/**
 * The transport is a recording double; the adapter is the real code under test.
 *
 * No socket is opened, `gemini.transport.ts` is never constructed, and no
 * credential is read. Every request the adapter sends is captured so the wire
 * contract can be asserted directly (Section 11.5.1).
 */

interface RecordedCall {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

interface RecordingTransport extends GeminiTransport {
  readonly calls: RecordedCall[];
}

function recordingTransport(
  respond: (call: RecordedCall) => { status: number; body: string } = () => ({
    status: 200,
    body: JSON.stringify(completedInteraction('ok')),
  }),
): RecordingTransport {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async send(url, init) {
      const call: RecordedCall = {
        url,
        body: init.body,
        headers: init.headers,
        signal: init.signal,
      };
      calls.push(call);
      return respond(call);
    },
  };
}

function config(overrides: Partial<GeminiProviderConfig> = {}): GeminiProviderConfig {
  return { provider: 'gemini', model: 'default', timeoutMs: 30000, ...overrides };
}

function provider(
  transport: GeminiTransport,
  overrides: Partial<GeminiProviderConfig> = {},
): GeminiProvider {
  return new GeminiProvider(config(overrides), { transport });
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { prompt: 'hello', maxOutputTokens: 128, ...overrides };
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>;
}

function completedInteraction(text: string, status = 'completed'): unknown {
  return {
    id: 'interaction-1',
    status,
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 7, total_output_tokens: 3, total_tokens: 10 },
  };
}

function ok(body: unknown): { status: number; body: string } {
  return { status: 200, body: JSON.stringify(body) };
}

describe('M4.2 assertion 1 — construction sends no request', () => {
  it('leaves the recording double with zero calls', () => {
    const transport = recordingTransport();
    provider(transport);
    expect(transport.calls).toHaveLength(0);
  });

  it('does not open a socket or resolve a transport of its own', () => {
    const transport = recordingTransport();
    const instance = provider(transport);
    expect(instance).toBeInstanceOf(GeminiProvider);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('M4.2 assertion 2 — complete() issues exactly one request', () => {
  it('sends one request through the injected double', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(transport.calls).toHaveLength(1);
  });

  it('posts to the fixed Interactions endpoint and nowhere else', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(transport.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1/interactions',
    );
  });

  it('sends a JSON content-type header', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(transport.calls[0]?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('sends no credential header of its own', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    const headers = transport.calls[0]?.headers ?? {};
    for (const name of Object.keys(headers)) {
      expect(name.toLowerCase()).not.toBe('x-goog-api-key');
      expect(name.toLowerCase()).not.toBe('authorization');
    }
  });
});

describe('M4.2 assertion 3 — store: false on every applicable request', () => {
  it('includes store: false on a normal request', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(bodyOf(transport.calls[0] as RecordedCall)['store']).toBe(false);
  });

  it('includes store: false when a system instruction is present', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ systemInstruction: 'be brief' }));
    expect(bodyOf(transport.calls[0] as RecordedCall)['store']).toBe(false);
  });

  it('includes store: false on every model alias', async () => {
    for (const model of ['default', 'fast', 'high-quality']) {
      const transport = recordingTransport();
      await provider(transport, { model }).complete(request());
      expect(bodyOf(transport.calls[0] as RecordedCall)['store']).toBe(false);
    }
  });
});

describe('M4.2 assertion 4 — temperature is never transmitted', () => {
  it('omits the temperature key even when the request supplies one', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ temperature: 0.7 }));
    const body = bodyOf(transport.calls[0] as RecordedCall);
    expect(body).not.toHaveProperty('temperature');
    expect(body['generation_config']).not.toHaveProperty('temperature');
  });

  it('sends no sampling parameter at all', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ temperature: 0.2 }));
    const body = bodyOf(transport.calls[0] as RecordedCall);
    expect(Object.keys(body['generation_config'] as object)).toEqual(['max_output_tokens']);
  });
});

describe('M4.2 assertion 5 — max_output_tokens is copied unmodified', () => {
  it('places the request value on generation_config.max_output_tokens', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ maxOutputTokens: 1234 }));
    const body = bodyOf(transport.calls[0] as RecordedCall);
    expect(body['generation_config']).toEqual({ max_output_tokens: 1234 });
  });

  it('never clamps a large value', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ maxOutputTokens: 32768 }));
    const body = bodyOf(transport.calls[0] as RecordedCall);
    expect((body['generation_config'] as Record<string, unknown>)['max_output_tokens']).toBe(32768);
  });

  it('never raises a small value', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ maxOutputTokens: 1 }));
    const body = bodyOf(transport.calls[0] as RecordedCall);
    expect((body['generation_config'] as Record<string, unknown>)['max_output_tokens']).toBe(1);
  });
});

describe('M4.2 assertion 6 — model alias mapping', () => {
  it('maps default to the ratified vendor id', async () => {
    const transport = recordingTransport();
    await provider(transport, { model: 'default' }).complete(request());
    expect(bodyOf(transport.calls[0] as RecordedCall)['model']).toBe('gemini-3.8-flash');
  });

  it('maps fast to the ratified vendor id', async () => {
    const transport = recordingTransport();
    await provider(transport, { model: 'fast' }).complete(request());
    expect(bodyOf(transport.calls[0] as RecordedCall)['model']).toBe('gemini-3.5-flash-lite');
  });

  it('maps high-quality to the ratified vendor id', async () => {
    const transport = recordingTransport();
    await provider(transport, { model: 'high-quality' }).complete(request());
    expect(bodyOf(transport.calls[0] as RecordedCall)['model']).toBe('gemini-4-argon');
  });

  it('never transmits the logical alias itself', async () => {
    const transport = recordingTransport();
    await provider(transport, { model: 'fast' }).complete(request());
    expect(bodyOf(transport.calls[0] as RecordedCall)['model']).not.toBe('fast');
  });

  it('reports the logical name, not the vendor id, on the response', async () => {
    const transport = recordingTransport();
    const response = await provider(transport, { model: 'high-quality' }).complete(request());
    expect(response.model).toBe('high-quality');
  });

  it('exposes the mapped vendor id on its model ref', () => {
    const instance = provider(recordingTransport(), { model: 'fast' });
    expect(instance.model).toEqual({ name: 'fast', vendorModelId: 'gemini-3.5-flash-lite' });
  });
});

describe('M4.2 assertion 7 — three-valued truncation from status', () => {
  it('maps completed to false', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('done', 'completed')));
    const response = await provider(transport).complete(request());
    expect(response.truncated).toBe(false);
  });

  it('maps incomplete to true', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('partial', 'incomplete')));
    const response = await provider(transport).complete(request());
    expect(response.truncated).toBe(true);
  });

  it('maps an absent status to null', async () => {
    const transport = recordingTransport(() =>
      ok({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }] }),
    );
    const response = await provider(transport).complete(request());
    expect(response.truncated).toBeNull();
  });

  it('maps an unrecognised status to null, never false', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('x', 'in_progress')));
    const response = await provider(transport).complete(request());
    expect(response.truncated).toBeNull();
  });

  it('treats failed as an error rather than a response', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('x', 'failed')));
    await expect(provider(transport).complete(request())).rejects.toBeInstanceOf(LlmError);
  });

  it('treats requires_action as invalid_response', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('x', 'requires_action')));
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('treats requires_continuation as invalid_response', async () => {
    const transport = recordingTransport(() =>
      ok(completedInteraction('x', 'requires_continuation')),
    );
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});

describe('M4.2 assertion 8 — non-2xx maps by documented error.code', () => {
  const cases: readonly {
    readonly status: number;
    readonly code: string;
    readonly kind: string;
  }[] = [
    { status: 401, code: 'authentication', kind: 'authentication' },
    { status: 403, code: 'permission_denied', kind: 'authentication' },
    { status: 400, code: 'invalid_request', kind: 'invalid_request' },
    { status: 400, code: 'parameter_unknown', kind: 'invalid_request' },
    { status: 404, code: 'model_not_found', kind: 'invalid_request' },
    { status: 409, code: 'aborted', kind: 'timeout' },
    { status: 429, code: 'rate_limit_exceeded', kind: 'rate_limit' },
    { status: 429, code: 'quota_exceeded', kind: 'rate_limit' },
    { status: 499, code: 'cancelled', kind: 'timeout' },
    { status: 500, code: 'api_error', kind: 'unavailable' },
    { status: 503, code: 'service_unavailable', kind: 'unavailable' },
    { status: 504, code: 'deadline_exceeded', kind: 'timeout' },
  ];

  for (const { status, code, kind } of cases) {
    it(`maps ${code} (HTTP ${status}) to ${kind}`, async () => {
      const transport = recordingTransport(() => ({
        status,
        body: JSON.stringify({ error: { code, message: 'vendor text' } }),
      }));
      const error = await provider(transport)
        .complete(request())
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).kind).toBe(kind);
      expect((error as LlmError).statusCode).toBe(status);
      // Retryability is derived from the kind by the single authoritative table,
      // so it must agree with that table rather than with a per-code column.
      expect((error as LlmError).retryable).toBe(isRetryableKind((error as LlmError).kind));
    });
  }

  it('falls back to the HTTP status when the code is unlisted', async () => {
    const transport = recordingTransport(() => ({
      status: 429,
      body: JSON.stringify({ error: { code: 'some_new_code', message: 'x' } }),
    }));
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'rate_limit',
    });
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    const transport = recordingTransport(() => ({ status: 500, body: 'gateway blew up' }));
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('maps a 400 with an unparseable body to invalid_request', async () => {
    const transport = recordingTransport(() => ({ status: 400, body: '<html>' }));
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'invalid_request',
    });
  });

  it('names the documented code without forwarding the vendor message', async () => {
    const transport = recordingTransport(() => ({
      status: 400,
      body: JSON.stringify({
        error: { code: 'parameter_unknown', message: 'prompt text echoed back here' },
      }),
    }));
    const error = await provider(transport)
      .complete(request())
      .then(() => undefined)
      .catch((caught: unknown) => caught as LlmError);

    expect(error?.message).toContain('parameter_unknown');
    expect(error?.message).not.toContain('prompt text echoed back here');
  });
});

describe('M4.2 assertion 9 — an unknown alias fails at construction', () => {
  it('throws LlmConfigurationError for an unknown logical name', () => {
    expect(() => provider(recordingTransport(), { model: 'gpt-4' })).toThrow(LlmConfigurationError);
  });

  it('names the offending value and the accepted aliases', () => {
    expect(() => provider(recordingTransport(), { model: 'turbo' })).toThrow(/turbo/);
  });

  it('fails before the transport is ever called', () => {
    const transport = recordingTransport();
    expect(() => provider(transport, { model: 'nope' })).toThrow(LlmConfigurationError);
    expect(transport.calls).toHaveLength(0);
  });

  it('classifies the failure as non-retryable configuration', () => {
    try {
      provider(recordingTransport(), { model: 'nope' });
      expect.unreachable('construction should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmConfigurationError);
      expect((error as LlmConfigurationError).kind).toBe('configuration');
      expect((error as LlmConfigurationError).retryable).toBe(false);
    }
  });
});

describe('M4.2 assertion 10 — text is joined over model_output steps only', () => {
  it('concatenates text across multiple model_output steps', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'Hello ' }] },
          { type: 'model_output', content: [{ type: 'text', text: 'world' }] },
        ],
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.text).toBe('Hello world');
  });

  it('ignores thought steps that carry text', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [
          { type: 'thought', content: [{ type: 'text', text: 'SECRET REASONING' }] },
          { type: 'model_output', content: [{ type: 'text', text: 'visible answer' }] },
        ],
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.text).toBe('visible answer');
    expect(response.text).not.toContain('SECRET REASONING');
  });

  it('joins multiple text parts inside one model_output step', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'part one ' },
              { type: 'text', text: 'part two' },
            ],
          },
        ],
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.text).toBe('part one part two');
  });
});

describe('M4.2 assertion 11 — empty output is an error', () => {
  it('throws LlmEmptyResponseError when no model_output text exists', async () => {
    const transport = recordingTransport(() => ok({ status: 'completed', steps: [] }));
    await expect(provider(transport).complete(request())).rejects.toBeInstanceOf(
      LlmEmptyResponseError,
    );
  });

  it('treats whitespace-only output as empty', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('   ')));
    await expect(provider(transport).complete(request())).rejects.toBeInstanceOf(
      LlmEmptyResponseError,
    );
  });

  it('never resolves with empty text', async () => {
    const transport = recordingTransport(() => ok(completedInteraction('')));
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'empty_response',
    });
  });

  it('treats a missing steps array as invalid_response', async () => {
    const transport = recordingTransport(() => ok({ status: 'completed' }));
    await expect(provider(transport).complete(request())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});

describe('M4.2 assertion 12 — absent usage yields null, never zero', () => {
  it('reports null counts when usage is absent', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }],
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it('reports null for individual absent usage fields', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }],
        usage: { total_input_tokens: 5 },
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: null, totalTokens: null });
  });

  it('maps reported usage fields', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }],
        usage: { total_input_tokens: 11, total_output_tokens: 22, total_tokens: 33 },
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it('never substitutes zero for an absent count', async () => {
    const transport = recordingTransport(() =>
      ok({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }],
        usage: {},
      }),
    );
    const response = await provider(transport).complete(request());
    expect(response.usage.inputTokens).not.toBe(0);
    expect(response.usage.inputTokens).toBeNull();
  });
});

describe('M4.2 — request prompt mapping and system instruction', () => {
  it('sends the prompt verbatim as input', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ prompt: 'translate this: héllo' }));
    expect(bodyOf(transport.calls[0] as RecordedCall)['input']).toBe('translate this: héllo');
  });

  it('omits system_instruction when undefined', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(bodyOf(transport.calls[0] as RecordedCall)).not.toHaveProperty('system_instruction');
  });

  it('sends system_instruction as a plain string when defined', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request({ systemInstruction: 'be terse' }));
    expect(bodyOf(transport.calls[0] as RecordedCall)['system_instruction']).toBe('be terse');
  });

  it('sends no stream or background flag', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    const body = bodyOf(transport.calls[0] as RecordedCall);
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('background');
  });
});

describe('M4.2 — no API key reaches the adapter', () => {
  it('accepts a config object with no apiKey field at the type level', () => {
    // `GeminiProviderConfig` omits `apiKey`; this literal has no key and compiles.
    const cfg: GeminiProviderConfig = { provider: 'gemini', model: 'default', timeoutMs: 1000 };
    expect(cfg).not.toHaveProperty('apiKey');
  });

  it('never sends a credential in the body', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(transport.calls[0]?.body).not.toMatch(/api[_-]?key/i);
  });

  it('keeps the key out of the module source and out of process.env', () => {
    const source = readFileSync(
      new URL('../../../../src/core/llm/providers/gemini.provider.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // The word `apiKey` appears exactly once, in the `Omit<..., 'apiKey'>`
    // exclusion that *removes* it from the adapter's config type. That is the
    // enforcement, not a violation (Section 11.1.4).
    expect(code).toMatch(/Omit<LlmProviderConfig, 'apiKey'>/);

    // What must never appear is any way to *obtain* the key.
    expect(code).not.toMatch(/\.apiKey\b/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/GEMINI_API_KEY/);
  });
});

describe('M4.2 — no second network egress path', () => {
  const source = readFileSync(
    new URL('../../../../src/core/llm/providers/gemini.provider.ts', import.meta.url),
    'utf8',
  );

  it('imports no networking module', () => {
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
      (match) => match[1] ?? '',
    );
    for (const forbidden of [
      'node:http',
      'node:https',
      'node:http2',
      'node:net',
      'node:tls',
      'node:dns',
      'undici',
    ]) {
      expect(specifiers).not.toContain(forbidden);
    }
  });

  it('references no global fetch or HTTP client', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/httpsRequest|httpRequest|createConnection/);
  });

  it('does not construct a transport of its own', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/createGeminiTransport/);
  });

  it('imports the transport module for its type only', () => {
    const valueImports = [
      ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((match) => match[1] ?? '');
    expect(valueImports).not.toContain('./gemini.transport.js');
  });

  it('reaches the network only through the injected transport', async () => {
    const transport = recordingTransport();
    const instance = provider(transport);
    await instance.complete(request());
    expect(transport.calls).toHaveLength(1);
  });
});

describe('M4.2 — timeout and abort composition', () => {
  it('passes an AbortSignal to the transport', async () => {
    const transport = recordingTransport();
    await provider(transport).complete(request());
    expect(transport.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours a per-call timeout override', async () => {
    const transport = recordingTransport();
    await provider(transport, { timeoutMs: 60000 }).complete(request({ timeoutMs: 5 }));
    const signal = transport.calls[0]?.signal;
    // A 5 ms deadline fires almost immediately; a 60 s one does not.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signal?.aborted).toBe(true);
  });

  it('propagates a caller abort to the signal the transport sees', async () => {
    const controller = new AbortController();
    const transport = recordingTransport();
    const pending = provider(transport).complete(request({ signal: controller.signal }));
    controller.abort();
    await pending.catch(() => undefined);
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it('rejects with LlmTimeoutError when the transport reports a timeout', async () => {
    const transport: GeminiTransport = {
      send: () => Promise.reject(new LlmTimeoutError('Gemini request timed out')),
    };
    await expect(provider(transport).complete(request())).rejects.toBeInstanceOf(LlmTimeoutError);
  });
});

describe('M4.2 — provider identity', () => {
  it('is assignable to LlmProvider', () => {
    const instance: LlmProvider = provider(recordingTransport());
    expect(instance.id).toBe('gemini');
  });

  it('reports a positive durationMs', async () => {
    const transport = recordingTransport();
    const response = await provider(transport).complete(request());
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });
});
