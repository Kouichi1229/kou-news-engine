import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../../../src/config/env.js';
import { FakeProvider } from '../../../../src/core/llm/fake.provider.js';
import { LlmConfigurationError } from '../../../../src/core/llm/llm.errors.js';
import type { LlmProviderConfig } from '../../../../src/core/llm/provider.factory.js';
import { createProvider } from '../../../../src/core/llm/provider.factory.js';
import type { GeminiTransport } from '../../../../src/core/llm/providers/gemini.transport.js';

/**
 * Assertion 4-A — credential and test-transport isolation.
 * Specified in design §9.5.3.7; rationale in docs/security/ci-security-model.md §4.
 *
 * 4-A establishes exactly two properties:
 *   1. the Fake provider is selected explicitly and needs no credential;
 *   2. the real Gemini transport is never constructed on the Fake path.
 *
 * 4-A does NOT establish network isolation. These tests say nothing about
 * whether a socket could be opened, and must never be cited as Assertion 4,
 * B-6, or N-1/N-2 evidence. Those remain BLOCKED.
 *
 * No mocks are used. The transport seam is a caller-supplied callback, so a
 * callback that *throws when called* proves non-invocation by passing rather
 * than by asserting against a stub's bookkeeping.
 */

/** Config with the fake provider selected and no credential at all. */
const fakeConfig: LlmProviderConfig = {
  provider: 'fake',
  model: 'default',
  apiKey: undefined,
  timeoutMs: 30_000,
};

/** A callback that fails the test if the factory ever calls it. */
function forbiddenTransport(): () => Promise<GeminiTransport> {
  return () => {
    throw new Error('4-A violation: the real transport seam was invoked on a non-gemini path');
  };
}

describe('4-A fake provider selection is explicit', () => {
  it('returns a FakeProvider for an explicit fake selection', async () => {
    const provider = await createProvider(fakeConfig, { createTransport: forbiddenTransport() });
    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.id).toBe('fake');
  });

  it('builds a fake even when no transport callback is supplied at all', async () => {
    const provider = await createProvider(fakeConfig);
    expect(provider).toBeInstanceOf(FakeProvider);
  });

  it('builds a fake with no credential present', async () => {
    expect(fakeConfig.apiKey).toBeUndefined();
    const provider = await createProvider(fakeConfig, { createTransport: forbiddenTransport() });
    expect(provider).toBeInstanceOf(FakeProvider);
  });
});

describe('4-A the real Gemini transport is never constructed on the fake path', () => {
  it('never invokes the transport seam', async () => {
    // `forbiddenTransport()` throws if called, so reaching the assertion at all
    // is the evidence.
    await expect(
      createProvider(fakeConfig, { createTransport: forbiddenTransport() }),
    ).resolves.toBeInstanceOf(FakeProvider);
  });

  it('does not invoke the seam for repeated calls', async () => {
    const calls = [createProvider(fakeConfig, { createTransport: forbiddenTransport() })];
    for (let i = 0; i < 4; i += 1) {
      calls.push(createProvider(fakeConfig, { createTransport: forbiddenTransport() }));
    }
    const providers = await Promise.all(calls);
    expect(providers).toHaveLength(5);
    for (const p of providers) expect(p).toBeInstanceOf(FakeProvider);
  });
});

describe('4-A no silent fallback to the real transport', () => {
  it('rejects an unknown provider instead of falling back to the fake', async () => {
    const unknown = {
      ...fakeConfig,
      provider: 'definitely-not-a-provider',
    } as unknown as LlmProviderConfig;
    await expect(
      createProvider(unknown, { createTransport: forbiddenTransport() }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('never selects the fake silently when gemini is explicitly requested', async () => {
    // A gemini selection with no key must fail, not degrade to a fake.
    const geminiWithoutKey: LlmProviderConfig = {
      provider: 'gemini',
      model: 'default',
      apiKey: undefined,
      timeoutMs: 30_000,
    };
    await expect(
      createProvider(geminiWithoutKey, { createTransport: forbiddenTransport() }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('rejects a blank key rather than treating it as present', async () => {
    const blankKey: LlmProviderConfig = {
      provider: 'gemini',
      model: 'default',
      apiKey: '   ',
      timeoutMs: 30_000,
    };
    await expect(
      createProvider(blankKey, { createTransport: forbiddenTransport() }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('rejects a gemini selection when the transport seam is absent', async () => {
    const geminiWithKey: LlmProviderConfig = {
      provider: 'gemini',
      model: 'default',
      apiKey: 'test-key-not-real',
      timeoutMs: 30_000,
    };
    await expect(createProvider(geminiWithKey)).rejects.toBeInstanceOf(LlmConfigurationError);
  });
});

describe('4-A the CI environment selects the fake provider by default', () => {
  it('defaults LLM_PROVIDER to fake when the variable is absent', () => {
    // Mirrors the CI job, which sets LLM_PROVIDER=fake explicitly and provides
    // no GEMINI_API_KEY. The default is asserted here so that a future change
    // to the env schema cannot silently switch CI onto a real provider.
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.LLM_PROVIDER).toBe('fake');
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('accepts an explicit LLM_PROVIDER=fake with no credential', () => {
    const env = loadEnv({ LLM_PROVIDER: 'fake' } as NodeJS.ProcessEnv);
    expect(env.LLM_PROVIDER).toBe('fake');
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('builds the factory provider from that CI-shaped environment without a credential', async () => {
    const env = loadEnv({ LLM_PROVIDER: 'fake' } as NodeJS.ProcessEnv);
    const provider = await createProvider(
      {
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL,
        apiKey: env.GEMINI_API_KEY,
        timeoutMs: env.LLM_TIMEOUT_MS,
      },
      { createTransport: forbiddenTransport() },
    );
    expect(provider).toBeInstanceOf(FakeProvider);
  });
});
