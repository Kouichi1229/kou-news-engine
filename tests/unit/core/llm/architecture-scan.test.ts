/**
 * T-10a assertion 5 — static architecture evidence (design §9.5.3, §11.5.4).
 *
 * These tests exercise the scanner against the real production tree and against
 * purpose-built fixtures. A scan that finds nothing looks identical to a clean
 * codebase, so the controls below prove the scanner actually does what it claims:
 * each positive control shows it performs a check, and each negative control shows
 * it fails when the property is violated.
 *
 * Limitations statement (deliverable 13, reproduced from §9.5.3.3):
 *
 * 1. This is a source-text and import-graph analysis, not a proof. It cannot see
 *    through code that computes a module name at runtime, and it does not model
 *    transitive networking inside a third-party package.
 * 2. It cannot inspect the internals of a vendor SDK. If a bare specifier appears
 *    in the closure the scan records that fact; whether the SDK's own transport is
 *    injected is answered by the documentation review (§9.5.2), not by this scan.
 * 3. It does not run the code. Assertion 5 is static; assertions 1–4 are what
 *    observe runtime behaviour.
 *
 * Assertion 4 (process-level network isolation) remains BLOCKED under B-6, which
 * M4.5 does not address. T-10a as a whole therefore does not pass, and these tests
 * do not report it as passing.
 */

import { describe, expect, it } from 'vitest';

import {
  EXCLUSION_REASONS,
  PART_B_ROOTS,
  TRANSPORT_BOUNDARY,
  checkAllowlist,
  classifyExclusion,
  collectEdges,
  countTransportConstructionSites,
  createFixtureWorkspace,
  createRepoWorkspace,
  identifyCallback,
  resolveProviderFactory,
  runValueTrace,
  runtimeHasNoStaticTransportImport,
  scanPartA,
  scanPartB,
  sourceLocation,
  type ExclusionReason,
  type ScanWorkspace,
} from '../../../../tests/helpers/architecture-scan.js';
import { architectureAllowlist } from '../../../../tests/fixtures/llm-architecture-allowlist.js';

/** A minimal part B tree: composition root, factory, transport, adapter. */
function baseFixture(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    'src/core/llm/providers/gemini.transport.ts': `
export interface GeminiTransport { send(url: string): Promise<string> }
export function createGeminiTransport(config: { apiKey: string; timeoutMs: number }): GeminiTransport {
  return { send: async () => config.apiKey };
}
`,
    'src/core/llm/providers/gemini.provider.ts': `
import type { GeminiTransport } from './gemini.transport.js';
export class GeminiProvider {
  constructor(
    public readonly config: { provider: string; model: string; timeoutMs: number },
    public readonly deps: { transport: GeminiTransport },
  ) {}
}
`,
    'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport });
}
`,
    'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies {
  createProvider?: (c: unknown, d: unknown) => Promise<unknown>;
  llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string };
}
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
    'src/index.ts': `
