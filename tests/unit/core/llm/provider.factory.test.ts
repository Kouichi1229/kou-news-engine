import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { FakeProvider } from '../../../../src/core/llm/fake.provider.js';
import { LlmConfigurationError, LlmError } from '../../../../src/core/llm/llm.errors.js';
import type { LlmProviderConfig } from '../../../../src/core/llm/provider.factory.js';
import { createProvider } from '../../../../src/core/llm/provider.factory.js';
import { GeminiProvider } from '../../../../src/core/llm/providers/gemini.provider.js';
import { loadEnv } from '../../../../src/config/env.js';

/**
 * Load detector for the transport module.
 *
 * The mock factory body executes only when the module is actually imported, so
 * `transportModuleLoaded` is evidence of a load rather than a restatement of an
 * assumption. The module currently declares types only, which makes a load a
 * no-op; the flag still flips, so the detector keeps working once Phase 4 gives
 * the module an implementation.
 */
let transportModuleLoaded = false;

vi.mock('../../../../src/core/llm/providers/gemini.transport.js', () => {
  transportModuleLoaded = true;
  return {};
});

/**
 * Constructor observer for the Gemini adapter.
 *
 * The factory receives the adapter through `await import(...)`, which resolves to
 * the same module id this mock replaces, so the subclass below is what the factory
 * constructs. It records the exact arguments and then delegates to `super`, so the
 * genuine constructor still runs: model-alias validation, `this.config`, and
 * `this.model` all come from the real implementation.
 *
 * The captures are module-scope `let` assigned lazily inside the mock factory. They
 * are read only from test bodies, never during module initialisation, because the
 * factory body runs at call time and would otherwise be unset.
 */
let capturedAdapterConfig: unknown;
let capturedAdapterDeps: unknown;
let adapterConstructorCalls = 0;

vi.mock('../../../../src/core/llm/providers/gemini.provider.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/core/llm/providers/gemini.provider.js')>();

  class CapturingGeminiProvider extends actual.GeminiProvider {
    constructor(
      config: ConstructorParameters<typeof actual.GeminiProvider>[0],
      deps: ConstructorParameters<typeof actual.GeminiProvider>[1],
    ) {
      adapterConstructorCalls += 1;
      capturedAdapterConfig = config;
      capturedAdapterDeps = deps;
      super(config, deps);
    }
  }

  return { ...actual, GeminiProvider: CapturingGeminiProvider };
});

function resetAdapterObserver(): void {
  capturedAdapterConfig = undefined;
  capturedAdapterDeps = undefined;
  adapterConstructorCalls = 0;
}

/**
 * A Gemini response the real adapter can parse.
 *
 * The adapter rejects anything that is not an object carrying a `steps` array with
 * at least one `model_output` step whose content yields non-whitespace text, so a
 * placeholder string would fail as `invalid_response` rather than exercising the
 * success path. Mirrors the shape used in `gemini.provider.test.ts`.
 */
function completedInteraction(text: string): string {
  return JSON.stringify({
    id: 'interaction-1',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 7, total_output_tokens: 3, total_tokens: 10 },
  });
}

/** A transport that resolves successfully and records each `send`. */
function successfulTransport(text: string): {
  readonly transport: { send: () => Promise<{ status: number; body: string }> };
  readonly sends: number;
} {
  const state = { sends: 0 };
  return {
    transport: {
      send: async () => {
        state.sends += 1;
        return { status: 200, body: completedInteraction(text) };
      },
    },
    get sends() {
      return state.sends;
    },
  };
}

