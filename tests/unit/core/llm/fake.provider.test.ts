import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  LlmEmptyResponseError,
  LlmError,
  LlmTimeoutError,
  isRetryableKind,
  type LlmErrorKind,
} from '../../../../src/core/llm/llm.errors.js';
import { FakeProvider } from '../../../../src/core/llm/fake.provider.js';
import type { LlmProvider } from '../../../../src/core/llm/llm.provider.js';
import type { LlmModelRef, LlmRequest } from '../../../../src/core/llm/llm.types.js';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { prompt: 'hello', maxOutputTokens: 128, ...overrides };
}

function success(text: string): FakeProvider {
  return new FakeProvider({ responses: [{ kind: 'success', text }] });
}

describe('T-01 FakeProvider satisfies LlmProvider and model identity', () => {
  it('is assignable to LlmProvider', () => {
    // Compile-time proof: the annotation is the assertion.
    const provider: LlmProvider = success('ok');

    expect(provider.id).toBe('fake');
    expect(typeof provider.complete).toBe('function');
  });

  it('reports a stable logical model name across reads and calls', async () => {
    const provider = success('ok');

    const first = provider.model.name;
    const second = provider.model.name;
    await provider.complete(request());

    expect(provider.model.name).toBe(first);
    expect(provider.model.name).toBe(second);
  });

  it('echoes the bound logical name in every response', async () => {
    const model: LlmModelRef = { name: 'fast', vendorModelId: 'fake-fast' };
    const provider = new FakeProvider({ responses: [{ kind: 'success', text: 'a' }], model });

    const response = await provider.complete(request());

    expect(response.model).toBe(provider.model.name);
    expect(response.model).toBe('fast');
  });

  it('never reports the vendor model id as the logical name', async () => {
    const model: LlmModelRef = { name: 'high-quality', vendorModelId: 'vendor-xyz' };
    const provider = new FakeProvider({ responses: [{ kind: 'success', text: 'a' }], model });

    const response = await provider.complete(request());

    expect(response.model).not.toBe(model.vendorModelId);
  });
});