import { createRuntime } from './runtime.js';
async function main(): Promise<void> {
  const runtime = createRuntime();
  void runtime;
}
void main();
`,
    ...overrides,
  };
}

/** Options matching the base fixture layout. */
const FIXTURE_OPTIONS = {
  adapterEntry: 'src/core/llm/providers/gemini.provider.ts',
  transportBoundary: 'src/core/llm/providers/gemini.transport.ts',
  roots: PART_B_ROOTS,
  runtimeModule: 'src/runtime.ts',
  factoryModule: 'src/core/llm/provider.factory.ts',
  entryPoint: 'src/index.ts',
} as const;

function withFixture<T>(files: Record<string, string>, run: (ws: ScanWorkspace) => T): T {
  const ws = createFixtureWorkspace(files);
  try {
    return run(ws);
  } finally {
    ws.dispose();
  }
}

// ---------------------------------------------------------------------------
// Part A and part B on the real production tree
// ---------------------------------------------------------------------------

describe('part A — adapter closure (§9.5.3.1)', () => {
  it('is exactly the adapter and its error module, with zero findings', () => {
    const report = scanPartA();
    expect([...report.modules].sort()).toEqual([
      'src/core/llm/llm.errors.ts',
      'src/core/llm/providers/gemini.provider.ts',
    ]);
    expect(report.failures).toEqual([]);
  });

  it('records the mixed declaration in gemini.provider.ts as two edges', () => {
    const report = scanPartA();
    const toErrors = report.edges.filter((e) => e.target === 'src/core/llm/llm.errors.ts');
    expect(toErrors.map((e) => e.edgeKind).sort()).toEqual(['static-import', 'type-only']);
    expect(toErrors.find((e) => e.edgeKind === 'type-only')?.disposition).toBe('excluded');
    expect(toErrors.find((e) => e.edgeKind === 'static-import')?.disposition).toBe('followed');
  });
});

describe('part B — bounded wiring closure (§9.5.3.3a)', () => {
  const report = scanPartB();

  it('analyses the six expected modules and nothing else', () => {
    expect([...report.modules].sort()).toEqual([
      'src/core/llm/fake.provider.ts',
      'src/core/llm/llm.errors.ts',
      'src/core/llm/provider.factory.ts',
      'src/core/llm/providers/gemini.provider.ts',
      'src/core/llm/providers/gemini.transport.ts',
      'src/runtime.ts',
    ]);
  });

  it('has no failures on the production tree', () => {
    expect(report.failures).toEqual([]);
  });

  it('identifies the callback at the documented 1-based location', () => {
    expect(report.callback?.origin).toBe('src/runtime.ts#createTransport@262:26');
  });

  it('assigns a reason from the closed enumeration to every excluded edge', () => {
    expect(report.exclusions.length).toBeGreaterThan(0);
    for (const record of report.exclusions) {
      expect(EXCLUSION_REASONS).toContain(record.reason);
      expect(record.origin).not.toBe('');
      expect(record.edgeKind).not.toBe('');
      expect(record.sourceLocation).toMatch(/^\d+:\d+$/);
      expect(record.target).not.toBe('');
    }
  });

  it('does not expand excluded targets (B1e): app.ts is never analysed', () => {
    expect(report.modules).not.toContain('src/app.ts');
    const appExclusion = report.exclusions.find((e) => e.target === 'src/app.ts');
    expect(appExclusion?.reason).toBe('http-composition');
  });
});

// ---------------------------------------------------------------------------
// P1–P17 positive controls
// ---------------------------------------------------------------------------

describe('P1 — transitive traversal two static edges deep', () => {
  it('reaches a module two static edges from the adapter entry', () => {
    withFixture(
      {
        'src/a.ts': `import { b } from './b.js';\nexport const a = b;\n`,
        'src/b.ts': `import { c } from './c.js';\nexport const b = c;\n`,
        'src/c.ts': `export const c = 1;\n`,
      },
      (ws) => {
        const report = scanPartA(ws, {
          adapterEntry: 'src/a.ts',
          transportBoundary: 'src/never.ts',
        });
        expect([...report.modules].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
        expect(report.failures).toEqual([]);
      },
    );
  });
});

describe('P2 — a literal dynamic import in part B is followed and recorded', () => {
  it('follows the callback target and records a dynamic-import edge', () => {
    const report = scanPartB();
    const dynamic = report.edges.filter(
      (e) => e.edgeKind === 'dynamic-import' && e.origin === 'src/runtime.ts',
    );
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]?.target).toBe(TRANSPORT_BOUNDARY);
    expect(dynamic[0]?.disposition).toBe('followed');
  });
});

describe('P3 — a callback-reachable local helper is included', () => {
  it('admits a helper the callback invokes, though imported at root level', () => {
    withFixture(
      baseFixture({
        'src/core/llm/helper.ts': `export function buildTransport(): { send: () => Promise<string> } {
  return { send: async () => 'ok' };
}
`,
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { buildTransport } from './core/llm/helper.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        const helper = buildTransport();
        void helper;
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        expect(report.modules).toContain('src/core/llm/helper.ts');
        expect(report.failures).toEqual([]);
      },
    );
  });
});

describe('P4 — an unrelated runtime import is excluded, subtree not traversed', () => {
  it('records the edge as excluded and never reaches its sentinel dependency', () => {
    withFixture(
      baseFixture({
        'src/unrelated.ts': `import { sentinel } from './sentinel.js';\nexport const u = sentinel;\n`,
        'src/sentinel.ts': `export const sentinel = 'never'; // SENTINEL_MUST_NOT_APPEAR\n`,
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { u } from './unrelated.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  void u;
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        expect(report.exclusions.some((e) => e.target === 'src/unrelated.ts')).toBe(true);
        expect(report.modules).not.toContain('src/unrelated.ts');
        expect(report.modules).not.toContain('src/sentinel.ts');
      },
    );
  });
});

describe('P5 — a module reached by several edges is analysed once', () => {
  it('keeps one module entry while reporting each reaching edge separately', () => {
    const report = scanPartB();
    // gemini.transport.ts is reached from runtime.ts (callback) and the factory.
    const count = report.modules.filter((m) => m === TRANSPORT_BOUNDARY).length;
    expect(count).toBe(1);
    const reaching = report.edges.filter((e) => e.target === TRANSPORT_BOUNDARY);
    expect(reaching.length).toBeGreaterThan(1);
  });
});