function config(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    provider: 'fake',
    model: 'default',
    apiKey: undefined,
    timeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * A transport source that records its own invocations.
 *
 * Supplying a working callback in every run is what makes a "0 calls" assertion
 * meaningful: an absent callback would also yield 0, and would prove nothing
 * about ordering.
 */
function instrumentedTransport(): {
  readonly create: () => Promise<never>;
  readonly calls: number;
} {
  const state = { calls: 0 };
  return {
    create: async () => {
      state.calls += 1;
      throw new Error('transport must not be resolved in this scenario');
    },
    get calls() {
      return state.calls;
    },
  };
}

/** A transport source that resolves successfully and records its invocations. */
function instrumentedSuccessfulSeam<T>(transport: T): {
  readonly create: () => Promise<T>;
  readonly calls: number;
} {
  const state = { calls: 0 };
  return {
    create: async () => {
      state.calls += 1;
      return transport;
    },
    get calls() {
      return state.calls;
    },
  };
}

describe('T-07 factory builds the fake without touching the transport seam', () => {
  it('resolves with a FakeProvider', async () => {
    const provider = await createProvider(config({ provider: 'fake' }));

    expect(provider).toBeInstanceOf(FakeProvider);
  });

  it('reports the logical model name it was configured with', async () => {
    const provider = await createProvider(config({ provider: 'fake', model: 'fast' }));

    expect(provider.model.name).toBe('fast');
    expect(provider.id).toBe('fake');
  });

  it('never invokes a supplied createTransport callback', async () => {
    const transport = instrumentedTransport();

    await createProvider(config({ provider: 'fake' }), { createTransport: transport.create });

    expect(transport.calls).toBe(0);
  });

  it('builds a fake even when the callback is absent', async () => {
    // The seam is optional at the factory boundary because 'fake' must not need it.
    await expect(createProvider(config({ provider: 'fake' }))).resolves.toBeInstanceOf(
      FakeProvider,
    );
  });

  it('builds a fake with no API key present at all', async () => {
    const provider = await createProvider(config({ provider: 'fake', apiKey: undefined }));

    expect(provider).toBeInstanceOf(FakeProvider);
  });

  it('produces a working provider whose output is not silently empty', async () => {
    const provider = await createProvider(config({ provider: 'fake' }));

    const response = await provider.complete({ prompt: 'hello', maxOutputTokens: 16 });

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.model).toBe('default');
  });
});