describe('T-02 Fake success records the exact request', () => {
  it('returns the scripted text', async () => {
    const response = await success('the answer').complete(request());

    expect(response.text).toBe('the answer');
  });

  it('records the exact request including maxOutputTokens', async () => {
    const provider = success('ok');
    const sent = request({
      prompt: 'translate this',
      systemInstruction: 'be terse',
      maxOutputTokens: 2048,
      temperature: 0.2,
      timeoutMs: 5000,
    });

    await provider.complete(sent);

    expect(provider.receivedRequests).toHaveLength(1);
    expect(provider.receivedRequests[0]).toEqual({
      prompt: 'translate this',
      systemInstruction: 'be terse',
      maxOutputTokens: 2048,
      temperature: 0.2,
      timeoutMs: 5000,
    });
  });

  it('preserves maxOutputTokens verbatim rather than defaulting it', async () => {
    const provider = success('ok');

    await provider.complete(request({ maxOutputTokens: 7 }));

    expect(provider.receivedRequests[0]?.maxOutputTokens).toBe(7);
  });

  it('records one entry per call, in order', async () => {
    const provider = success('ok');

    await provider.complete(request({ prompt: 'one' }));
    await provider.complete(request({ prompt: 'two' }));

    expect(provider.receivedRequests.map((r) => r.prompt)).toEqual(['one', 'two']);
  });

  it('reports unreported usage as null, never zero', async () => {
    const response = await success('ok').complete(request());

    expect(response.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it('defaults truncated to false when the outcome omits it', async () => {
    const response = await success('ok').complete(request());

    expect(response.truncated).toBe(false);
  });

  it('preserves an explicit truncated: null instead of collapsing it to false', async () => {
    const provider = new FakeProvider({
      responses: [{ kind: 'success', text: 'ok', truncated: null }],
    });

    const response = await provider.complete(request());

    expect(response.truncated).toBeNull();
  });
});

describe('T-03 Fake empty response is an error', () => {
  it('rejects kind:empty with LlmEmptyResponseError', async () => {
    const provider = new FakeProvider({ responses: [{ kind: 'empty' }] });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(LlmEmptyResponseError);
  });

  it('carries kind empty_response and is retryable once', async () => {
    const provider = new FakeProvider({ responses: [{ kind: 'empty' }] });

    await expect(provider.complete(request())).rejects.toMatchObject({
      kind: 'empty_response',
      retryable: true,
    });
  });

  it('rejects whitespace-only success text rather than resolving with it', async () => {
    const provider = new FakeProvider({ responses: [{ kind: 'success', text: '   ' }] });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(LlmEmptyResponseError);
  });
});

// Cancellation is not a provider failure: these assert the native AbortSignal
// contract (T-14's "rejects rather than resolving late"), not an LlmErrorKind.
describe('AbortSignal cancellation preserves native reason semantics', () => {
  it('rejects with the exact signal.reason when already aborted', async () => {
    const provider = success('never reached');
    const controller = new AbortController();
    controller.abort();
    const reason = controller.signal.reason;

    const error = await provider.complete(request({ signal: controller.signal })).catch((e) => e);

    // Identity, not merely shape: the platform object must pass through untouched.
    expect(error).toBe(reason);
  });

  it('surfaces a native AbortError name so callers can recognise cancellation', async () => {
    const provider = success('never reached');
    const controller = new AbortController();
    controller.abort();

    const error = await provider
      .complete(request({ signal: controller.signal }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('preserves custom reason object identity', async () => {
    const provider = success('never reached');
    const controller = new AbortController();
    const customError = new Error('caller said stop');
    controller.abort(customError);

    const error = await provider
      .complete(request({ signal: controller.signal }))
      .catch((e: unknown) => e);

    expect(error).toBe(customError);
  });

  it('does not classify cancellation as an LlmError', async () => {
    const provider = success('never reached');
    const controller = new AbortController();
    controller.abort();

    const error = await provider
      .complete(request({ signal: controller.signal }))
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(LlmError);
  });

  it('does not consume a scripted outcome when the signal is already aborted', async () => {
    const provider = new FakeProvider({
      responses: [
        { kind: 'success', text: 'first' },
        { kind: 'success', text: 'second' },
      ],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.complete(request({ signal: controller.signal }))).rejects.toBeDefined();

    // The aborted call must not have advanced the script: the next live call
    // still receives the first outcome.
    const response = await provider.complete(request());
    expect(response.text).toBe('first');
  });

  it('still records the request when the signal is already aborted', async () => {
    const provider = success('never reached');
    const controller = new AbortController();
    controller.abort();
    const aborted = request({ prompt: 'aborted call', signal: controller.signal });

    await provider.complete(aborted).catch(() => undefined);

    // The caller did issue the request, so diagnostics must show it.
    expect(provider.receivedRequests).toHaveLength(1);
    expect(provider.receivedRequests[0]).toBe(aborted);
  });

  it('rejects with the exact signal.reason when aborted during delayMs', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider({
        responses: [{ kind: 'success', text: 'too late' }],
        delayMs: 30_000,
      });
      const controller = new AbortController();

      const pending = provider.complete(request({ signal: controller.signal })).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      const reason = controller.signal.reason;

      expect(await pending).toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume a scripted outcome when aborted during delayMs', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider({
        responses: [
          { kind: 'success', text: 'first' },
          { kind: 'success', text: 'second' },
        ],
        delayMs: 1000,
      });
      const controller = new AbortController();

      const pending = provider.complete(request({ signal: controller.signal })).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await pending;

      // The cancelled call consumed nothing, so the next live call gets 'first'.
      const next = provider.complete(request());
      await vi.advanceTimersByTimeAsync(1000);

      expect((await next).text).toBe('first');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still records the request when aborted during delayMs', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider({
        responses: [{ kind: 'success', text: 'too late' }],
        delayMs: 30_000,
      });
      const controller = new AbortController();
      const aborted = request({ prompt: 'mid-delay abort', signal: controller.signal });

      const pending = provider.complete(aborted).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await pending;

      expect(provider.receivedRequests).toHaveLength(1);
      expect(provider.receivedRequests[0]).toBe(aborted);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T-04 each LlmErrorKind maps to the documented retryable value', () => {
  const table: ReadonlyArray<readonly [LlmErrorKind, boolean]> = [
    ['configuration', false],
    ['authentication', false],
    ['rate_limit', true],
    ['timeout', true],
    ['unavailable', true],
    ['invalid_request', false],
    ['empty_response', true],
    ['invalid_response', false],
  ];

  it.each(table)('%s is retryable=%s in the taxonomy', (kind, expected) => {
    expect(isRetryableKind(kind)).toBe(expected);
  });

  it.each(table)('%s thrown by FakeProvider carries retryable=%s', async (kind, expected) => {
    const provider = new FakeProvider({ responses: [{ kind: 'error', error: kind }] });

    await expect(provider.complete(request())).rejects.toMatchObject({
      kind,
      retryable: expected,
    });
  });

  it('exposes the classification on the error, not only in the table', async () => {
    const provider = new FakeProvider({ responses: [{ kind: 'error', error: 'rate_limit' }] });

    const error = await provider.complete(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(true);
  });
});

describe('T-05 Fake timeout without real waiting', () => {
  it('rejects with LlmTimeoutError', async () => {
    const provider = new FakeProvider({ responses: [{ kind: 'timeout' }] });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('rejects immediately, without a real delay', async () => {
    const provider = new FakeProvider({ responses: [{ kind: 'timeout' }] });
    const startedAt = Date.now();

    await expect(provider.complete(request())).rejects.toBeInstanceOf(LlmTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('rejects after delayMs using a fake clock, so no real time passes', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider({
        responses: [{ kind: 'success', text: 'late' }],
        delayMs: 30_000,
      });

      const pending = provider.complete(request());
      const settled = vi.fn();
      void pending.then(settled, settled);

      // Nothing has resolved yet: the delay is pending on the fake clock.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ text: 'late' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T-06 FakeProvider has no network or vendor dependency', () => {
  const source = readFileSync(
    new URL('../../../../src/core/llm/fake.provider.ts', import.meta.url),
    'utf8',
  );

  it('imports no networking module', () => {
    expect(source).not.toMatch(/from\s+['"]node:(http|https|net|tls|dns)['"]/);
    expect(source).not.toMatch(/from\s+['"](undici|axios|node-fetch)['"]/);
  });

  it('imports no vendor SDK', () => {
    expect(source).not.toMatch(/from\s+['"]@google\//);
    expect(source).not.toMatch(/from\s+['"](openai|anthropic|@anthropic-ai\/sdk)['"]/);
  });

  it('does not reference a global fetch or a raw socket', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bnew\s+WebSocket\b/);
  });

  it('does not read an API key or environment configuration', () => {
    expect(source).not.toMatch(/GEMINI_API_KEY/);
    expect(source).not.toMatch(/process\.env/);
  });

  it('imports only local modules', () => {
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('./')).toBe(true);
    }
  });
});