describe('P6 — the default providerFactory fallback is resolved', () => {
  it('resolves the alias binding and the nullish-coalescing fallback', () => {
    const ws = createRepoWorkspace();

    // The binding is resolved through the TypeChecker, not by identifier text:
    // the right operand must resolve, as an alias, to the factory's
    // `createProvider` declaration and the left operand to a declared binding.
    const resolution = resolveProviderFactory(ws);
    expect(resolution.ok).toBe(true);
    expect(resolution.bindingName).toBe('providerFactory');
    expect(resolution.failure).toBeUndefined();

    // The resolved binding is the one callback identification consumes.
    const callback = identifyCallback(ws);
    expect(callback).toBeDefined();
    expect(callback?.origin).toBe('src/runtime.ts#createTransport@262:26');
  });

  it('does not accept an unrelated ?? expression as the designated factory', () => {
    withFixture(
      baseFixture({
        // The right operand resolves to a local declaration, not to the
        // factory's imported `createProvider`. Identifier-text matching would
        // still bind `providerFactory` here and report a false positive.
        'src/runtime.ts': `
export interface RuntimeDependencies {
  createProvider?: (c: unknown, d: unknown) => Promise<unknown>;
  llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string };
}
declare const unrelatedProvider: (c: unknown, d: unknown) => Promise<unknown>;
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? unrelatedProvider;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(false);
        expect(resolution.failure).toBe('right-operand-not-imported-factory');
        expect(resolution.bindingName).toBeUndefined();

        // With no designated factory binding, the callback cannot be identified.
        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();
      },
    );
  });
});

describe('P7 — the production call site is resolved', () => {
  it('establishes createRuntime() with zero arguments and the default {}', () => {
    const trace = runValueTrace();
    expect(trace.stages.find((s) => s.name === 'stage1')?.resolved).toBe(true);
  });
});

describe('P8 — the callback-returned transport reaches the constructor', () => {
  it('traces Stage 3 to Stage 5 as one chain', () => {
    const trace = runValueTrace();
    expect(trace.ok).toBe(true);
    expect(trace.transportBinding).toBe('transport');
  });
});

describe('P9 — a direct alias is followed and still proves identity', () => {
  it('preserves identity through `const t = transport`', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  const t = transport;
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: t });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(true);
      },
    );
  });
});

describe('P10 — type-only and dynamic import of one target yield two edges', () => {
  it('reports excluded:type-only beside followed dynamic-import', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import type { GeminiTransport } from './core/llm/providers/gemini.transport.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async (): Promise<GeminiTransport> => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        const toTransport = report.edges.filter(
          (e) => e.origin === 'src/runtime.ts' && e.target === TRANSPORT_BOUNDARY,
        );
        const kinds = toTransport.map((e) => e.edgeKind).sort();
        expect(kinds).toEqual(['dynamic-import', 'type-only']);
        const typeOnly = toTransport.find((e) => e.edgeKind === 'type-only');
        expect(typeOnly?.disposition).toBe('excluded');
        expect(typeOnly?.reason).toBe('type-only');
        expect(toTransport.find((e) => e.edgeKind === 'dynamic-import')?.disposition).toBe(
          'followed',
        );
      },
    );
  });
});

describe('P11 — two static import declarations of one target yield two edges', () => {
  it('keeps both static-import edges through deduplication, differing in source location', () => {
    withFixture(
      {
        'src/a.ts': `import { x } from './t.js';\nimport { y } from './t.js';\nexport const a = x + y;\n`,
        'src/t.ts': `export const x = 1;\nexport const y = 2;\n`,
      },
      (ws) => {
        // Assert on the public report, which is the post-`dedupeEdges` result.
        const report = scanPartA(ws, { adapterEntry: 'src/a.ts', transportBoundary: 'src/never.ts' });
        const edges = report.edges.filter((e) => e.target === 'src/t.ts');
        expect(edges).toHaveLength(2);
        expect(edges.map((e) => e.edgeKind)).toEqual(['static-import', 'static-import']);
        expect(edges[0]?.origin).toBe(edges[1]?.origin);
        expect(edges[0]?.sourceLocation).not.toBe(edges[1]?.sourceLocation);
        // Same module reached twice is still analysed once (§9.5.3.3a).
        expect(report.modules.filter((m) => m === 'src/t.ts')).toHaveLength(1);
      },
    );
  });
});

describe('P12 — the entry-point witness stays bounded', () => {
  it('inspects src/index.ts for the call site only, imposing no express allow-list entry', () => {
    const report = scanPartB();

    // The witness is read for the Stage 1 call site but never joins the closure.
    expect(report.modules).not.toContain('src/index.ts');

    // The witness contributes no value-level obligation: its bare specifiers
    // never enter the part B allow-list (§11.5.4 C). A type-only occurrence is
    // exempt under B6a and is therefore not an obligation.
    expect(
      report.edges.filter((e) => e.target === 'express' && e.edgeKind !== 'type-only'),
    ).toEqual([]);

    // Asserted through Scanner output, not by inspecting the allow-list constant:
    // no part B edge demands an entry the fixture does not carry. A regression
    // that made the witness contribute a value edge would surface here.
    expect(checkAllowlist(report, architectureAllowlist).failures).toEqual([]);
  });
});

describe('P13 — exactly one createTransport invocation passes Stage 4', () => {
  it('resolves a single invocation whose awaited result reaches Stage 5', () => {
    const trace = runValueTrace();
    expect(trace.stages.find((s) => s.name === 'stage4')?.resolved).toBe(true);
    expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(true);
  });
});

describe('P14 — a bare specifier only on type-only edges is exempt (B6a)', () => {
  it('records express as excluded rather than requiring an allow-list entry', () => {
    const report = scanPartB();
    const expressEdge = report.exclusions.find(
      (e) => e.target === 'express' && e.origin === 'src/runtime.ts',
    );
    expect(expressEdge?.reason).toBe('type-only');
    expect(architectureAllowlist.some((e) => e.specifier === 'express')).toBe(false);
    expect(report.failures).toEqual([]);
  });
});

describe('P15 — module-scope import and its callback reference yield two entries', () => {
  it('reports a declaration edge and a callback reference edge', () => {
    withFixture(
      baseFixture({
        'src/core/llm/helper.ts': `export function buildTransport(): { send: () => Promise<string> } {
  return { send: async () => 'ok' };
}
`,
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { buildTransport } from './core/llm/helper.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        const helper = buildTransport();
        void helper;
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        const toHelper = report.edges.filter((e) => e.target === 'src/core/llm/helper.ts');
        const declarations = toHelper.filter((e) => e.origin === 'src/runtime.ts');
        const references = toHelper.filter((e) => e.origin.startsWith('src/runtime.ts#createTransport@'));
        expect(declarations).toHaveLength(1);
        expect(references).toHaveLength(1);
      },
    );
  });
});

describe('P16 — a valid baseline with one construction site passes condition 11', () => {
  it('counts exactly one createGeminiTransport call site', () => {
    expect(countTransportConstructionSites()).toBe(1);
  });
});

describe('P17 — src/runtime.ts has no static import of the transport module', () => {
  it('confirms the only reference is the callback literal specifier', () => {
    expect(runtimeHasNoStaticTransportImport()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N1–N24 negative controls
// ---------------------------------------------------------------------------

describe('N1 — a callback-reachable helper cannot be silently omitted', () => {
  it('leaves the helper out of the closure once the callback no longer invokes it', () => {
    withFixture(
      baseFixture({
        'src/core/llm/helper.ts': `export function buildTransport(): { send: () => Promise<string> } {
  return { send: async () => 'ok' };
}
`,
        // The helper is still imported at composition-root level, but the
        // callback no longer references it. Reachability, not the mere
        // existence of the import, is what admits a helper to the closure.
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { buildTransport } from './core/llm/helper.js';
void buildTransport;
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);

        // The helper is not traversed...
        expect(report.modules).not.toContain('src/core/llm/helper.ts');
        // ...but the edge is still reported, excluded rather than dropped, so
        // the omission is a deliberate classification and not silence (§B1g).
        const helperEdges = report.edges.filter((e) => e.target === 'src/core/llm/helper.ts');
        expect(helperEdges).toHaveLength(1);
        expect(helperEdges[0]?.origin).toBe('src/runtime.ts');
        expect(helperEdges[0]?.disposition).toBe('excluded');
        expect(helperEdges[0]?.reason).toBe('not-transport-wiring');

        // The rest of the closure is unaffected, so this is not passing
        // because the whole scan collapsed.
        expect(report.modules).toContain('src/runtime.ts');
        expect(report.modules).toContain('src/core/llm/provider.factory.ts');
        expect(report.modules).toContain('src/core/llm/providers/gemini.transport.ts');
      },
    );
  });
});

describe('N2 — an unresolved callback helper fails', () => {
  it('reports a failure when an invoked callee has no locatable definition', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        const helper = totallyUndeclaredHelper();
        void helper;
        return createGeminiTransport({ apiKey: llmConfig.apiKey ?? '', timeoutMs: llmConfig.timeoutMs });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        // `totallyUndeclaredHelper` has no declaration at all: the call has no
        // locatable body, so the scan must fail rather than ignore it.
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        expect(report.failures.some((f) => f.includes('unresolved callback helper'))).toBe(true);
      },
    );
  });
});

describe('N3 — an unresolved value handoff fails', () => {
  it('fails Stage 5 when the injected value is a fresh call, not the binding', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: transportFactory() });
}
function transportFactory(): GeminiTransport { throw new Error('unused'); }
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(false);
      },
    );
  });

  it('preserves identity for the `{ transport: transport }` form', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: transport });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(true);
      },
    );
  });
});

describe('N4 — a computed dynamic-import specifier fails', () => {
  it('fails when the callback computes its module name', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const name = './core/llm/providers/gemini.transport.js';
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const mod = await import(name);
        return mod.createGeminiTransport({ apiKey: '', timeoutMs: 1 });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        expect(report.failures.some((f) => f.includes('computed dynamic-import'))).toBe(true);
      },
    );
  });
});

describe('N5 — a missing or ambiguous default factory resolution fails', () => {
  it('fails Stage 2 (not Stage 1) when the ?? declaration is absent', () => {
    withFixture(
      baseFixture({
        'src/index.ts': `
import { createRuntime } from './runtime.js';
async function main(): Promise<void> { void createRuntime(); }
void main();
`,
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown> }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const providerFactory = createProviderFromFactory;
  return { getProvider: async () => providerFactory(deps, {}) };
}
`,
      }),
      (ws) => {
        // No `??` binding exists at all, so no factory binding can be resolved.
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(false);
        expect(resolution.failure).toBe('no-nullish-declaration');

        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();

        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        // Stage 1 resolves: the call site and its default parameter are intact.
        expect(trace.stages.find((s) => s.name === 'stage1')?.resolved).toBe(true);
        // The failure is Stage 2, where the factory binding is resolved.
        expect(trace.stages.find((s) => s.name === 'stage2')?.resolved).toBe(false);
        expect(trace.failures.some((f) => f.startsWith('Stage 2:'))).toBe(true);
        expect(trace.failures.some((f) => f.startsWith('Stage 1:'))).toBe(false);
      },
    );
  });

  it('fails when the alias exists but its ?? left operand is unresolvable', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = undeclaredDeps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey: '', timeoutMs: 1 });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        // The right operand resolves to the imported factory, but the left
        // operand `undeclaredDeps.createProvider` has no declaration at all.
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(false);
        expect(resolution.failure).toBe('left-operand-unresolved');

        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();

        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage2')?.resolved).toBe(false);
        expect(trace.ok).toBe(false);
        // The failure names the operand, not a missing declaration or a Stage 1
        // call-site problem, so the two N5 failure modes stay distinguishable.
        expect(
          trace.failures.some(
            (f) => f.includes('left operand') && f.includes('does not resolve'),
          ),
        ).toBe(true);
      },
    );
  });

  // --- Candidate-set cases A–E (§11.5.4 E N5) ------------------------------
  // A resolvable candidate must not mask a sibling that resolves to the same
  // designated factory but whose left operand is unresolved.

  it('Case A: one valid designated-factory candidate resolves', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number } }