describe('T-08 an unknown provider is an error, never a fallback', () => {
  it('rejects with LlmConfigurationError', async () => {
    const invalid = { ...config(), provider: 'openai' } as unknown as LlmProviderConfig;

    await expect(createProvider(invalid)).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('names the offending value rather than silently selecting a default', async () => {
    const invalid = { ...config(), provider: 'gemni' } as unknown as LlmProviderConfig;

    const error = await createProvider(invalid).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmConfigurationError);
    expect((error as LlmError).message).toContain('gemni');
    expect((error as LlmError).kind).toBe('configuration');
  });

  it('does not fall back to a FakeProvider', async () => {
    const invalid = { ...config(), provider: 'gemini-2.0' } as unknown as LlmProviderConfig;

    const settled = await createProvider(invalid).then(
      (p) => ({ ok: true as const, p }),
      () => ({ ok: false as const }),
    );

    expect(settled.ok).toBe(false);
  });

  it('does not invoke the transport callback for an unknown provider', async () => {
    const transport = instrumentedTransport();
    const invalid = { ...config(), provider: 'bogus' } as unknown as LlmProviderConfig;

    await createProvider(invalid, { createTransport: transport.create }).catch(() => undefined);

    expect(transport.calls).toBe(0);
  });
});

describe('T-09 a missing credential rejects before the transport is resolved', () => {
  it('rejects with LlmConfigurationError', async () => {
    const transport = instrumentedTransport();

    await expect(
      createProvider(config({ provider: 'gemini', apiKey: undefined }), {
        createTransport: transport.create,
      }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('names GEMINI_API_KEY without echoing a value', async () => {
    const error = await createProvider(config({ provider: 'gemini', apiKey: undefined })).catch(
      (e: unknown) => e,
    );

    expect((error as LlmError).message).toContain('GEMINI_API_KEY');
    expect((error as LlmError).kind).toBe('configuration');
    expect((error as LlmError).retryable).toBe(false);
  });

  it('never passes the live key into the adapter configuration', async () => {
    // Replaces the Phase 2 error-message assertion at this location. That subject
    // is T-18's, assigned to M4.7; this case proves a different property — the key
    // never reaches the adapter on the success path, which only Phase 4 can reach.
    resetAdapterObserver();
    const secret = 'sk-m43-SYNTHETIC-do-not-pass-4f7a9c';
    const { transport } = successfulTransport('credential isolation probe');
    const seam = instrumentedSuccessfulSeam(transport);

    const factoryConfig = config({ provider: 'gemini', apiKey: secret });
    const provider = await createProvider(factoryConfig, { createTransport: seam.create });

    expect(adapterConstructorCalls).toBe(1);

    // The adapter received a different object from the one the caller passed in.
    expect(capturedAdapterConfig).not.toBe(factoryConfig);

    // Exactly the three approved non-secret fields, no more and no fewer.
    expect(Object.keys(capturedAdapterConfig as object).sort()).toEqual([
      'model',
      'provider',
      'timeoutMs',
    ]);

    // Absence, not `undefined`: under `exactOptionalPropertyTypes` a present-but-
    // undefined property is a different runtime state from an absent one.
    expect(capturedAdapterConfig).not.toHaveProperty('apiKey');
    expect('apiKey' in (capturedAdapterConfig as object)).toBe(false);
    expect(JSON.stringify(capturedAdapterConfig)).not.toContain(secret);

    // The seam ran once and the adapter got exactly that instance.
    expect(seam.calls).toBe(1);
    expect((capturedAdapterDeps as { transport: unknown }).transport).toBe(transport);

    // Genuine adapter execution, corroborated through public behaviour.
    expect(provider.id).toBe('gemini');
    expect(provider.model.name).toBe('default');
    expect(provider.model.vendorModelId).toBe('gemini-3.8-flash');

    const response = await provider.complete({ prompt: 'hello', maxOutputTokens: 128 });
    expect(response.text).toBe('credential isolation probe');
  });

  it('treats a blank key as missing', async () => {
    const transport = instrumentedTransport();

    await expect(
      createProvider(config({ provider: 'gemini', apiKey: '   ' }), {
        createTransport: transport.create,
      }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);

    expect(transport.calls).toBe(0);
  });

  it('invokes a supplied createTransport callback exactly 0 times', async () => {
    const transport = instrumentedTransport();

    await createProvider(config({ provider: 'gemini', apiKey: undefined }), {
      createTransport: transport.create,
    }).catch(() => undefined);

    // The counter, not the absence of a callback, is the evidence.
    expect(transport.calls).toBe(0);
  });

  it('rejects at the factory call rather than resolving anything', async () => {
    const transport = instrumentedTransport();

    const settled = await createProvider(config({ provider: 'gemini', apiKey: undefined }), {
      createTransport: transport.create,
    }).then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );

    expect(settled).toBe('rejected');
  });

  it('rejects on a missing key before ever reaching the transport seam', async () => {
    // Ordering, observed directly: a callback that would throw is never entered,
    // so the failure must have happened earlier in the sequence.
    const transport = instrumentedTransport();

    const error = await createProvider(config({ provider: 'gemini', apiKey: undefined }), {
      createTransport: transport.create,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmConfigurationError);
    expect(transport.calls).toBe(0);
  });

  it('never evaluates the transport module on the credential-failure path', async () => {
    // A mock factory runs only if something actually imports the module, so the
    // flag is a real load detector rather than a claim. It stays valid in Phase 4,
    // when the module gains an implementation: a load there would set the flag.
    transportModuleLoaded = false;

    await createProvider(config({ provider: 'gemini', apiKey: undefined }), {
      createTransport: instrumentedTransport().create,
    }).catch(() => undefined);

    expect(transportModuleLoaded).toBe(false);
  });

  it('constructs the Gemini adapter when the key and the seam are both valid', async () => {
    // Replaces the Phase 2 terminal-error pin. Phase 4 wires stages 5-6, so a valid
    // key plus a valid seam now resolves a real adapter instead of throwing.
    resetAdapterObserver();
    const secret = 'sk-m43-SYNTHETIC-valid-key-8b2e1d';
    const { transport, sends } = successfulTransport('success path probe');
    const seam = instrumentedSuccessfulSeam(transport);

    const provider = await createProvider(config({ provider: 'gemini', apiKey: secret }), {
      createTransport: seam.create,
    });

    // The real adapter was constructed, and exactly once.
    expect(adapterConstructorCalls).toBe(1);
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider).not.toBeInstanceOf(FakeProvider);
    expect(provider.id).toBe('gemini');

    // The seam resolved exactly once and the adapter holds that exact instance.
    expect(seam.calls).toBe(1);
    expect((capturedAdapterDeps as { transport: unknown }).transport).toBe(transport);

    // Construction alone opens no connection: the double was never asked to send.
    expect(sends).toBe(0);
  });

  it('never silently returns a fake provider for a configured gemini selection', async () => {
    // A deployment that asked for a real vendor must not be served placeholder text.
    // The seam resolves successfully here: an earlier version used a throwing double,
    // which would have let this pass for the wrong reason — because transport
    // resolution failed, not because a real adapter was built.
    resetAdapterObserver();
    const secret = 'sk-m43-SYNTHETIC-no-fallback-c3d5e7';
    const { transport } = successfulTransport('real vendor output');
    const seam = instrumentedSuccessfulSeam(transport);

    const provider = await createProvider(config({ provider: 'gemini', apiKey: secret }), {
      createTransport: seam.create,
    });

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider).not.toBeInstanceOf(FakeProvider);
    expect(provider.id).toBe('gemini');
    expect(provider.model.name).toBe('default');
    expect(provider.model.vendorModelId).toBe('gemini-3.8-flash');

    // The decisive check: real text from the double, not the factory's placeholder.
    const response = await provider.complete({ prompt: 'hello', maxOutputTokens: 64 });
    expect(response.text).toBe('real vendor output');
    expect(response.text).not.toContain('[fake provider]');
  });
});

describe('T-09a the env schema does not require GEMINI_API_KEY', () => {
  it('loads with LLM_PROVIDER=gemini and no key', () => {
    const env = loadEnv({ LLM_PROVIDER: 'gemini' });

    expect(env.LLM_PROVIDER).toBe('gemini');
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('loads with an empty source at all', () => {
    expect(() => loadEnv({})).not.toThrow();
  });

  it('defaults LLM_PROVIDER to fake', () => {
    expect(loadEnv({}).LLM_PROVIDER).toBe('fake');
  });

  it('defaults the numeric LLM settings', () => {
    const env = loadEnv({});

    expect(env.LLM_MODEL).toBe('default');
    expect(env.LLM_TIMEOUT_MS).toBe(30_000);
    expect(env.LLM_MAX_OUTPUT_TOKENS).toBe(2048);
  });

  it('rejects an unknown LLM_PROVIDER', () => {
    expect(() => loadEnv({ LLM_PROVIDER: 'openai' })).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects out-of-range LLM settings', () => {
    expect(() => loadEnv({ LLM_TIMEOUT_MS: '999' })).toThrowError(
      /Invalid environment configuration/,
    );
    expect(() => loadEnv({ LLM_MAX_OUTPUT_TOKENS: '0' })).toThrowError(
      /Invalid environment configuration/,
    );
    expect(() => loadEnv({ LLM_MAX_OUTPUT_TOKENS: '32769' })).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('carries no cross-field credential rule', () => {
    // A schema with `superRefine` tying provider to key would reject this.
    expect(() => loadEnv({ LLM_PROVIDER: 'gemini' })).not.toThrow();
  });
});

describe('T-10 importing the factory performs no work', () => {
  const source = readFileSync(
    new URL('../../../../src/core/llm/provider.factory.ts', import.meta.url),
    'utf8',
  );

  it('reads no environment variable at module scope', () => {
    expect(source).not.toMatch(/process\.env/);
  });

  it('constructs no provider at module scope', () => {
    // Every `new` must sit inside the exported function body, not at module level.
    const moduleScopeNews = [...source.matchAll(/^ {0,2}new\s+(\w+)/gm)].map((m) => m[1]);
    expect(moduleScopeNews).toEqual([]);
  });

  it('holds only an inert module-scope constant', () => {
    const moduleScopeDecls = [...source.matchAll(/^(?:export\s+)?const\s+(\w+)\s*=/gm)].map(
      (m) => m[1],
    );

    // Constants are permitted; none may be a call, which is what would do work.
    for (const name of moduleScopeDecls) {
      const decl = new RegExp(`^const ${name}\\s*=\\s*(.+)`, 'm').exec(source);
      if (decl?.[1] !== undefined) {
        expect(decl[1]).not.toMatch(/^new\s/);
        expect(decl[1]).not.toMatch(/^\w+\(/);
      }
    }
  });

  it('imports no vendor SDK and no HTTP client', () => {
    expect(source).not.toMatch(/from\s+['"]@google\//);
    expect(source).not.toMatch(/from\s+['"](openai|anthropic|undici|axios|node-fetch)['"]/);
    expect(source).not.toMatch(/from\s+['"]node:(http|https|net|tls|dns)['"]/);
  });

  it('references the transport type only through `import type`', () => {
    const transportImport = /import\s+(type\s+)?\{[^}]*GeminiTransport[^}]*\}\s+from/.exec(source);

    expect(transportImport).not.toBeNull();
    expect(transportImport?.[1]).toBe('type ');
  });

  it('imports the transport module only as a type, which erases at compile time', () => {
    // A value import would load the module at runtime; `import type` is erased, so
    // naming the interface costs no load. Every reference to the module path must
    // therefore be type-only.
    const valueImports = [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1] ?? '')
      .filter((spec) => spec.includes('gemini.transport'));

    expect(valueImports).toEqual([]);
  });

  it('declares a createProvider function that is exported', () => {
    expect(source).toMatch(/export\s+async\s+function\s+createProvider/);
  });
});

describe('the transport module holds the single HTTP egress', () => {
  const source = readFileSync(
    new URL('../../../../src/core/llm/providers/gemini.transport.ts', import.meta.url),
    'utf8',
  );

  it('declares the GeminiTransport interface with the approved send signature', () => {
    expect(source).toMatch(/export\s+interface\s+GeminiTransport/);
    expect(source).toMatch(/send\(/);
    expect(source).toMatch(/readonly\s+body:\s*string/);
    expect(source).toMatch(/readonly\s+headers:\s*Record<string,\s*string>/);
    expect(source).toMatch(/readonly\s+signal:\s*AbortSignal/);
    expect(source).toMatch(/Promise<\{ readonly status: number; readonly body: string \}>/);
  });

  it('exports the single transport factory and nothing that runs on import', () => {
    expect(source).toMatch(/export\s+function\s+createGeminiTransport\s*\(/);

    // Section 9.5.5.1 rule 6: the module must be inert at import — it exports a
    // factory and opens nothing until that factory is called. Every call to the
    // HTTP entry point must therefore sit inside a function body, never at
    // module scope (which would be column 0 in this file's formatting).
    const httpCalls = source.split('\n').filter((line) => line.includes('httpsRequest('));
    expect(httpCalls.length).toBeGreaterThan(0);
    for (const line of httpCalls) {
      expect(line).toMatch(/^\s+\S/);
    }
  });

  it('confines networking to node:https and imports no second HTTP client', () => {
    // Section 9.5.3.2: this is the one module allowed to open a socket, and
    // Section 11.1.5 restricts it to Node's built-in `node:https`.
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
      (match) => match[1] ?? '',
    );

    const nodeSpecifiers = specifiers.filter((spec) => spec.startsWith('node:'));
    expect(nodeSpecifiers.sort()).toEqual(['node:http', 'node:https']);

    for (const forbidden of ['undici', 'node:http2', 'node:net', 'node:tls', 'node:dns']) {
      expect(specifiers).not.toContain(forbidden);
    }
  });

  it('takes the key by injection instead of reading the environment', () => {
    // Section 7.2 keeps environment access in `env.ts`; Section 11.1.4 keeps the
    // key inside the transport's send boundary. Injection satisfies both, so the
    // module must not read `process.env` and must not honour proxy variables.
    // Comments are stripped first: the file legitimately *mentions* `process.env`
    // in prose to explain why it does not use it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/HTTP_PROXY|HTTPS_PROXY|NO_PROXY/);
  });
});