export function createRuntime(deps: RuntimeDependencies = {}): void {
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  void providerFactory;
}
`,
      }),
      (ws) => {
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(true);
        expect(resolution.bindingName).toBe('providerFactory');
        expect(resolution.failure).toBeUndefined();
      },
    );
  });

  it('Case B: one unresolved designated-factory candidate fails', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number } }
export function createRuntime(deps: RuntimeDependencies = {}): void {
  const providerFactory = undeclaredDeps.createProvider ?? createProviderFromFactory;
  void providerFactory;
}
`,
      }),
      (ws) => {
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(false);
        expect(resolution.failure).toBe('left-operand-unresolved');
        expect(resolution.bindingName).toBeUndefined();
      },
    );
  });

  it('Case C: two valid designated-factory candidates are ambiguous', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number } }
export function createRuntime(deps: RuntimeDependencies = {}): void {
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const anotherFactory = deps.createProvider ?? createProviderFromFactory;
  void providerFactory;
  void anotherFactory;
}
`,
      }),
      (ws) => {
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(false);
        expect(resolution.failure).toBe('ambiguous');
        expect(resolution.bindingName).toBeUndefined();
      },
    );
  });

  it('Case D: a valid candidate must not mask an unresolved sibling', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number } }
export function createRuntime(deps: RuntimeDependencies = {}): void {
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const anotherFactory = undeclaredDeps.createProvider ?? createProviderFromFactory;
  void providerFactory;
  void anotherFactory;
}
`,
      }),
      (ws) => {
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        // Both candidates resolve their right operand to the designated
        // factory, so the set is ambiguous regardless of the left operands.
        expect(resolution.ok).toBe(false);
        expect(resolution.failure).toBe('ambiguous');
        expect(resolution.bindingName).toBeUndefined();
        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();
      },
    );
  });

  it('Case E: an unrelated nullish expression is not a factory candidate', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number } }
export function createRuntime(deps: RuntimeDependencies = {}): void {
  const llmConfig = deps.llmConfig ?? {};
  void llmConfig;
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  void providerFactory;
}
`,
      }),
      (ws) => {
        // `llmConfig` uses `??` but its right operand does not resolve to the
        // imported factory, so it neither competes nor creates ambiguity.
        const resolution = resolveProviderFactory(ws, FIXTURE_OPTIONS);
        expect(resolution.ok).toBe(true);
        expect(resolution.bindingName).toBe('providerFactory');
        expect(resolution.failure).toBeUndefined();
      },
    );
  });

  it('still resolves the genuine production deps.createProvider ?? createProviderFromFactory path', () => {
    const ws = createRepoWorkspace();
    const resolution = resolveProviderFactory(ws);
    expect(resolution.ok).toBe(true);
    expect(resolution.bindingName).toBe('providerFactory');
    expect(resolution.failure).toBeUndefined();
    expect(identifyCallback(ws)?.origin).toBe('src/runtime.ts#createTransport@262:26');
  });
});

describe('N6 — a transport construction value that is not injected fails', () => {
  it('fails Stage 5 when a fresh value reaches the constructor', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: transportFactory() });
}
function transportFactory(): GeminiTransport { throw new Error('unused'); }
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(false);
      },
    );
  });
});

describe('N7 — node:https inside the adapter closure is a failure', () => {
  it('reports the networking import as a part A failure', () => {
    withFixture(
      {
        'src/a.ts': `import { request } from 'node:https';\nexport const a = request;\n`,
      },
      (ws) => {
        const report = scanPartA(ws, { adapterEntry: 'src/a.ts', transportBoundary: 'src/never.ts' });
        expect(report.failures.some((f) => f.includes('node:https'))).toBe(true);
      },
    );
  });
});

describe('N8 — an unlisted bare specifier on a non-type-only edge fails', () => {
  it('reports an unlisted bare specifier as a failure', () => {
    withFixture(
      {
        'src/a.ts': `import { z } from 'zod';\nexport const a = z;\n`,
      },
      (ws) => {
        const report = scanPartA(ws, { adapterEntry: 'src/a.ts', transportBoundary: 'src/never.ts' });
        const result = checkAllowlist(report, architectureAllowlist);
        expect(result.failures.some((f) => f.includes("unlisted bare specifier 'zod'"))).toBe(true);
      },
    );
  });

  it('accepts the production allow-list for the real part B report', () => {
    const result = checkAllowlist(scanPartB(), architectureAllowlist);
    expect(result.failures).toEqual([]);
  });
});

describe('N9 — a stale allow-list entry fails', () => {
  it('reports an entry whose specifier no longer appears in the closure', () => {
    const stale = [
      ...architectureAllowlist,
      {
        specifier: 'undici',
        part: 'B' as const,
        origin: 'src/core/llm/providers/gemini.transport.ts',
        kind: 'static-import' as const,
        reason: 'hypothetical entry that must be detected as stale',
      },
    ];
    const result = checkAllowlist(scanPartB(), stale);
    expect(result.failures.some((f) => f.includes("stale allow-list entry: 'undici'"))).toBe(true);
  });

  it('has no stale entry in the real production allow-list', () => {
    const result = checkAllowlist(scanPartB(), architectureAllowlist);
    expect(result.failures).toEqual([]);
  });
});

describe('N10 — two providerFactory invocations fail', () => {
  it('leaves the callback unidentified', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const cb = { createTransport: async () => {
    const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
    return createGeminiTransport({ apiKey: '', timeoutMs: 1 });
  } };
  const a = providerFactory(llmConfig, cb);
  const b = providerFactory(llmConfig, cb);
  return { getProvider: async () => Promise.all([a, b]) };
}
`,
      }),
      (ws) => {
        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();
      },
    );
  });
});

describe('N11 — two createTransport properties fail', () => {
  it('leaves the callback unidentified', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const one = async () => { const m = await import('./core/llm/providers/gemini.transport.js'); return m.createGeminiTransport({ apiKey: '', timeoutMs: 1 }); };
  const two = async () => { const m = await import('./core/llm/providers/gemini.transport.js'); return m.createGeminiTransport({ apiKey: '', timeoutMs: 1 }); };
  const attempt = providerFactory(llmConfig, { createTransport: one, createTransport: two });
  return { getProvider: async () => attempt };
}
`,
      }),
      (ws) => {
        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();
      },
    );
  });
});

describe('N12 — an identifier-referenced callback with conditional assignment fails', () => {
  it('leaves the callback unidentified', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const cond = true;
  const cb = cond
    ? async () => { const m = await import('./core/llm/providers/gemini.transport.js'); return m.createGeminiTransport({ apiKey: '', timeoutMs: 1 }); }
    : async () => { const m = await import('./core/llm/providers/gemini.transport.js'); return m.createGeminiTransport({ apiKey: '', timeoutMs: 2 }); };
  const attempt = providerFactory(llmConfig, { createTransport: cb });
  return { getProvider: async () => attempt };
}
`,
      }),
      (ws) => {
        expect(identifyCallback(ws, FIXTURE_OPTIONS)).toBeUndefined();
      },
    );
  });
});

describe('N13 — an unresolved production call site fails', () => {
  it('fails Stage 1 when the entry point passes arguments', () => {
    withFixture(
      baseFixture({
        'src/index.ts': `
import { createRuntime } from './runtime.js';
async function main(): Promise<void> { void createRuntime({ createProvider: async () => 1 }); }
void main();
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage1')?.resolved).toBe(false);
        expect(trace.ok).toBe(false);
      },
    );
  });
});

describe('N14 — a separately constructed transport of the same type fails', () => {
  it('fails identity when a second createGeminiTransport call is injected', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import { createGeminiTransport, type GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  void transport;
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: createGeminiTransport({ apiKey: 'x', timeoutMs: 1 }) });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(false);
      },
    );
  });
});

describe('N15 — a binding reassigned between Stage 4 and Stage 5 fails', () => {
  it('does not treat a different binding as identity', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  void transport;
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: other });
}
declare const other: GeminiTransport;
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(false);
      },
    );
  });

  it('does not follow an alias declared with `let`', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const transport = await deps.createTransport!();
  let t = transport;
  t = transport;
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: t });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage5')?.resolved).toBe(false);
      },
    );
  });
});

describe('N16 — two createTransport invocations with the first discarded fail', () => {
  it('fails Stage 4 on more than one invocation', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  await deps.createTransport!();
  const transport = await deps.createTransport!();
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage4')?.resolved).toBe(false);
      },
    );
  });
});

describe('N17 — an invocation through an alias fails', () => {
  it('fails Stage 4 when the callee is not the property itself', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  const ct = deps.createTransport!;
  const transport = await ct();
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage4')?.resolved).toBe(false);
      },
    );
  });
});

describe('N18 — an invocation hidden in a branch or try/catch fails', () => {
  it('fails Stage 4 when the call is conditional', () => {
    withFixture(
      baseFixture({
        'src/core/llm/provider.factory.ts': `
import type { GeminiTransport } from './providers/gemini.transport.js';
export interface LlmProviderDeps { readonly createTransport?: () => Promise<GeminiTransport> }
export interface LlmProviderConfig { readonly provider: string; readonly model: string; readonly timeoutMs: number }
export async function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<unknown> {
  let transport: GeminiTransport | undefined;
  try {
    transport = await deps.createTransport!();
  } catch {
    transport = undefined;
  }
  const { GeminiProvider } = await import('./providers/gemini.provider.js');
  return new GeminiProvider(config, { transport: transport! });
}
`,
      }),
      (ws) => {
        const trace = runValueTrace(ws, FIXTURE_OPTIONS);
        expect(trace.stages.find((s) => s.name === 'stage4')?.resolved).toBe(false);
      },
    );
  });
});

describe('N19 — two distinct syntactic edges to one target must not be merged', () => {
  it('keeps both edges when one declaration carries value and type bindings', () => {
    withFixture(
      {
        // One declaration, so origin, target and source location are all
        // identical; only the edge kind distinguishes the two edges. A scanner
        // that deduplicates on endpoints alone would collapse them into one row.
        'src/b.ts': `import { x, type T } from './u.js';\nexport const b: T = x;\n`,
        'src/u.ts': `export const x = 1;\nexport type T = number;\n`,
      },
      (ws) => {
        const report = scanPartA(ws, { adapterEntry: 'src/b.ts', transportBoundary: 'src/never.ts' });
        const edges = report.edges.filter((e) => e.target === 'src/u.ts');

        // Post-dedupe cardinality: the two edges must survive as separate rows.
        expect(edges).toHaveLength(2);
        expect(edges.map((e) => e.edgeKind).sort()).toEqual(['static-import', 'type-only']);

        // They are not distinguishable by endpoint or location, only by kind,
        // so this is the endpoint-only deduplication case (§11.5.4 B1g).
        expect(edges[0]?.origin).toBe(edges[1]?.origin);
        expect(edges[0]?.sourceLocation).toBe(edges[1]?.sourceLocation);

        // Each edge keeps its own disposition rather than sharing one row.
        expect(edges.find((e) => e.edgeKind === 'type-only')?.disposition).toBe('excluded');
        expect(edges.find((e) => e.edgeKind === 'static-import')?.disposition).toBe('followed');
      },
    );
  });
});

describe('N20 — an over-read witness would admit express to part B', () => {
  it('turns a value-level express import in the witness into a failing allow-list obligation', () => {
    withFixture(
      baseFixture({
        // The witness carries a value-level express import. Over-reading it
        // makes that import a part B allow-list obligation (§11.5.4 C, rule B6).
        'src/index.ts': `
import express from 'express';
import { createRuntime } from './runtime.js';
async function main(): Promise<void> {
  void express;
  void createRuntime();
}
void main();
`,
      }),
      (ws) => {
        // Bounded run: the witness is not a closure member and contributes no
        // obligation, so express never becomes a value-level edge.
        const bounded = scanPartB(ws, FIXTURE_OPTIONS);
        expect(bounded.modules).not.toContain('src/index.ts');
        expect(
          bounded.edges.filter((e) => e.target === 'express' && e.edgeKind !== 'type-only'),
        ).toEqual([]);

        // Over-read run: supplying the entry point as a root admits it, and its
        // express import becomes exactly the obligation N20 says must fail.
        const overread = scanPartB(ws, {
          ...FIXTURE_OPTIONS,
          roots: [...PART_B_ROOTS, 'src/index.ts'],
        });
        expect(overread.modules).toContain('src/index.ts');
        expect(
          overread.edges.filter((e) => e.target === 'express' && e.edgeKind !== 'type-only'),
        ).toHaveLength(1);
        expect(checkAllowlist(overread, architectureAllowlist).failures).toContainEqual(
          expect.stringContaining("unlisted bare specifier 'express'"),
        );
      },
    );
  });
});

describe('N21 — a type-only bare specifier must not need an entry', () => {
  it('does not fail the run because express is unlisted', () => {
    const report = scanPartB();
    expect(report.failures).toEqual([]);
    const expressEdges = report.edges.filter((e) => e.target === 'express');
    expect(expressEdges.every((e) => e.edgeKind === 'type-only')).toBe(true);
  });
});

describe('N22 — a callback reference must not be misattributed as a declaration', () => {
  it('attributes the declaration and the reference to distinct origins', () => {
    withFixture(
      baseFixture({
        'src/core/llm/helper.ts': `export function buildTransport(): { send: () => Promise<string> } {
  return { send: async () => 'ok' };
}
`,
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { buildTransport } from './core/llm/helper.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        const helper = buildTransport();
        void helper;
        return createGeminiTransport({ apiKey: '', timeoutMs: 1 });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        const callbackOrigin = report.callback?.origin;
        expect(callbackOrigin).toBeDefined();
        expect(callbackOrigin).not.toBe('src/runtime.ts');

        const toHelper = report.edges.filter(
          (e) => e.target === 'src/core/llm/helper.ts',
        );

        const declarations = toHelper.filter((e) => e.origin === 'src/runtime.ts');
        const references = toHelper.filter((e) => e.origin === callbackOrigin);

        // Cardinality first: both edge kinds must actually exist, so the
        // attribution assertions below cannot pass vacuously.
        expect(declarations).toHaveLength(1);
        expect(references).toHaveLength(1);

        // The declaration stays at its declaration origin and is not a
        // callback-unit origin.
        expect(declarations[0]?.origin).toBe('src/runtime.ts');
        expect(declarations[0]?.origin).not.toContain('#createTransport@');

        // The reference is attributed to the callback's own location, and its
        // source location is the callback's location rather than the
        // declaration's.
        expect(references[0]?.origin).toBe(callbackOrigin);
        expect(references[0]?.origin).toContain('#createTransport@');
        expect(references[0]?.sourceLocation).toBe(
          callbackOrigin?.split('@')[1],
        );
        expect(references[0]?.sourceLocation).not.toBe(declarations[0]?.sourceLocation);

        // No edge is counted twice under both origins.
        expect(toHelper).toHaveLength(2);
      },
    );
  });

  it('does not attribute every declaration to the callback unit', () => {
    withFixture(
      baseFixture({
        'src/core/llm/helper.ts': `export function buildTransport(): { send: () => Promise<string> } {
  return { send: async () => 'ok' };
}
`,
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { buildTransport } from './core/llm/helper.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        const helper = buildTransport();
        void helper;
        return createGeminiTransport({ apiKey: '', timeoutMs: 1 });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        const report = scanPartB(ws, FIXTURE_OPTIONS);
        const callbackOrigin = report.callback?.origin ?? '';

        const moduleScopeEdges = report.edges.filter((e) => e.origin === 'src/runtime.ts');
        const callbackEdges = report.edges.filter((e) => e.origin === callbackOrigin);

        // Nonempty before the attribution check (avoids a vacuous `.every`).
        expect(moduleScopeEdges.length).toBeGreaterThan(0);
        expect(callbackEdges.length).toBeGreaterThan(0);

        // A declaration edge never carries the callback-unit origin, and a
        // reference edge always does.
        expect(moduleScopeEdges.every((e) => !e.origin.includes('#createTransport@'))).toBe(true);
        expect(callbackEdges.every((e) => e.origin.includes('#createTransport@'))).toBe(true);

        // The callback's own reference edge is the only callback-origin edge to
        // the helper, so a declaration re-attributed to the callback unit would
        // show up as a second row here.
        expect(
          callbackEdges.filter((e) => e.target === 'src/core/llm/helper.ts'),
        ).toHaveLength(1);
      },
    );
  });
});

describe('N23 — a second construction site is detected', () => {
  it('counts two sites when the callback builds two transports', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
        const first = createGeminiTransport({ apiKey: '', timeoutMs: 1 });
        void first;
        return createGeminiTransport({ apiKey: '', timeoutMs: 1 });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        expect(countTransportConstructionSites(ws, FIXTURE_OPTIONS)).toBe(2);
      },
    );
  });
});

describe('N24 — a static import of the transport in runtime.ts is detected', () => {
  it('reports the violation of condition 12', () => {
    withFixture(
      baseFixture({
        'src/runtime.ts': `
import { createProvider as createProviderFromFactory } from './core/llm/provider.factory.js';
import { createGeminiTransport } from './core/llm/providers/gemini.transport.js';
export interface RuntimeDependencies { createProvider?: (c: unknown, d: unknown) => Promise<unknown>; llmConfig?: { provider: string; model: string; timeoutMs: number; apiKey?: string } }
export function createRuntime(deps: RuntimeDependencies = {}): { getProvider: () => Promise<unknown> } {
  void createGeminiTransport;
  const llmConfig = deps.llmConfig ?? { provider: 'gemini', model: 'm', timeoutMs: 1 };
  const providerFactory = deps.createProvider ?? createProviderFromFactory;
  const startProviderAttempt = (): Promise<unknown> => {
    const attempt = providerFactory(llmConfig, {
      createTransport: async () => {
        const { createGeminiTransport: make } = await import('./core/llm/providers/gemini.transport.js');
        return make({ apiKey: '', timeoutMs: 1 });
      },
    });
    return attempt;
  };
  return { getProvider: startProviderAttempt };
}
`,
      }),
      (ws) => {
        expect(runtimeHasNoStaticTransportImport(ws, FIXTURE_OPTIONS)).toBe(false);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// T-10a partial state (§11.5.4 D closing)
// ---------------------------------------------------------------------------

describe('T-10a is partially satisfied and must not be reported as passing', () => {
  it('records assertion 5 as satisfied by the evidence above', () => {
    const partA = scanPartA();
    const partB = scanPartB();
    const trace = runValueTrace();

    expect(partA.failures).toEqual([]);
    expect(partB.failures).toEqual([]);
    expect(checkAllowlist(partB, architectureAllowlist).failures).toEqual([]);
    expect(trace.ok).toBe(true);
    expect(countTransportConstructionSites()).toBe(1);
    expect(runtimeHasNoStaticTransportImport()).toBe(true);
  });

  it('records assertion 4 as blocked under B-6, which M4.5 does not address', () => {
    // Assertion 4 is process-level network isolation. No static scan can
    // establish it, so the suite states the block rather than implying a pass.
    type Status = 'SATISFIED' | 'BLOCKED';
    const t10a: Readonly<Record<'assertion4' | 'assertion5', Status>> = {
      assertion4: 'BLOCKED',
      assertion5: 'SATISFIED',
    };

    expect(t10a.assertion5).toBe('SATISFIED');
    expect(t10a.assertion4).toBe('BLOCKED');
    expect(Object.values(t10a).every((s) => s === 'SATISFIED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Classification and location invariants
// ---------------------------------------------------------------------------

describe('exclusion classification (§11.5.4 B)', () => {
  it('applies the closed enumeration in first-match order', () => {
    expect(classifyExclusion({ edgeKind: 'type-only', isBare: true, target: 'express' })).toBe(
      'type-only',
    );
    expect(classifyExclusion({ edgeKind: 'static-import', isBare: true, target: 'zod' })).toBe(
      'bare-specifier',
    );
    expect(
      classifyExclusion({ edgeKind: 'static-import', isBare: false, target: 'src/app.ts' }),
    ).toBe('http-composition');
    expect(
      classifyExclusion({
        edgeKind: 'static-import',
        isBare: false,
        target: 'src/core/persistence/sqlite.ts',
      }),
    ).toBe('persistence');
    expect(
      classifyExclusion({
        edgeKind: 'static-import',
        isBare: false,
        target: 'src/modules/health/database.probe.ts',
      }),
    ).toBe('health-and-probes');
    expect(
      classifyExclusion({
        edgeKind: 'static-import',
        isBare: false,
        target: 'src/core/lifecycle/shutdown.ts',
      }),
    ).toBe('lifecycle');
  });

  it('uses not-transport-wiring only as the residual member', () => {
    const reason: ExclusionReason = classifyExclusion({
      edgeKind: 'static-import',
      isBare: false,
      target: 'src/config/env.ts',
    });
    expect(reason).toBe('not-transport-wiring');
  });

  it('assigns every real-tree exclusion exactly one valid reason', () => {
    const report = scanPartB();
    for (const record of report.exclusions) {
      expect(EXCLUSION_REASONS.filter((r) => r === record.reason)).toHaveLength(1);
    }
  });

  it('records env.ts as excluded with the residual reason', () => {
    const report = scanPartB();
    const env = report.exclusions.find((e) => e.target === 'src/config/env.ts');
    expect(env?.reason).toBe('not-transport-wiring');
  });
});

describe('source locations are 1-based', () => {
  it('reports the first character of a file as 1:1', () => {
    withFixture({ 'src/a.ts': `import { b } from './b.js';\nexport const a = b;\n`, 'src/b.ts': `export const b = 1;\n` }, (ws) => {
      const sf = ws.program.getSourceFile(`${ws.rootDir}/src/a.ts`)!;
      expect(sourceLocation(sf, 0)).toBe('1:1');
    });
  });

  it('records the callback origin at 262:26, not the 0-based 261:25', () => {
    const report = scanPartB();
    expect(report.callback?.origin).toContain('@262:26');
    expect(report.callback?.origin).not.toContain('@261:25');
  });
});

describe('mixed import declarations preserve edge identity', () => {
  it('splits one mixed declaration into static-import and type-only', () => {
    withFixture(
      {
        'src/a.ts': `import { v, type T } from './t.js';\nexport const a: T = v;\n`,
        'src/t.ts': `export const v = 1;\nexport type T = number;\n`,
      },
      (ws) => {
        const sf = ws.program.getSourceFile(`${ws.rootDir}/src/a.ts`)!;
        const edges = collectEdges(ws, sf, 'src/a.ts').filter((e) => e.resolved.target === 'src/t.ts');
        expect(edges.map((e) => e.edgeKind).sort()).toEqual(['static-import', 'type-only']);
        expect(edges[0]?.sourceLocation).toBe(edges[1]?.sourceLocation);
      },
    );
  });
});
