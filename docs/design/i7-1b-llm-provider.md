# I7-1b — LLM Provider Abstraction: Design Specification

Status: **Phases 1–4 implemented (uncommitted) and reviewed through M4.4 acceptance;
M4.5–M4.7 not started.** B-6 remains BLOCKED (see the table below).
Audience: whoever implements I7-1b and reviews the resulting PR.

This document specifies a provider-agnostic LLM layer. Section 2 separates what
is already built from what this milestone still adds, so no reader mistakes a
plan for a fact.

### Implementation status

| Scope                                          | Status                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1 — types, errors, interface, fake       | **Implemented, not committed**                                                                                                                                                 |
| Phase 2 — config and factory                   | **Implemented, not committed**                                                                                                                                                 |
| Phase 3 — CLI isolation tests (T-11a..T-11d)   | **Implemented, not committed** — PASS WITH LIMITATIONS (Section 11.0)                                                                                                          |
| Phase 4 — real Gemini adapter                  | **Implemented, not committed** (M4.1 transport, M4.2 adapter, M4.3 factory wiring, M4.4 runtime composition). Specification revised by M4.0 (§11.1) and M4.0.1 (§11.6)         |
| API interface for Phase 4                      | **Interactions API**, `POST /v1/interactions` — selected by M4.0.1 (Section 11.6.7). `generateContent` is officially legacy                                                    |
| Pricing / egress / response limits             | **Specified** by M4.0.2 — tiered pricing (§11.1.1), O-5 approved (§11.6.9), O-7 provisional (§11.6.8). **T-19 approved and 32,768 retained** by M4.0.3 (§11.6.8.4a, §11.6.8.7) |
| Gemini provider adapter (`gemini.provider.ts`) | **Implemented, not committed** (M4.2)                                                                                                                                          |
| Gemini transport (`gemini.transport.ts`)       | **Implemented, not committed** (M4.1) — `node:https` request, no SDK. Specified in §11.1.5                                                                                     |
| `createProvider` factory                       | **Exists**; the `gemini` branch validates the key and transport seam, then lazily constructs `GeminiProvider` (M4.3). Stages specified in §11.3.2                              |
| Network isolation evidence (B-6)               | **BLOCKED** — no N-1 and no complete N-2 (Section 11.2.2)                                                                                                                      |

"Implemented" here means present in the working tree and reviewed. Nothing in
Phases 1–2 has been committed, released or deployed.

---

## 1. Goals and non-goals

### 1.1 Goals

1. Define one interface that translation, summarisation and (later) briefing
   generation call, with no vendor type visible at that boundary.
2. Make the provider replaceable by configuration alone. Swapping Gemini for
   another vendor must not touch translation or summarisation logic.
3. Guarantee that a dry-run never constructs a real provider, never reads an API
   key, and never opens a network connection.
4. Provide a `FakeProvider` good enough to test every caller without the network,
   including failure, empty-response and timeout paths.
5. Fail loudly and early on misconfiguration — an unknown provider name or a
   missing key must be an error, not a silent fallback. "Early" means at the point
   the selected provider is actually built, not at process start: a deployment
   that never uses a vendor must never be asked for that vendor's credential.
6. Keep secrets out of logs, error messages, dry-run output and test output.

### 1.2 Non-goals

- **No prompt engineering or prompt templates.** Prompt content belongs to the
  translation/summarisation milestones. This document defines the transport, not
  the instructions.
- **No streaming.** The first version returns a whole completion. Streaming can
  be added later behind a separate method, and adding it now would shape the
  interface around a feature nothing needs yet.
- **No structured output.** V1 is text-in, text-out only. There is no generic
  JSON or structured-output API, no `responseFormat` field and no schema-validated
  response type. A caller that needs JSON parses the returned text itself. A
  structured-output method is added only when a concrete business requirement
  exists, and it would be a new method rather than a widened `complete()`.
  This is distinct from **envelope parsing**, which the adapter must do and which
  Section 6.6 defines: the adapter parses the vendor's HTTP response envelope, it
  does not ask the model to produce structured content.
- **No retry orchestration inside the provider.** Retry policy belongs to the
  caller or a shared helper, because whether a retry is safe depends on the
  business operation. The provider only classifies errors as retryable or not.
- **No token counting or cost accounting.** Usage is _reported_ if the vendor
  returns it; nothing is calculated or enforced.
- **No batching, caching, embeddings, or tool calling.**
- **No database schema changes.** This milestone stores nothing.

### 1.3 Relationship to the stated product goal

The project goal includes translating and summarising articles into Traditional
Chinese. This milestone builds only the LLM transport those modules will call. It
does not translate or summarise anything, and it adds no CLI, route or scheduled
job.

---

## 2. What exists today vs. what this milestone adds

This section is the honesty check. Everything in the left column is real and was
verified by reading the current working tree. It was originally written before any
of this milestone existed; it has been re-verified and corrected now that Phases 1
and 2 are in the tree. Where a row describes work this milestone adds, the right
column records whether that work is now present.

| Concern                     | Exists today                                                                                                                                                                                                                                       | This milestone                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Config loading              | `src/config/env.ts`, Zod schema, fails fast, `env` exported                                                                                                                                                                                        | Adds LLM variables to the same schema; **general settings only** — credentials are not validated there (Section 7) |
| Structured logging          | `src/core/logger.ts`, JSON lines, level filter                                                                                                                                                                                                     | Provider logs through it; must not log keys                                                                        |
| Error base class            | `src/core/errors.ts` — `AppError` with `code`, `statusCode`, `expose`, `cause`                                                                                                                                                                     | Adds LLM-specific error subclasses (Section 6)                                                                     |
| Module error pattern        | `src/modules/extraction/extraction.errors.ts` — code carried on the error, not parsed from the message                                                                                                                                             | Same pattern reused for LLM errors                                                                                 |
| Clock seam                  | `src/modules/extraction/clock.ts` — `Clock` interface + `systemClock`                                                                                                                                                                              | Reused for timeout/retry tests                                                                                     |
| Cancellation                | `src/core/lifecycle/cancellation.ts` — cooperative `isCancelled()`, **not** `AbortSignal`                                                                                                                                                          | LLM layer adopts `AbortSignal` (Section 6.4), a deliberate difference explained there                              |
| HTTP client pattern         | `src/modules/extraction/http/safe-fetch.ts`, `src/modules/ingestion/feed/feed.client.ts` — injectable `FetchLike`, `REQUEST_TIMEOUT_MS`, `setTimeout`-based abort                                                                                  | Same injection style for the real provider                                                                         |
| Composition root            | `src/runtime.ts` — `createRuntime(deps)`, every seam defaulted, nothing connects at import                                                                                                                                                         | Supplies the `createTransport` callback; creates no transport itself (Section 9.5.5)                               |
| Dry-run CLIs                | `src/cli/args.ts`, `extraction.cli.ts`, `ingestion.cli.ts` — read-only DB, no `--execute` unless literal                                                                                                                                           | Must remain untouched by LLM work (Section 5.4)                                                                    |
| Dependency direction        | `routes → modules → core → config`; modules never import each other                                                                                                                                                                                | LLM adapter lives under `core`; consumers under `modules`                                                          |
| Translation / summarisation | **Not implemented.** `docs/architecture.md` lists them as planned                                                                                                                                                                                  | Still not implemented here                                                                                         |
| Any LLM code                | **Phase 1 and Phase 2 only.** `src/core/llm/` holds `llm.types.ts`, `llm.errors.ts`, `llm.provider.ts`, `fake.provider.ts`, `provider.factory.ts` and the type-only `providers/gemini.transport.ts`. No vendor SDK, no Gemini adapter, no HTTP I/O | Phases 3–4 still to come (Sections 9, 11)                                                                          |

**Verified inventory of Phase 1 and Phase 2 in the working tree** (uncommitted):

| Artifact                                       | Phase | What is actually there                                                                |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `src/core/llm/llm.types.ts`                    | 1     | `LlmRequest`, `LlmResponse`, `LlmUsage`, `LlmModelRef` — no vendor type               |
| `src/core/llm/llm.errors.ts`                   | 1     | `LlmError` + three subclasses, eight `LlmErrorKind` values, the retryability table    |
| `src/core/llm/llm.provider.ts`                 | 1     | The `LlmProvider` interface                                                           |
| `src/core/llm/fake.provider.ts`                | 1     | `FakeProvider` — no network, no vendor SDK, no environment read                       |
| `src/core/llm/provider.factory.ts`             | 2     | `createProvider`; `fake` path complete, `gemini` branch terminates as not implemented |
| `src/core/llm/providers/gemini.transport.ts`   | 2     | The `GeminiTransport` interface only — no implementation, no imports                  |
| `src/config/env.ts`                            | 2     | The five LLM variables; `GEMINI_API_KEY` optional, no cross-field rule                |
| `src/config/constants.ts`                      | 2     | `DEFAULT_LLM_TIMEOUT_MS`, `DEFAULT_LLM_MAX_OUTPUT_TOKENS` and their bounds            |
| `.env.example`                                 | 2     | The five variables documented; the key line left commented out                        |
| `tests/unit/core/llm/fake.provider.test.ts`    | 1     | T-01..T-06                                                                            |
| `tests/unit/core/llm/provider.factory.test.ts` | 2     | T-07, T-08, T-09, T-09a, T-10                                                         |
| `tests/unit/core/llm/gemini.provider.test.ts`  | 4     | M4.2 adapter unit tests (Section 11.5.1) — **allocated by the M4.2 reconciliation**   |
| `tests/unit/config/env.test.ts`                | 2     | The five new fields added to the two exact `toEqual` literals                         |

**Still absent by design:** `src/core/llm/providers/gemini.provider.ts` (Phase 4),
any Gemini transport implementation, any vendor SDK dependency, and any consumer of
`createProvider` in `src/`. The Gemini branch of the factory throws a
not-implemented `LlmConfigurationError` (Section 10.1).

### 2.1 Compatibility constraints inherited from I7-1a

These are hard requirements, not preferences:

1. **Dry-run must not construct a provider.** `extraction.cli.ts` builds a
   read-only connection and issues three `SELECT`s. Adding an LLM dependency must
   not add an import, an env read, or a constructor call to that path.
2. **`--help` must not read configuration.** `args.ts` and `usage.ts` import
   nothing precisely so help can be answered before `env.ts` is evaluated. Any
   LLM module reachable from an entry point must respect that ordering.
3. **No import-time side effects.** `env.ts` validates on evaluation, which is why
   entry points import it dynamically. A provider module must not construct a
   client, read a key, or validate config at import time.
4. **Exit-code contract.** `0` success, `1` failure, `2` usage. An LLM error in a
   future CLI must map onto this contract rather than inventing new codes.
5. **No credential requirement at startup.** Neither CLI, their `--help` paths,
   their dry-runs, nor `createRuntime()` may require `GEMINI_API_KEY`. Only an
   actual `LLM_PROVIDER=gemini` factory call may demand it (decisions D-1, D-2).

---

## 3. Module architecture

### 3.1 Placement

The interface, types, errors, fake and factory go under `core`, because both the
future translation module and the future summarisation module must depend on
them, and `core` is the only layer both may reach.

```
src/
  core/
    llm/
      llm.types.ts        Request, response, usage, model identifier
      llm.errors.ts       Error taxonomy + retryability
      llm.provider.ts     The LlmProvider interface
      fake.provider.ts    FakeProvider — no network, ever
      provider.factory.ts createProvider(config) — the only place vendors appear
      providers/
        gemini.provider.ts    (future) first real adapter
    ...
  modules/
    translation/          (future) depends on core/llm, never on a vendor
    summarisation/        (future) depends on core/llm, never on a vendor
```

### 3.2 Dependency direction

```
modules/translation ─┐
modules/summarisation┼─▶ core/llm ◀─ core/llm/providers/gemini
                     │                 (only the factory imports this)
        config ◀─────┘
```

Rules:

- `modules/translation` and `modules/summarisation` import **only**
  `core/llm/llm.provider.ts` and `core/llm/llm.types.ts`.
- They must never import `core/llm/providers/*`.
- `core/llm/providers/*` may import a vendor SDK. Nothing else may.
- `provider.factory.ts` is the single module that maps a config string to a
  vendor adapter, and it does so with a **dynamic import** so that a process which
  never asks for a provider never loads the SDK.

This mirrors the existing rule that `createRuntime()` is the only place a
database connection is opened.

### 3.3 Why not put this in `modules/`

A `modules/llm/` directory would make translation and summarisation depend on
another module, which `docs/architecture.md` explicitly forbids ("A module
depends on shared foundations and on Express. It does not depend on another
module."). `core/llm` keeps the graph legal without an exception.

---

## 4. Interface and type draft

These are drafts for review, not final code. They follow the repository's existing
conventions: `readonly` fields, `exactOptionalPropertyTypes` compatibility
(optional fields are `?: T | undefined` or omitted entirely), and no vendor types.

### 4.1 Request

```ts
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
   * the vendor's field. See Section 7.3 for how `LLM_MAX_OUTPUT_TOKENS` seeds it.
   */
  readonly maxOutputTokens: number;
  /** 0..1 where supported; adapters that cannot honour it ignore it. */
  readonly temperature?: number | undefined;
  /**
   * Cancels an in-flight call. See Section 6.4 for why this is `AbortSignal`
   * and not the project's `isCancelled()` convention.
   */
  readonly signal?: AbortSignal | undefined;
  /** Per-call timeout. Falls back to the provider's configured default. */
  readonly timeoutMs?: number | undefined;
}
```

`LlmRequest` deliberately has **no** `model` string and no vendor options bag.
Model selection is a provider-construction concern (Section 5), so a caller
cannot smuggle a vendor-specific field through the shared type.

It also has **no** `responseFormat`, JSON-schema or structured-output field: V1 is
text in, text out (decision D-6). A caller needing JSON parses `LlmResponse.text`
itself. Adding structured output later means a new method, not widening this
request type. Parsing the vendor's HTTP envelope is a different matter and stays
the adapter's job (Section 6.6).

`maxOutputTokens` is required rather than optional. A per-request budget that
silently defaulted inside the adapter would hide which caller asked for what, and
would make the environment default impossible to verify end to end (T-16a, T-16b, T-16c).

### 4.2 Response

```ts
export interface LlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface LlmResponse {
  /** The generated text. Guaranteed non-empty; empty output is an error. */
  readonly text: string;
  /**
   * The logical model name that served the request. This is the name the caller
   * asked for (Section 4.4), not a vendor model id — vendor ids never cross this
   * boundary.
   */
  readonly model: string;
  /**
   * Token counts, or all-null when the vendor did not report them. Null rather
   * than 0 so "not reported" is never mistaken for "used nothing" (decision D-7).
   * No count is ever estimated to fill a gap.
   */
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
   * silently ship a cut-off translation.
   */
  readonly truncated: boolean | null;
  /** Wall-clock duration measured by the adapter, for observability. */
  readonly durationMs: number;
}
```

### 4.3 The interface

```ts
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
   *
   * Caller-initiated `AbortSignal` cancellation is not a failure mode: it
   * rejects with `signal.reason` instead, so the platform's `AbortError` (or the
   * caller's own reason object) survives unchanged. See Section 6.4.
   */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
```

Two methods were considered and rejected: `isAvailable()` (it invites a
pre-flight check that then races the real call, and the call itself reports
unavailability precisely) and `countTokens()` (nothing needs it yet).

### 4.4 Provider identification and model identity

`id` is a short, stable, lowercase token (`'gemini'`, `'fake'`). It appears in
logs and error messages. It is **not** a secret and must never be derived from
the key.

**Model identity contract.** `LlmProvider.model` and `LlmResponse.model` are
checked against these three rules, which are what T-01 asserts:

1. **Stable per instance.** For one provider instance built from one
   `LlmProviderConfig`, `provider.model.name` is the same value on every read and
   does not change between calls.
2. **Echoes the bound logical name.** `LlmResponse.model` equals
   `provider.model.name`. That name is bound once, at construction, from
   `LlmProviderConfig.model`, which the composition layer fills from `LLM_MODEL`.
   A response never reports a different logical name than the one its provider was
   built with.

   Note that `LlmRequest` has no `model` field (Section 4.1): a caller cannot pick
   a model per call. Selecting a model means constructing a provider, so "the
   requested name" always means the construction-time name and nothing else. If a
   future milestone needs per-call model selection, that is an interface change
   and is out of scope here.

3. **No cross-vendor id equality.** Vendor model ids are _not_ required to match
   across providers, and no test asserts that they do. `'fast'` on Gemini and
   `'fast'` on a future vendor resolve to different vendor ids; only the logical
   name is contractually comparable.

**Mapping ownership.** Where a logical name turns into a vendor model id is fixed:

| Concern                                  | Owner                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Choosing the logical name                | `LLM_MODEL`, read once by the composition layer when it builds the provider  |
| Mapping a logical name → vendor model id | The **vendor adapter** (`providers/gemini.provider.ts`)                      |
| Carrying the mapping table               | The adapter module, as a private constant                                    |
| Business modules (`translation`, …)      | **Never** — they only ever see logical names                                 |
| `provider.factory.ts`                    | **Not** the owner of vendor mappings; it selects an adapter and nothing more |

So the factory does not hold a model table, and adding a vendor does not mean
editing the factory's model list — it means writing an adapter that owns its own
mapping. The concrete list of logical names is still open (Section 13.1), but
_ownership_ of the mapping is settled here and is not open.

---

## 5. Provider factory

### 5.1 Shape

```ts
export interface LlmProviderConfig {
  readonly provider: 'gemini' | 'fake';
  readonly model: string; // logical name; the adapter maps it to a vendor id
  readonly apiKey: string | undefined; // undefined for 'fake'
  readonly timeoutMs: number;
}

export interface LlmProviderDeps {
  /**
   * Resolves the transport for the selected adapter. Supplied by the composition
   * root in production and by the test in tests. Never called for 'fake'.
   * Async so the production implementation can load its module lazily.
   */
  readonly createTransport?: () => Promise<GeminiTransport>;
}

export function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<LlmProvider>;
```

`LlmProviderConfig` carries **provider-wide** settings only: which adapter, which
logical model, the credential, and the default timeout. `LlmProviderDeps` carries
_seams_ — things the caller supplies rather than reads from configuration — and it
is the same shape `createRuntime(deps)` already uses (Section 2). The transport is a
seam, not a setting, so it belongs there and not in `LlmProviderConfig`.

The seam is **async** deliberately. A synchronous seam would force the composition
root to import the transport module eagerly, which would load Gemini — and possibly
a vendor SDK — in every process that imports `runtime.ts`, including `fake` runs and
non-LLM workflows. Returning a promise lets the production implementation perform a
literal-specifier dynamic `import()` inside the callback body, so the module loads
only when a Gemini provider is actually built (Section 9.5.5).

`deps.createTransport` is a **seam, not a hidden factory**. The prohibition in
Section 9.5.4 is against the _adapter_ reaching for a factory it was not given; this
seam is the opposite — it is the caller handing the transport source in explicitly,
and it is visible in the factory signature. There is no ambient lookup, no module
singleton, and no dynamic import that could obtain a transport behind the caller's
back.

It deliberately does **not** carry `maxOutputTokens`. That is a per-request
budget (`LlmRequest.maxOutputTokens`, Section 4.1), because the right cap differs
per caller — a briefing headline and a full article translation do not share one.
`LLM_MAX_OUTPUT_TOKENS` is therefore a _runtime default_ that the composition
layer copies into each request, not a factory input. The factory never reads it
and must never accept-then-discard it; see Section 7.3.

`createProvider` is **async** because the vendor adapter is loaded with a dynamic
`import()`. It performs no network I/O: every step below is local work.

### 5.2 Flow

The stages are ordered so that no credential is inspected until the provider that
needs it has actually been selected.

```
stage 1  caller reads general config            env.ts: LLM_PROVIDER, LLM_MODEL,
                                                LLM_TIMEOUT_MS
                                                (GEMINI_API_KEY is read as an optional
                                                 raw string; the schema does NOT
                                                 require it. LLM_MAX_OUTPUT_TOKENS is
                                                 also read here but is NOT passed to the
                                                 factory — it seeds each LlmRequest.)
   │
stage 2  caller passes LlmProviderConfig to createProvider()
   │        fields: provider, model, apiKey, timeoutMs
   │        no maxOutputTokens: it belongs to the request, not the provider
   │
stage 3  validate provider name
   │        'fake'   → skip stages 4-5, continue at stage 6
   │        'gemini' → continue at stage 4
   │        anything else → throw LlmConfigurationError('Unknown provider')
   │
stage 4  validate the credentials THIS provider needs
   │        'gemini': apiKey missing or blank
   │                  → throw LlmConfigurationError (names the variable,
   │                    never a value)
   │                  deps.createTransport absent
   │                  → throw LlmConfigurationError (names the missing seam;
   │                    a 'gemini' build with no transport source would force
   │                    the adapter to invent one)
   │
stage 5  dynamically load the adapter
   │        await import('./providers/gemini.provider.js')
   │
stage 6  resolve the transport and construct the provider instance
   │        const transport = await deps.createTransport()   ← the only call
   │        the callback body lazily imports gemini.transport.js;
   │        the factory itself constructs no transport
   │        constructor stores config + transport only — opens no socket,
   │        sends nothing
   │        'fake' path skips this entirely: the callback is never invoked
   │
stage 7  return the provider
   │        nothing has touched the network yet
   │
stage 8  caller invokes provider.complete(request)
            request.maxOutputTokens was filled from LLM_MAX_OUTPUT_TOKENS
            ← the first and only point where a network request is issued
```

Stage 4 is the whole of V-1: **credential validation happens here, at
construction time for the selected provider, and nowhere earlier.** It is not in
the env schema, so a process that selects `fake`, or a process that never builds a
provider at all, cannot fail for a missing `GEMINI_API_KEY`.

### 5.3 Rules

1. **Unknown provider is an error, never a fallback.** A typo must not silently
   select a default. This matches the CLI's stance that a misspelled flag must
   not start real work.
2. **No import-time construction.** `createProvider` is a function; importing the
   module constructs nothing and reads no environment.
3. **No network in any constructor.** Adapters are inert until `complete()` is
   called. Stages 1–7 issue no request; only stage 8 does.
4. **Fake is always available.** It requires no key and no configuration beyond
   its own options, so tests never depend on the factory's vendor path. The
   credential stage is never reached for `fake`.
5. **The key is validated for presence only, and only when selected.** No format
   check: vendor key formats change, and a wrong-format check would reject a valid
   future key. Presence and non-emptiness is the whole test, and it runs only on
   the `gemini` branch.
6. **General config validation stays in the env schema; credentials do not.**
   `LLM_PROVIDER`, `LLM_MODEL`, `LLM_TIMEOUT_MS` and `LLM_MAX_OUTPUT_TOKENS` are
   validated at startup like every other setting. `GEMINI_API_KEY` is declared
   optional there and is enforced at stage 4.
7. **The provider name is checked twice, on purpose.** `env.ts` rejects an
   invalid `LLM_PROVIDER` at startup so a typo fails before anything else runs;
   stage 3 checks it again at the construction boundary so a caller that bypasses
   `env` (a test, a script, a future composition root) still cannot smuggle an
   unknown value in. The two checks have different jobs — input validation versus
   boundary defence — and neither is redundant. Stage 3 is reachable in practice
   precisely because `LlmProviderConfig` can be constructed by hand.
8. **`maxOutputTokens` is not a factory concern.** The factory neither reads nor
   stores it. A per-request budget that the factory accepted and then dropped
   would be a silent configuration loss, so it is not in the config type at all
   (Section 7.3).

### 5.4 Dry-run, help and server-startup guarantee

No process that does not intend to call a model may construct a provider. There
are **three kinds of execution path** and **five test scenarios** — the counts
differ because the two CLIs are tested independently for two of the three paths.

Three execution paths:

- **`--help`** — both CLIs answer help before `env.ts` is evaluated and before any
  factory call. Help therefore loads no environment configuration at all, so
  `GEMINI_API_KEY` is neither read nor parsed.
- **Dry-run** — both CLIs' preview paths never call `createProvider` and construct
  no provider. They open a read-only database and issue `SELECT`s only, and make no
  network request. A dry-run **may** import `env.ts` to resolve `DATABASE_PATH`, and
  that import parses the whole environment object, so `GEMINI_API_KEY` may be read
  and parsed as part of it. What a dry-run must never do is _consume_ the key: it
  does not pass it into provider configuration, does not validate it, and does not
  require it. A dry-run succeeds when `GEMINI_API_KEY` is unset, provided all other
  required conditions are satisfied.
- **Server startup** — `createRuntime()` builds no provider. Starting the HTTP
  server requires no `GEMINI_API_KEY` and contacts no vendor.

The distinction between the two CLI paths is deliberate and is what the tests pin:
`--help` is answered before any configuration exists, while a dry-run genuinely
needs `DATABASE_PATH` and so evaluates `env.ts`. Stating that a dry-run "reads no
key" would be inaccurate; the accurate guarantee is that a dry-run builds no
provider and never consumes the key.

The five test scenarios, one per path-and-CLI pair:

| Scenario | Path         | CLI / process     | Test  | Phase            |
| -------- | ------------ | ----------------- | ----- | ---------------- |
| 1        | `--help`     | extraction CLI    | T-11a | 3                |
| 2        | `--help`     | ingestion CLI     | T-11b | 3                |
| 3        | Dry-run      | extraction CLI    | T-11c | 3                |
| 4        | Dry-run      | ingestion CLI     | T-11d | 3                |
| 5        | Server start | `createRuntime()` | T-11e | **4 — deferred** |

Scenarios 1–4 are Phase 3. Scenario 5 (T-11e) is deferred to Phase 4 because its
subject — that `createRuntime()` composes no Gemini provider or transport — only
becomes meaningful once the runtime gains LLM composition. Before that wiring
exists, `src/runtime.ts` contains no LLM reference and an assertion that it builds
no provider cannot fail. T-11e keeps its T-ID and its place in the matrix; only its
phase and acceptance are deferred (Section 9.6a).

Concretely, **no production consumer currently exists**: `createProvider` has no
caller in `src/`, and this milestone adds none. (Tests call it directly, which is
the point of the abstraction.) A future CLI must follow the `extraction.cli.ts`
pattern and resolve the provider **after** the `execute === true` branch. Scenarios
1–4 above are what T-11a..T-11d assert (Section 9).

This is consistent with the composition-root design rather than in tension with it.
`createRuntime()` **gains the transport callback and the wiring** described in
Section 9.5.5, but it still **builds no provider during this milestone**: the wiring
exists so that the injection path is specified and testable, not so that server
startup constructs a Gemini client. Because the callback loads the transport module
lazily (Section 9.5.5.1), server startup also loads no Gemini transport or vendor
SDK. T-11e asserts that `createRuntime()` starts with no key and builds no provider,
and it does so in Phase 4, once the wiring it guards actually exists. When a consumer
arrives in a later milestone, it calls `createProvider` from inside the
already-wired composition root — the seam is in place, and no new architecture is
needed.

---

## 6. Errors and timeouts

### 6.1 Taxonomy

One base class, mirroring `ExtractionFailureError`'s "code on the error" style:

```ts
export type LlmErrorKind =
  | 'configuration'   // bad or missing config; not retryable
  | 'authentication'  // key rejected; not retryable
  | 'rate_limit'      // quota/429; retryable after a delay
  | 'timeout'         // exceeded the deadline; retryable
  | 'unavailable'     // 5xx or connection failure; retryable
  | 'invalid_request' // vendor rejected the request; not retryable
  | 'empty_response'  // vendor returned nothing usable; retryable once
  | 'invalid_response'; // could not parse what came back; not retryable

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly providerId: string;
  readonly statusCode: number | null;
  constructor(...);
}

export class LlmConfigurationError extends LlmError { /* kind: 'configuration' */ }
export class LlmTimeoutError       extends LlmError { /* kind: 'timeout' */ }
export class LlmEmptyResponseError extends LlmError { /* kind: 'empty_response' */ }
```

`LlmConfigurationError` is thrown by the factory (stages 3 and 4 of Section 5.2),
never by the env schema. It covers an unknown provider name and a missing or blank
credential for the selected provider.

`retryable` is stored, not derived at the call site, so the classification lives
in one table (Section 6.2) rather than in every caller.

**`RuntimeDisposedError` is deliberately outside this hierarchy.** It is defined in
`src/runtime.ts` (Section 11.1.8) and extends plain `Error`, not `LlmError`. Two
reasons make that the correct home:

- `LlmErrorKind` is a closed union backed by `RETRYABLE_BY_KIND: Record<LlmErrorKind,
boolean>`, so adding a kind is a source change to `llm.errors.ts` that would also
  have to answer a retryability question. "The runtime was disposed" is not a
  provider failure with a retry semantics; it is a lifecycle condition, and every
  answer to "is it retryable?" would be wrong.
- `LlmError` describes what a **provider** did. A disposed runtime never reached a
  provider, so classifying it there would misattribute the failure.

The existing codebase already uses this shape for a lifecycle error:
`RuntimeInitializationError` in `src/cli/ingestion.cli.ts` extends plain `Error`,
sets `this.name`, and is owned by the module that raises it. `RuntimeDisposedError`
follows that precedent, which keeps it inside the authorized M4.4 file list.

Distinguishing the two failure classes is therefore structural, not textual:

| Condition                             | Error                                                                       | `kind`            | `instanceof LlmError` | Retryable      |
| ------------------------------------- | --------------------------------------------------------------------------- | ----------------- | --------------------- | -------------- |
| `getProvider()` called after disposal | `RuntimeDisposedError`                                                      | `'disposed'`      | `false`               | No             |
| Provider construction failed          | whatever `createProvider` rejected with (typically `LlmConfigurationError`) | an `LlmErrorKind` | `true`                | Per its `kind` |

A caller that catches `LlmError` will not accidentally swallow a disposal error, and
a caller that catches `RuntimeDisposedError` learns the runtime is finished rather
than that its credential is wrong.

#### 6.1.1 `RuntimeDisposedError` kind contract

`RuntimeDisposedError` carries a **stable `kind` discriminator**, but in its own kind
space. It is **not** a member of `LlmErrorKind`, and `llm.errors.ts` is not modified.

```ts
/** Closed union of runtime-lifecycle error kinds. Disjoint from `LlmErrorKind`. */
export type RuntimeErrorKind = 'disposed';

export class RuntimeDisposedError extends Error {
  readonly kind: RuntimeErrorKind = 'disposed';

  constructor(message = 'Runtime has been disposed') {
    super(message);
    this.name = 'RuntimeDisposedError';
  }
}
```

**Why a separate union rather than a ninth `LlmErrorKind`.** `LlmErrorKind` is closed
and every member must answer a retryability question through
`RETRYABLE_BY_KIND: Record<LlmErrorKind, boolean>`. A lifecycle condition has no
sensible retry answer, so widening that union would either add a meaningless
`retryable` entry or force a special case into a table whose whole purpose is to be
exhaustive. A separate one-member union keeps both spaces honest and keeps the change
inside `src/runtime.ts`.

**Disjointness is checked by the type system.** `'disposed'` is not a member of
`LlmErrorKind` (which holds `configuration`, `authentication`, `rate_limit`,
`timeout`, `unavailable`, `invalid_request`, `empty_response`, `invalid_response`),
so a `RuntimeErrorKind` value cannot be assigned to an `LlmErrorKind` variable
without a compile error. The two discriminators can never collide at runtime.

**Identification contract.** Callers and tests identify a disposal failure by three
independent, non-textual signals, in this order of preference:

| #   | Signal                        | Assertion                               | Why it is stable                                                                  |
| --- | ----------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `kind` discriminator          | `error.kind === 'disposed'`             | A literal type; independent of message and of class identity across module copies |
| 2   | Class identity                | `error instanceof RuntimeDisposedError` | Names the exact condition                                                         |
| 3   | Exclusion from provider space | `error instanceof LlmError === false`   | Proves it is not misclassified as a provider failure                              |

`error.name === 'RuntimeDisposedError'` is retained as a fourth, **diagnostic** signal
for logs and error serialisation. It is not the primary discriminator, because `name`
is a mutable string while `kind` is a readonly literal type.

Matching on message text is explicitly **not** an accepted identification method, and
no test may rely on it.

### 6.2 Retryable vs. not

| Kind               | Retryable         | Why                                                               |
| ------------------ | ----------------- | ----------------------------------------------------------------- |
| `configuration`    | No                | Retrying a bad key burns quota for the same result                |
| `authentication`   | No                | Same                                                              |
| `invalid_request`  | No                | The prompt is wrong; retrying sends the same wrong prompt         |
| `invalid_response` | No                | An envelope the adapter cannot parse will fail the same way again |
| `rate_limit`       | Yes, with backoff | The existing `backoffDelay()` in `feed.client.ts` is the model    |
| `timeout`          | Yes               | Transient by nature                                               |
| `unavailable`      | Yes               | Transient by nature                                               |
| `empty_response`   | Yes, once         | Often a sampling artefact; a second attempt usually differs       |

The provider classifies; the **caller** decides how many attempts (decision D-5).
This keeps a retry from duplicating a side effect the caller already committed.

### 6.3 Timeout behaviour

- A per-call `timeoutMs` overrides the provider default.
- The default comes from `LLM_TIMEOUT_MS` (Section 7), not from a hard-coded
  literal, because unlike `LEASE_MS` this is a deployment property: a slower
  vendor or a larger model legitimately needs longer.
- On expiry the provider rejects with `LlmTimeoutError`. It must also abort the
  underlying request so the socket is not left open.
- Timeouts are measured per attempt, not per retry chain.

### 6.4 Why `AbortSignal` here, when the project uses `isCancelled()`

The existing `cancellation.ts` is deliberately cooperative: it never interrupts an
in-flight write, because a half-written database row is worse than a slow finish.
An LLM call has no such hazard — there is nothing to write and nothing to leave
inconsistent. Aborting it is safe and is the only way to stop a hung socket.

`AbortSignal` is also what the platform's `fetch` takes, so the adapter can pass
it straight through instead of translating between two cancellation models. The
interface therefore accepts an optional `signal`, and the two mechanisms stay
separate on purpose. This is a documented divergence, not an inconsistency.

Decision D-3 records the boundary precisely: the LLM layer **accepts** an
`AbortSignal` on its request type, and `cancellation.ts` is **not** rewritten,
generalised or replaced. The existing `isCancelled()` contract continues to govern
ingestion and extraction runs exactly as it does today; the two mechanisms are
never merged.

**Cancellation is not an `LlmError`.** Caller-initiated `AbortSignal` cancellation
is not a provider failure and must not be classified as one. The provider rejects
with `signal.reason`, preserving the original cancellation reason and its object
identity — so `controller.abort(customError)` produces a rejection where
`rejection === customError`, and a default `abort()` produces the platform's
`AbortError`. Cancellation is therefore never mapped to `invalid_request`,
`timeout`, or any other `LlmErrorKind`; the eight-kind taxonomy in Section 6.1
describes how the _provider_ failed, and a caller withdrawing is not that.

This is what "pass it straight through" means concretely: a caller that already
distinguishes cancellation by `error.name === 'AbortError'` — the idiom
`feed.client.ts` uses — recognises an aborted LLM call without learning a second
vocabulary.

Section 4.3's rule that `complete()` "rejects with an `LlmError` subclass for every
failure mode" is scoped to **LLM/provider failure modes**: vendor errors, transport
faults, empty responses and timeouts. Caller-initiated cancellation is not a
failure mode, so it is the one documented exception to that rule.

### 6.5 Empty and truncated responses

- **Empty or whitespace-only text** → `LlmEmptyResponseError`, retryable once.
  A caller that wants to accept an empty answer must say so explicitly; the
  default must not be "silently return nothing".
- **Truncated output** → returned as a normal response, never an error, with
  `LlmResponse.truncated` carrying the fact. The three-valued contract is:

  | `truncated` | Meaning                                         | Adapter rule                                   |
  | ----------- | ----------------------------------------------- | ---------------------------------------------- |
  | `true`      | The provider explicitly reported a length stop  | Map the vendor's length-stop reason to `true`  |
  | `false`     | The provider explicitly reported a normal stop  | Map the vendor's normal stop reason to `false` |
  | `null`      | The provider gave no reliable truncation signal | **Never** guess; report `null`                 |

  `null` must not be collapsed to `false`. An adapter that cannot interpret the
  vendor's stop reason reports `null`, because a caller that treats unknown as
  "complete" would ship a silently cut-off translation. Equally, `null` must not
  be collapsed to `true` — a false truncation warning is noise a caller cannot act
  on. Callers decide what to do with each value; the provider only reports it.

  Truncation is **not** an error: a short answer may be perfectly acceptable, and
  whether it is belongs to the business caller. Nothing in this milestone retries
  or rejects on `truncated === true`.

### 6.6 Envelope parsing vs. model output parsing

Two different things are called "parsing" here, and only one of them belongs to
this milestone. Keeping them apart is what makes decision D-6 coherent.

**Provider envelope parsing — the adapter's job.**

- The adapter must parse the vendor's HTTP response envelope: status code, body
  shape, the text field, the usage fields, the stop reason.
- If the envelope is malformed — not the expected structure, a required field
  missing, a body that cannot be decoded — that is `invalid_response`. The
  provider could not understand the vendor, which is a transport-level fault.
- This is an internal protocol concern. No caller ever sees the envelope.

**Model output parsing — not this milestone.**

- V1 offers no JSON schema, no `responseFormat`, and no general structured-output
  API (Section 1.2, decision D-6).
- The provider never asks the model to emit JSON and never validates model text
  against a schema.
- **Model text that is not valid JSON is not an `invalid_response`.** The text is
  returned as-is in `LlmResponse.text`; it is a perfectly valid completion.
- If a future business module wants structured data, that module owns the parsing
  and its failure handling. `translation` and `summarisation` may parse
  `LlmResponse.text` themselves; the LLM layer stays agnostic.

A one-line test of the boundary: `invalid_response` means "the vendor spoke a
language the adapter could not read". It never means "the model's answer was not
the JSON I hoped for".

---

## 7. Configuration specification

### 7.1 Variables

Added to the existing Zod schema in `src/config/env.ts`. Every one has a default
except the key, so an environment with no LLM settings still boots — which is
required, because the current server and CLIs must keep working unchanged.

| Variable                | Type                 | Proposed default | Status       | Required at startup | Meaning                            |
| ----------------------- | -------------------- | ---------------- | ------------ | ------------------- | ---------------------------------- |
| `LLM_PROVIDER`          | `'gemini' \| 'fake'` | `'fake'`         | **Approved** | No                  | Which adapter the factory builds   |
| `LLM_MODEL`             | string, min 1        | `'default'`      | Proposed     | No                  | Logical model name                 |
| `LLM_TIMEOUT_MS`        | int, 1000–120000     | `30000`          | Proposed     | No                  | Provider-level default timeout     |
| `LLM_MAX_OUTPUT_TOKENS` | int, 1–32768         | `2048`           | Proposed     | No                  | Seeds `LlmRequest.maxOutputTokens` |
| `GEMINI_API_KEY`        | string, optional     | _(none)_         | n/a          | **No — see 7.2**    | Vendor credential                  |

Two statuses are in play and they are not the same thing:

- **Approved** — ratified as a design decision (D-1). `LLM_PROVIDER` defaulting to
  `'fake'` is settled and will not change.
- **Proposed** — a concrete default the document adopts so the design is complete
  and implementable, but which still needs sign-off as a _production_ value. These
  values exist and are usable; they are simply not yet ratified (Section 13.1).

Nothing in the table is "unset". Every variable has a working default, so an
environment with no LLM settings still boots — which is required, because the
current server and CLIs must keep working unchanged.

The "Required at startup" column is the point of V-1: **no LLM credential is
required for the process to start.** `GEMINI_API_KEY` is declared in the schema as
an optional string so it is visible in one place and can be read without
`process.env` access scattered through the code, but its absence is not a
configuration error.

### 7.2 Validation rules

1. **The env schema validates general settings only.** `LLM_PROVIDER` must be one
   of the two literals, and the numeric settings must be in range. That is the
   entire LLM part of the startup schema. There is **no `superRefine`** and no
   cross-field credential rule: the schema cannot know whether a provider will
   ever be built.
2. **The credential is validated by the factory, for the selected provider only.**
   `GEMINI_API_KEY` is checked at stage 4 of Section 5.2 — after
   `LLM_PROVIDER=gemini` has been chosen, before the adapter is loaded. A missing
   or blank key throws `LlmConfigurationError`. This is the only place the check
   exists.
3. **`LLM_PROVIDER=fake` never inspects the key.** The credential stage is skipped
   entirely, so a fake deployment needs no secret and local development needs no
   vendor account.
4. **A process that builds no provider is never asked for a key.** The server, the
   ingestion CLI, the extraction CLI, their `--help` paths and their dry-runs all
   run with `GEMINI_API_KEY` unset. Only an actual `LLM_PROVIDER=gemini` factory
   call can fail on it.
5. **Defaults keep the current deployment valid.** `LLM_PROVIDER` defaulting to
   `'fake'` means nothing real is ever contacted unless an operator opts in. This
   is the same posture as the CLIs' dry-run default.
6. **The key is never logged, echoed, or included in an error message.** The
   `LlmConfigurationError` for a missing key names the variable, never a value. A
   present-but-wrong key produces `LlmError` with `kind: 'authentication'` and a
   message that contains the provider id and status code only.
7. **`LLM_MAX_OUTPUT_TOKENS` is validated here but consumed by the caller.** The
   schema checks the range (1–32768) because a nonsense value should fail at
   startup, but the value's journey ends at the composition layer, which copies it
   into each `LlmRequest` (Section 7.3). It is not a factory input.

### 7.3 How `LLM_MAX_OUTPUT_TOKENS` reaches the provider

`LLM_MAX_OUTPUT_TOKENS` is a **runtime default**, not a provider setting. The path
is:

```
env.ts                      LLM_MAX_OUTPUT_TOKENS = 2048 (validated 1..32768)
   │
   ▼
composition layer           reads the default; a business caller may override it
   │                        per call (a headline needs far fewer than a translation)
   ▼
LlmRequest.maxOutputTokens  required field, always set explicitly
   │
   ▼
adapter                     maps it to the vendor's max-output parameter
   │                        (Gemini: generationConfig.maxOutputTokens)
   ▼
vendor API
```

Rules:

1. **The factory never sees it.** `LlmProviderConfig` has no such field
   (Section 5.1), so it cannot be silently read and dropped.
2. **Every request carries a value.** `maxOutputTokens` is required on
   `LlmRequest`, so a caller cannot forget it and inherit an implicit vendor
   default.
3. **The default is a starting point, not a ceiling.** A caller that knows better
   passes its own value; the environment variable only supplies the fallback.
4. **The fake records it.** `FakeProvider` stores each received request, so a test
   can assert the value arrived intact (T-02, T-16b).
5. **`LLM_TIMEOUT_MS` is different and stays put.** Timeout remains a
   provider-level setting in `LlmProviderConfig.timeoutMs`, with a per-call
   `LlmRequest.timeoutMs` override. That split already existed and is unchanged by
   this decision.

### 7.4 Secret handling checklist

- `env.ts` errors list the variable name and the validation problem, never the
  value (existing behaviour, preserved).
- The provider never logs `config.apiKey`; logs carry `providerId` and `model`.
- Error objects carry no key. `cause` is preserved for debugging but is expected
  to be a vendor error that does not echo the credential.
- Test fixtures use obvious placeholders (`'test-key-not-real'`) and no test
  asserts on a real-looking key.
- `.env.example` documents the variables with a placeholder, never a real value.

---

## 8. Fake provider behaviour

`FakeProvider` is a first-class deliverable, not a test afterthought. It is the
only way callers can be tested without a network, and it must be impossible for
it to reach one.

### 8.1 Options

```ts
export interface FakeProviderOptions {
  /**
   * Scripted results, consumed in order; the last one repeats.
   *
   * There is deliberately no separate `text` option: a plain fixed answer is
   * expressed through the `success` variant, so exactly one construct says
   * "return this string" and no two options can disagree about which one wins.
   */
  readonly responses: readonly FakeOutcome[];
  /** Delay before resolving, to exercise timeout paths with a fake clock. */
  readonly delayMs?: number;
  /** The model identity to report. Defaults to a fake model ref. */
  readonly model?: LlmModelRef;
}

export type FakeOutcome =
  | {
      readonly kind: 'success';
      readonly text: string;
      readonly usage?: LlmUsage;
      /** Defaults to `false`. Use `null` to exercise the "unknown" branch. */
      readonly truncated?: boolean | null;
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: LlmErrorKind }
  | { readonly kind: 'timeout' };
```

### 8.2 Behaviour

- Records every received `LlmRequest` in `receivedRequests`, so a test can assert
  the exact prompt, system instruction, `maxOutputTokens`, timeout and signal it
  was given.
- **Preserves `maxOutputTokens` verbatim.** It does not default, clamp or drop the
  field. A test that needs to prove the runtime default was threaded through
  asserts on `receivedRequests[n].maxOutputTokens` (T-16b).
- `kind: 'success'` is the **only** way to return text. It resolves with
  `truncated` taken from the outcome, defaulting to `false` when omitted. Passing
  `null` explicitly produces the "provider cannot tell" case, so a caller's
  unknown-handling path is testable without a vendor. There is no second
  fixed-text path: `FakeProviderOptions` has no `text` field, so a test cannot set
  both a fixed answer and a scripted one and wonder which applies.
- `kind: 'empty'` rejects with `LlmEmptyResponseError`.
- `kind: 'error'` rejects with an `LlmError` of the requested kind, with
  `retryable` set from the same table the real providers use.
- `kind: 'timeout'` rejects with `LlmTimeoutError` immediately, or after
  `delayMs` when a fake clock is in use, so a test does not have to wait 30 s.
- Honours `request.signal`: an already-aborted signal rejects before recording a
  successful result, and a signal aborted during `delayMs` clears the pending timer
  and rejects. Both paths reject with the exact `signal.reason` — cancellation is
  not converted into an `LlmError` (Section 6.4) — and neither consumes a scripted
  outcome. The request itself is recorded on invocation, even when its signal is
  already aborted, so diagnostics show every call the provider was asked to serve.
- Reports `LlmResponse.model` as the logical name it was constructed with, so the
  identity contract in Section 4.4 holds for the fake too.
- Requires no credential and never reads `GEMINI_API_KEY`. `FakeProvider` can be
  constructed and used in a process where the variable is entirely unset, which is
  what makes the default `LLM_PROVIDER=fake` deployment work with no secret
  (decision D-1).
- **Never imports `node:http`, `node:https`, `fetch`, or any vendor SDK.** This is
  asserted by a test that inspects the module's imports (Section 9, T-06).

### 8.3 Why not `vi.mock` the real provider

Mocking a vendor SDK couples every test to that SDK's shape and breaks when the
SDK changes. A fake behind the interface tests the caller against the contract
that actually matters, and it keeps working when the vendor is replaced.

---

## 9. Test matrix

Every test is deterministic, offline, and uses only the fake provider, test
doubles and temporary resources. **No test in this matrix may call a real Gemini
API, reach the network, or touch a production database.**

| ID    | Test                           | Level        | Phase        | Asserts                                                                                                                                                        |
| ----- | ------------------------------ | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01  | Interface conformance          | unit         | 1            | `FakeProvider` satisfies `LlmProvider`; model identity obeys the three rules in Section 4.4                                                                    |
| T-02  | Fake success                   | unit         | 1            | Returns the fixed text; `receivedRequests` holds the exact request, including `maxOutputTokens`                                                                |
| T-03  | Fake empty                     | unit         | 1            | `kind: 'empty'` rejects with `LlmEmptyResponseError`                                                                                                           |
| T-04  | Fake error kinds               | unit         | 1            | Each `LlmErrorKind` maps to the documented `retryable` value                                                                                                   |
| T-05  | Fake timeout                   | unit         | 1            | Rejects with `LlmTimeoutError` without real waiting                                                                                                            |
| T-06  | Fake never networks            | unit         | 1            | Module imports contain no http/fetch/vendor reference                                                                                                          |
| T-07  | Factory: fake                  | unit         | 2            | `fake` builds a fake; credential stage never reached; `createTransport` never called                                                                           |
| T-08  | Factory: unknown               | unit         | 2            | Unknown provider throws `LlmConfigurationError`, no fallback                                                                                                   |
| T-09  | Factory: missing key           | unit         | 2            | `gemini` with no key throws at factory call; `createTransport` never called, transport unloaded                                                                |
| T-09a | Env load without key           | unit         | 2            | `loadEnv()` succeeds with `LLM_PROVIDER=gemini` and no `GEMINI_API_KEY`                                                                                        |
| T-10  | Factory: no import-time work   | unit         | 2            | Importing `provider.factory` constructs nothing and reads no key                                                                                               |
| T-11a | `extract.ts --help` isolation  | integration  | 3            | Exit 0, no env load, no provider constructed, no key read                                                                                                      |
| T-11b | `ingest.ts --help` isolation   | integration  | 3            | Exit 0, no env load, no provider constructed, no key read                                                                                                      |
| T-11c | Extraction dry-run isolation   | integration  | 3            | Real dry-run path with no `GEMINI_API_KEY`: no provider, no `createProvider`, no network                                                                       |
| T-11d | Ingestion dry-run isolation    | integration  | 3            | Real dry-run path with no `GEMINI_API_KEY`: no provider, no `createProvider`, no network                                                                       |
| T-11e | Server startup without key     | integration  | 4 (deferred) | `createRuntime()` starts with `GEMINI_API_KEY` unset; no eager provider/transport                                                                              |
| T-13  | Timeout mapping                | unit         | 4            | An adapter-level timeout becomes `LlmTimeoutError` with `kind: 'timeout'`                                                                                      |
| T-14  | Abort propagation              | unit         | 4            | An aborted `signal` rejects rather than resolving late                                                                                                         |
| T-16a | `maxOutputTokens`: env layer   | unit         | 4            | `LLM_MAX_OUTPUT_TOKENS` parses, defaults to `2048`, rejects out-of-range values                                                                                |
| T-16b | `maxOutputTokens`: composition | unit         | 4            | The env value is copied verbatim into `LlmRequest.maxOutputTokens`; a caller override wins                                                                     |
| T-16c | `maxOutputTokens`: adapter     | unit         | 4            | The value lands on `generationConfig.maxOutputTokens` unmodified, never clamped                                                                                |
| T-17  | Truncation mapping             | unit         | 4            | Length stop → `true`, normal stop → `false`, absent/unknown stop → `null`                                                                                      |
| T-18  | API key isolation              | unit         | 4            | A synthetic key never appears in an error message, log line, or propagated vendor body (Section 11.1.7)                                                        |
| T-19  | Response body size ceilings    | unit         | 4            | 1 MiB / 64 KiB ceilings enforced by bounded reading and abort; never by truncation (Section 11.6.8.7)                                                          |
| T-20  | Concurrent init sharing        | integration  | 4            | Concurrent `getProvider()` calls share one `createProvider` call and one provider instance, but each receives its own wrapper promise (Section 9.0b)           |
| T-21  | Retry after failed init        | integration  | 4            | Retry proven by public API results and `createProvider` call count only; no private cell state inspected (Section 9.0b)                                        |
| T-22  | Dispose during pending init    | integration  | 4            | `dispose()` does not await the build; an unsettled caller promise rejects with `RuntimeDisposedError`; late settle neither resurrects nor leaks (Section 9.0b) |
| T-23  | Access after disposal          | integration  | 4            | `getProvider()` rejects with `RuntimeDisposedError` and starts nothing (Section 9.0b)                                                                          |
| T-10a | Single egress: build + call    | unit         | 4            | Runtime + network-isolation + two-part static evidence; all required                                                                                           |
| T-12  | Consumer independence          | architecture | — deferred   | Consumers import no vendor SDK; requires modules that this milestone does not create                                                                           |
| T-15  | Swap without caller change     | architecture | — deferred   | A second stub provider substitutes for the fake with no consumer file edited                                                                                   |

**Test counts.** Every T-ID is unique, and the matrix registers exactly these
totals:

| Scope          |  Count | Tests                                                                                   |
| -------------- | -----: | --------------------------------------------------------------------------------------- |
| Phase 1        |      6 | T-01, T-02, T-03, T-04, T-05, T-06                                                      |
| Phase 2        |      5 | T-07, T-08, T-09, T-09a, T-10                                                           |
| Phase 3        |      4 | T-11a, T-11b, T-11c, T-11d                                                              |
| Phase 4        |     14 | T-10a, T-11e, T-13, T-14, T-16a, T-16b, T-16c, T-17, T-18, T-19, T-20, T-21, T-22, T-23 |
| **In scope**   | **29** | Phases 1–4                                                                              |
| Deferred       |      2 | T-12, T-15                                                                              |
| **Registered** | **31** | All T-IDs in this matrix                                                                |

T-18 is added by M4.0 to enforce the API-key isolation requirements in
Section 11.1.4, which are behavioural and would otherwise have no test. It raised
the Phase 4 count from 8 to 9 and the in-scope total from 23 to 24.

T-19 is added by M4.0.3 to verify the response body size ceilings in Section 11.6.8.
It raises the Phase 4 count from 9 to 10, the in-scope total from 24 to 25, and the
registered total from 26 to 27.

### 9.0a Phase 4 test specifications

Every Phase 4 test, specified to the level the acceptance criteria require. No test
below reaches the network, and none is permitted to be weakened to obtain a pass.

| Field                           | **T-10a**                                                                                                                                                                                                      | **T-11e**                                                                                                                                                        | **T-13**                                                                           | **T-14**                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Purpose**                     | Prove the adapter is built and called through one injected transport, with no second egress path                                                                                                               | Prove `createRuntime()` starts with no key and eagerly builds no provider or transport                                                                           | Prove an adapter-level timeout surfaces as `LlmTimeoutError`                       | Prove an aborted caller signal rejects instead of resolving late |
| **Precondition**                | Adapter + recording double; static scans available                                                                                                                                                             | `GEMINI_API_KEY` unset; fresh runtime                                                                                                                            | Adapter + a transport that never settles                                           | Adapter + a transport that is pending when the signal aborts     |
| **Input**                       | Construct, then `complete()` with a normal request                                                                                                                                                             | Call `createRuntime()`; never call `getProvider()`                                                                                                               | Request with `timeoutMs` below the transport's delay                               | Request with an `AbortSignal`; abort after the call starts       |
| **Expected**                    | No request on construction; `calls.length === 0` after construction; the expected `POST /v1/interactions` request appears after `complete()` with `store: false`; N-1 or complete N-2; both static parts clean | Returns a runtime; no provider constructed; `gemini.transport` not in the module registry; `getProvider()` never called (see the assertion-strength table below) | Rejects with `LlmTimeoutError`, `kind === 'timeout'`, and the request is destroyed | Rejects; does not resolve after abort; no unhandled rejection    |
| **Security property verified**  | Single egress; no hidden socket                                                                                                                                                                                | No eager credential or vendor initialisation                                                                                                                     | A hung socket cannot outlive its deadline                                          | Cancellation actually stops work                                 |
| **External network**            | **No**                                                                                                                                                                                                         | **No**                                                                                                                                                           | **No**                                                                             | **No**                                                           |
| **Fake transport allowed**      | **Required**                                                                                                                                                                                                   | Not used                                                                                                                                                         | **Required**                                                                       | **Required**                                                     |
| **Process-level egress denial** | **Required** for assertion 4 (currently BLOCKED)                                                                                                                                                               | Not required                                                                                                                                                     | Not required                                                                       | Not required                                                     |

| Field                           | **T-16a**                                                           | **T-16b**                                                               | **T-16c**                                                                                 | **T-17**                                                        | **T-18**                                                                        |
| ------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Purpose**                     | Env layer parses and bounds `LLM_MAX_OUTPUT_TOKENS`                 | Composition copies the env value into the request; caller override wins | Adapter copies the value to the vendor field unmodified                                   | Truncation is three-valued                                      | A synthetic key never leaks                                                     |
| **Precondition**                | `loadEnv()`                                                         | Composition layer                                                       | Adapter + recording double                                                                | Adapter + recording double                                      | Adapter + transport returning a non-2xx body that echoes the key                |
| **Input**                       | Unset; `2048`; `0`; `32769`; non-numeric                            | Env value `1024`, no override; env `1024`, override `4096`              | `maxOutputTokens: 1234`                                                                   | `status`: `incomplete`; `completed`; absent; an unrelated value | Key `'test-key-not-real'` echoed in the vendor body                             |
| **Expected**                    | Default `2048`; valid passes; out-of-range and non-numeric rejected | `1024` copied; override yields `4096`                                   | `generation_config.max_output_tokens === 1234`, not clamped; no `temperature` key present | `true` / `false` / `null` / `null`                              | No key in `message`, `String(error)`, `JSON.stringify(error)`, or captured logs |
| **Security property verified**  | Budget is bounded before use                                        | No silent setting loss                                                  | No silent clamping of a caller budget                                                     | An unknown stop is never reported as complete                   | Credential cannot escape through errors or logs                                 |
| **External network**            | **No**                                                              | **No**                                                                  | **No**                                                                                    | **No**                                                          | **No**                                                                          |
| **Fake transport allowed**      | Not used                                                            | Not used                                                                | **Required**                                                                              | **Required**                                                    | **Required**                                                                    |
| **Process-level egress denial** | Not required                                                        | Not required                                                            | Not required                                                                              | Not required                                                    | Not required                                                                    |

**T-10a is the only Phase 4 test that requires process-level egress denial**, and
that requirement is currently BLOCKED (Section 11.2.2). Every other Phase 4 test is
satisfiable offline with a recording double.

#### 9.0a.1 T-11e assertion strength (G-3)

T-11e previously listed "no SDK loaded" as an expected outcome. That assertion is
**currently vacuous**: M4.1 implemented the transport over `node:https` and no vendor
SDK is installed, so a check for "no SDK loaded" passes without proving anything
about lazy loading. Per §9.6, a vacuous pass is worse than an absent test. The
assertion set is therefore split by what it actually demonstrates today.

| #   | Assertion                                                     | Kind                      | Non-vacuous because                                                           |
| --- | ------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| 1   | `createRuntime()` succeeds with `GEMINI_API_KEY` unset        | Runtime, observable       | A missing key must not fail startup; it can regress if `env` gains a rule     |
| 2   | No provider is constructed during `createRuntime()`           | Runtime, observable       | An injected `createProvider` seam records **0** invocations                   |
| 3   | `providers/gemini.transport.ts` is not in the module registry | Runtime, observable       | The module exists and _would_ be recorded if loaded; the check is falsifiable |
| 4   | The `createTransport` callback was never invoked              | Runtime, observable       | A recording seam counts 0; the callback is the only path to the module        |
| 5   | No vendor SDK is loaded at startup                            | **Forward-looking guard** | **Not** falsifiable today — no SDK is installed                               |

Assertions 1–4 are the operative evidence and are all falsifiable today. Assertion 5
is retained as a **forward-looking architectural guard**, not as proof: with
`node:https` and an empty vendor-SDK dependency list it cannot fail, and it must not
be cited as evidence that lazy loading works.

**Combined evidence is non-vacuous.** T-11e alone would be weak — a runtime with no
LLM code at all also satisfies assertions 1–5. What makes the pair meaningful is the
**static scan in §9.5.3.3a**, which requires that `runtime.ts` contain no static
import of `gemini.transport.ts` and that its only reference to that module be the
literal specifier inside the callback body. T-11e proves the module is not loaded at
startup; the scan proves the _only_ way it could ever load is through the lazy
callback. Neither alone is sufficient, and neither is vacuous.

T-11e must remain executable and deterministic against the current `node:https`
implementation. It requires no vendor SDK, no network access, and no change to the
transport architecture.

T-11e is counted in Phase 4, not Phase 3. It stays in scope and keeps its T-ID; only
its phase and acceptance moved, because the property it guards — that
`createRuntime()` eagerly builds no Gemini provider or transport — cannot fail before
the runtime gains LLM composition (Section 9.6a). Moving it does not change the
in-scope total: 6 + 5 + 4 + 14 = 29.

T-16 is deliberately counted as three tests (T-16a/b/c), not one. It covers three
layers that fail independently (Section 9.4), so collapsing it back to a single
row would understate Phase 4 by two tests.

| Field                           | **T-19**                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Purpose**                     | Prove the reader enforces the 1 MiB / 64 KiB ceilings by bounded reading and abort, never by truncating |
| **Precondition**                | Adapter + fake transport yielding controlled byte streams                                               |
| **Input**                       | Bodies at, just under, and just over each ceiling; chunked delivery; under-declared `Content-Length`    |
| **Expected**                    | The eight assertions of Section 11.6.8.7 all hold                                                       |
| **Security property verified**  | A hostile or misrouted response cannot cause unbounded buffering or a silently truncated result         |
| **External network**            | **No**                                                                                                  |
| **Fake transport allowed**      | **Required**                                                                                            |
| **Process-level egress denial** | Not required                                                                                            |

T-19 is the only Phase 4 test that owns body-size behaviour. It is registered by
M4.0.3 and is specified in full in Section 11.6.8.7, where its eight assertions
live. It is counted once, in Phase 4.

#### 9.0b Phase 4 test specifications: ProviderCell lifecycle (T-20..T-23)

T-11e proves only that startup constructs nothing. It says nothing about what the
cell does once `getProvider()` is called — and that is where the state machine can
fail silently. A cached rejection, a non-atomic `idle → pending` transition, or a
late resolution resurrecting a disposed runtime would all leave T-11e green. These
four tests are registered by M4.4 (Revision 1, G-5) so the behaviour specified in
Section 11.1.8 is an acceptance criterion rather than prose.

Every test below drives the cell through **injected seams only**: `llmConfig` and
`createProvider` are supplied by the test, so no credential, no network, and no
transport module is involved. Synchronisation is by **deferred promises the test
controls**, never by `setTimeout` sleeps: the test decides exactly when the
initialisation promise settles, so the assertion order is deterministic rather than
timing-dependent.

| Field                           | **T-20**                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                     | Prove concurrent `getProvider()` calls share **one initialisation attempt** while each caller still receives its **own** disposal-aware wrapper promise                                                                                                                                                                                                                                                    |
| **Precondition**                | Runtime with an injected `createProvider` that returns a promise the test settles manually                                                                                                                                                                                                                                                                                                                 |
| **Input**                       | Call `getProvider()` twice (and a third time in the same tick) before settling the injected promise                                                                                                                                                                                                                                                                                                        |
| **Runtime assertions**          | (1) `createProvider` invoked **exactly once**; (2) each call returns a **distinct** promise — `promiseA !== promiseB`; (3) once initialisation succeeds and no disposal intervenes, every wrapper resolves to the **identical** provider instance; (4) no second initialisation starts after settlement. All four are asserted through the public `Runtime` API and the injected factory's call count only |
| **Architectural invariant**     | Verified by **implementation review** of `src/runtime.ts` at acceptance, not by T-20 at runtime: the internal attempt lives in `ProviderCell.pending.attempt`, is shared by concurrent callers, is **never returned directly**, and every `getProvider()` call returns its own wrapper — so no wrapper _is_ the internal attempt. T-20 cannot observe that private promise and does not claim to           |
| **Not inspected**               | No `cell.state`, no private field, no internal attempt reference, no debug-only accessor, and no public `Runtime` addition exists to expose internal promise identity. The test asserts only public-API results and the injected factory's call count                                                                                                                                                      |
| **Security property verified**  | A burst of requests cannot multiply provider construction or credential use. Sharing the attempt must not be implemented by handing callers a shared promise, which would make T-22's per-caller disposal rejection impossible                                                                                                                                                                             |
| **External network**            | **No**                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Fake transport allowed**      | Not used — the provider is injected                                                                                                                                                                                                                                                                                                                                                                        |
| **Process-level egress denial** | Not required                                                                                                                                                                                                                                                                                                                                                                                               |
| **Owner**                       | M4.4                                                                                                                                                                                                                                                                                                                                                                                                       |

| Field                           | **T-21**                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                     | Prove a failed initialisation is not cached permanently and a later call retries, using **only observable API behaviour**                                                                                                                                                                                                                                                                                                                               |
| **Precondition**                | Injected `createProvider` that rejects on the first call and resolves on the second; the ProviderCell is **private** and is not inspected                                                                                                                                                                                                                                                                                                               |
| **Input**                       | `getProvider()` (rejects); then `getProvider()` again                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Expected**                    | (1) The first call rejects with the injected initialisation error; (2) the second call starts a **new** attempt — `createProvider` call count increases from **1** to **2**; (3) the second call resolves with a provider; (4) a third call resolves with the **same** provider instance and does **not** increment the call count; (5) no permanently cached rejected promise is observable — the first rejection does not determine any later outcome |
| **Not inspected**               | No `cell.state`, no private field, no internally stored error, no internal promise, and no debug-only accessor. The test asserts only what the public API returns and how often the injected factory is invoked                                                                                                                                                                                                                                         |
| **Security property verified**  | A transient credential or network failure does not permanently disable the runtime                                                                                                                                                                                                                                                                                                                                                                      |
| **External network**            | **No**                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Fake transport allowed**      | Not used                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Process-level egress denial** | Not required                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Owner**                       | M4.4                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

| Field                           | **T-22**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                     | Prove disposal during a pending initialisation neither blocks shutdown nor resurrects the cell, **and** that a caller whose `getProvider()` was still unsettled when disposal began is rejected with `RuntimeDisposedError`                                                                                                                                                                                                                                                                                                                                |
| **Precondition**                | Injected `createProvider` returning a deferred promise the test holds unsettled; a `dispose()` call made while that promise is pending                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Input**                       | **Case A:** `getProvider()` (pending); `dispose()`; then settle the held promise — once resolving and once rejecting. **Case B:** call `getProvider()` and **retain the returned promise**; keep initialisation pending; call `dispose()`; await the retained promise; then settle the underlying attempt (once resolving, once rejecting)                                                                                                                                                                                                                 |
| **Expected**                    | **A:** `dispose()` completes **without awaiting** the pending attempt; the cell remains `disposed`; no provider is published. **B:** the retained caller-facing promise **rejects** with `RuntimeDisposedError`; `kind === 'disposed'`; `instanceof RuntimeDisposedError` is true; `instanceof LlmError` is false. **Late success:** no provider is published or returned to that pre-disposal caller. **Late rejection:** no unhandled rejection occurs, and the caller-facing result remains the disposal error. Identification is never by message text |
| **Synchronisation**             | Deferred promises (manually resolved/rejected handles) or an equivalent deterministic mechanism. Arbitrary sleeps are **not** acceptable as the primary proof                                                                                                                                                                                                                                                                                                                                                                                              |
| **Security property verified**  | A hung or slow provider build cannot delay process exit, cannot resurrect a disposed cell, and cannot deliver a provider to a caller whose call was superseded by disposal. A provider already delivered **before** disposal is not retroactively revoked                                                                                                                                                                                                                                                                                                  |
| **External network**            | **No**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Fake transport allowed**      | Not used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Process-level egress denial** | Not required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Owner**                       | M4.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

| Field                           | **T-23**                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                     | Prove `getProvider()` after disposal rejects with the exact disposed-state error and starts nothing                                                                                                                                                                                                                                                                                                                                                      |
| **Precondition**                | A disposed runtime; an injected `createProvider` that records invocations; a `createTransport` seam that records invocations                                                                                                                                                                                                                                                                                                                             |
| **Input**                       | Call `getProvider()` after `dispose()`, twice                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Expected**                    | Each call rejects with `RuntimeDisposedError`; `error.kind === 'disposed'`; `instanceof RuntimeDisposedError` is true; `instanceof LlmError` is **false**; `error.name === 'RuntimeDisposedError'`; each call gets a **distinct** error instance; `createProvider` was invoked **0** times; the transport seam was invoked **0** times; the message contains no credential. Identification is by `kind` and class, never by message text (Section 6.1.1) |
| **Security property verified**  | A post-shutdown caller cannot trigger credential use, module loading, or provider construction                                                                                                                                                                                                                                                                                                                                                           |
| **External network**            | **No**                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Fake transport allowed**      | Not used                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Process-level egress denial** | Not required                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Owner**                       | M4.4                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**What these tests deliberately do not assert.** They do not assert on private field
names or on the `ProviderCell` type itself, which is not exported. Observable
behaviour — invocation counts, promise identity, resolution values, error identity,
and whether a provider was published — is what the assertions read, so an
implementation may restructure the cell internally without breaking them.

**Registration impact.** Four new Phase 4 tests. The in-scope total moves from 25 to
**29** (6 + 5 + 4 + 14) and the registered total from 27 to **31**. No existing test
ID is renamed, reassigned, or removed; T-10a, T-11e, T-16c, T-17 and T-18 keep their
current owners and statuses.

### 9.1 Why T-10a moved to Phase 4

T-10a used to be scheduled in Phase 2, which was impossible: it constructs the
Gemini provider, and that adapter does not exist until Phase 4, so the test would
fail on the dynamic import. It moved to Phase 4 and is satisfied with an injected
recording transport (Section 9.5): the adapter is given a transport double that
records calls, and the assertion is that the recording is empty after construction
and that `complete()` used the double.

The test itself makes no real Gemini call and opens no socket, because it only ever
talks to the double. That is a property of the test. Whether the adapter _can_ be
held to that path in all cases depends on the Phase 4 blocking verification in
Section 9.5.2, which is why T-10a also carries network-isolation and
dependency-closure evidence (Section 9.5.3). All three evidence kinds are required;
none is a substitute for another.

T-12 and T-15 are a different case — they are deferred entirely, not rescheduled.
See Section 9.6.

### 9.2 T-09/T-09a are a pair

T-09 proves the factory rejects a missing key; T-09a proves the env schema does
**not**. Without both, a regression could silently move the check back to startup
and only one test would notice.

#### 9.2.1 T-09 — a failed credential check must not resolve the transport

Scenario: `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` unset, a `createTransport` callback
supplied that counts its own invocations, and `createProvider()` called.

All four assertions are required. A test that checks only the error is incomplete.

| #   | Assertion                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `createProvider()` rejects with `LlmConfigurationError` naming `GEMINI_API_KEY` — the variable, never a value |
| 2   | `createTransport` was called **0** times                                                                      |
| 3   | `gemini.transport.ts` was **not** dynamically imported (module registry / import spy)                         |
| 4   | No network request was issued                                                                                 |

**Why 2–4 are not optional.** The credential error alone does not prove ordering. A
factory could validate the credential _after_ resolving the transport and still throw
the same error, in which case a real transport would already have been constructed —
and a transport module already loaded — before the failure. Assertions 2–4 pin the
ordering that Section 5.2 specifies: credential validation is stage 4, transport
resolution is stage 6. Only assertion 2 makes that ordering observable; 3 and 4 catch
the case where the callback is skipped but the module was still loaded eagerly.

**Anti-vacuity.** Assertion 2 must observe an instrumented callback that _would_
have been called had the ordering been wrong. A test that passes no callback at all
would make assertion 2 vacuous, because a missing seam also yields zero calls. The
callback is therefore supplied in every run, and the counter is the evidence.

#### 9.2.2 T-07 — the fake provider must never invoke the transport callback

Scenario: `LLM_PROVIDER=fake`, a `createTransport` callback supplied that counts its
own invocations, and `createProvider()` called.

| #   | Assertion                                                        |
| --- | ---------------------------------------------------------------- |
| 1   | `createProvider()` resolves with a `FakeProvider`                |
| 2   | The callback was called **0** times, even though it was supplied |
| 3   | `gemini.transport.ts` was not loaded                             |
| 4   | No Gemini vendor SDK was loaded                                  |

**Why supply a callback that must not run.** Passing the callback is what makes the
assertion meaningful: the fake path must ignore it rather than being untested because
it was never given one. This mirrors T-09's anti-vacuity rule — in both cases the
seam is present and the counter, not its absence, is the evidence.

Assertions 3 and 4 also close the gap left by "no network request": a fake could in
principle load the transport module without calling it, and assertion 2 alone would
still read zero. Loading is checked separately from calling.

### 9.3 T-11a..T-11d cover three paths in Phase 3; T-11e joins them in Phase 4

#### 9.3.1 Authoritative T-11 definitions

This table is the single source of truth for what T-11a..T-11e mean. Any summary
that assigns different subjects to these identifiers is wrong and must be corrected
against this section.

| T-ID  | Definition                    | Phase                  | Test file                                  |
| ----- | ----------------------------- | ---------------------- | ------------------------------------------ |
| T-11a | `extract.ts --help` isolation | Phase 3                | `tests/integration/cli/cli-safety.test.ts` |
| T-11b | `ingest.ts --help` isolation  | Phase 3                | `tests/integration/cli/cli-safety.test.ts` |
| T-11c | Extraction dry-run isolation  | Phase 3                | `tests/integration/cli/dry-run.test.ts`    |
| T-11d | Ingestion dry-run isolation   | Phase 3                | `tests/integration/cli/dry-run.test.ts`    |
| T-11e | Server startup without key    | **Phase 4 — deferred** | `tests/integration/runtime.test.ts`        |

T-11a..T-11d are isolation tests over existing entry points. None of them exercises
a vendor adapter, because no adapter exists in Phase 3.

#### 9.3.2 What the T-11 identifiers do **not** cover

Four distinct concerns are sometimes wrongly folded into T-11a..T-11e. They keep
their own identifiers and their own phases:

| Concern                                                   | Correct identifier                                                  | Phase   |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| Network-isolation proof for the adapter's single egress   | **T-10a**                                                           | Phase 4 |
| Gemini request mapping (`LlmRequest` → vendor request)    | Phase 4 adapter work; T-16b/T-16c cover its `maxOutputTokens` layer | Phase 4 |
| Gemini response mapping (vendor response → `LlmResponse`) | Phase 4 adapter work; T-17 covers truncation                        | Phase 4 |
| Gemini error mapping (vendor failure → `LlmError` kind)   | Phase 4 adapter work; T-13 covers timeout                           | Phase 4 |

Two rules follow, and they are not negotiable:

- **Network isolation is T-10a, never T-11e.** T-11e asserts only that
  `createRuntime()` starts with `GEMINI_API_KEY` unset and eagerly builds no
  provider and loads no transport (`getProvider()` never called, callback never
  invoked, module absent from the registry). "No SDK loaded" is a forward-looking
  guard only, since no SDK is installed (§9.0a.1). T-11e says nothing about
  proving a single egress.
- **Request, response and error mapping belong to Phase 4.** They are not
  re-labelled as T-11a..T-11d, and they are not pulled into Phase 3.

Section 5.4 lists three execution paths and five scenarios: `--help` and dry-run
are each tested once per CLI, server startup once. Splitting by CLI matters
because a static import added to one entry point's argument parser would break
only that CLI's help path, and a single combined test would hide it.

Four of the five scenarios are Phase 3:

| Test  | Path     | Subject                                                           |
| ----- | -------- | ----------------------------------------------------------------- |
| T-11a | `--help` | `extract.ts` — no environment configuration is loaded             |
| T-11b | `--help` | `ingest.ts` — no environment configuration is loaded              |
| T-11c | Dry-run  | extraction preview — no provider, no `createProvider`, no network |
| T-11d | Dry-run  | ingestion preview — no provider, no `createProvider`, no network  |

The fifth, T-11e, is deferred to Phase 4 (Section 9.6a). It is the only scenario
whose subject does not exist yet: before the runtime gains LLM composition, there
is no wiring that could eagerly build a provider, so the assertion could not fail.

**What each pair must prove, and how.**

T-11a and T-11b assert that help is answered _before_ environment configuration
exists. This is a stronger claim than "help prints usage": the test must establish
that `env.ts` is not evaluated at all. Because the test runner's own modules are
already loaded, this is only observable from a child process, and the existing
`cli-safety.test.ts` already runs the real entry points that way. The mechanism is
to supply an environment that would fail validation and assert help still succeeds
with no configuration error — a direct, non-vacuous signal that `loadEnv()` never
ran. That test file is the home for T-11a and T-11b.

T-11c and T-11d assert that the **production** dry-run path, with
`GEMINI_API_KEY` unset, builds no provider, does not invoke `createProvider`, makes
no network request, and does not fail for want of a key. The dry-run legitimately
evaluates `env.ts` to resolve `DATABASE_PATH` (Section 5.4), so the test must not
claim the key is never parsed. It must instead show the key is never _consumed_.
Critically, the test must exercise the production path — the one where
`databasePath` is not injected — because injecting `databasePath` short-circuits
the `env.ts` import and would make the test pass without touching the code path it
claims to cover. `dry-run.test.ts` is the home for T-11c and T-11d, but its
existing cases inject `databasePath`, so the new cases must use the real entry
point rather than those helpers.

If an assertion cannot be established without changing production source, that
limitation is reported rather than papered over by weakening the test. If it cannot
be established without extending the existing fixture, that is recorded explicitly in
the Phase 3 allowlist (Section 10.0) rather than added silently.

### 9.4 T-16 is three assertions, not one

`maxOutputTokens` crosses three layers, and each can fail independently. A single
end-to-end assertion would hide which layer broke, so T-16 is specified as three
assertions:

| #     | Layer             | What is asserted                                                                                                   | How                                                                                         |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| T-16a | Environment       | `LLM_MAX_OUTPUT_TOKENS` parses to the documented integer; the default is `2048`; out-of-range values are rejected  | `loadEnv()` against a prepared env object. No provider, no network                          |
| T-16b | Composition layer | The env value is copied verbatim into `LlmRequest.maxOutputTokens`; an explicit caller value wins over the default | Build a request from the env object and inspect the field                                   |
| T-16c | Adapter           | `request.maxOutputTokens` lands on `generationConfig.maxOutputTokens` unchanged                                    | Gemini adapter driven by the injected stub transport; inspect the recorded outgoing payload |

The boundaries matter: T-16a proves the setting is validated, T-16b proves it is
not silently dropped or defaulted twice, and T-16c proves the adapter does not
clamp it. Any one of the three failing is a distinct defect, and the failure
message names the layer.

These are unit tests. None of them constructs a real provider or contacts a
vendor; T-16c uses the same stub transport as T-10a (Section 9.5).

### 9.5 How T-10a injects its stub transport

The Gemini adapter must accept its HTTP transport as a constructor argument rather
than reaching for a global `fetch`. That single design choice is what makes both
T-10a and T-16c testable without a network.

```ts
export interface GeminiTransport {
  send(
    url: string,
    init: {
      readonly body: string;
      readonly headers: Record<string, string>;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly status: number; readonly body: string }>;
}

export interface GeminiProviderDeps {
  /** The one transport this adapter may use. Required — see Section 9.5.4. */
  readonly transport: GeminiTransport;
}
```

#### 9.5.1 Single egress principle

`GeminiTransport.send()` is the **only** permitted external network egress for the
Gemini adapter. Every Gemini API HTTP request must go through the injected
transport:

- the normal completion request;
- any later API request the adapter adds (token counting, model listing, a second
  endpoint);
- any HTTP request issued while retrying, including a retry driven by the caller,
  because the retry re-enters `complete()` and therefore the same transport.

This principle is enforced structurally, not by convention. The adapter layer
(Section 9.5.3.2) may not reference the global `fetch`, may not import
`node:http`, `node:https`, `node:net`, `node:tls`, `undici`, `http2`, `dns` or
`node:dgram`, and may not construct any HTTP client. Real socket I/O happens in
exactly one module, the default transport, which the adapter receives as a value
rather than importing.

A second egress path is a design defect, not a testing inconvenience: it would mean
T-10a and T-16c can pass while real network traffic still escapes during the suite.
There is no configuration in which a weaker guarantee is accepted (Section 9.5.2).

#### 9.5.2 SDK usage is not yet decided — Phase 4 blocking verification

This document does **not** specify a Google SDK, and it does not assert that any
particular SDK supports injecting a custom HTTP transport. Nothing here should be
read as a verified SDK capability.

What Phase 4 must settle **before** any adapter code is written:

| #   | Question                                                                                                                                                         | Why it blocks                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Which Gemini integration is used — the official Google SDK, or a direct implementation of the documented Gemini HTTP API?                                        | Determines whether injection is even possible                       |
| 2   | If an SDK is used, does its **official documentation** describe a supported way to supply a custom HTTP transport?                                               | If not, the SDK cannot be used at all (rule S-2)                    |
| 3   | If it does, at which exact constructor or client option is the transport supplied, in which SDK version?                                                         | Without a verified injection point, `GeminiTransport` is decorative |
| 4   | Does the documentation confirm that **all** HTTP requests the SDK makes go through that one transport — including retries, streaming and any auxiliary endpoint? | A partially injectable SDK is not injectable                        |

These questions are answered from the vendor's own documentation. Supplying a
`fetch` or `client` parameter is **not** by itself evidence that every request goes
through it, so question 4 is the one that decides the outcome.

**Decision rules — there are exactly three outcomes, and no fourth.**

| Rule | Condition                                                                                      | Required action                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1  | The SDK's documentation proves a single injectable transport carries **all** its HTTP requests | The SDK may be used. Record the documentation source, the SDK version and the exact injection point                                                                                                      |
| S-2  | The documentation does not prove that, or no injection point exists                            | The SDK is **not** used as the transport layer. Implement the adapter directly against the documented Gemini HTTP API, with every request executed by `GeminiTransport.send()` and no second HTTP client |
| S-3  | Even the direct HTTP API implementation cannot be shown to have a single egress                | **Phase 4 stops.** T-10a is not marked passing, no network-isolation claim is made, and the blocking reason is recorded for redesign and explicit re-authorisation                                       |

There is no "accept a weaker guarantee" outcome. A weaker guarantee means the
single-egress principle does not hold, and a design whose central safety property
does not hold is not deliverable. S-3 exists precisely so that this case ends in a
stop rather than a quiet downgrade.

Until questions 1–4 are answered against the vendor's actual documentation, this
milestone **does not claim** that the recording double makes the network
unreachable. The honest current status is: the interface is designed, the SDK
decision is open, and the isolation guarantee is unproven.

Recording requirements for S-1 and S-2 (both are design-review inputs, not
afterthoughts):

- the documentation URL and the SDK version the claim was verified against;
- the exact injection point, quoted from that documentation;
- a statement of which request types were confirmed to traverse it;
- for S-2, the HTTP API reference the adapter is written against.

#### 9.5.3 What T-10a must prove

T-10a keeps its five goals and gains a precise definition of what each one
covers. The five assertions split into three kinds of evidence, and **all three
must pass** for T-10a to pass:

| #   | Assertion                                                        | Evidence kind       |
| --- | ---------------------------------------------------------------- | ------------------- |
| 1   | Constructing `GeminiProvider` issues no network request          | Runtime             |
| 2   | After construction, `calls.length === 0`                         | Runtime             |
| 3   | After `complete()`, the expected HTTP request appears in `calls` | Runtime             |
| 4   | No real Gemini API call is made and no external socket is opened | Network isolation   |
| 5   | No network path exists outside the transport boundary            | Static architecture |

Assertion 5 has **two parts, both required**: the adapter closure (9.5.3.1) and the
production composition path (9.5.3.3a). Part A alone would miss a second transport
obtained through the composition root; part B alone would miss a helper inside the
adapter that opens its own socket.

Assertions 1–3 alone only describe what the recording double saw. They cannot, by
themselves, prove that nothing else opened a socket, because a second egress path
would simply never appear in `calls`. Assertion 4 supplies that proof at the
process level, and assertion 5 supplies it at the source level. Dropping any one of
the three evidence kinds makes T-10a vacuous, so none is optional.

#### 9.5.3.1 The dependency closure

Assertion 5 must not scan only `gemini.provider.ts`. A helper imported by the
adapter could use `fetch` internally and a single-file scan would miss it. The scan
therefore operates on the adapter's **production dependency closure**:

**Definition.** The closure is the set of local modules reachable from
`providers/gemini.provider.ts` by following **static, value-level** `import` and
`require` edges, transitively, restricted to modules inside `src/`, and **stopping
at the transport boundary** (Section 9.5.3.2).

Tracking rules:

1. **Static edges only, followed transitively.** Start at the adapter entry file.
   For each module in the set, parse its import specifiers, resolve relative
   specifiers to files under `src/`, and add each resolved local module. Repeat
   until no new module is added. The scan is a fixpoint over the import graph, not a
   directory listing.
2. **Package imports are recorded, not expanded.** A bare specifier such as
   `@google/genai` is an external dependency. Its source is not walked, but its
   presence in the closure is recorded and reported, because it is exactly the case
   where an SDK could carry its own egress.
3. **Type-only imports are excluded from the closure.** `import type` edges carry
   no runtime code and cannot open a socket. They are ignored for egress purposes
   but still recorded in the report.
4. **Dynamic `import()` is a failure, not a traversal.** A dynamic specifier cannot
   be resolved statically, so a dynamic import of a local module inside the closure
   **fails** assertion 5 rather than being silently skipped. This closes the
   "hide the helper behind `await import()`" hole. A dynamic import of a bare
   package specifier is also a failure, for the same reason.
5. **`require()` and `createRequire` are treated as import edges.** They are
   resolved by the same rules. An unresolvable `require` inside the closure fails
   the scan.
6. **Re-exports are edges.** `export ... from './x'` is traversed exactly like an
   import, because it makes `./x` part of the runtime closure.

#### 9.5.3.2 The transport boundary

The closure is split at exactly one boundary, and the split is by **file**, not by
directory exemption:

| Layer                   | File                                                                                        | May open a socket? | Responsibility                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Adapter layer           | `providers/gemini.provider.ts` and every module in its closure except the default transport | **No**             | Request mapping, response mapping, error mapping. Calls `GeminiTransport.send()` only |
| Default transport layer | `providers/gemini.transport.ts`                                                             | **Yes**            | The only place that performs real HTTP I/O. Implements `GeminiTransport.send()`       |

The boundary is a single named file, so "which module is allowed to touch the
network" has one answer and no ambiguity. There is no rule of the form "scan the
directory but exempt this file"; the scan is defined over the closure minus that one
named module.

Rules for each side:

- **Adapter layer.** May not reference the global `fetch`; may not import
  `node:http`, `node:https`, `node:net`, `node:tls`, or `undici`; may not construct
  any HTTP client. It reaches the network **only** by calling the `GeminiTransport`
  it was given.
- **Default transport layer.** May import the Node networking modules it needs.
  It is the sole implementation of `GeminiTransport` used in production. It is
  **not** in the adapter's import closure by static edge — the adapter receives it
  as a constructor value — so it cannot be reached from the adapter except through
  the injected interface.
- **`undici` is confined to the default transport layer.** The adapter closure may
  not import `undici` at all. It is permitted only inside `gemini.transport.ts`,
  because that is the one module allowed to perform HTTP I/O. If Phase 4 chooses
  `undici` as the transport's HTTP library, the allow-list records that decision and
  the module that may use it — never the adapter or a helper it loads.
- **Test replacement point.** Tests pass a recording double in place of the default
  transport through the same constructor parameter. The default transport module is
  never imported by the test's provider construction, so its networking code cannot
  run during the test.

Because the default transport is supplied as a value rather than imported by the
adapter, the closure scan never needs an exemption: the networking module is simply
outside the closure.

#### 9.5.3.3 What the static scan checks, and what it cannot prove

The scan reports, for every module in the adapter closure:

- any import of `node:http`, `node:https`, `node:net`, `node:tls`, `undici`,
  `http2`, `dns`, or `node:dgram`;
- any reference to the global `fetch`, `XMLHttpRequest`, or `WebSocket`;
- any dynamic `import()` or unresolvable `require`;
- any bare package specifier, listed for review.

A **failure** is: a networking import or global in the adapter layer, a dynamic
import, an unresolvable `require`, or a bare package specifier that is not on an
explicit allow-list recorded at Phase 4.

The scan's limits must be stated plainly, and are part of the design:

1. **It is a source-text and import-graph analysis, not a proof.** It cannot see
   through code that computes a module name at runtime, and it does not model
   transitive networking inside a third-party package. It is strong evidence, not a
   mathematical guarantee.
2. **It cannot inspect the internals of a vendor SDK.** If a bare specifier such as
   an official SDK appears in the closure, the scan can only record that fact. It
   cannot prove the SDK's own transport is injected. That question is answered by
   the documentation review in Section 9.5.2, not by this scan.
3. **It does not run the code.** Assertion 5 is static; assertions 1–4 are what
   observe runtime behaviour.

Because of limit 2, assertion 5 alone is insufficient whenever the adapter depends
on a vendor SDK. In that case the SDK must first pass the injection verification in
Section 9.5.2, and the allow-list entry must name the verified injection point. If
that verification fails, Section 9.5.2's decision rules apply — the SDK is not used.

#### 9.5.3.3a The production composition path scan (assertion 5, part B)

The adapter closure (9.5.3.1) proves only that the adapter and its helpers open no
socket. It says nothing about the code that _builds_ the adapter. A composition
root could construct a second HTTP client, or build a transport that is not the
designated one, and the adapter closure would stay green. Assertion 5 therefore has
a second, independent part.

**Scope.** The scan walks the production composition path — the modules that
construct and wire the Gemini provider:

1. `src/runtime.ts` — the composition root (Section 9.5.5);
2. `provider.factory.ts` — `createProvider`;
3. `providers/gemini.transport.ts` — the designated transport;
4. any local module imported by 1–3 (transitive, same static-edge rules as
   9.5.3.1).

**What it must verify.**

| #   | Property                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Exactly one module constructs a `GeminiTransport` implementation: `gemini.transport.ts`                    |
| 2   | No second Gemini HTTP client is constructed anywhere on this path                                          |
| 3   | Neither the composition root nor the factory opens a socket or issues a request itself                     |
| 4   | The transport value passed to `createProvider` is the one built by the designated module, not a second one |
| 5   | The wiring is visible as an explicit value flow — build, pass, inject — not an ambient lookup              |

**How properties 4 and 5 are checked.** This part is not a pure text search. The
scan must follow the value: it locates the `createProvider(...)` call in the
composition root, resolves the body of the `deps.createTransport` callback, and
confirms that the factory that body calls resolves to `gemini.transport.ts`.

Because the callback loads its module lazily (Section 9.5.5.1), the scan looks
**inside the callback body**, not at the file's import list. A callback whose body
calls a factory from any other module — or a `gemini` build with no callback at all —
fails the check. This is what distinguishes "the transport exists" from "the
designated transport is the one injected", and it is why the lazy form does not
weaken the scan: the literal specifier inside the callback is still statically
resolvable, and a non-literal specifier there fails.

Two expectations apply specifically to `runtime.ts`, and the scan enforces both:

- it must contain **no** static import of `gemini.transport.ts` (Section 9.5.5.1,
  requirement 1);
- the only reference to that module must be the literal specifier inside the
  callback body.

**What this part cannot prove.**

- It cannot prove that the _designated_ transport module's internal HTTP library
  makes no second connection of its own. That is a property of the library, covered
  by the SDK/HTTP-API verification in Section 9.5.2 and by runtime isolation
  (9.5.3.6).
- It cannot follow a transport obtained through reflection, a getter with a hidden
  branch, or a runtime-computed module name. Those are treated as failures, not
  passes (same rule as 9.5.3.1 rule 4).
- It does not execute the path, so it cannot observe a request that only happens at
  runtime. That is assertion 4's job.

**Scope of the claim.** Taken together, 9.5.3.1 and 9.5.3.3a support a bounded
statement: _no source-level network egress and no second transport construction
exist on the specified production path, as far as static import and value-flow
analysis can determine._ That is deliberately weaker than "the whole Gemini system
has exactly one egress". The stronger claim additionally requires runtime evidence
(9.5.3.6) and, if a vendor SDK is used, the documentation verification (9.5.2). The
document never asserts the stronger claim on static evidence alone.

#### 9.5.3.4 Why the scan is written this way

The alternative — scanning the whole `providers/` directory and exempting the
transport file — would let a future helper inside that directory open its own
socket while the scan stayed green. Defining the unit of analysis as the **closure
of what the adapter actually loads** means a new helper is automatically in scope
the moment it is imported, and a dynamic import fails loudly instead of escaping.

#### 9.5.3.5 Interaction with the SDK decision

Assertion 5's allow-list cannot be finalised until Section 9.5.2 is resolved,
because the answer decides whether a bare SDK specifier appears in the closure at
all. That is why 9.5.2 is a blocking condition (Section 11.2) rather than a note.

#### 9.5.3.6 Network isolation evidence (assertion 4)

Assertions 2 and 3 inspect only the recording double. `calls.length === 0` proves
the double saw nothing; it cannot prove no other code opened a socket. Assertion 4
therefore needs an independent mechanism, not a `toHaveLength` check.

Three mechanisms exist. They are **not** interchangeable, and the difference matters
because a partial interception that is described as complete is worse than no
interception at all.

| Option | Mechanism                                                                            | Rank                |
| ------ | ------------------------------------------------------------------------------------ | ------------------- |
| N-1    | Process-level outbound network denial (CI network policy, or an egress-less sandbox) | 1 (preferred)       |
| N-2    | Node-runtime interception of the networking surface, proven complete (below)         | 2 (conditional)     |
| N-3    | Assert the designated transport module was never loaded (module registry spy)        | 3 (supporting only) |

**N-1** is the strongest evidence because it does not depend on the code under test
or on hooking the same runtime. If the process cannot reach the network, no library,
SDK, subprocess or native addon can either. When N-1 is available it is the evidence
of record for assertion 4.

**N-3** is never sufficient on its own: it proves the _known_ egress was unused, not
that no other exists. It may be recorded as supporting evidence only.

**N-2** is the hard case. Monkey-patching Node modules is only as complete as the
surface it covers, and a vendor SDK can reach the network through a path the patch
misses. N-2 therefore has a mandatory coverage table, and it may be cited for
assertion 4 **only if every row is either intercepted-and-verified or explicitly
declared uncovered with a compensating control**. If any row is "cannot intercept"
and has no compensating control, N-2 does not meet the bar and assertion 4 is
BLOCKED.

##### N-2 coverage table

| Surface                            | Interceptable? | How                                                                     | Known limits                                                                                                            |
| ---------------------------------- | -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `node:http`                        | Yes            | Replace `request`/`get`, or hook `Agent`/`ClientRequest`                | Missed if code captured a reference before the patch, or bypasses `ClientRequest`                                       |
| `node:https`                       | Yes            | Same as `http`, plus `tls` below                                        | Same as `http`                                                                                                          |
| `node:net`                         | Yes            | Patch `Socket.prototype.connect` / `createConnection`                   | A raw `net.Socket` written to by hand is still a socket; the patch must cover `connect`, not just `createConnection`    |
| `node:tls`                         | Yes            | Patch `connect` / `TLSSocket`                                           | Same reference-capture limit as `net`                                                                                   |
| `node:http2`                       | Yes            | Patch `connect`                                                         | Easy to overlook because it is a separate module                                                                        |
| `undici` (module)                  | Yes            | Patch `undici.request`, `undici.fetch`, and the `Agent`/`Pool` dispatch | A private `Agent` instance created by an SDK still funnels through the patched dispatch _if_ patched at dispatch level  |
| Global `fetch`                     | Yes            | It is `undici`'s fetch; patching `undici` dispatch covers it            | If Node ships a different `fetch` implementation in a future major, this row must be re-verified                        |
| SDK-internal HTTP transport        | **Depends**    | Only if the SDK routes through one of the above                         | **Unprovable by patching.** Must be settled by documentation verification (Section 9.5.2); otherwise treat as uncovered |
| Subprocess / `child_process`       | Partially      | Patch `spawn`/`exec`/`fork`, or forbid them in the test sandbox         | A child process has its own runtime; patching the parent does not constrain it. **Requires N-1 or a sandbox rule**      |
| Worker threads                     | Partially      | Patch `Worker` construction, or forbid them                             | A worker has its own isolate; the parent's patches do not apply inside it. **Requires N-1 or a sandbox rule**           |
| Native addon / non-Node networking | **No**         | Not interceptable from JavaScript                                       | A native addon can open sockets directly. **Only N-1 covers this.** Must be declared uncovered if N-1 is unavailable    |

Direct answers to the questions this table exists to settle:

- **Can monkey-patching be bypassed by an SDK or package?** Yes. Reference capture,
  a private client instance, or a different module entry can all escape a
  patch. Patching is a strong in-process signal, not a proof.
- **Can an SDK use a native or other runtime transport that the patch misses?** Yes,
  and JavaScript cannot see it. Only N-1 rules this out.
- **Does `undici` interception cover global `fetch` and SDK-private instances?** It
  covers global `fetch` because that is `undici`'s fetch. It covers an SDK's private
  `Agent` **only if** the patch is applied at the dispatch level rather than to the
  exported convenience functions. This must be verified, not assumed.
- **Do subprocesses and workers need separate restriction?** Yes. They have their
  own runtime and are not constrained by parent-process patches. N-1 covers them;
  N-2 alone does not.
- **How is it confirmed that the recording transport is the only egress?** Only by
  N-1, or by N-2 with every row above either verified or declared uncovered _and_
  compensated. Otherwise it is not confirmed, and assertion 4 says so.

##### Decision rule for assertion 4

1. N-1 is preferred and, when present, is sufficient.
2. N-2 may substitute **only** when its coverage table is fully accounted for: every
   row intercepted-and-verified, or explicitly declared uncovered with a
   compensating control that closes the gap.
3. If N-2's coverage cannot be shown to include the SDK's actual network path, it is
   **not** equivalent to N-1 and may not be cited for assertion 4.
4. N-3 alone is never sufficient.
5. If N-1 is unavailable and N-2 cannot be shown complete, assertion 4 is
   **BLOCKED**. T-10a is not marked passing, the standard is not lowered, and the
   gap is recorded as Phase 4 blocking condition B-6 (Section 11.2).

Practical note: N-1 is preferred where the CI runner supports it, since it does not
depend on hooking the same runtime the code uses. N-2 is the fallback for local and
single-process runs, and only under the conditions above. Whichever is used is named
in the T-10a test file, together with the coverage table result, so the evidence is
auditable rather than asserted.

#### 9.5.4 One injection path, shared by production and tests

There is exactly **one** way a `GeminiTransport` reaches the adapter: a required
constructor argument. Production and tests use the same path; only the value
differs.

`GeminiProviderDeps.transport` is **required**, not optional:

```ts
export interface GeminiProviderDeps {
  /** The one transport this adapter may use. Supplied by the caller. */
  readonly transport: GeminiTransport;
}
```

The adapter's configuration type **excludes the credential**. Section 11.1.4
forbids `GeminiProvider` from ever receiving the key, and `LlmProviderConfig`
carries `apiKey: string | undefined`. Passing the factory's config object straight
into the adapter would therefore hand it the key. The adapter takes a narrowed
type instead:

```ts
export type GeminiProviderConfig = Omit<LlmProviderConfig, 'apiKey'>;
```

`GeminiProviderConfig` keeps `provider`, `model` and `timeoutMs` and drops
`apiKey`. The constructor is two arguments, not a merged object:

```ts
// `config` here is a GeminiProviderConfig — a fresh object with no `apiKey`.
// It is never the factory's LlmProviderConfig (§11.3.2).
new GeminiProvider(config, { transport }); // config: GeminiProviderConfig
```

**Compile-time restriction is necessary but not sufficient.** `Omit<…>` is a
type-level operation only. TypeScript is structurally typed, so an
`LlmProviderConfig` value is assignable to `GeminiProviderConfig`: the extra
`apiKey` property is neither rejected nor removed. A factory that passed its own
`config` object through would compile cleanly while the adapter's stored
`this.config` still held the live key. The exclusion must therefore hold at
**two** levels, and both are required:

| Level        | What it guarantees                                             | Enforced by                                            |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------ |
| Compile time | The adapter has no typed way to _read_ an `apiKey` field       | `GeminiProviderConfig = Omit<…, 'apiKey'>`             |
| Runtime      | The object the adapter holds _contains no key property at all_ | the factory building a fresh narrowed object (§11.3.2) |

Neither level alone is sufficient. Type restriction without runtime isolation
leaves the secret in the adapter's object graph; runtime isolation without type
restriction would leave an adapter free to ask for the key later.

**The factory must build a new object.** Section 11.3.2 specifies the exact form:
a fresh object literal that names `provider`, `model` and `timeoutMs` explicitly.
The following are prohibited, because each carries `apiKey` through at runtime:

- passing the original `LlmProviderConfig` to `GeminiProvider`;
- passing any object that still carries an `apiKey` property, including one whose
  parameter type happens to be `GeminiProviderConfig`;
- `{ ...config }`, or any other spread of the full factory config, as a substitute
  for explicit field selection — a spread copies `apiKey`, and only the annotation
  would hide it;
- relying on `Omit` alone, or on a type assertion such as
  `config as GeminiProviderConfig`, to stand in for runtime removal.

A type assertion is explicitly **not** an acceptable implementation. It silences
the compiler without changing the value. The object handed to the constructor must
be one whose properties the factory enumerated, not the factory's own config
object.

An optional dependency would let the adapter fall back to importing or building a
transport of its own, which is exactly the second egress path this design forbids.
Making it required removes that possibility at the type level rather than by
convention.

| Concern                    | Production                                       | Test                                     |
| -------------------------- | ------------------------------------------------ | ---------------------------------------- |
| Which transport is used    | The production transport (`gemini.transport.ts`) | A recording double                       |
| Who supplies the callback  | The composition root (Section 9.5.5)             | The test file                            |
| Who invokes the callback   | `createProvider`, gemini branch only             | `createProvider`, gemini branch only     |
| Who creates the transport  | `gemini.transport.ts`, called from the callback  | The test file                            |
| How it reaches the adapter | `GeminiProviderDeps.transport`, required         | `GeminiProviderDeps.transport`, required |
| Who may open a socket      | Only `gemini.transport.ts`                       | Nobody — the double opens none           |
| `LlmProviderConfig`        | No transport field                               | No transport field                       |
| `FakeProvider`             | Needs no transport at all                        | Needs no transport at all                |

The adapter never imports `gemini.transport.ts`, never constructs an HTTP client in
its constructor, and never reaches for a global singleton, service locator or
hidden factory. The transport it uses is the object it was handed, and nothing
else.

```ts
const calls: Array<{ url: string; body: string }> = [];
const transport: GeminiTransport = {
  send: async (url, init) => {
    calls.push({ url, body: init.body });
    return { status: 200, body: JSON.stringify(cannedEnvelope) };
  },
};

const adapterConfig: GeminiProviderConfig = {
  provider: 'gemini',
  model: 'default',
  timeoutMs: 30_000,
};
const provider = new GeminiProvider(adapterConfig, { transport });

expect(calls).toHaveLength(0); // T-10a assertion 2: construction sent nothing
await provider.complete(request);
expect(calls).toHaveLength(1); // T-10a assertion 3: the call used the double
```

That test snippet is not a test-only arrangement. Production builds the same call
with a different `transport` value, through the same `createProvider` path
(Section 9.5.5). There is no second constructor signature and no test-only branch
inside the adapter.

#### 9.5.5 Who provides, who calls, who creates

Three different actors are involved, and conflating them is what made the earlier
wording ambiguous. They are separated here once:

| Role                         | Actor                               | What it does                                                                                             |
| ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Provider of the callback** | `src/runtime.ts` (composition root) | Decides _that_ a transport source exists for this process, and supplies the callback to `createProvider` |
| **Caller of the callback**   | `provider.factory.ts`               | Invokes `deps.createTransport()` — and only on the `gemini` branch, after credential validation          |
| **Actual transport creator** | `providers/gemini.transport.ts`     | Owns the HTTP client and the real socket I/O. Its exported factory is what the callback body calls       |

`src/runtime.ts` **does not create the transport**. It provides a callback whose body
calls the factory exported by `gemini.transport.ts`. That distinction is not
pedantry: it is what keeps `runtime.ts` free of any HTTP client, and it is what makes
the lazy-loading guarantee below possible.

Responsibilities, stated as a closed list:

| Responsibility                                 | Owning module                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Supply the `createTransport` callback          | `src/runtime.ts` (composition root) — provider of the callback                 |
| Invoke the callback (gemini branch only)       | `provider.factory.ts` — `createProvider(config, deps)`                         |
| Select the adapter and validate the credential | `provider.factory.ts`                                                          |
| Load the transport module (lazily)             | the callback body in `src/runtime.ts`                                          |
| Construct the `GeminiTransport` implementation | `providers/gemini.transport.ts` — actual creator, only module opening a socket |
| Inject it into `GeminiProvider`                | `provider.factory.ts`, via the required `GeminiProviderDeps.transport`         |
| Map request/response/error                     | `providers/gemini.provider.ts` — opens nothing, calls `deps.transport.send()`  |

**`createProvider()` is not the composition root.** It is a factory that runs
inside it. The distinction matters because the two have different jobs:

- The **composition root** decides _that a transport source exists_ and supplies the
  callback. It does not import the transport module and does not construct a client.
- **`createProvider()`** decides _which adapter to build_, validates that adapter's
  credential, and invokes the callback on the `gemini` branch. It does not construct
  a transport itself; it awaits the one the callback returns.

`createProvider` gains exactly one new parameter — the transport callback seam — and
keeps its existing stages (Section 5.2) otherwise unchanged:

```ts
export interface LlmProviderDeps {
  /**
   * Resolves the transport for the selected adapter. The composition root supplies
   * the production implementation; tests supply a recording double.
   * Never called for the 'fake' provider.
   */
  readonly createTransport?: () => Promise<GeminiTransport>;
}

export function createProvider(
  config: LlmProviderConfig,
  deps: LlmProviderDeps = {},
): Promise<LlmProvider>;
```

Production call from the composition root. Note what is **not** here: no static
import of the transport module, and no client construction.

```ts
// src/runtime.ts — provides the callback; creates nothing itself
const provider = await createProvider(config, {
  createTransport: async () => {
    // Literal specifier, so it is statically analysable (Section 9.5.3.1 rule 4
    // does not apply to the composition root, but the literal keeps the scan
    // honest). Loaded only when this branch actually runs.
    const { createGeminiTransport } = await import('./core/llm/providers/gemini.transport.js');
    // `apiKey` is the credential the composition root already holds. The key is
    // injected rather than read inside the transport: Section 7.2 keeps
    // environment access in `env.ts`, and Section 11.1.4 keeps the key inside
    // the transport's send boundary. Stage 4 has already rejected a missing or
    // blank key, so no second credential check is performed here.
    return createGeminiTransport({ apiKey, timeoutMs });
  },
});
```

`createGeminiTransport` takes a single options object — `{ apiKey, timeoutMs? }` —
and returns a `GeminiTransport`. `apiKey` is required and is the only credential
the transport ever sees; `timeoutMs` is optional and, when present, is composed
with the caller's `AbortSignal` so a local deadline and a caller abort are
distinguishable. The factory performs no I/O itself: it captures the options and
opens a socket only when `send()` is called (Section 9.5.5.1 rule 6).

The snippet shows `apiKey` and `timeoutMs` as already-resolved locals rather than
re-deriving them from `config`, because how the runtime carries the validated
credential to this callback is settled with the lazy-initialisation wiring in
Section 11.1.8 (M4.4), not here. What this milestone fixes is only the factory's
signature: one options object, not a zero-argument call.

Test call — same seam, no module load at all:

```ts
const provider = await createProvider(config, {
  createTransport: async () => recordingTransport,
});
```

Both paths call the same factory with the same seam. The factory awaits the
callback and passes the resulting transport into the adapter constructor as the
required `GeminiProviderDeps.transport`. There is no branch that constructs a
transport when the seam is absent, because for `gemini` the seam is mandatory:
omitting it for `LLM_PROVIDER=gemini` throws `LlmConfigurationError` at the factory
call, the same way a missing key does (Section 5.2, stage 4). For `fake`, the seam
is never consulted, so `FakeProvider` stays free of any Gemini SDK or production
transport dependency.

This is why `GeminiProviderDeps.transport` is required while
`LlmProviderDeps.createTransport` is optional: the optionality is at the factory
boundary, where the `fake` path must not need it, and the requirement is at the
adapter boundary, where the transport must exist. The adapter itself never sees an
optional transport, so it has nothing to fall back to.

##### 9.5.5.1 No eager Gemini initialisation

`src/runtime.ts` must not cause Gemini initialisation for a process that never
builds a Gemini provider. Concretely, it must satisfy all of the following:

| #   | Requirement                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------- |
| 1   | No static `import` of `providers/gemini.transport.js` (or any vendor SDK) in `runtime.ts`                      |
| 2   | No `new`/factory call for a transport at module scope or at `createRuntime()` body scope                       |
| 3   | The transport module is loaded only inside the callback body, by literal-specifier dynamic `import()`          |
| 4   | `LLM_PROVIDER=fake` never invokes the callback, so the transport module is never loaded                        |
| 5   | A process that never calls `createProvider` at all (CLI `--help`, both dry-runs, server startup) loads nothing |
| 6   | The `gemini.transport.ts` module has no module-scope side effect that opens a socket or reads a key on import  |
| 7   | A `gemini` build that **fails credential validation** never invokes the callback and never loads the module    |

Requirement 7 is the ordering guarantee from Section 5.2: credential validation is
stage 4 and transport resolution is stage 6, so a missing key ends the call before
the callback is reached. It is asserted by T-09 (Section 9.2.1), not by a new T-ID.

Requirement 6 matters because lazy loading alone is not enough if merely importing
the transport module has side effects. The module must be inert at import: it
exports a factory and nothing more.

This is why the seam is `() => Promise<GeminiTransport>` rather than
`() => GeminiTransport`. With a synchronous seam the natural implementation is a
static import plus a direct call, which loads the module as soon as `runtime.ts` is
imported. The promise forces the load to happen inside the callback, after the
`gemini` branch has been chosen.

**What this does not change.** T-11e is the test that asserts `createRuntime()`
starts with `GEMINI_API_KEY` unset and eagerly builds no provider. These requirements
strengthen that test's basis rather than replacing it: T-11e now also implies no
transport module was loaded. No new T-ID is introduced — the guarantee is carried by
T-11e plus the static scan in Section 9.5.3.3a, which already requires that neither
the composition root nor the factory opens a socket or issues a request. T-11e is
implemented in Phase 4, because the runtime composition it guards is introduced
there (Section 9.6a).

**T-12 and T-15 are out of scope for this milestone.** The two consumer modules
do not exist yet, so a test that scans them could only pass vacuously. They are
deferred to the milestone that creates the modules; Section 9.6 records the
deferral and the conditions for picking them up.

### 9.6 Deferred tests: T-12 and T-15

I7-1b delivers the LLM transport. It does **not** deliver `modules/translation` or
`modules/summarisation`; both remain planned (Section 2). Two tests therefore
cannot run in this milestone and are deferred rather than scheduled against code
that does not exist.

| Test | Original intent                                  | Status   | Deferred to                                |
| ---- | ------------------------------------------------ | -------- | ------------------------------------------ |
| T-12 | Consumers import no vendor SDK                   | Deferred | The milestone that creates the two modules |
| T-15 | Provider is swappable without editing a consumer | Deferred | The same milestone                         |

Deferred count: **2**. In-scope count: **29**. Registered total: **31**.

Why defer instead of keeping them in I7-1b:

- A directory scan over a missing directory finds no vendor import and **passes**.
  That is a vacuous pass, and a vacuous pass is worse than an absent test because
  it reports green while proving nothing.
- An existence guard that fails when the modules are absent would make the I7-1b
  suite red for a reason unrelated to I7-1b. The suite must stay green at every
  phase boundary (Section 11).
- The property T-12 protects — "business modules never see a vendor" — only
  becomes meaningful once a business module exists to violate it.

Conditions for picking them up, recorded now so nothing is lost:

1. The pickup milestone must **first assert both directories exist** and contain at
   least one `.ts` file. A missing directory fails the test; it never passes.
2. Only then scan for vendor imports: `gemini`, `@google/`, `openai`, `anthropic`,
   `fetch`, `node:http`, `node:https`.
3. T-15 additionally asserts that substituting a second stub provider required
   editing no file under those two directories.
4. Written as source-text assertions in the same style as the existing
   `database-path-isolation` test, because the property is structural.

I7-1b acceptance therefore does **not** include T-12 or T-15 (Section 12), and
this document makes no claim that consumer independence has been demonstrated.
What I7-1b does provide is the interface and the fake that make those tests
writable the moment the consumers land.

### 9.6a Deferred within the milestone: T-11e

T-11e is not deferred out of I7-1b. It stays in scope, keeps its T-ID, and remains
an acceptance criterion — but its phase moves from 3 to 4.

**Why it moved.** T-11e asserts that `createRuntime()` starts with
`GEMINI_API_KEY` unset and eagerly constructs or loads no Gemini provider or
transport. In Phase 3 that assertion cannot fail: `src/runtime.ts` contains no LLM
reference at all, so there is no wiring through which a provider could be built. A
test that passes because the code it examines does not exist is a vacuous pass, and
Section 9.6 already records the position that a vacuous pass is worse than an
absent test.

**What it becomes in Phase 4.** Once `src/runtime.ts` supplies the
`createTransport` callback (Section 9.5.5), the runtime genuinely could build a
provider or load a transport eagerly. At that point T-11e has real teeth, and it
must assert:

1. `createRuntime()` succeeds with `GEMINI_API_KEY` unset.
2. No provider is constructed during startup.
3. `providers/gemini.transport.ts` is not loaded at startup — the callback body is
   not executed (Section 9.5.5.1, requirements 2, 3 and 5).
4. No vendor SDK is loaded at startup.

**What does not change.** T-11e keeps its T-ID and its matrix row; the in-scope
total remains 23 (Section 9, counts table). No other test's phase moves.

---

## 10. Proposed file list

New files, all under `src/core/llm/`:

| File                            | Purpose                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.types.ts`                  | `LlmRequest`, `LlmResponse`, `LlmUsage`, `LlmModelRef`                                                                                                                                                           |
| `llm.errors.ts`                 | `LlmError` + subclasses, the retryability table                                                                                                                                                                  |
| `llm.provider.ts`               | The `LlmProvider` interface                                                                                                                                                                                      |
| `fake.provider.ts`              | `FakeProvider` and its options                                                                                                                                                                                   |
| `provider.factory.ts`           | `createProvider(config)` — selects an adapter, no model table                                                                                                                                                    |
| `providers/gemini.provider.ts`  | First real adapter; owns its own logical-name → vendor-id map. **Opens no socket**                                                                                                                               |
| `providers/gemini.transport.ts` | **Phase 2:** declares the type-only `GeminiTransport` interface (no imports, no factory, no side effect). **Phase 4:** the same file gains the only implementation that performs real HTTP I/O (Section 9.5.3.2) |

`gemini.transport.ts` is not an extra abstraction layer: it is the single
implementation of the `GeminiTransport` interface that already exists in Section
9.5. Splitting it into its own file is what makes the transport boundary (Section
9.5.3.2) a concrete, checkable fact rather than a convention:

- **Sole responsibility:** perform the HTTP request and return `{ status, body }`.
  No request mapping, no response mapping, no error classification — those stay in
  the adapter.
- **The adapter calls it only through `GeminiTransport`.** The adapter receives the
  transport as a constructor value and never imports this file, so the module is
  outside the adapter's dependency closure and needs no scan exemption.
- **Tests replace it** by passing a recording double through the same constructor
  parameter; this module is never loaded during those tests.
- **No duplicate interface.** It implements the one `GeminiTransport` interface
  defined in Section 9.5. There is no second transport type.

Modified files:

| File                                       | Phase | Change                                                                                                                                                      |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                        | 2     | Add the five variables; `GEMINI_API_KEY` optional. **No `superRefine`, no cross-field credential rule**                                                     |
| `tests/unit/config/env.test.ts`            | 2     | Add the five new fields to the two exact `toEqual` literals. `toEqual` is kept: no assertion is weakened to `toMatchObject`                                 |
| `src/config/constants.ts`                  | 2     | Add `DEFAULT_LLM_TIMEOUT_MS`, `DEFAULT_LLM_MAX_OUTPUT_TOKENS`                                                                                               |
| `.env.example`                             | 2     | Document the variables with placeholders; note that the key is only needed for `LLM_PROVIDER=gemini`                                                        |
| `docs/architecture.md`                     | 2     | Add `core/llm` to the structure. Leave translation/summarisation listed as planned — they are **not** part of this milestone                                |
| `tests/fixtures/cli-config-probe.ts`       | 3     | Extend into the network guard: intercept and count `fetch`, `http`/`https` `request`+`get`, `dns` `lookup`; call `syncBuiltinESMExports()` (Section 10.0.3) |
| `tests/integration/cli/harness.ts`         | 3     | Add `spawnCli()` (fail-closed on `DATABASE_PATH`), `snapshotDatabase()`, `assertNoDatabaseFiles()` (Section 10.0.4)                                         |
| `tests/integration/cli/cli-safety.test.ts` | 3     | Add T-11a and T-11b: prove each CLI's `--help` loads no environment configuration and creates no database file (Section 9.3)                                |
| `tests/integration/cli/dry-run.test.ts`    | 3     | Add T-11c and T-11d: prove the production dry-run path builds no provider, calls no `createProvider` and makes no network request                           |
| `src/runtime.ts`                           | 4     | Supply the `createTransport` callback (lazy `import()` inside it); no static import, no eager Gemini init (Section 9.5.5)                                   |

### 10.0 Phase 3 test allocation

Phase 3 changes **no production source**. It adds tests to two existing test files,
extends one existing fixture, adds shared helpers to one existing harness, and
revises this document. No new test file and no dependency are part of this
allocation.

| File                                       | Action | Tests        | Design reference          |
| ------------------------------------------ | ------ | ------------ | ------------------------- |
| `tests/fixtures/cli-config-probe.ts`       | modify | T-11a..T-11d | §5.4, §9.3, §12 items 6–7 |
| `tests/integration/cli/harness.ts`         | modify | T-11a..T-11d | §5.4, §9.3, §12 items 6–7 |
| `tests/integration/cli/cli-safety.test.ts` | modify | T-11a, T-11b | §5.4, §9.3, §12 item 6    |
| `tests/integration/cli/dry-run.test.ts`    | modify | T-11c, T-11d | §5.4, §9.3, §12 item 7    |
| `docs/design/i7-1b-llm-provider.md`        | modify | —            | this section              |

**T-11a and T-11b — `--help` isolation.** For both `extract.ts` and `ingest.ts`, the
test must establish all of the following:

1. The process exits successfully.
2. `env.ts` is not evaluated, so no environment configuration is loaded.
3. `GEMINI_API_KEY` is neither read nor parsed.
4. No provider is constructed and `createProvider()` is not invoked.
5. No database file is created: no `.db`, no `-wal`, no `-shm`.
6. The network counter is zero on every intercepted API (Section 10.0.3).

Criterion 2 is observable only from a child process, and only by supplying an
environment that **would** fail validation: help must still succeed with no
configuration error. That is a direct, non-vacuous signal that `loadEnv()` never ran.

**T-11c and T-11d — dry-run isolation.** For both CLIs' preview paths, the test must
establish all of the following:

1. The production dry-run path succeeds with `GEMINI_API_KEY` unset and
   `LLM_PROVIDER=gemini`, provided all other required conditions are satisfied.
2. No provider is constructed and `createProvider()` is not invoked.
3. `GEMINI_API_KEY` is not passed into provider configuration.
4. The key is not validated as a prerequisite for the dry-run.
5. The network counter is zero on every intercepted API (Section 10.0.3).
6. A missing database yields no `.db`, `-wal` or `-shm`, and runs no migration.
7. An existing WAL database is byte-identical before and after, with unchanged
   `user_version`, `articles` and `article_contents` lifecycle state.

Importing `env.ts` to resolve `DATABASE_PATH` is permitted, and parsing
`GEMINI_API_KEY` as part of the environment object is permitted. The test must not
claim otherwise (Section 5.4). **"`env.ts` is not loaded" is not a pass condition for
T-11c or T-11d** — `extraction.cli.ts` reaches `env.ts` through its static import
chain, so that claim would be false. What must hold is that no provider is built or
used.

Setting `LLM_PROVIDER=gemini` while withholding `GEMINI_API_KEY` is deliberate: a
dry-run that wrongly entered the Gemini construction path would fail at the
credential stage with `LlmConfigurationError`. The default `fake` provider needs no
key, so a mis-scoped test under `fake` could pass while still touching provider code.

**Both files already exist and both already exercise their CLI.**
`cli-safety.test.ts` runs the real entry points in child processes, which is the only
way to observe that `env.ts` was never evaluated. `dry-run.test.ts` currently drives
the CLI functions with an injected `databasePath`, which short-circuits the `env.ts`
import; the T-11c and T-11d cases must therefore go through the production path
instead, and must not inject `databasePath` (Section 9.3).

#### 10.0.1 Former proposed dependency — now authorized

An earlier revision of this section recorded a child-process probe as a **proposed
dependency requiring separate authorization**, on the grounds that "no provider
constructed" and "no network request" might not be establishable from a same-process
call.

That authorization has since been granted, but the resolution is narrower than the
proposal. **No new probe file is created.** The existing
`tests/fixtures/cli-config-probe.ts` is extended instead, and the two CLIs are
invoked as real child processes with their own `--help` / `--dry-run` arguments. A
second probe would have duplicated the child-process plumbing already present.

| Path                                  | Action | Status                                        |
| ------------------------------------- | ------ | --------------------------------------------- |
| `tests/fixtures/cli-config-probe.ts`  | modify | **Authorized**, part of the Phase 3 allowlist |
| `tests/fixtures/cli-dry-run-probe.ts` | —      | **Not created.** Superseded by the row above  |

`src/runtime.ts` is modified in **Phase 4**, not Phase 3: it is the existing
composition root (Section 2). That change is confined to adding the transport
callback and the wiring; it does not import the transport module eagerly and does not
start constructing a provider during server startup.

`package.json` gains a vendor SDK **only** in the phase that implements the real
adapter. Phases 1–3 need no dependency at all.

**Phase 2 stops at stage 4.** Section 5.2's stage 5 loads the adapter and stage 6
resolves the transport; both belong to Phase 4, because the adapter module does not
exist before then. A Phase 2 `createProvider` therefore implements the fake path,
the provider-name stage and the credential stage, and validates the transport seam's
presence on the `gemini` branch. It must not contain a literal `import()` of
`providers/gemini.provider.js`: that would reference a module that does not exist,
break the build, and make a "module was not loaded" assertion vacuous rather than
evidential. Phase 4 adds the load and the transport resolution, and T-09's
module-load assertion becomes real evidence at that point.

#### 10.0.2 Child-process execution model

All four tests run the CLI as a **separate child process**. No result obtained by
calling `runExtractionCli()` or `runCli()` inside the Vitest process counts as
network-isolation evidence: the test runner has already loaded modules, so its
`globalThis.fetch` and its module cache cannot represent a fresh CLI process.

| Test  | Command shape                                                     |
| ----- | ----------------------------------------------------------------- |
| T-11a | `node --import tsx --import <guard> src/cli/extract.ts --help`    |
| T-11b | `node --import tsx --import <guard> src/cli/ingest.ts --help`     |
| T-11c | `node --import tsx --import <guard> src/cli/extract.ts --dry-run` |
| T-11d | `node --import tsx --import <guard> src/cli/ingest.ts --dry-run`  |

`--import` preloads run in the order given, **before** the entry module, so the guard
is installed before any CLI module is evaluated. This ordering is what makes the
counters meaningful: `safe-fetch.ts` binds `request` from `node:http` by name at
module evaluation, so patching afterwards would be too late.

Library-level calls may remain in `dry-run.test.ts` as **supplementary** cases, but
they must be labelled as such and must not be cited as network-isolation evidence.

#### 10.0.3 Network guard and its declared limits

The guard fixture intercepts and counts, at minimum:

| Module       | Members                     |
| ------------ | --------------------------- |
| global       | `fetch`                     |
| `node:http`  | `request`, `get`            |
| `node:https` | `request`, `get`            |
| `node:dns`   | `lookup`, `promises.lookup` |

`net.connect` and `tls.connect` may be intercepted additionally. Counts are emitted
on `process.exit` and asserted to be **zero** for every intercepted member.

**`syncBuiltinESMExports()` is mandatory.** ESM named imports capture the export
binding at link time; reassigning `http.request` alone leaves an
`import { request } from 'node:http'` caller bound to the original function. The
guard must call `syncBuiltinESMExports()` after patching, otherwise the counters stay
at zero because the interception never happened — a false pass.

**Why four APIs and not just `fetch`.** Extraction does not use `fetch` at all. It
issues HTTP through `node:http` / `node:https` (`safe-fetch.ts`), and it resolves DNS
through `node:dns` **before** the request is created (`dns-pin.ts`, called from
`safe-fetch.ts`). A zero `fetch` count proves nothing about the extraction path, and
a guard covering only http/https would still let a DNS query escape.

**Declared limits.** The guard is a test double, not a sandbox. It does not claim
that the process is incapable of network access; it claims that the intercepted
members were never called. Specifically:

- An API the guard does not patch is not counted. `http.get` bypasses a patched
  `http.request` through module-internal closure, which is why both are patched.
- Native addons, `process.binding`, and direct syscalls are outside the guard.
- If the child process dies before `process.exit`, no counts are emitted. The test
  must treat a **missing** counter line as failure, never as zero.

Accordingly no test may state that the process "cannot reach the network". The
accurate claim is that every intercepted call site recorded zero invocations.

**Positive control.** A guard that never fires and a guard that never could fire look
identical from the counters alone. The suite therefore includes a positive control
proving the guard actually intercepts: a loopback server on `127.0.0.1` is started,
the guard is installed, a request through the patched API must be blocked and counted,
and — after restoring the original — the same request must succeed, showing the block
came from the guard rather than from an unreachable server. The control uses loopback
only. **No test may contact an external host**, including as a control.

#### 10.0.4 Database path fail-closed helper

`tests/integration/cli/harness.ts` gains a shared `spawnCli()` helper. It validates
before spawning and throws — failing the test — when any condition is unmet:

| Condition                                         | Rationale                                                      |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `DATABASE_PATH` is provided                       | Absent, the CLI falls back to `./data/kou-news.db`             |
| It is an absolute path                            | A relative path resolves against `cwd`, not the temp directory |
| It lies inside the test's own temporary directory | Prevents any path from reaching the real database              |

The helper must never fall back to the production default, and it must confirm from
evidence that the child process used the intended path — for example by asserting the
expected file exists, or by having the CLI report the path it resolved. Passing a
value and assuming it took effect is not sufficient.

Two further helpers are added alongside it:

| Helper                    | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `snapshotDatabase()`      | Captures SHA-256 of the database and WAL, `user_version`, and the rows under test |
| `assertNoDatabaseFiles()` | Asserts the given path has no `.db`, no `-wal` and no `-shm`                      |

The fail-closed rule exists because of a concrete failure mode: a misspelled
dependency key silently fell through to `env.ts`'s default and opened the real
database. A helper that rejects anything outside its temp directory makes that class
of mistake a test failure rather than an unnoticed side effect.

#### 10.0.5 Database isolation scenarios

**Absent database.** The run must leave no `.db`, no `-wal` and no `-shm`. This is
achievable because the read-only opener checks for the file first and throws before
any SQLite handle is created, so no side files can appear.

**Existing WAL database.** Built in the test's own temporary directory, seeded with
`articles` and `article_contents` rows including lifecycle state (status, attempts,
lease fields). The writer connection is **held open** for the duration, but with no
transaction in flight. Then:

| Comparison                                  | Expected  |
| ------------------------------------------- | --------- |
| Main database SHA-256                       | unchanged |
| WAL SHA-256                                 | unchanged |
| `user_version`                              | unchanged |
| `articles` rows                             | unchanged |
| `article_contents` rows and lifecycle state | unchanged |

`-shm` may be created or updated: a read-only connection to a WAL database maintains
a shared-memory index. It is explicitly permitted and is not asserted absent for this
scenario.

Holding the writer open is load-bearing. When the last writer closes, SQLite
checkpoints and **removes** the `-wal` file; a later read-only open then recreates an
empty one. A byte comparison against the pre-close state would therefore fail for
reasons unrelated to the dry-run. With the writer held open, the WAL persists and the
comparison is meaningful.

`immutable=1` must not be used. It suppresses the WAL, so the dry-run would read a
stale database and under-report rows — trading a real correctness property for a
tidier file listing.

The production database `data/kou-news.db` must not be opened, and no production
database file may be deleted or rebuilt to restore an earlier `-shm` timestamp.

#### 10.0.6 Provider isolation and the static-analysis boundary

T-11c and T-11d run with a fully controlled environment: `LLM_PROVIDER=gemini`,
`GEMINI_API_KEY` absent, no `.env` loaded, and no `--env-file-if-exists` flag. The
dry-run must still succeed, which is the behavioural proof that the key is not
consumed. A static AST scan supports this by confirming the preview functions contain
no provider construction.

The scan covers, within the analysed files: static imports, re-exports, dynamic
imports, import aliases, namespace imports, property access and destructuring. It is
**not** a full dependency-graph analysis. It does not follow imports recursively, does
not perform data-flow analysis across function boundaries, and cannot see provider
construction reached through a callback, an alias chain or `eval`.

The scan therefore supports a bounded claim: _the preview functions and the two CLI
modules that contain them reference no provider module, no provider identifier and no
`GEMINI_API_KEY` read._ It does not support the claim that the entire import graph is
free of provider construction. The behavioural evidence carries the rest of the
argument; the static scan corroborates it and is not a substitute.

Production source is not modified for any of this. The scan is a read-only test
helper.

#### 10.0.7 Negative control

A read-only assertion is only worth what its ability to fail is worth. The suite
includes a negative control that deliberately breaks the property under test and
confirms the assertion notices.

The control uses the documented injection seam — both preview functions accept
`openReadOnly` as a dependency — and substitutes a **write-capable** `openDatabase`
call. No production source is edited, and the real database is never involved: the
control runs against its own temporary directory.

Expected outcome: the substituted opener creates `.db` (and, while open, `-wal`), so
an assertion that "no database file was created" fails. That failure is the point —
it demonstrates the assertion is falsifiable rather than vacuous.

The control must live in the isolated test, not in a shared fixture, and must clean
up its temporary directory. If the control cannot be run safely, it is reported as
**unverified** and is not claimed to have passed.

#### 10.1 The Phase 2 `gemini` branch terminates by design

The `gemini` branch is fully specified here because, in Phase 2, it ends in a
deliberate error rather than in a constructed provider. The order below is the
contract; it is what T-09 and the T-07/T-08/T-09a/T-10 group assert.

1. **The API key is validated first.** A missing or blank key throws
   `LlmConfigurationError` naming `GEMINI_API_KEY`. The key's value never appears in
   the message.
2. **The `createTransport` dependency is checked next**, and only after the
   credential has passed.
3. **If the dependency is absent**, the factory throws `LlmConfigurationError`
   stating that a `createTransport` callback is required when
   `LLM_PROVIDER=gemini`.
4. **If the dependency is present**, Phase 2 still terminates with
   `LlmConfigurationError`, stating that the Gemini provider adapter is not
   implemented in this build.
5. **The callback is never invoked in Phase 2.** It is checked for presence only.
6. **No Gemini provider and no Gemini transport is constructed.** Nothing is loaded,
   nothing is opened, nothing is sent.
7. **There is no silent fallback to `fake`.** A configured `gemini` selection fails
   loudly rather than quietly returning a fake provider; a deployment that asked for
   a real vendor must never be served placeholder text without knowing it.

**The dependency check is an interface-precondition check only.** Step 2 does not
mean Phase 2 implements transport creation, and it does not mean the transport
machinery is reachable. It verifies that the caller has supplied the seam the
eventual adapter will require, so a misconfigured composition root fails at the
factory boundary with a precise message instead of failing later inside an adapter.
Because step 4 throws unconditionally, Phase 2 never proceeds past the check into
actual seam use.

**Intended future transition.** A later authorized phase replaces the terminal
not-implemented error at step 4 with the real construction path: load
`providers/gemini.provider.js`, `await deps.createTransport()`, build a fresh
narrowed `{ provider, model, timeoutMs }` config, and construct `GeminiProvider`
with that object and the resolved transport (§11.3.2). Steps 1–3 are unchanged by
that transition — the credential check and the seam-precondition check keep their
positions and their messages. Only the terminal branch changes, which is why the
error text at step 4 is pinned by a test: replacing it must be a deliberate edit
accompanied by a test update, not a silent behavior change.

#### 10.0.8 Implementation record

Recorded after the Phase 3 work, so a reviewer can see what was built against what
was planned. No production source was modified.

| Criterion                           | How it is established                                                        | Where                        |
| ----------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `--help` exits 0, no DB file        | Child process, `assertNoDatabaseFiles()` plus a directory listing comparison | `cli-safety.test.ts` T-11a/b |
| `--help` never evaluates `env.ts`   | Child runs with `NODE_ENV=not-an-environment`; still exits 0 with no error   | `cli-safety.test.ts` T-11a/b |
| No provider built on `--help`       | `LLM_PROVIDER=gemini` with no key; no `LlmConfigurationError`                | `cli-safety.test.ts` T-11a/b |
| Dry-run survives gemini with no key | Child process, `LLM_PROVIDER=gemini`, key withheld                           | `dry-run.test.ts` T-11c/d    |
| Dry-run writes nothing (WAL)        | Writer held open across the run; `.db` and `-wal` SHA-256 unchanged          | `dry-run.test.ts` T-11c/d    |
| Dry-run writes nothing (absent DB)  | `assertNoDatabaseFiles()` on a path that never existed                       | `dry-run.test.ts` T-11c/d    |
| Zero network, every intercepted API | Guard counters asserted individually by name                                 | both files                   |
| The assertions can fail             | Writable seam and a written fixture; both shown to trip the check            | both files                   |
| The guard actually intercepts       | Loopback self-check, asserting `blocked,reached` and `httpRequest > 0`       | `cli-safety.test.ts` control |

**Falsifiability checks run by hand.** Three were performed, because a green suite
alone does not show the tests can fail:

1. A real `UPDATE` against a WAL database changed the `.db` hash and removed the
   `-wal` file, confirming `snapshotDatabase()` detects a write.
2. A module importing `{ request }` from `node:http` was run under the guard; the
   call was refused and `httpRequest` reached 1, confirming named ESM imports are
   intercepted rather than silently missing.
3. `requireNetCounts()` was called with a result lacking the counter line; it threw
   rather than returning zero.

**Declared limits of the evidence.**

- The network guard is a test double. It proves the intercepted call sites were not
  reached; it does not make the process incapable of network access. Unlisted APIs
  are not counted.
- The static scan is not a whole-program analysis. It reads two files, does not
  follow imports, and cannot see a provider reached through a callback or alias.
- T-11c/T-11d assert `env.ts` **is** reachable, per Section 10.0; only T-11a/T-11b
  claim it is never evaluated.
- The direct-call cases already present in `dry-run.test.ts` remain as behaviour
  tests. They are not counted as isolation evidence, because the runner's modules
  are already loaded before they run.

---

## 11. Phased implementation order

Each phase is independently reviewable and leaves the suite green. A test is only
scheduled in a phase where the code it examines already exists. Phase test counts
sum to 29 in-scope tests: 6 + 5 + 4 + 14.

1. **Phase 1 — types, errors, interface, fake.** No vendor, no config change, no
   dependency. Tests T-01..T-06 (**6**). This phase alone makes callers testable.
2. **Phase 2 — config and factory.** Add the five variables with defaults (key
   optional, no `superRefine`), and `createProvider` with the fake path and the
   provider-name/credential stages. Unknown provider and missing-key-before-
   adapter-load are both covered here. Tests T-07..T-10 (**5**).
   **No Gemini adapter is required in this phase**, so nothing here depends on a
   vendor SDK.
3. **Phase 3 — CLI isolation tests.** Prove both CLIs' `--help` loads no
   environment configuration, and both dry-runs build no provider and never consume
   `GEMINI_API_KEY`. Tests T-11a..T-11d (**4**). No production source changes and no
   dependency.
4. **Phase 4 — real Gemini adapter.** Add the SDK, implement `complete()`, map
   errors, timeouts, truncation and `maxOutputTokens`, and wire the composition root.
   Tests T-10a, T-11e, T-13, T-14, T-16a, T-16b, T-16c, T-17, T-18, T-19, T-20, T-21,
   T-22, T-23 (**14**).
   T-10a lands here because it constructs the adapter; it uses an injected stub
   transport and makes no real call. T-11e lands here because it guards the runtime
   composition that this phase introduces (Section 9.6a). T-19 lands here because it
   verifies the transport's response-size ceilings (Section 11.6.8).

**I7-1b ends at Phase 4.** There is no Phase 5 in this milestone.
`modules/translation` and `modules/summarisation` are separate future milestones
and are **not** implemented here; Section 2 already lists them as planned. Because
they do not exist, T-12 and T-15 are deferred with them (Section 9.6) rather than
scheduled against absent code.

### 11.0 Phase 3 and Phase 4 boundary

**Status: Phase 3 is implemented and accepted — PASS WITH LIMITATIONS.** All four
tests T-11a..T-11d exist and pass, and the accepted Phase 3 changes are recorded
below. Phase 3 is **not** reopened by this document; the limitations it carries are
carried forward as Phase 4 risk inputs (Section 11.3), not as defects to be fixed
here.

#### 11.0.1 Phase 3 accepted state

| Item                      | Recorded value                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict                   | **PASS WITH LIMITATIONS**                                                                                                                                     |
| Tests                     | T-11a, T-11b, T-11c, T-11d — all present and passing (15 cases across the four IDs)                                                                           |
| Production source changed | None. Phase 3 added tests only                                                                                                                                |
| Dependencies added        | None                                                                                                                                                          |
| Files carrying the change | `tests/integration/cli/cli-safety.test.ts`, `tests/integration/cli/dry-run.test.ts`, `tests/fixtures/cli-config-probe.ts`, `tests/integration/cli/harness.ts` |

#### 11.0.2 Phase 3 limitations, carried forward unchanged

These are recorded, not resolved. None of them is silently upgraded to a full PASS.

| #   | Limitation                                                                                                                                      | Effect on Phase 4                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| L-1 | The committed loopback positive control exercises `http.request` only; the other intercepted APIs have zero-count evidence but no positive test | **Direct.** It is the starting point for B-6/N-2 and does **not** satisfy Phase 4's assertion-4 bar (Section 9.5.3.6)  |
| L-2 | A dead-guard fault injection was attempted and did not complete, so falsifiability rests on a synthetic assertion check                         | Indirect. The guard Phase 4 must extend is less proven than a completed injection would make it                        |
| L-3 | `net.createConnection` shares the `netConnect` counter, so the two functions cannot be told apart                                               | Minor accounting limitation; both are blocked                                                                          |
| L-4 | A legacy `PROBE_FETCH_CALLS` line is still emitted beside `PROBE_NET_COUNTS`                                                                    | Cosmetic; the superseded line is not authoritative                                                                     |
| L-5 | The static scan does not follow the full import graph or cross-function data flow                                                               | **Direct.** T-10a assertion 5 requires a transitive fixpoint scan, which is a stronger requirement than Phase 3's scan |
| L-6 | The build gate was verified with `--outDir` redirected outside the repository                                                                   | None. Tooling only                                                                                                     |

L-1 and L-5 are the two limitations that materially shape Phase 4. Section 11.3
records how each is addressed, and Section 11.2 records that B-6 remains BLOCKED
until the evidence bar in Section 9.5.3.6 is actually met.

Phase 3 is isolation tests only. It changes no production source, adds no
dependency, and constructs no vendor code. It touches test files only: two existing
test files, the existing network-guard fixture, and the existing CLI harness
(Section 10.0). Stated as a closed exclusion list, Phase 3 does **not**:

- implement `providers/gemini.provider.ts`;
- implement `providers/gemini.transport.ts`;
- install the Gemini SDK;
- change `src/runtime.ts`;
- change `provider.factory.ts`;
- implement request or response mapping;
- implement error classification;
- implement timeout or truncation handling;
- make any real Gemini API call.

Phase 4 owns all of the above, and additionally owns:

| Phase 4 responsibility              | File                                          |
| ----------------------------------- | --------------------------------------------- |
| Gemini adapter implementation       | `src/core/llm/providers/gemini.provider.ts`   |
| Gemini transport implementation     | `src/core/llm/providers/gemini.transport.ts`  |
| Adapter unit tests (M4.2)           | `tests/unit/core/llm/gemini.provider.test.ts` |
| Composition-root callback wiring    | `src/runtime.ts`                              |
| Vendor SDK dependency               | `package.json`                                |
| T-11e implementation and acceptance | `tests/integration/runtime.test.ts`           |

Phase 2's factory behavior and every accepted Phase 1 and Phase 2 contract are
preserved unchanged. Phase 3 consumes them; it does not revise them.

Phase 4 is deliberately late: the abstraction is proven against a fake before any
vendor is involved, so a vendor quirk cannot shape the interface. The credential
check lands in Phase 2, not Phase 4, so the failure path is tested without any
SDK present.

Phase 4 leaves a complete, tested transport layer. Adding a consumer later means
writing a module that depends on `core/llm`, plus the two deferred architecture
tests — no change to this milestone's files.

### 11.1 Gemini adapter specification

This is the contract Phase 4 must implement. It is written down now so the
adapter is not designed by improvisation later.

**Model mapping.** The adapter owns a private constant table from logical name to
vendor model id. It is not exported, not configurable, and not in the factory.

| Logical name (input) | Vendor model id (adapter-internal) | Notes                         |
| -------------------- | ---------------------------------- | ----------------------------- |
| `default`            | the adapter's current stable model | Used when `LLM_MODEL=default` |
| `fast`               | a lower-latency model              | Cheap, shorter outputs        |
| `high-quality`       | the strongest available model      | Longer, more expensive        |

The concrete vendor ids are **confirmed** in Section 11.1.1 against Google's own
model documentation, with the documentation URL and verification date recorded
there. The logical names above are application-internal aliases and are **never**
sent to the vendor; only the mapped vendor id is. An unknown logical name is a
`LlmConfigurationError` thrown at construction, not at call time.

The earlier draft of this section used `gemini-2.0-flash` as an illustrative
vendor id. That example is withdrawn: `gemini-2.5-flash` and `gemini-2.5-pro` are
documented as deprecated, and no illustrative id in this document should be copied
into code. Section 11.1.1 is the only authoritative mapping.

**Request mapping.**

| `LlmRequest` field  | Interactions request field (adopted)     | `generateContent` field (superseded)   | Rule                                |
| ------------------- | ---------------------------------------- | -------------------------------------- | ----------------------------------- |
| `prompt`            | `input`                                  | `contents[].parts[].text`              | Sent verbatim, no added framing     |
| `systemInstruction` | `system_instruction`                     | `systemInstruction`                    | Omitted when undefined              |
| `maxOutputTokens`   | `generation_config.max_output_tokens`    | `generationConfig.maxOutputTokens`     | Always set, from the request        |
| `temperature`       | **not sent at all** (see 11.1.2, 11.6.5) | `generationConfig.temperature`         | Dropped before the request is built |
| `timeoutMs`         | `AbortSignal.timeout(...)`               | Request value, else `config.timeoutMs` |
| `signal`            | composed with the timeout signal         | Either one aborts the call             |

**Truncation mapping.** The adapter converts the vendor's terminal signal and
never guesses. The field that carries that signal differs between the two
interfaces, so the M4.0 table is restated in interface-neutral terms; the
Interactions-specific mapping is in Section 11.6.4.3.

| Vendor terminal signal                 | `LlmResponse.truncated` |
| -------------------------------------- | ----------------------- |
| a length/max-token stop (`incomplete`) | `true`                  |
| a normal completion (`completed`)      | `false`                 |
| any other or absent value              | `null`                  |

A signal that is absent — or that the adapter does not recognise — yields `null`,
never `false`. This is the rule that makes T-17 pass, and it is unchanged by the
switch from `finishReason` to `status`.

**Transport injection — single egress.** The adapter never reaches for a global
`fetch`, `node:http`, `node:https`, `undici`, or any HTTP client it builds itself.
It receives a **required** `GeminiTransport` through its constructor (Sections 9.5
and 9.5.4), and `GeminiTransport.send()` is the **only** permitted network egress
for every Gemini API request, including any request added later and any retry that
re-enters `complete()`.

Real socket I/O lives in exactly one module, `providers/gemini.transport.ts`
(Section 9.5.3.2). The adapter receives it as a value and never imports it, so the
networking code sits outside the adapter's dependency closure.

The composition root, `src/runtime.ts`, supplies the `createTransport` callback; the
callback's body lazily imports `gemini.transport.ts` and calls its factory, and the
result travels through `createProvider` into the adapter constructor (Section 9.5.5).
Tests use the same seam with a recording double. There is no production path in which
the adapter supplies its own transport, and no `LlmProviderConfig` field that could
carry one.

`LlmProviderConfig` gains no transport field, so no production caller can smuggle
one through configuration. The transport travels only as the `createTransport` seam
and then as the adapter's required constructor argument.

The transport module is loaded lazily, inside the callback body, so a process that
never builds a Gemini provider — `fake` runs, CLI `--help`, both dry-runs, server
startup — never loads it (Section 9.5.5.1).

This specification does **not** assert that a Google SDK supports transport
injection. Whether the adapter is written over an SDK or directly over the HTTP API
is decided at Phase 4 under the blocking verification in Section 9.5.2. Until that
is settled, the single-egress property is a design requirement, not a proven
runtime fact. If neither option can satisfy it, Phase 4 stops (Section 9.5.2, rule
S-3); there is no weaker-guarantee delivery path.

**Envelope mapping.** The adapter parses the HTTP response envelope and maps:

- a non-2xx status to `authentication` (401/403), `rate_limit` (429),
  `unavailable` (5xx), or `invalid_request` (other 4xx);
- a body missing its expected fields, or not decodable, to `invalid_response`;
- an empty text field to `empty_response`;
- otherwise a normal `LlmResponse` with `text`, `model` (the logical name),
  `usage`, `truncated` and `durationMs`.

Model text is **never** parsed as JSON or validated against a schema (Section 6.6).

#### 11.1.1 Confirmed vendor model ids (Q-7, Q-8)

**Verification basis.** Every value below was read from Google's own published
documentation on **2026-11-18**. No value is taken from memory, a third-party
article, or an earlier draft of this document. Where the official documentation
does not state a fact, it is marked **"official documentation unconfirmed"**
rather than guessed.

Sources consulted (all Google-owned):

| Source                                | URL                                                     |
| ------------------------------------- | ------------------------------------------------------- |
| Models overview                       | `https://ai.google.dev/gemini-api/docs/models`          |
| Interactions API reference (`v1`)     | `https://ai.google.dev/api/interactions?api-version=v1` |
| Interactions API reference (`v1beta`) | `https://ai.google.dev/api/interactions`                |
| Text generation guide (REST examples) | `https://ai.google.dev/gemini-api/docs/text-generation` |
| API key guide                         | `https://ai.google.dev/gemini-api/docs/api-key`         |
| Deprecations                          | `https://ai.google.dev/gemini-api/docs/deprecations`    |
| Pricing                               | `https://ai.google.dev/gemini-api/docs/pricing`         |

Model ids were re-verified in M4.0.1 against the **Interactions API** model enum
(Section 11.6.1, S-2/S-3), not only against the models overview page. All three
proposed ids appear in that enum, so none of them is unusable on the adopted
interface.

**Ratified alias → vendor id mapping (O-1, approved in the M4.2 reconciliation).** These
three ids are **approved** exactly as listed. They are stable, non-preview models where
one exists. The logical aliases remain application-internal and are never sent to the
vendor.

| Alias          | Vendor id               | Official lifecycle       | Max output tokens            | Rationale                                                                                                                                           |
| -------------- | ----------------------- | ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | `gemini-3.8-flash`      | Documented as **Stable** | 65,536                       | Best general-purpose balance; the documented successor for the deprecated 2.5 Flash/Pro line                                                        |
| `fast`         | `gemini-3.5-flash-lite` | Documented as **Stable** | 65,536                       | Fastest, most cost-effective tier; documented as the automatic routing target for deprecated `gemini-2.5-flash`                                     |
| `high-quality` | `gemini-4-argon`        | Documented as **Stable** | 65,536 (default synchronous) | Strongest reasoning tier offered as a stable id; the other Gemini 4 ids (`-carbon`, `-neon`, `-hydrogen`) are also listed but are not marked Stable |

Evidence per candidate:

| Vendor id               | Documented purpose                                                                                       | Generation config support                                    | Deprecation / lifecycle notes                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.8-flash`      | "most intelligent Flash model … long-horizon software engineering, autonomous agents"                    | `max_output_tokens` only; sampling params ignored (11.6.5.1) | Listed as Stable. Appears in the deprecations page as a **routing target**, not as deprecated. In the Interactions enum   |
| `gemini-3.5-flash-lite` | "cost-efficient model, optimized for high-volume agentic tasks, translation, and simple data processing" | Same as above                                                | Listed as Stable. Documented as the routing target for `gemini-2.5-flash`. In the Interactions enum                       |
| `gemini-4-argon`        | "efficient Gemini 4 frontier reasoning model … lower token spend per turn"                               | Same as above                                                | Listed as **Stable** on its model page. Unified 1,048,576 context; 65,536 max output by default. In the Interactions enum |

**Pricing.** Recorded because the alias choice has a real cost consequence. Every
figure below is copied from Google's official pricing page (S-8) and read on
**2026-11-18**. Nothing is inferred, averaged or converted.

**Pricing is per tier, and tiers are not interchangeable.** Google publishes four
billable tiers plus a private-preview Contributor tier. The table below therefore
separates them, and each row states which tier it describes. Mixing a Standard
figure with a Batch figure would understate cost by half, so no combined "price"
appears anywhere in this document.

**Tier semantics, quoted from the official optimization page (S-14):**

| Tier         | Pricing relative to Standard | Latency                   | Reliability                 | Interface    |
| ------------ | ---------------------------- | ------------------------- | --------------------------- | ------------ |
| **Standard** | Full price                   | Seconds to minutes        | High / medium-high          | Synchronous  |
| **Flex**     | **50% discount**             | Minutes (1–15 min target) | Best-effort (**sheddable**) | Synchronous  |
| **Priority** | **75%–100% more**            | Seconds                   | High (**non-sheddable**)    | Synchronous  |
| **Batch**    | **50% discount**             | Up to 24 hours            | High (for throughput)       | Asynchronous |

Flex and Batch both cost half of Standard but are not the same product: Flex is
synchronous and may be **preempted**; Batch is asynchronous with a 24-hour target.
Priority costs more than Standard because it is never preempted.

**The tier is selected by the `service_tier` request field.** The Interactions API
reference documents `service_tier` as an `Interaction` field with values `flex`,
`standard` and `priority` (S-3). Batch is a separate asynchronous interface, not a
`service_tier` value.

**Phase 4 does not set `service_tier`.** The adapter sends no tier field, so
requests are billed at **Standard** rates and behave as Standard-synchronous. This
is deliberate and consistent with the standing decisions: no retry/backoff, no
batching, no queueing, no streaming. Selecting Flex or Batch would change the
reliability contract and is out of scope. Priority is likewise not selected.

#### Standard tier — the only tier Phase 4 can reach

All prices are **USD per 1,000,000 tokens**, paid tier.

| Alias          | Vendor id               | Input                                               | Output (including thinking tokens)                    | Context caching                | Free tier                                 |
| -------------- | ----------------------- | --------------------------------------------------- | ----------------------------------------------------- | ------------------------------ | ----------------------------------------- |
| `default`      | `gemini-3.8-flash`      | $0.75 through 2026-12-31; **$1.50 from 2027-01-01** | $3.75 through 2026-12-31; **$7.50 from 2027-01-01**   | $0.075 → $0.15 from 2027-01-01 | **Free of charge** (limited access)       |
| `fast`         | `gemini-3.5-flash-lite` | $0.30 (text / image / video / audio)                | $2.50                                                 | $0.03                          | **Free of charge** (limited access)       |
| `high-quality` | `gemini-4-argon`        | $2.00 through 2026-11-30; **$4.00 from 2026-12-01** | $10.00 through 2026-11-30; **$20.00 from 2026-12-01** | $0.10 → $0.20 from 2026-12-01  | **Not available** — every token is billed |

#### Flex tier — 50% of Standard, sheddable, not used

Recorded for completeness so a future cost review has the numbers without
re-fetching. **Not selected by this design.**

| Alias          | Vendor id               | Input                                            | Output (including thinking tokens)               | Free tier     |
| -------------- | ----------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------- |
| `default`      | `gemini-3.8-flash`      | $0.375 through 2026-12-31; $0.75 from 2027-01-01 | $1.875 through 2026-12-31; $3.75 from 2027-01-01 | Not available |
| `fast`         | `gemini-3.5-flash-lite` | $0.15                                            | $1.25                                            | Not available |
| `high-quality` | `gemini-4-argon`        | $1.00 through 2026-11-30; $2.00 from 2026-12-01  | $5.00 through 2026-11-30; $10.00 from 2026-12-01 | Not available |

#### Batch tier — 50% of Standard, asynchronous, not used

**Not selected by this design**: Batch is asynchronous with a target turnaround of
up to 24 hours, which is incompatible with a synchronous request/response adapter
and with the decision to add no queueing.

| Alias          | Vendor id               | Input                                            | Output (including thinking tokens)               | Free tier          |
| -------------- | ----------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------ |
| `default`      | `gemini-3.8-flash`      | $0.375 through 2026-12-31; $0.75 from 2027-01-01 | $1.875 through 2026-12-31; $3.75 from 2027-01-01 | Not available      |
| `fast`         | `gemini-3.5-flash-lite` | $0.15                                            | $1.25                                            | **Free of charge** |
| `high-quality` | `gemini-4-argon`        | $1.00 through 2026-11-30; $2.00 from 2026-12-01  | $5.00 through 2026-11-30; $10.00 from 2026-12-01 | Not available      |

Note the asymmetry: `gemini-3.5-flash-lite` is listed as free of charge on the
**Batch** free tier but free of charge on **Standard** too, whereas
`gemini-3.8-flash` is free of charge on Standard and Priority but **not** on Batch
or Flex. These are separate per-tier Free-tier columns on the official page and are
reproduced as published rather than harmonised.

#### Priority tier — 75%–100% above Standard, not used

| Alias          | Vendor id               | Input                                           | Output (including thinking tokens)                | Free tier          |
| -------------- | ----------------------- | ----------------------------------------------- | ------------------------------------------------- | ------------------ |
| `default`      | `gemini-3.8-flash`      | $1.35 through 2026-12-31; $2.70 from 2027-01-01 | $6.75 through 2026-12-31; $13.50 from 2027-01-01  | **Free of charge** |
| `fast`         | `gemini-3.5-flash-lite` | $0.54                                           | $4.50                                             | **Free of charge** |
| `high-quality` | `gemini-4-argon`        | $3.60 through 2026-11-30; $7.20 from 2026-12-01 | $18.00 through 2026-11-30; $36.00 from 2026-12-01 | Not available      |

#### Tiers documented but deliberately not reproduced

| Tier            | Why no price is recorded here                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Contributor** | Private preview, invite-only, and documented as "discounts and model availability are subject to change". It is not a purchasable tier and cannot be planned against. It appears only on the `gemini-4-argon` page (S-8) |

#### Facts that materially affect the alias decision

1. **`gemini-4-argon` doubles on 2026-12-01** — two weeks after this review. Its
   Standard input goes $2.00 → $4.00 and output $10.00 → $20.00. Any cost estimate
   for `high-quality` must use the post-increase figures.
2. **`gemini-4-argon` has no free tier at all.** Every token is billed, including
   thinking tokens. Development against `high-quality` therefore incurs real cost
   from the first call, unlike the other two aliases.
3. **`gemini-3.8-flash` doubles on 2027-01-01.** It is the `default` alias, so the
   baseline cost of the whole service doubles on that date.
4. **Output prices include thinking tokens.** For a reasoning model this is not a
   rounding detail: thinking tokens are billed as output at $10–$20 per 1M on
   `gemini-4-argon`. See §11.6.8 for why this widens the response-size analysis.
5. **Grounding prices are separate and not applicable.** Google Search and Maps
   grounding are billed per request. Phase 4 sends no tools (§11.6.5), so no
   grounding charge applies.

**Unverified pricing.** No price in this document is estimated. Where Google
publishes a price only per tier and Phase 4 cannot reach that tier, the number is
still recorded and labelled. If Google publishes a price this table omits, that is
an omission to fix, not a gap to infer around.

**Explicitly rejected candidates**, with reason:

| Candidate                                                        | Reason for rejection                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `gemini-2.5-flash`                                               | **Deprecated.** Official callout: no longer selectable in AI Studio; routes to `gemini-3.5-flash-lite` from 2026-12-01 |
| `gemini-2.5-pro`                                                 | **Deprecated.** Routes to `gemini-3.8-flash` from 2026-12-01                                                           |
| `gemini-2.0-flash`                                               | Not listed as a current model on the models overview page; superseded                                                  |
| `gemini-3.1-pro-preview`                                         | Preview only. Preview ids are not acceptable for a production default                                                  |
| `gemini-3-flash-preview`                                         | Preview only                                                                                                           |
| Any `-tts`, `-image`, `-live`, `-transcribe`, `-computer-use` id | Wrong modality for text summarisation/translation. Out of scope                                                        |

**Alias rules.**

1. Aliases are application-internal vocabulary. `default`, `fast` and
   `high-quality` are **never** transmitted to Gemini. Only the mapped vendor id
   reaches the URL path.
2. An unknown alias is a `LlmConfigurationError` thrown **at adapter
   construction**, never at call time, so a typo fails before any socket opens.
3. The mapping table lives in `gemini.provider.ts` as a private module constant. It
   is not exported, not in the factory, and not in `LlmProviderConfig`.
4. Application-internal stability is preserved by editing that one constant when
   vendor ids change. No caller, no `LlmRequest`, and no consumer module changes.

**Maintenance rule.** Vendor ids are confirmed against the vendor's model list at
each dependency review. The verification date above is the reference point; a
mapping older than the vendor's next model retirement window must be re-verified
before release. **Official documentation unconfirmed:** the exact retirement date
of `gemini-3.8-flash`, `gemini-3.5-flash-lite` and `gemini-4-argon` is not stated
on the pages consulted, so no assumption about their longevity is made here.

#### 11.1.2 `temperature` is no longer transmittable (revised by M4.0.1)

Google's troubleshooting guide states, in its parameter-range table:

> Temperature | 0.0-1.0 (**ignored on Gemini 3.6+ and 4**; keep at default on earlier
> Gemini 3 models)
>
> TopP | 0.0-1.0 (**ignored on Gemini 3.6+ and 4**; keep at default on earlier
> Gemini 3 models)

The earlier M4.0 `GenerationConfig` wording ("silently ignored on Gemini 3.6 Flash
and newer models") and this table agree on the substance: on the three models this
design proposes, `temperature` has no effect.

**M4.0.1 resolves this conflict rather than carrying it forward.** M4.0 recorded
the conflict and left the adapter sending the field. That is no longer defensible,
for two independent reasons:

1. **The adopted interface has no `temperature` field at all.** The Interactions
   API `generation_config` schema documents `seed`, `stop_sequences`,
   `tool_choice`, `thinking_level`, `thinking_summaries`, `max_output_tokens`,
   `video_config`, `transcription_config`, `structured_speech_config` and
   media-specific members. It documents **no `temperature`, no `top_p`, no
   `top_k`**. A request that carries them is at best ignored and at worst rejected
   as `parameter_unknown` (HTTP 400), which the API-errors page lists explicitly.
2. **Every model this design proposes is in the ignored range.** `gemini-3.8-flash`
   and `gemini-3.5-flash-lite` are Gemini 3.6+, and `gemini-4-argon` is Gemini 4.

**Policy adopted: the adapter never sends `temperature`.** The field stays on
`LlmRequest` — removing it would be a breaking change to a published type and is
outside this milestone's authority — but the Gemini adapter **drops it before
building the request body**. Dropping is silent by design: it is not an error,
because callers legitimately set it for a provider that honours it, and the `fake`
provider still records it so a caller can assert what it asked for.

| Aspect              | Position after M4.0.1                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Wire behaviour      | `temperature` is **never** placed in the request body, on any model                                       |
| Reason              | The adopted interface does not document the field, and the proposed models ignore it                      |
| Caller visibility   | `LlmRequest.temperature` still exists and is still accepted; the adapter documents that Gemini ignores it |
| Error behaviour     | Dropping is silent. It is **not** an error, because the field is valid on `LlmRequest`                    |
| `fake` provider     | Still echoes `temperature` in `receivedRequests`; the fake is not a Gemini adapter                        |
| What is NOT claimed | No claim that temperature influences output. No test asserts it does                                      |
| Capability mapping  | **Not introduced.** See Section 11.6.5 for why per-model capability tables are rejected at this stage     |

No test asserts that temperature changes model output, and no test asserts the
field is transmitted — asserting transmission would now be asserting a bug.

#### 11.1.3 Direct HTTP contract (Q-3, revised by M4.0.1)

Phase 4 calls the Gemini API **directly over HTTPS**. No Google SDK is added. No
second HTTP client is added. The only HTTP module used is Node's built-in
`node:https` (Section 11.1.5).

**Interface adopted by M4.0.1: the Interactions API.** M4.0 specified
`generateContent` at `/v1beta/models/{model}:generateContent`. M4.0.1 supersedes
that choice after re-reading Google's documentation (Section 11.6). The reasons
are recorded in full in Section 11.6.3 and summarised here: Google now labels
`generateContent` **legacy** and names the Interactions API the recommended
interface for all new projects. The M4.0 text is preserved in Section 11.6.2 so
the change is auditable rather than silent.

| Element          | Specification (Interactions API)                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint (fixed) | `https://generativelanguage.googleapis.com` — a module constant. **No caller may supply a URL, host, or path**                             |
| Path             | `/v1/interactions`                                                                                                                         |
| HTTP method      | `POST`                                                                                                                                     |
| API version      | `v1` — the **stable** version. Google documents the Interactions API as generally available in `v1`                                        |
| Auth header      | `x-goog-api-key: <key>` — set by the transport only (Section 11.1.4)                                                                       |
| Content-Type     | `application/json`                                                                                                                         |
| `Api-Revision`   | **Not sent.** It is not part of the documented API reference and not required for `v1`. See Section 11.6.2.1                               |
| Request body     | `{ model, input, system_instruction?, generation_config?, store }` per Section 11.6.4                                                      |
| Success response | HTTP 2xx with an `Interaction` JSON body                                                                                                   |
| Response parsing | `JSON.parse` inside a `try`; a parse failure is `invalid_response`. Structural validation is explicit field checking, not a schema library |
| Non-2xx handling | Classified by the documented `error.code` string per Section 11.6.6. The raw vendor body is **not** propagated (Section 11.1.4)            |

**Why `v1` and not `v1beta`.** Google's API-versions page states that the
Interactions API and its core features are **generally available in `v1`**, and
that `v1` is the stable version whose features are fully supported for the
lifetime of the major version. `v1beta` is documented as carrying features still
subject to change. Phase 4 needs none of the `v1beta`-only features (Live API,
explicit context caching, managed agents), so `v1` is both sufficient and the
lower-risk choice.

This also closes a gap M4.0 left open. M4.0 wrote that a stable `v1` equivalent
"was not confirmed" for `generateContent`. For the Interactions API that question
is answered: `/v1/interactions` is documented.

**`store` is sent explicitly as `false`.** Google documents that the Interactions
API **stores every interaction by default** (`store=true`) — 55 days on the paid
tier, 1 day on the free tier — so that server-side state and background execution
can work. Kou News Engine is a stateless, single-shot text generator: it never
uses `previous_interaction_id`, never runs background jobs, and must not cause
article text to be retained on a vendor side store as a side effect of a default.
The adapter therefore always sends `store: false`.

This is a deliberate, documented deviation from the vendor default, and it is a
privacy decision, not a performance one. `store: false` is documented as
incompatible with `background=true` and with `previous_interaction_id`; Phase 4
uses neither. If a future milestone wants conversation state, this decision must
be revisited explicitly, because turning storage back on changes the data
retention posture of the whole service.

**Response fields consumed** (from the documented `Interaction` resource):

| Field path                                            | Use                                        |
| ----------------------------------------------------- | ------------------------------------------ |
| `steps[].type === 'model_output'` → `.content[].text` | Concatenated into `LlmResponse.text`       |
| `status`                                              | Truncation and failure mapping (§11.6.4.3) |
| `usage.total_input_tokens`                            | `LlmResponse.usage.inputTokens`            |
| `usage.total_output_tokens`                           | `LlmResponse.usage.outputTokens`           |
| `usage.total_tokens`                                  | `LlmResponse.usage.totalTokens`            |

A field that is absent yields `null` in `LlmUsage`, never `0` (Section 4.2). No
count is ever estimated.

**Text extraction is not `output_text`.** Google's migration guide notes that the
SDKs expose an `output_text` convenience property, but also states that it only
joins _consecutive trailing_ text blocks and omits earlier text separated by
non-text steps. Because Phase 4 issues direct HTTP and has no SDK, the adapter
performs the equivalent join itself over `model_output` steps only, and ignores
every other step type (`thought`, tool calls, and so on). Relying on a
convenience property that the vendor documents as lossy would risk silently
dropping part of a translation.

**Empty output.** An `Interaction` that yields no `model_output` text is
`empty_response`, matching the existing rule that an empty result is an error and
never a valid empty translation. Output consisting **only of whitespace** is
treated as empty on the same grounds: the adapter trims before deciding, so a
response of spaces or newlines is `empty_response` rather than a successful
translation of nothing. This applies the §6.5 rule ("empty or whitespace-only
text") to the Interactions envelope. Trimming is used for the emptiness decision
only; text that passes the check is returned verbatim, without being trimmed.

**Blocked or failed generations.** The Interactions API reports these through
`status` and through the documented generation-blocked codes (`safety`,
`recitation`, `language`, `prohibited_content`, `spii`, `blocklist`, …) rather
than through `promptFeedback`. The adapter maps them to `invalid_response` with a
message naming the code, and never fabricates text. This replaces the M4.0
`promptFeedback.blockReason` rule, which does not exist on this interface.

#### 11.1.4 API key isolation

The key has exactly one permitted use: the `x-goog-api-key` header on the outbound
request, set inside `gemini.transport.ts`.

| Requirement                                            | Enforcement                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key used only by the transport, only when sending      | `GeminiProvider` never receives the key. It receives only a `GeminiTransport`                                                                                                                                                                       |
| Provider cannot read the key                           | `GeminiProviderDeps` has no `apiKey` field, and the adapter's config is `GeminiProviderConfig = Omit<LlmProviderConfig, 'apiKey'>` (§9.5.4). Adding either back would be a design violation                                                         |
| Provider's config object **contains** no key           | The factory constructs a fresh `{ provider, model, timeoutMs }` literal and passes that, never its own `LlmProviderConfig` (§11.3.2). `Omit` is compile-time only; structural typing would otherwise let the live key ride along invisibly (§9.5.4) |
| Key never in an error message                          | Error messages name the **variable** (`GEMINI_API_KEY`), never a value. Factory messages are already so                                                                                                                                             |
| Key never in a log line                                | Logs carry `providerId` and the logical model name only                                                                                                                                                                                             |
| Key never in an HTTP error body propagated to the user | Vendor error bodies are **not** forwarded. Only a classification plus status code is surfaced                                                                                                                                                       |
| Key never in a test assertion or fixture               | Fixtures use an obvious placeholder such as `'test-key-not-real'`                                                                                                                                                                                   |
| `Authorization`-style headers never logged             | No header map is ever logged in full. If headers are logged at all, the key header is redacted                                                                                                                                                      |

**Dedicated test.** A Phase 4 test (T-18, Section 11.1.7) asserts that a synthetic
key does not appear in any error message, log line, or propagated body produced by
a failing call. This is a required test, not an optional one.

#### 11.1.5 `node:https` transport requirements (Q-6)

| Concern                   | Requirement                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Module                    | `node:https` only. `undici` is **not** added as a dependency (see Section 11.3, item 5)                                                   |
| Request lifecycle         | Build options → `https.request()` → write body → `end()` → read response → resolve `{ status, body }`                                     |
| Timeout                   | `AbortSignal` composed from `AbortSignal.timeout(timeoutMs)` and the caller signal. On abort, `request.destroy()`                         |
| Abort mapping             | The composed signal is passed as `signal` in the request options. An abort rejects with `LlmTimeoutError` (timeout) or a propagated abort |
| Response size limit       | Enforced **while streaming**, not after buffering. A hard byte ceiling; on exceed, destroy the response and reject                        |
| Declared `content-length` | Checked first as a cheap early exit, but the streaming total is the real guarantee (a header is a claim, not a fact)                      |
| Redirects                 | **Rejected.** A 3xx is not followed. It is surfaced as `invalid_response` (or `unavailable` for 5xx-adjacent cases)                       |
| Socket cleanup            | Every terminal path destroys the request/response. No socket is left open on success, error, timeout, or size exceed                      |
| Module import side effect | The module is inert at import: it exports a factory and opens nothing until the factory is called                                         |

The streaming size limiter and the "declared length is only an early exit" rule
mirror the extraction layer's `readBodyWithLimit`, which already implements exactly
this reasoning. Reuse of the **pattern** is intended; see Section 11.1.6 for why the
**module** is not imported.

**Interface sufficiency.** The existing `GeminiTransport.send(url, { body,
headers, signal })` signature is sufficient for all of the above. The URL is
supplied by the adapter from its fixed constant; the transport still validates that
the URL it receives matches the permitted origin, so a future adapter bug cannot
turn the transport into an open proxy. **No interface change is required.** If
implementation reveals a genuine need, that is a separate authorized change — not
part of M4.0.

#### 11.1.6 SSRF posture and reuse boundary (Q-5)

The extraction layer (`ip-guard.ts`, `dns-pin.ts`, `safe-fetch.ts`) solves a
**different problem**: fetching arbitrary user-supplied article URLs. Phase 4
fetches **one fixed vendor endpoint**. The threat models differ, so the reuse
boundary is stated explicitly rather than copying the whole guard.

| Extraction component | What it does                                                 | Reuse in Phase 4?                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ip-guard.ts`        | Deny-list of private/loopback/link-local/metadata ranges     | **Design only.** The reasoning (deny-lists, IPv6 bracket traps, IPv4-mapped decoding) is sound, but the Gemini host is a public Google endpoint resolved once. Importing the module would create a cross-module dependency from `core/llm` into `modules/extraction`, which the dependency direction forbids |
| `dns-pin.ts`         | Resolves and pins the address to prevent DNS rebinding       | **Not reused.** There is no user-controlled hostname, so rebinding is not the threat                                                                                                                                                                                                                         |
| `safe-fetch.ts`      | Full URL validation, port allow-list, redirect re-validation | **Not reused as a module.** The **pattern** for redirect rejection and size limiting is reused (11.1.5)                                                                                                                                                                                                      |
| `body-reader.ts`     | Streaming byte ceiling with early `content-length` exit      | **Pattern reused.** The reasoning is adopted; the module is not imported                                                                                                                                                                                                                                     |

**Why not import them.** `core/llm` must not depend on `modules/*` (Section 3.2).
Importing `modules/extraction/http/*` from the transport would invert the
dependency direction and would also pull extraction's error types into the LLM
layer. The correct relationship is a shared **pattern**, not a shared module.

**SSRF posture for Phase 4:**

1. **Fixed destination.** The origin and path are module constants. No caller
   supplies a URL. This is the primary control, and it is stronger than any
   runtime address check because there is nothing to check.
2. **Transport-side origin assertion.** `send()` verifies the URL's origin equals
   the permitted constant and rejects anything else before opening a socket. This
   defends against a future adapter bug, not against user input.
3. **No redirects.** A redirect cannot move the request to an attacker-chosen
   host.
4. **No proxy environment variables.** The transport does not honour
   `HTTP_PROXY`/`HTTPS_PROXY`; a proxy could silently redirect traffic.
   **Official documentation unconfirmed:** whether the deployment environment
   requires an egress proxy is a deployment question, not a code question.
5. **Residual risk, stated honestly.** If the fixed vendor hostname were poisoned
   at the DNS layer, a plain `node:https` request could be redirected to an
   attacker-controlled address. Because the destination is a fixed public vendor
   and the response is only parsed for text, this is accepted for Phase 4 and
   recorded rather than mitigated. Mitigating it would require address pinning
   (i.e. reusing the `dns-pin` design), which is **deferred** — see Section 11.4.

#### 11.1.7 API key isolation test (T-18)

Because the key-isolation requirements in 11.1.4 are behavioural, they need a test
of their own. T-18 is **added** to Phase 4 for this purpose. It does not replace or
weaken any existing test.

| Aspect        | Specification                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Prove a synthetic key never escapes into an error, a log line, or a propagated body                                               |
| Precondition  | A recording transport that returns a non-2xx response whose body **echoes** the key                                               |
| Input         | `apiKey = 'test-key-not-real'`; a transport response containing that string in the body                                           |
| Expected      | The rejection's `message`, `String(error)`, `JSON.stringify(error)`, and captured log output contain **no** occurrence of the key |
| Fails if      | The key appears in any of those surfaces, or the raw vendor body is attached to the error                                         |
| Network       | None. Recording transport only                                                                                                    |
| Egress denial | Not required                                                                                                                      |

This test is the direct enforcement of the "HTTP error body must not leak the key"
requirement. It is deliberately constructed so the vendor body **does** contain the
key: a test whose body does not echo the key would pass for the wrong reason.

#### 11.1.8 Lazy provider initialisation in the runtime (Q-2)

`createRuntime()` **stays synchronous**. The provider is built lazily on first use,
behind a cached promise. This section is the interface and lifecycle specification;
it is deliberately concrete enough to implement without further design.

**State.** The runtime holds a private provider cell with four active states plus a
terminal `disposed` state:

```
type ProviderCell =
  | { status: 'idle' }
  | { status: 'pending'; attempt: Promise<LlmProvider> }
  | { status: 'ready'; provider: LlmProvider }
  | { status: 'failed'; error: unknown }
  | { status: 'disposed' };
```

`pending.attempt` is the **internal initialisation promise**. It is never returned to
a caller directly (§11.1.8.2).

`failed` **retains the error value** for diagnostics and logging; it never gates a
retry, and it is not exposed for test inspection (T-21 is defined purely in terms of
observable API behaviour, §9.0b).

**The accessor.** The only async seam on `Runtime` is a named method:

```ts
getProvider(): Promise<LlmProvider>;
```

It is part of the public `Runtime` interface. There is no other name for it in the
design, and no consumer calls it in M4.4 (Section 11.5.3 E).

**Initialisation timing.** The provider is constructed on the **first call** to
`getProvider()`. It is never constructed at `createRuntime()` time, during server
startup, during CLI `--help`, or during a dry-run. This is what T-11e asserts.

**One initialisation attempt, one wrapper per caller.** On the first call, the cell
moves `idle → pending` and stores the internal `attempt` **synchronously**, before
any await is reached. Concurrent calls while `pending` **share that one attempt** —
`createProvider` runs exactly once — but each caller receives its **own
disposal-aware wrapper** over it. Callers share the initialisation; they do not share
the promise object they are handed. The full contract is §11.1.8.2.

**Failure is not cached permanently.** On rejection the cell moves to `failed` with
the error, and the **attempt is discarded**. A subsequent call starts a fresh
attempt. The failed state is retained only for diagnostics; it never blocks a retry.

**Complete transition table.** Every transition the cell can make, including the
disposal column. `getProvider()` is the only trigger except `dispose()`.

| From       | Event           | To         | Side effect                                                                                                                                                              |
| ---------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idle`     | `getProvider()` | `pending`  | Starts one `createProvider`; stores the attempt **synchronously**                                                                                                        |
| `pending`  | `getProvider()` | `pending`  | Returns a **new wrapper** over the stored attempt; starts nothing                                                                                                        |
| `pending`  | resolution      | `ready`    | Stores the provider; attempt retained for later callers                                                                                                                  |
| `pending`  | rejection       | `failed`   | Stores the error; attempt discarded                                                                                                                                      |
| `ready`    | `getProvider()` | `ready`    | **Disposal check first**; if not disposed, returns a **new** caller-facing wrapper resolving with the stored provider; never the internal attempt; no new initialisation |
| `failed`   | `getProvider()` | `pending`  | Starts a fresh attempt with a new promise                                                                                                                                |
| `idle`     | `dispose()`     | `disposed` | Sets the flag; nothing pending to orphan                                                                                                                                 |
| `pending`  | `dispose()`     | `disposed` | Sets the flag; does **not** await the attempt; unsettled wrappers reject                                                                                                 |
| `ready`    | `dispose()`     | `disposed` | Drops the reference; see "does not close the provider" below                                                                                                             |
| `failed`   | `dispose()`     | `disposed` | Drops the stored error                                                                                                                                                   |
| `disposed` | `getProvider()` | `disposed` | Rejects with `RuntimeDisposedError`; starts nothing                                                                                                                      |
| `disposed` | `dispose()`     | `disposed` | No-op; idempotent                                                                                                                                                        |

`disposed` **supersedes** `pending` and `failed`: once set, it is terminal and no
transition leaves it. There is no `disposed → pending` and no `disposed → ready`
edge, so a late resolution cannot resurrect the cell.

**The `ready` fast path obeys the disposal contract.** Once the cell is `ready`, a
`getProvider()` call does no initialisation work, but it is **not** a shortcut around
disposal. The call performs the disposal check **first**:

- if the runtime has been disposed, the call rejects with `RuntimeDisposedError`
  — it does not read the stored provider, and no provider is reachable through a
  disposed `Runtime`;
- otherwise it returns a **new** caller-facing wrapper that resolves with the stored
  provider. That wrapper is never the internal attempt promise, and it is a distinct
  object per call, exactly as in the `pending` path (§11.1.8.2);
- no new initialisation attempt is created in `ready` state, and `createProvider` is
  not invoked.

**Concurrent callers share one initialisation attempt.** Because `idle → pending`
happens synchronously and the internal `attempt` is stored before any `await`, two
calls in the same tick cannot both observe `idle`. `createProvider` therefore runs
exactly once, and every caller settles with that one attempt's outcome — unless
disposal intervenes, which supersedes it (§11.1.8.2).

#### 11.1.8.1 Provider configuration source (G-2)

The runtime builds `LlmProviderConfig` from the **existing validated environment**.
No second configuration system is introduced, `createRuntime()` stays synchronous
and keeps its `(deps?: RuntimeDependencies) => Runtime` signature, and `src/index.ts`
keeps calling `createRuntime()` with no arguments.

**Field mapping.** `src/config/env.ts` already validates all five LLM variables, so
the composition layer only copies them:

| `LlmProviderConfig` field | Source in `Env`  | Default in `env.ts`      | Notes                                                    |
| ------------------------- | ---------------- | ------------------------ | -------------------------------------------------------- |
| `provider`                | `LLM_PROVIDER`   | `'fake'`                 | `'gemini' \| 'fake'`, already a closed enum by Zod       |
| `model`                   | `LLM_MODEL`      | `'default'`              | Logical name; the adapter owns the vendor-id mapping     |
| `timeoutMs`               | `LLM_TIMEOUT_MS` | `DEFAULT_LLM_TIMEOUT_MS` | Bounded at parse time by `MIN/MAX_LLM_TIMEOUT_MS`        |
| `apiKey`                  | `GEMINI_API_KEY` | `undefined`              | Optional; passed through untouched, never validated here |

`LLM_MAX_OUTPUT_TOKENS` is **not** part of `LlmProviderConfig`. It is a per-request
budget, not a provider-wide setting, and the factory never reads it (§12 criterion
11, T-16a/T-16b). The composition layer copies it into each `LlmRequest` when a
consumer exists; M4.4 adds no consumer, so M4.4 neither reads nor forwards it.

**When the configuration is read.** The configuration is captured **once, at
`createRuntime()` time**, into a plain object held by the closure. It is not
re-read on each `getProvider()` call.

Capturing at construction time is what makes the runtime's behaviour deterministic:
the cell may retry after a failure, and a retry that re-read `process.env` could
build a provider for a different model than the first attempt. Reading `env` at
`createRuntime()` time is also free — `runtime.ts` already evaluates `env.ts`
transitively through `sqlite.ts` (`openDatabase()` reads `env.DATABASE_PATH`), so
this adds no new module evaluation to any path.

**What "not eagerly consumed" means.** Three distinct things are separated here, and
conflating them was the defect this revision corrects:

| Stage                | What happens                                                 | Does it use the credential?                                              |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Module evaluation    | `env.ts` parses `process.env` and validates the schema       | No — `GEMINI_API_KEY` is `z.string().optional()`, parsed but unvalidated |
| Configuration access | `env.GEMINI_API_KEY` is read into the captured config object | Reads the value; does not use it                                         |
| Credential use       | The key reaches `createGeminiTransport({ apiKey })`          | **Yes** — only here                                                      |

T-11e's guarantee is that the third row never happens without a `getProvider()`
call that selects `gemini`. Merely importing `env.ts` is **not** consumption: the
schema deliberately has no `superRefine` and no cross-field rule, so a process with
no key boots and a process with a key never validates it. Copying the optional value
into a config object that is never passed to `createProvider` also does not consume
it — the factory is what validates it (stage 4), and the factory is only reached
through `getProvider()`.

**`RuntimeDependencies` shape.** Two seams are added. Both default to production
behaviour, matching the existing convention in this file (`openDatabase?`,
`createRepository?`, `createApp?`):

```ts
export interface RuntimeDependencies {
  // ...existing seams unchanged...
  /** Defaults to `loadEnv`-validated `env` projected onto `LlmProviderConfig`. */
  readonly llmConfig?: LlmProviderConfig;
  /** Defaults to the real `createProvider` from `provider.factory.ts`. */
  readonly createProvider?: (
    config: LlmProviderConfig,
    deps: LlmProviderDeps,
  ) => Promise<LlmProvider>;
}
```

`llmConfig` exists so tests can supply deterministic configuration without real
credentials — a synthetic key, `provider: 'fake'`, or a deliberately missing key —
and without mutating `process.env`. It is a seam, not a second config system: it
overrides the projection of `env`, and when omitted the projection is used.

`createProvider` receives the transport **through the existing factory dependency
contract** (`LlmProviderDeps.createTransport`), not as a direct transport argument.
M4.4 therefore adds no new parameter to `createProvider` and does not modify
`provider.factory.ts`.

**Where the callback is created.** The `createTransport` callback is created
**inside** `getProvider()`, as part of the argument object passed to `createProvider`.
It is not created at `createRuntime()` time and not stored on the runtime. Its body
performs the literal-specifier dynamic import of `gemini.transport.ts` and calls
`createGeminiTransport({ apiKey, timeoutMs })` (§9.5.5.1, requirements 1–3).

**When it is invoked.** Never by the runtime. The factory invokes it, and only on
the `gemini` branch after credential validation (stage 6), so a `fake` selection or
a missing key never reaches it (§9.5.5.1, requirements 4 and 7).

**No signature change.** This contract needs no change to `createRuntime`'s public
signature: both new members are optional fields on the existing `RuntimeDependencies`
object, which `src/index.ts` already omits entirely.

**Why the existing design example was inconsistent.** §9.5.5 showed
`const provider = await createProvider(...)` at composition-root scope, which
cannot run inside a synchronous `createRuntime()`. The resolution is: the
composition root **does not await**. It stores a thunk that awaits on first use.
The snippet in §9.5.5 is corrected by this section and should be read as describing
the thunk's body, not `createRuntime()`'s body.

**No architectural conflict.** `createRuntime()` remains sync, `index.ts` needs no
change to its `const runtime = createRuntime()` line, and the 33 existing runtime
tests keep their synchronous setup. This is why lazy construction was chosen over
making `createRuntime` async.

**Summary of the M4.4 contract.** In one place, so nothing below has to be inferred:

| Item                        | Value                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| Accessor name               | `getProvider`                                                              |
| Signature                   | `getProvider(): Promise<LlmProvider>`                                      |
| Public interface membership | Yes — a member of the `Runtime` interface                                  |
| Config source               | `env`, projected once at `createRuntime()` into `LlmProviderConfig`        |
| Disposed error              | `RuntimeDisposedError`, defined in `src/runtime.ts`, extends plain `Error` |

#### 11.1.8.2 Disposal-aware caller promise semantics

Two promises exist and they must not be conflated:

| Promise                   | Stored where                   | Returned to callers? | Purpose                                      |
| ------------------------- | ------------------------------ | -------------------- | -------------------------------------------- |
| **Internal attempt**      | `ProviderCell.pending.attempt` | **No**, never        | Shared so `createProvider` runs exactly once |
| **Caller-facing wrapper** | Nowhere — created per call     | **Yes**, always      | Adds disposal awareness to that caller       |

`getProvider()` **must not return the internal attempt directly**. It returns a
**disposal-aware wrapper** around it. Sharing the attempt is what prevents duplicate
construction; wrapping per call is what makes disposal observable to a caller whose
call is still unsettled.

**The contract.** For every `getProvider()` call:

1. **First call.** `idle → pending` synchronously; exactly one `createProvider()`
   starts; the internal attempt is stored **before** any `await`.
2. **Concurrent calls while `pending`.** They share the same internal attempt —
   `createProvider` is not called again — and each receives its own wrapper.
3. **Initialisation succeeds before disposal begins.** Every waiting wrapper
   resolves with the **same** `LlmProvider` instance.
4. **Initialisation fails before disposal begins.** Every waiting wrapper rejects
   with the **initialisation error**, and the cell becomes `failed`, so a later call
   retries (§11.1.8).
5. **Disposal begins before a wrapper has settled.** That wrapper rejects with
   `RuntimeDisposedError` (`kind === 'disposed'`), **regardless** of whether the
   internal attempt later resolves or rejects.
6. **Late successful initialisation.** The provider is **never published and never
   returned** to a caller whose wrapper was already superseded by disposal. It is
   dropped, not stored, and not closed (§11.1.8).
7. **Late failed initialisation.** The error does **not** replace or leak to any
   caller whose operation disposal already superseded. Those callers keep the
   disposal error.
8. **Disposal never awaits the internal attempt.** Blocking shutdown on a hung build
   would prevent process exit.
9. **`disposed` is terminal.** No late outcome produces `disposed → ready` or
   `disposed → pending`. Nothing is accessible through a `Runtime` that entered
   `disposed`.

**Disposal wins.** Precedence is fixed: if disposal is signalled before a given
wrapper settles, that wrapper settles with `RuntimeDisposedError`. Initialisation
settlement does not override a disposal that already happened.

**This does not revoke a provider already delivered.** A provider returned by a
wrapper that settled **before** disposal began cannot be retroactively revoked. The
guarantee covers calls **still unsettled** when disposal begins. No text in this
document may claim that disposal invalidates a reference already handed to
application code.

**The wrapper settlement boundary.** "Settled" in this document means one specific
event, not a family of related ones:

> A caller-facing wrapper is **settled** at the moment its own arbitration logic
> **commits** by invoking its `resolve` or `reject` operation for that wrapper.

Settlement is therefore defined by the wrapper's own commit, and explicitly **not**
by any of the following:

- the internal attempt becoming fulfilled or rejected — that is an input to
  arbitration, not the decision;
- the scheduling of a promise reaction on the attempt;
- the moment the caller's `.then()` / `.catch()` handler runs — handler execution
  happens strictly after settlement and has no bearing on which outcome won.

**One-shot settlement.** Each wrapper has exactly **one** settlement decision. The
first arbitration operation that commits `resolve` or `reject` fixes that wrapper's
permanent outcome. A second commit is impossible by construction: the arbitration
must be guarded so that once one outcome commits, every later candidate is discarded
without effect. Disposal after a wrapper has already settled changes nothing for that
caller.

**Ordering rule.** Arbitration is a single synchronous decision that reads two facts:
whether the wrapper has already settled, and whether the disposal signal has been
observed. Its invariants are:

1. **Underlying completion alone does not settle a wrapper.** An attempt that
   fulfils or rejects only makes an outcome _available_; the wrapper commits only
   when its arbitration runs and chooses.
2. **Disposal wins only if observed first.** If the disposal signal is observed by
   the wrapper's arbitration **before** that wrapper commits another outcome, the
   wrapper commits `RuntimeDisposedError`.
3. **An earlier commit is final.** If arbitration already committed the provider (or
   the initialisation error) before disposal began, disposal cannot override it. This
   is the non-revocation boundary above, expressed at the commit point.
4. **No interleaving yields two outcomes.** State mutation and wrapper settlement
   cannot contradict each other, because settlement is gated on the same synchronous
   decision that reads the disposal flag.

**Same-tick and microtask ordering.** The rule is stated in terms of _observable
program order_, which JavaScript's single-threaded execution makes deterministic:

- **Attempt fulfils, then `dispose()` runs synchronously before the attempt's
  reaction runs.** Disposal is observed first, so the still-unsettled wrapper
  rejects with `RuntimeDisposedError`. The later fulfilment reaction finds the
  wrapper already settled and cannot resolve it with a provider.
- **Wrapper arbitration commits `resolve(provider)`, then `dispose()` runs.** The
  wrapper is already settled successfully; disposal cannot revoke it. The caller
  keeps the provider, exactly as the non-revocation boundary requires.
- **The equivalent rule for rejection.** Whichever arbitration commits first wins:
  an initialisation-error commit yields that error, a disposal commit yields
  `RuntimeDisposedError`. The two cannot both apply to one wrapper.

Because both `dispose()` and the arbitration step are synchronous decision points,
microtask reaction order is never the tiebreaker. The contract therefore holds under
same-tick and microtask interleavings alike, and it depends on **no** timing
assumption, sleep, or scheduler detail.

**Primitive freedom.** The design does not mandate a JavaScript primitive.
`Promise.race` against a disposal signal, a per-call deferred settled by whichever
event fires first, or an equivalent deterministic mechanism are all acceptable,
provided the settlement boundary and the four invariants above hold observably.

**Unhandled rejections.** A rejection handler must be attached to the internal
attempt **at the moment the attempt starts**, not when disposal occurs. This
guarantees the attempt is handled exactly once even if it rejects before any
disposal, and it prevents a late rejection from surfacing as an unhandled rejection
after the cell is `disposed`.

**Late settlement after disposal.** The internal attempt is internal: it is never
the promise a caller awaits. Once the cell is `disposed`, an attempt that settles
afterwards is **discarded**:

- **Late resolution** — the provider is dropped without being used. It is not
  stored, it is not published to any wrapper, and it is not closed (see below).
- **Late rejection** — the error is swallowed. Every caller whose wrapper had not
  settled when disposal began already rejected with `RuntimeDisposedError`
  (§11.1.8.2), so the late rejection must not replace that outcome. The internal
  attempt carries a handler attached at attempt start, so the rejection cannot
  surface as an unhandled rejection.

**`dispose()` is idempotent.** A second call is a no-op. The existing `dispose()`
already sets its `disposed` flag before closing the database, and the cell's
`disposed` flag follows the same order: set first, then anything else.

**Disposal does not close the provider.** `LlmProvider` has no `close()`,
`dispose()` or `shutdown()` member, and the runtime holds no handle to release. A
resolved provider is simply dropped. This is a deliberate non-behaviour: adding a
close contract to `LlmProvider` would be an interface change outside M4.4 and would
force every adapter to implement teardown it does not need, since the transport
opens a socket per `send()` and holds none between calls.

**Shutdown race.** If the runtime is disposed while the cell is `pending`:

1. `dispose()` sets a `disposed` flag **before** awaiting anything.
2. The internal attempt is **not** awaited by `dispose()`; blocking shutdown on a
   hung network call would prevent the process from exiting.
3. When the internal attempt settles after disposal, its result is **discarded**:
   if it resolved, the provider is dropped without being used and is not published
   to any wrapper; if it rejected, the error is swallowed and cannot replace a
   caller's `RuntimeDisposedError` (§11.1.8.2).
4. Every caller whose wrapper was **still unsettled** when disposal began rejects
   with `RuntimeDisposedError`. This applies whether the attempt later resolves or
   rejects.
5. A call to `getProvider()` after disposal **rejects immediately** with
   `RuntimeDisposedError`. It does not start a new initialisation, does not call
   `createProvider`, and does not resolve the transport.

**The disposed error.** Every post-disposal call **rejects with a freshly created**
`RuntimeDisposedError` rather than a shared rejected promise. A shared promise would
be one object with one rejection reason; a caller attaching its own handler later
would still see a settled promise, and nothing would distinguish "rejected long ago"
from "rejected for this call". A fresh instance per call also avoids an unhandled
rejection being created when no caller ever observes the shared one.

```ts
// src/runtime.ts — owned by the composition root, outside the LlmError hierarchy
export type RuntimeErrorKind = 'disposed';

export class RuntimeDisposedError extends Error {
  readonly kind: RuntimeErrorKind = 'disposed';

  constructor(message = 'Runtime has been disposed') {
    super(message);
    this.name = 'RuntimeDisposedError';
  }
}
```

Its identity is fixed by five properties:

| Property        | Value                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| Class name      | `RuntimeDisposedError`                                                              |
| `name` property | `'RuntimeDisposedError'`                                                            |
| `kind` property | `'disposed'`, typed as `RuntimeErrorKind` (Section 6.1.1)                           |
| Base class      | plain `Error` — **not** `LlmError`, so no `retryable`, `providerId` or `statusCode` |
| Owning module   | `src/runtime.ts`                                                                    |

Message semantics: it states the runtime lifecycle condition, never a credential,
provider name or configuration value. It carries no `cause`, because there is no
underlying failure — disposal is not an error condition of the provider, it is a
refusal to start one. Tests identify it by `kind === 'disposed'` and by
`instanceof RuntimeDisposedError` (with `instanceof LlmError === false`), never by
matching message text. The full identification contract is Section 6.1.1.

**Type relationships.** The relationships are fixed as follows:

| Symbol                | Signature                                 | Note                                              |
| --------------------- | ----------------------------------------- | ------------------------------------------------- |
| `createRuntime`       | `(deps?: RuntimeDependencies) => Runtime` | Stays **sync**; unchanged signature               |
| `createProvider`      | `(config, deps) => Promise<LlmProvider>`  | Stays **async**; unchanged signature              |
| `Runtime.getProvider` | `() => Promise<LlmProvider>`              | New. The only async seam on `Runtime`             |
| `RuntimeDependencies` | gains `createProvider?` and `llmConfig?`  | Test seams; default to the real factory and `env` |

### 11.2 Phase 4 blocking conditions

Phase 4 does not start until the following are resolved and recorded. Each one
gates a claim the document would otherwise make without evidence.

| #   | Blocking condition                                                                                                                                       | Unblocks                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| B-1 | Gemini integration chosen: official SDK, or a direct implementation of the documented HTTP API (Section 9.5.2, rule S-1 vs S-2)                          | 9.5.2 questions 1–4          |
| B-2 | If an SDK is used, a **verified** injection point exists in its official documentation, with the SDK version and the exact option recorded — not assumed | `GeminiTransport` being real |
| B-3 | If no verified injection point exists, the adapter is implemented directly against the documented Gemini HTTP API, with no second HTTP client            | Single-egress principle      |
| B-4 | Concrete vendor model ids for `default`, `fast`, `high-quality` confirmed against the current vendor model list                                          | Section 11.1 model mapping   |
| B-5 | Both static parts are computed and their allow-lists recorded: the adapter closure (9.5.3.1) **and** the production composition path (9.5.3.3a)          | T-10a assertion 5            |
| B-6 | Assertion 4 has an evidence mechanism that meets the bar: N-1 available, **or** N-2 with a fully accounted coverage table (Section 9.5.3.6)              | T-10a assertion 4            |

#### 11.2.1 Status after M4.0 and M4.0.1

M4.0 and M4.0.1 are specification phases. They resolve the conditions that are
answerable from documentation and **records** the ones that are not. No code was
written, so B-5 is not claimed as met.

M4.0.1 changed the chosen interface (B-3) but changed **no** B-status: nothing in
this revision produces runtime evidence, so no condition moves from BLOCKED or OPEN
to RESOLVED. B-6 in particular is untouched (§11.2.2).

| #   | Status after M4.0         | Evidence / reason                                                                                                                                                                                                                               |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | **RESOLVED**              | Direct HTTP chosen (§11.1.3). No SDK. Rule S-2 applies, not S-1                                                                                                                                                                                 |
| B-2 | **NOT APPLICABLE**        | No SDK is used, so no SDK injection point is required. Condition is void, not satisfied-by-assumption                                                                                                                                           |
| B-3 | **RESOLVED (design)**     | Adapter written directly against the documented `v1/interactions` API; `node:https` is the only client (§11.1.5, §11.6.4)                                                                                                                       |
| B-4 | **RESOLVED (proposed)**   | Model ids confirmed against Google's official pages on 2026-11-18 (§11.1.1), and re-verified against the Interactions API model enum in M4.0.1. The mapping is **proposed for approval**, so B-4 closes on approval, not on this document alone |
| B-5 | **OPEN — implementation** | The two allow-lists can only be computed once the adapter and composition root exist. This is a Phase 4 implementation task, not a specification task                                                                                           |
| B-6 | **BLOCKED**               | N-1 was not demonstrated in this environment; no complete N-2 coverage table exists. Assertion 4 remains BLOCKED (§11.2.2)                                                                                                                      |

**B-6 remains the single hard blocker.** It is not resolved by this document, and
this document does not claim it is.

#### 11.2.2 B-6 network isolation: decision and current evidence (Q-4)

N-1 (process-level egress denial) is **preferred**. N-2 is a fallback and only
qualifies with a fully accounted coverage table.

| Mechanism | Status in this environment                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| N-1       | **Not demonstrated.** No OS/CI egress-denial policy is configured or verified for this project                           |
| N-2       | **Incomplete.** The existing probe covers 6 surfaces; the required table has 11 rows, and several are entirely uncovered |
| N-3       | Supporting only; never sufficient alone                                                                                  |

**N-2 coverage table as it stands today.** This is the honest audit, not a claim:

| Surface                           | Required by §9.5.3.6 | Covered by current probe | Status                                    |
| --------------------------------- | -------------------- | ------------------------ | ----------------------------------------- |
| `node:http` (`request`/`get`)     | Yes                  | Yes                      | Covered                                   |
| `node:https` (`request`/`get`)    | Yes                  | Yes                      | Covered                                   |
| `node:net` (`connect`)            | Yes                  | Yes                      | Covered                                   |
| `node:tls` (`connect`)            | Yes                  | Yes                      | Covered                                   |
| `node:dns` (`lookup`, promises)   | Yes                  | Yes                      | Covered                                   |
| Global `fetch`                    | Yes                  | Yes                      | Covered                                   |
| `node:http2`                      | Yes                  | **No**                   | **UNCOVERED**                             |
| `undici` (module/dispatch)        | Yes                  | **No**                   | **UNCOVERED**                             |
| `child_process`                   | Yes                  | **No**                   | **UNCOVERED**                             |
| `worker_threads`                  | Yes                  | **No**                   | **UNCOVERED**                             |
| Native addons / non-JS networking | Yes                  | **No**                   | **UNCOVERED — not interceptable from JS** |

Five rows are uncovered, and the last one is not interceptable from JavaScript at
all. Under §9.5.3.6's decision rule 5, **assertion 4 is BLOCKED** and T-10a cannot
be marked passing.

**What would unblock B-6.** Either:

1. **N-1**: a verified egress-denied sandbox or CI network policy, recorded with the
   mechanism and the command/policy that establishes it; **or**
2. **N-2**: extend the probe to `http2`, `undici` dispatch, `child_process`, and
   `worker_threads`, **and** provide a compensating control for native addons
   (e.g. a dependency allow-list proving no native addon is present), with every row
   either verified or explicitly declared uncovered-plus-compensated.

Option 2 is substantial work and is **not** authorized by M4.0. It is scheduled as
its own milestone (Section 11.5, M4.6) and requires explicit approval.

**No test in this phase exercises the network.** Q-4 is satisfied as a
specification only; no isolation test was run, and none is claimed to have passed.

These are not advisory. B-1 through B-3 decide the transport architecture; B-5 and
B-6 decide whether T-10a can carry its evidence at all.

If B-2 fails and B-3 cannot be satisfied either, Phase 4 **stops** under rule S-3:
T-10a is not marked passing, no network-isolation claim is made, and the blocking
reason is recorded for redesign and explicit re-authorisation. Accepting a weaker
guarantee is not an available outcome.

If B-5 or B-6 is unmet, T-10a cannot pass even if assertions 1–3 hold, because its
architecture and isolation evidence would be missing. A partial T-10a is a failed
T-10a.

**B-6 is BLOCKED by default until proven.** At the time of writing, neither N-1 nor
a complete N-2 has been demonstrated in this project's test setup. Assertion 4
therefore stands as **BLOCKED**, and T-10a cannot be marked passing, until a later
step supplies the evidence. This is recorded rather than assumed: the document does
not claim network isolation today, only that the requirement and its evidence bar
are defined.

Two things are explicitly **not** blocked and can proceed now: Phase 1–3 work needs
no vendor SDK at all, and the interface in Section 9.5 is settled regardless of
which option B-1 selects.

### 11.3 Pre-existing gaps and how this revision resolves them

These are the eight gaps identified before M4.0. Each is resolved here or explicitly
left open with a reason.

| #   | Gap                                                                    | Resolution in this revision                                                                                                                                  | Status               |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 1   | `LLM_MAX_OUTPUT_TOKENS` is parsed but has no consumer                  | §11.3.1 fixes the consumption path: env → composition layer → `LlmRequest.maxOutputTokens` → `generationConfig.maxOutputTokens`. T-16a/b/c verify each layer | **Resolved (spec)**  |
| 2   | `GeminiTransport` is type-only with no implementation                  | §11.1.5 specifies the `node:https` implementation, lifecycle, limits and cleanup. Implementation is M4.1                                                     | **Resolved (spec)**  |
| 3   | The factory's `gemini` branch throws before the transport seam         | §11.3.2 specifies the replacement stages (5–6). The throw is removed in M4.3, after the adapter exists                                                       | **Resolved (spec)**  |
| 4   | `createRuntime()` is sync, but the design shows `await createProvider` | §11.1.8 defines the lazy cached-promise cell, the sync `createRuntime` signature, and `getProvider()` as the new async accessor                              | **Resolved (spec)**  |
| 5   | `undici` is not a declared dependency and must not be added            | §11.1.5 restricts the transport to `node:https`. `undici` is **not** added. The transitive `jsdom` copy is never imported by production code                 | **Resolved**         |
| 6   | SSRF, response-size limit and redirect behaviour were unspecified      | §11.1.5 and §11.1.6 specify all three, including the reuse boundary against extraction's guard                                                               | **Resolved (spec)**  |
| 7   | T-10a assertion 4's isolation evidence must satisfy Q-4                | §11.2.2 records the audit and keeps assertion 4 **BLOCKED**. No weaker evidence is accepted                                                                  | **BLOCKED (honest)** |
| 8   | Phase 3 status must match the accepted result                          | §11.0 and §11.0.1/11.0.2 record PASS WITH LIMITATIONS and preserve all six limitations                                                                       | **Resolved**         |

#### 11.3.1 `maxOutputTokens` consumption path (gap 1)

| Layer       | Responsibility                                                                 | Verified by |
| ----------- | ------------------------------------------------------------------------------ | ----------- |
| Env         | `LLM_MAX_OUTPUT_TOKENS` parses, defaults to `2048`, rejects outside `1..32768` | T-16a       |
| Composition | The env value seeds `LlmRequest.maxOutputTokens`; a caller override wins       | T-16b       |
| Adapter     | Copies the value to `generationConfig.maxOutputTokens` **unmodified**          | T-16c       |
| Factory     | **Never reads it.** It is a per-request budget, not a provider setting         | T-07..T-10  |

The value is never clamped by the adapter. A value outside the vendor's own limit
is the vendor's rejection to make, and surfaces as `invalid_request` — the adapter
does not silently rewrite a caller's budget.

#### 11.3.2 Factory stages 5–6 (gap 3)

The current terminal `LlmConfigurationError` on the `gemini` branch is replaced by:

```
stage 5  const { GeminiProvider } = await import('./providers/gemini.provider.js')
stage 6  const transport = await deps.createTransport()      ← the only invocation
         const adapterConfig = {
           provider: config.provider,
           model: config.model,
           timeoutMs: config.timeoutMs,
         }
         return new GeminiProvider(adapterConfig, { transport })
```

**The adapter config is built field by field, and that is a security requirement,
not a style choice.** `adapterConfig` is a new object whose only properties are the
three non-secret fields of `GeminiProviderConfig` — `provider`, `model` and
`timeoutMs`, exactly the fields the adapter reads (§9.5.4). `apiKey` is never
copied, because it is never named. The original `config` object is not passed to the
constructor, and no spread of it is used as a shortcut.

Three forms are prohibited here, for the reason given in §9.5.4:

- `new GeminiProvider(config, { transport })` — carries the live key at runtime;
- `new GeminiProvider({ ...config }, { transport })` — the spread copies `apiKey`;
- `new GeminiProvider(config as GeminiProviderConfig, { transport })` — a type
  assertion hides the property without removing it.

Type-level narrowing alone cannot satisfy this: `LlmProviderConfig` is assignable to
`GeminiProviderConfig` under structural typing, so all three of the above compile.
The explicit literal is what makes the exclusion observable at runtime, and it is
what the M4.3 tests assert (§11.5.2).

Ordering is preserved exactly: credential validation (stage 4) still precedes the
seam, so a missing key never resolves a transport (T-09). The `fake` branch still
skips stages 4–6 entirely (T-07). The key continues to reach the transport and
nothing else: the composition root closes over it when it supplies
`createTransport` (§9.5.5), and the adapter receives only the transport value.

### 11.4 Open items requiring a decision

Recorded, not decided. None of these blocks the specification; each blocks a
specific implementation choice.

| #   | Open item                                                                                                    | Blocks                  | Status after M4.0.2                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| O-1 | Ratify the proposed model mapping in §11.1.1 (`gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-4-argon`) | B-4 closure and M4.2    | **RATIFIED (M4.2 reconciliation)** — the three ids are approved exactly as listed; see §11.1.1                                    |
| O-2 | `temperature` policy given §11.1.2                                                                           | M4.2 request mapping    | **RESOLVED (spec)** — never sent; see §11.1.2 and §11.6.5.1                                                                       |
| O-3 | Whether N-1 egress denial is available; otherwise approve the N-2 extension work                             | B-6 / T-10a assertion 4 | **BLOCKED** — unchanged by M4.0.1 and M4.0.2                                                                                      |
| O-4 | Whether to adopt the Interactions surface instead of `generateContent`                                       | §11.1.3                 | **RESOLVED (recommendation)** — Interactions API adopted; see §11.6.12                                                            |
| O-5 | Whether deployment requires an egress proxy                                                                  | M4.1 transport          | **APPROVED** — direct HTTPS, no proxy support, deployment must provide egress control (§11.6.9)                                   |
| O-6 | Whether DNS pinning for the fixed vendor host is in scope                                                    | Optional hardening      | **PROPOSED** — deferred, path named (§11.6.10)                                                                                    |
| O-7 | Response body size ceiling value for LLM responses                                                           | M4.1 transport          | **APPROVED AS PROVISIONAL** — 1 MiB success / 64 KiB error; verified by approved test T-19 (§11.6.8.7). Values remain provisional |

**What changed in M4.0.2.** O-5 moved from PROPOSED to **APPROVED** as an approach,
and O-7 from NEEDS USER APPROVAL to **APPROVED AS PROVISIONAL** with a full capacity
analysis. "Provisional" is deliberate: the values are authorised as working limits
but are not proven safe until implementation-stage verification (§11.6.8.8).

**What changed in M4.0.3.** T-19 was formally approved and registered, so the O-7
test-coverage gap is closed (§11.6.8.7). The 32,768 maximum on
`LLM_MAX_OUTPUT_TOKENS` was explicitly retained (§11.6.8.4a). **Neither change
upgrades O-7 from provisional**: a registered test proves the reader enforces
whatever ceiling is configured; it does not prove the chosen values are safe.

**What did not change.** O-1 was **pending user approval** at M4.0.3 and has since
been **ratified** in the M4.2 reconciliation (§11.1.1, §11.4): the pricing work in
this revision documented cost; the mapping itself is now approved. O-3 remains
**BLOCKED**, and it is the same blocker as before: network isolation is not a
specification problem, and no API or pricing decision can close it.

**O-6 remains PROPOSED and is not affected by the O-5 approval.** O-5 approves the
connection _path_ (direct, no proxy); O-6 asks about _address pinning_ on that path.
Approving one does not approve the other.

### 11.5 Revised Phase 4 milestones

The milestone split from the specification proposal is retained, with M4.0 now
complete. Each milestone remains independently reviewable and leaves the suite
green.

| Milestone  | Goal                                                                    | Depends on                | Stop condition                                           |
| ---------- | ----------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| **M4.0**   | Specification revision (§11.1)                                          | —                         | **Complete**                                             |
| **M4.0.1** | API interface re-evaluation (§11.6)                                     | —                         | **Complete** — Interactions API adopted                  |
| M4.1       | Transport implementation (`node:https`, §11.6.4)                        | O-5, O-7                  | Single egress cannot be shown → S-3 stop                 |
| M4.2       | Adapter implementation (`/v1/interactions`) + `gemini.provider.test.ts` | M4.1, O-1 (ratified), O-2 | Adapter needs a networking import                        |
| M4.3       | Factory wiring (§11.3.2)                                                | M4.2                      | Unintended Phase 2 product behaviour changes (§11.5.2)   |
| M4.4       | Runtime lazy composition (§11.1.8, §11.5.3)                             | M4.3                      | Sync/async cannot be reconciled (none expected)          |
| M4.5       | Static architecture evidence (B-5)                                      | M4.2, M4.4                | A bare specifier cannot be justified                     |
| M4.6       | Network isolation evidence (B-6)                                        | O-3                       | Neither N-1 nor complete N-2 → assertion 4 stays BLOCKED |
| M4.7       | Integration, gates, T-16a/b/c, T-17, T-18                               | M4.1–M4.6                 | Any gate red                                             |

M4.1 no longer depends on O-3: choosing the interface does not resolve network
isolation, and gating transport work on it would conflate two independent problems.
O-3 continues to gate **M4.6**, where the isolation evidence is actually produced.

#### M4.3 stop-condition semantics (F-2)

The M4.3 stop condition reads "unintended Phase 2 **product behaviour** changes".
It is about what the factory does at runtime, not about what its test file says.
The distinction matters because M4.3 must edit that test file, and an earlier
wording ("any Phase 2 test changes behaviour") read as though the edit itself were
the violation.

**Authorized in M4.3** — each of these is a required part of the milestone, not a
concession. Three specific tests in `provider.factory.test.ts` are authorized to
change, and only these three:

| Line (baseline) | Test                                                                                 | Authorized change                                                    |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 164             | `does not expose a supplied key value in the error message`                          | **Replaced** by a runtime credential-isolation test (§11.5.2 G)      |
| 243             | `terminates with the not-implemented error when the key and the seam are both valid` | **Replaced** by the approved Gemini success-path test (§11.5.2 B, C) |
| 268             | `never silently returns a fake provider for a configured gemini selection`           | **Strengthened** to use a successful transport double (§11.5.2 H)    |

Each of the three is a forced consequence of the same approved behaviour change: the
`gemini` branch no longer terminates before stage 6. All three supply a **valid**
key and a transport seam, so all three currently pass only because the terminal
throw pre-empts transport resolution. Removing that throw necessarily invalidates
all three, not one. A revision that authorized only the pinned test would leave the
milestone with a red gate and no lawful way to clear it.

The remaining authorized items are the additions those three changes require:

- the Gemini success-path assertions specified in §11.5.2 C;
- the runtime credential-isolation assertions specified in §11.5.2 G;
- the successful-double assertions specified in §11.5.2 H;
- updating expectations that directly represent the approved Factory wiring
  behaviour, such as "the `gemini` branch now resolves a provider".

**The retired responsibility.** Test 164's original subject — "a supplied key never
appears in an error message, `cause`, or serialized error" — is **explicitly retired
from this M4.3 Factory test location**. That subject is not abandoned: it is T-18's
responsibility (§11.1.7), assigned to **M4.7**, and it remains fully registered and
unmodified. M4.3 neither completes nor narrows T-18; it only stops hosting a
partial duplicate of it in the Factory file. The replacement at that location tests
a different property — runtime credential isolation on the success path — which
only M4.3 can test, because only M4.3 makes the success path reachable.

**Not authorized in M4.3** — any of these is a stop condition:

- changing unrelated Phase 2 product behaviour;
- weakening unrelated Phase 2 assertions, or editing unrelated test semantics so a
  test passes;
- changing the order of credential validation relative to transport resolution;
- changing `fake`-provider behaviour, including invoking the transport seam;
- changing unknown-provider behaviour, including introducing a fallback;
- any change to `T-10`'s import-purity or type-only-transport constraints.

The stop condition therefore separates **authorized test-expectation updates**
from **unauthorized product-behaviour drift**. A reviewer applying it asks: did the
factory's observable behaviour change outside the `gemini` success path? Editing the
test file to match the authorized new behaviour is not, by itself, a violation.

#### 11.5.1 M4.2 adapter unit-test responsibilities

M4.2 owns the adapter **and** its own unit tests, in the file allocated for them:

`tests/unit/core/llm/gemini.provider.test.ts`

Every test in that file drives the adapter through a **recording transport
double** passed as the required `GeminiProviderDeps.transport`. No test opens a
socket, and none loads `gemini.transport.ts`.

M4.2 asserts, at minimum:

| #   | Assertion                                                                                                       | Design reference                             |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | Construction sends no request: the recording double has zero calls                                              | §9.5.4, T-10a assertion 2 (restated locally) |
| 2   | `complete()` issues exactly one request through the injected double                                             | §9.5.1                                       |
| 3   | Every applicable request body contains `store: false`                                                           | §11.1.3, §11.6.4.1                           |
| 4   | No request body contains a `temperature` key, even when the request supplies one                                | §11.1.2                                      |
| 5   | `generation_config.max_output_tokens` equals the request value, unmodified                                      | §11.6.5                                      |
| 6   | `model` is the mapped vendor id; a logical alias is never transmitted                                           | §11.1.1                                      |
| 7   | `status` maps to the three-valued `truncated` (`completed`→`false`, `incomplete`→`true`, absent/unknown→`null`) | §11.6.4.3                                    |
| 8   | A non-2xx response maps to the documented `LlmError` kind by `error.code`                                       | §11.6.6                                      |
| 9   | An unknown logical alias throws `LlmConfigurationError` at construction                                         | §11.1                                        |
| 10  | Text is joined over `model_output` steps only; other step types are ignored                                     | §11.1.3                                      |
| 11  | Empty output is `LlmEmptyResponseError`, never an empty success                                                 | §11.1.3                                      |
| 12  | Absent usage fields yield `null`, never `0`                                                                     | §4.2                                         |

**Ownership boundary — M4.2 does not absorb M4.7's tests.** Adding these adapter
unit tests does **not** mark T-16c, T-17 or T-18 complete. Those three remain
assigned to **M4.7**, where they are registered, counted and accepted as part of
the gate run. M4.2's assertions 5, 7 and 8 above overlap their subject matter, but
the registered T-IDs stay open until M4.7 runs them under the full matrix. Where a
property is duplicated, M4.7 remains the authority; M4.2's version is a local
guard, not a substitute.

**T-10a is unchanged.** It stays in `tests/unit/core/llm/provider.factory.test.ts`
and is **not** edited by M4.2. Its assertion 4 (process-level egress denial) remains
**BLOCKED** under B-6. M4.2 asserts `store: false` locally, in its own file, and
does not claim T-10a coverage.

#### 11.5.2 M4.3 factory wiring test responsibilities

M4.3 owns the factory wiring **and** the updates its own unit tests require. The
file is the existing `tests/unit/core/llm/provider.factory.test.ts`; M4.3 allocates
no new test file and no new dependency. The adapter's tests
(`gemini.provider.test.ts`) are **not** edited by M4.3.

M4.3 changes exactly one production module, `provider.factory.ts`, and only its
`gemini` branch stages 5–6 (§11.3.2). Everything else the factory does is asserted
to be unchanged, not re-implemented.

##### A. Existing registered tests that must remain valid

These keep their registered identities, their original purposes and their counts.
M4.3 must leave them green; it must not redefine them.

| ID    | Registered purpose                                           | M4.3 obligation                                                                                                                                             |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-07  | `fake` builds a fake and never invokes the transport seam    | Unchanged; the `fake` branch still skips stages 4–6                                                                                                         |
| T-08  | Unknown provider throws `LlmConfigurationError`, no fallback | Unchanged; stage 3 still rejects unknown values                                                                                                             |
| T-09  | A missing key throws before the transport is resolved        | Stage 4 still precedes stage 6; the two `apiKey: undefined`/blank cases are unchanged. The **valid-key** case (baseline line 164) is replaced per §11.5.2 G |
| T-09a | `loadEnv()` succeeds with `gemini` and no key                | Unchanged; the env schema still does not require it                                                                                                         |
| T-10  | Importing the factory performs no work                       | Unchanged; import purity and the type-only transport reference are preserved                                                                                |

T-10's two structural constraints still bind M4.3: no `process.env` read at module
scope, and `gemini.transport.ts` referenced only through `import type`. The stage 5
dynamic import names `providers/gemini.provider.js`, not the transport module, so it
does not weaken either constraint.

##### B. The pinned not-implemented test is replaced

The test that pins the Phase 2 terminal message — "The Gemini provider adapter is
not implemented in this build" (baseline line 243) — is **deliberately replaced**,
as §10.1 requires. Its replacement asserts the approved Gemini success path rather
than the old terminal error. Deleting the test without replacing it is not
authorized; neither is weakening it to assert only that "something resolves".

It is one of three tests that the terminal throw currently props up; the other two
are handled in §11.5.2 G (baseline line 164) and §11.5.2 H (baseline line 268). All
three supply a valid key and a transport seam, so all three are invalidated by the
same approved change.

##### C. Required Gemini success-path coverage

The replacement and the new cases must assert, at minimum:

| #   | Assertion                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `provider: 'gemini'` with a valid synthetic key resolves to an instance of `GeminiProvider`                                            |
| 2   | `deps.createTransport()` was invoked **exactly once**                                                                                  |
| 3   | The value returned by the seam is the transport the adapter received                                                                   |
| 4   | The adapter received a **fresh** config object — not the factory's `LlmProviderConfig` instance                                        |
| 5   | That config object has **no** `apiKey` property (`expect(cfg).not.toHaveProperty('apiKey')`)                                           |
| 6   | The synthetic key does not appear in the returned provider's configuration, its `message`, `String(error)`, or `JSON.stringify(error)` |
| 7   | Construction issued **no** network request — the recording double's call count is `0`                                                  |

Assertion 4 is the runtime counterpart of §9.5.4's compile-time restriction and is
the direct guard for F-1. A test that only checks the static type would pass while
the live key rode along, so 4 and 5 must inspect the **actual object**, not a type
annotation. Assertion 6 uses the same anti-leak style as T-18 (§11.1.7) but stays
local to M4.3; it does **not** claim T-18 coverage.

Credentials are synthetic placeholders (for example `'test-key-not-real'`), and the
transport is a recording double. No test in this file opens a socket, loads
`gemini.transport.ts`, or calls a real Gemini endpoint.

##### D. Error and ordering coverage

M4.3 must also confirm the wiring did not disturb the existing ordering. Using
§5.2's stage numbering (stage 3 provider name, stage 4 credential + seam presence,
stage 5 adapter load, stage 6 transport resolution):

- a missing or blank key fails **before** `createTransport` is invoked — stage 4
  precedes stage 6 (T-09's ordering, restated for the new branch);
- a `gemini` build with no `createTransport` seam still throws
  `LlmConfigurationError` at stage 4, before the stage 5 adapter load;
- `fake` still bypasses stages 4–6 entirely (T-07);
- an unknown provider still throws at stage 3 with no fallback (T-08);
- the **stage 3 → 4 → 5 → 6** order is unchanged: provider name, then credential
  and seam presence, then adapter load, then transport resolution.

##### E. Test registration

**M4.3 introduces no new registered T-ID.** At M4.3 the registered total remained
**27**; M4.4 Revision 1 later raised it to 31 by registering T-20..T-23.
New assertions and new `it()` cases live inside the existing factory test file and
do not add a row to the matrix. This mirrors the M4.2 reconciliation, which also
added local tests without changing the count.

- **T-10a remains BLOCKED**, including assertion 4 (process-level egress denial).
  M4.3 does not edit it, does not weaken it, and does not claim it.
- **T-11e** (runtime startup) stays with M4.4/M4.7.
- **T-16c, T-17, T-18** stay with M4.7.
- M4.3 must not redefine, absorb or resolve any deferred test responsibility.

Three tests change (baseline lines 164, 243, 268 — §11.5.2 G, B/C, H respectively).
None of them is a registered T-ID; they are `it()` cases inside T-09's and the
Phase 2 Factory's describe blocks. Replacing or strengthening them therefore leaves
the registered count untouched (27 at M4.3; 31 after M4.4 Revision 1).

**What the replacements do _not_ do.** The test at baseline line 164 is replaced by
a runtime credential-isolation test (§11.5.2 G). That replacement is **not** T-18
completion and must not be reported as such. T-18 remains a registered Phase 4 test
owned by M4.7, covering the broader property that a synthetic key never appears in
an error message, a log line, or a propagated vendor body. M4.3 verifies a narrower,
different property — that the live key never reaches the adapter's config object on
the success path — which T-18 does not cover and which is only reachable once M4.3
wires the factory. The two are complementary, not overlapping.

##### F. Quality gates

M4.3's acceptance run is expected to report, at minimum:

- the factory tests, including the replaced and added cases;
- the Gemini adapter tests (`gemini.provider.test.ts`);
- the Gemini transport tests (`gemini.transport.test.ts`);
- the fake-provider tests (`fake.provider.test.ts`);
- the full Vitest suite;
- `tsc --noEmit` typecheck;
- ESLint;
- Prettier `--check`.

These are expectations for the M4.3 acceptance report. This section is a
specification; it records no test result, and nothing here should be read as a claim
that any gate has passed.

##### G. Baseline line 164 — replaced by a runtime credential-isolation test

**Why it must change.** The existing test
`does not expose a supplied key value in the error message` supplies a **valid** key
and `instrumentedTransport().create`, then asserts a `LlmConfigurationError` and
`transport.calls === 0`. It passes today only because the terminal throw at stage 6
pre-empts the seam. Once M4.3 wires the branch, stage 6 invokes the callback: the
double increments its counter and throws a plain `Error`, so both assertions invert.
The test cannot survive M4.3, and its subject is not M4.3's to keep — see §11.5.2 E
on the T-18 boundary.

**The replacement.** One `it()` case, in the same describe block, asserting the
runtime half of F-1. It supplies a valid synthetic key and a **successful** recording
transport, and verifies:

| #   | Assertion                                                                                   |
| --- | ------------------------------------------------------------------------------------------- |
| 1   | A valid Gemini API key is supplied to `createProvider`                                      |
| 2   | The Factory reaches `GeminiProvider` construction — the constructor is entered, not skipped |
| 3   | The constructor receives a config object that is **not** the factory's `LlmProviderConfig`  |
| 4   | That config has exactly the keys `provider`, `model`, `timeoutMs` — no more, no fewer       |
| 5   | `expect(cfg).not.toHaveProperty('apiKey')` — the property is absent, not merely `undefined` |
| 6   | `deps.createTransport()` was invoked exactly once                                           |
| 7   | The transport passed to the constructor is the value the seam resolved                      |

Assertion 4 is stated as exact key-set equality, not as a subset check. A subset
check would pass if the factory forwarded an extra property; exact equality is what
distinguishes "built field by field" from "narrowed by annotation".

Assertion 5 must use `toHaveProperty`/`in`, never `cfg.apiKey === undefined`. Under
`exactOptionalPropertyTypes` a present-but-undefined property is a different runtime
state from an absent one, and only the absent state satisfies F-1's runtime claim.

**What this replacement is not.** It is not T-18, it does not complete T-18, and it
does not restore the retired error-message coverage. It proves that the live key
does not reach the adapter's config on the success path. T-18's broader property —
no key in an error message, log line, or propagated vendor body — remains M4.7's,
fully registered and unmodified.

##### H. Baseline line 268 — strengthened to a successful transport double

**Why it must change.** `never silently returns a fake provider for a configured
gemini selection` currently uses `instrumentedTransport()`, whose callback throws.
After wiring, it would still report `rejected` — but for the wrong reason: the
transport double threw, not "no adapter exists". The assertion would pass while its
registered intent became vacuous. That is silent semantic drift, not coverage.

**The authorized change.** Supply a **successful** transport double (a recording
`send` returning a canned `200` envelope) so that the only reason the call can
resolve is a real `GeminiProvider`. Then assert:

- the call **resolves** — it does not reject;
- the resolved provider is a `GeminiProvider`, and `provider.id === 'gemini'`;
- the resolved provider is **not** a `FakeProvider`;
- `provider.complete(...)` returns text from the transport double, not the factory's
  placeholder `FACTORY_FAKE_TEXT`.

The last point is what makes the test meaningful: it distinguishes "a real adapter
was constructed" from "the factory fell back to a fake". Checking only
`not.toBeInstanceOf(FakeProvider)` would be weaker than checking the observed output.

**This is an authorized strengthening, not an unrelated semantic change.** The test
keeps its identity, its describe block, and its registered purpose ("no silent fake
fallback"); only the double changes from throwing to succeeding, so that the test
can observe the success path the milestone creates.

##### I. Observing the constructor argument without changing production source

§11.5.2 C.4/C.5 and G.3–G.5 require observing the object passed to
`new GeminiProvider(...)`. That object is not publicly reachable: the adapter stores
it as `private readonly config` and exposes no accessor. Adding an accessor would
change production source, which M4.3 may not do. Inspecting the private field via
`as any` is prohibited as the sole mechanism, and would also be brittle.

**Specified strategy: a capturing subclass installed by `vi.mock`.** The test file
already mocks `gemini.transport.js` at module scope to detect loads; this reuses the
same established pattern for a different purpose.

```ts
// tests/unit/core/llm/provider.factory.test.ts — module scope
let capturedConfig: unknown;
let capturedDeps: { transport: GeminiTransport } | undefined;

vi.mock('../../../../src/core/llm/providers/gemini.provider.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/core/llm/providers/gemini.provider.js')>();
  class CapturingGeminiProvider extends actual.GeminiProvider {
    constructor(config: GeminiProviderConfig, deps: GeminiProviderDeps) {
      capturedConfig = config;
      capturedDeps = deps;
      super(config, deps);
    }
  }
  return { ...actual, GeminiProvider: CapturingGeminiProvider };
});
```

This satisfies all three requirements at once:

| Requirement                | How it is met                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| A real `GeminiProvider`    | `super(config, deps)` runs the genuine constructor — model validation, `this.config`, `this.model`  |
| Exact constructor argument | `capturedConfig` is the very object reference the factory passed, not a copy                        |
| Fresh object / no key      | Identity (`expect(capturedConfig).not.toBe(factoryConfig)`) plus exact key-set and `toHaveProperty` |

**Why `instanceof` still works.** The factory reaches the adapter through
`await import('./providers/gemini.provider.js')`, which resolves to the same module
id the test mocks, so the factory receives `CapturingGeminiProvider`. When the test
asserts `expect(provider).toBeInstanceOf(GeminiProvider)` against its own import of
that path, both sides reference the same mocked export and the check is meaningful.

**Stated limitation — do not overstate this.** `instanceof` is evaluated against the
_mocked_ binding, which is a subclass, not the pristine class. The evidence that the
real class was constructed comes from `super()` running and from the subclass
producing genuine behaviour (correct `model.vendorModelId`, a real `complete()`
round-trip through the transport double). This is strong but indirect: it proves the
real constructor executed, not that the unmocked class was instantiated. No test
technique available to M4.3 can prove both "exact constructor argument" and
"pristine class identity" simultaneously without adding a production accessor. This
is recorded as a known, accepted limitation of the observation method, not papered
over.

**Corroboration, not substitution.** Assertions on public, observable state —
`provider.id`, `provider.model.name`, `provider.model.vendorModelId`, and the
`complete()` output — are required alongside the capture. They are the evidence that
the object under test behaves as a Gemini adapter. The capture alone would be
insufficient, because it observes the input rather than the resulting behaviour.

**Test count is preserved.** Each of the three changes is one-to-one: 164 is
replaced by one case, 243 by one case, 268 strengthened in place. The file's case
count is unchanged, and no registered T-ID is added or removed.

#### 11.5.3 M4.4 runtime lazy composition responsibilities

M4.4 implements §11.1.8 in the composition root and registers the four ProviderCell
lifecycle tests. It allocates **no new test file** and **no new dependency**.

##### A. Authorized file list

Exactly two files may change. Both are tracked in HEAD and clean, so `git diff HEAD`
is authoritative for M4.4 review — unlike M4.3, whose files were untracked.

| File                                | Pre-M4.4 SHA-256                                                   | Change                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/runtime.ts`                    | `901bf436c7dcda80519eef4622a7dde770af45fcbfe0608300d6b86fc3ec7ef0` | ProviderCell, `getProvider()` with per-caller disposal-aware wrappers, `RuntimeDisposedError`, `RuntimeDependencies` seams, lazy transport callback, disposal race |
| `tests/integration/runtime.test.ts` | `d94207233fcb729a2214a71c293a8fc999457a7d3eb78f06504eaa7bec862835` | Add T-11e and T-20..T-23                                                                                                                                           |

##### B. `src/runtime.ts` — required changes

1. **`RuntimeDisposedError`** and its `RuntimeErrorKind` union — exported, extending
   plain `Error`, with `name = 'RuntimeDisposedError'` and `kind = 'disposed'`
   (§6.1.1, §11.1.8). Defined in this module, not in `llm.errors.ts`; no new
   `LlmErrorKind` is introduced.
2. **`ProviderCell`** — a private, non-exported discriminated union with the five
   states of §11.1.8. It is not part of the public API, and no accessor, debug hook
   or test-only seam may be added to expose it (§9.0b T-21).
3. **`getProvider(): Promise<LlmProvider>`** — added to the `Runtime` interface and
   implemented as §11.1.8 and §11.1.8.2 specify, including the synchronous
   `idle → pending`
   transition, promise sharing, retry after failure, and the disposal checks.
4. **`RuntimeDependencies`** — gains optional `llmConfig?: LlmProviderConfig` and
   `createProvider?: (config, deps) => Promise<LlmProvider>`, both defaulted so
   `createRuntime()` with no arguments behaves as production (§11.1.8.1).
5. **Config projection** — `env` projected once at `createRuntime()` time into
   `LlmProviderConfig` (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_TIMEOUT_MS`,
   `GEMINI_API_KEY`).
6. **Lazy transport callback** — created inside `getProvider()`, containing the
   literal-specifier dynamic import of `providers/gemini.transport.js` and the
   `createGeminiTransport({ apiKey, timeoutMs })` call (§9.5.5.1).
7. **Disposal race and caller wrappers** — the `disposed` flag set before any
   await; the internal attempt never awaited; one disposal-aware wrapper per caller,
   each settling exactly once; disposal precedence over initialisation settlement;
   late settlements discarded; and a rejection handler attached at attempt start so
   no unhandled rejection escapes (§11.1.8.2).

##### C. `tests/integration/runtime.test.ts` — required changes

- **T-11e** added, asserting §9.0a's assertions 1–4 as operative evidence and
  retaining assertion 5 as a forward-looking guard.
- **T-20..T-23** added per §9.0b, using injected `llmConfig`/`createProvider` seams
  and deferred promises for synchronisation. No `setTimeout`-based synchronisation
  as the primary proof.
- **All 33 existing tests preserved.** No existing test may be deleted, renamed, or
  weakened. If a specific change proves unavoidable, it must be justified by a
  demonstrated contract conflict and reported rather than made silently.

##### D. Explicit exclusions

These files are **not** modified by M4.4:

| File                                         | Why excluded                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                               | Already calls `createRuntime()` with no arguments; the signature is unchanged, so no edit is needed                               |
| `src/core/llm/provider.factory.ts`           | **Consumed, not modified.** Its `createProvider(config, deps)` signature already matches §11.1.8                                  |
| `src/core/llm/providers/gemini.provider.ts`  | Complete; M4.4 injects it through the factory, never constructs it directly                                                       |
| `src/core/llm/providers/gemini.transport.ts` | Complete; loaded lazily, never edited                                                                                             |
| `src/core/llm/fake.provider.ts`              | Complete; selected by default and never reaches the transport callback                                                            |
| `src/core/llm/llm.errors.ts`                 | **Not required** — `RuntimeDisposedError` lives in `runtime.ts` and extends plain `Error`, so no new `LlmErrorKind` is introduced |
| `src/config/env.ts`                          | Already validates all five LLM variables; M4.4 only reads them                                                                    |
| `src/core/llm/llm.provider.ts`               | `LlmProvider` already has the needed surface; no `close()` is added                                                               |
| Any CLI, deployment, or unrelated test file  | Out of scope                                                                                                                      |

**No additional file is required.** The one candidate for expansion —
`llm.errors.ts` — was avoided by defining `RuntimeDisposedError` in the composition
root, which is both the architecturally correct home (§6.1) and consistent with the
existing `RuntimeInitializationError` precedent.

##### E. No production consumer in M4.4

`getProvider()` is **exposed but not called** by any production path in M4.4.
`src/index.ts` does not call it, no HTTP route calls it, and no CLI path calls it.
M4.4 delivers the seam and its proofs; wiring a consumer is a later milestone's
work. This is what keeps T-11e meaningful: a runtime with no caller cannot
accidentally initialise a provider.

##### F. Quality gates

M4.4's acceptance run must report, at minimum: the runtime integration tests
(33 existing plus T-11e and T-20..T-23), the full Vitest suite, `tsc --noEmit`,
ESLint, and Prettier `--check`. This section records a specification, not a result.

### 11.6 API interface re-evaluation: Interactions API vs `generateContent` (M4.0.1)

M4.0 selected `generateContent` and recorded the Interactions API as an
alternative "considered and rejected" (Section 11.6.2). M4.0.1 re-opens that
question on the user's instruction and reaches a **different** conclusion. This
section records the evidence, the reversal, and its consequences. The M4.0 text is
reproduced verbatim in Section 11.6.2 so nothing is silently overwritten.

**Verification basis.** Every claim below was read from Google's own published
documentation on **2026-11-18**, by unauthenticated `GET` of public documentation
pages. No API endpoint was called, no API key was used, and no third-party article
is cited as evidence for any technical conclusion. Where Google does not state
something, this document says **"official documentation unconfirmed"** rather than
inferring it.

#### 11.6.1 Official sources

| #    | Title                                          | URL                                                                  | Consulted  |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------- | ---------- |
| S-1  | Interactions API (overview)                    | `https://ai.google.dev/gemini-api/docs/interactions`                 | 2026-11-18 |
| S-2  | Gemini Interactions API (reference, `v1beta`)  | `https://ai.google.dev/api/interactions`                             | 2026-11-18 |
| S-3  | Gemini Interactions API (reference, `v1`)      | `https://ai.google.dev/api/interactions?api-version=v1`              | 2026-11-18 |
| S-4  | Migrating to the Interactions API              | `https://ai.google.dev/gemini-api/docs/migrate-to-interactions`      | 2026-11-18 |
| S-5  | API versions explained                         | `https://ai.google.dev/api-reference/api-versions`                   | 2026-11-18 |
| S-6  | API errors                                     | `https://ai.google.dev/gemini-api/docs/api-errors`                   | 2026-11-18 |
| S-7  | Troubleshooting guide (parameter ranges)       | `https://ai.google.dev/gemini-api/docs/troubleshooting`              | 2026-11-18 |
| S-8  | Pricing                                        | `https://ai.google.dev/gemini-api/docs/pricing`                      | 2026-11-18 |
| S-9  | Deprecations                                   | `https://ai.google.dev/gemini-api/docs/deprecations`                 | 2026-11-18 |
| S-10 | Model card: `gemini-3.8-flash`                 | `https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash`      | 2026-11-18 |
| S-11 | Model card: `gemini-3.5-flash-lite`            | `https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite` | 2026-11-18 |
| S-12 | Model card: `gemini-4-argon`                   | `https://ai.google.dev/gemini-api/docs/models/gemini-4-argon`        | 2026-11-18 |
| S-13 | Text generation (REST samples, `Api-Revision`) | `https://ai.google.dev/gemini-api/docs/text-generation`              | 2026-11-18 |
| S-14 | Optimization and inference (service tiers)     | `https://ai.google.dev/gemini-api/docs/optimization`                 | 2026-11-18 |

Google's `ai.google.dev` documentation host now redirects to
`aistudio.google.com` for these paths. The URLs above are the canonical ones that
were requested; each returned HTTP 200 after redirect.

#### 11.6.2 The M4.0 decision being superseded (preserved)

For auditability, the M4.0 position is retained verbatim. It is **no longer the
design**.

> **Alternative endpoint considered and rejected** (M4.0). Google's current
> text-generation guide also documents `POST /v1beta/interactions` with an
> `Api-Revision` header (e.g. `2026-05-20`) and a different request shape (`model`
> and `input` in the body). That is a newer, revisioned surface. It is **not**
> adopted here because:
>
> - it carries a second versioning axis (`Api-Revision`) whose compatibility
>   policy was not verified;
> - its request/response schema differs from the `GenerateContentRequest` shape
>   this design already specifies;
> - the `generateContent` method is still documented and current.
>
> If Google retires `generateContent`, this decision must be revisited
> explicitly — it is recorded as an open dependency in Section 11.4.

**What M4.0 got right, and what it got wrong.** M4.0 correctly identified the
endpoint, the `Api-Revision` header and the schema difference. It was wrong on
three points, each now checkable against a primary source:

1. **"Still documented and current" is not the vendor's own positioning.** Google
   states that `generateContent` "is now considered legacy", while the Interactions
   API is "Generally Available and the recommended interface for all new projects"
   (S-1). M4.0 treated "still supported" as equivalent to "appropriate for a new
   project". Section 11.6.3 argues that equivalence is invalid.
2. **The `Api-Revision` concern was over-weighted.** It appears only in REST
   samples on one guide page (S-13) and appears **nowhere** in either API reference
   (S-2, S-3). It is therefore not a mandatory axis of the interface, and Section
   11.6.2.1 explains why this design sends no such header.
3. **The version risk was overstated for the Interactions API.** M4.0 wrote that a
   stable `v1` was unconfirmed. Google documents the Interactions API as GA in
   `v1` (S-5), and `/v1/interactions` is a documented route (S-3).

#### 11.6.2.1 `Api-Revision`: what it is and why this design does not send it

This resolves the first bullet of the M4.0 objection.

| Question                            | Finding                                                                                                               | Source   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| Where does `Api-Revision` appear?   | Only in `curl` REST samples on the text-generation guide, with value `2026-05-20`                                     | S-13     |
| Is it in the `v1beta` reference?    | **No.** Zero occurrences in the Interactions API reference                                                            | S-2      |
| Is it in the `v1` reference?        | **No.** Zero occurrences                                                                                              | S-3      |
| Is it in the overview or migration? | **No.** Zero occurrences                                                                                              | S-1, S-4 |
| Is it documented as required?       | **Official documentation unconfirmed.** No page states it is mandatory, optional, or what its compatibility policy is | —        |

**Decision.** Phase 4 does **not** send `Api-Revision`. Rationale: the API
reference is the normative description of the request schema, and it does not
define this header; sending an undocumented header with a guessed value would be
worse than omitting it. If Google later documents it as required, adding one
constant header is a one-line change confined to the transport.

#### 11.6.3 API positioning and lifecycle

This is the decisive comparison, and it is a matter of vendor positioning rather
than of feature preference.

| Question                        | `generateContent`                                             | Interactions API                                                    | Source         |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- | -------------- |
| Vendor's own label              | **"now considered legacy"**                                   | **"new interface", "Generally Available"**                          | S-1            |
| Recommendation for new projects | Not recommended; retained for existing integrations           | **"the recommended interface for all new projects"**                | S-1, S-4       |
| Lifecycle state                 | Legacy but "fully supported"                                  | GA in `v1`; also in `v1beta`                                        | S-1, S-5       |
| Deprecation announced?          | **No.** Zero mentions on the deprecations page                | Not applicable (it is the successor)                                | S-9            |
| Retirement date announced?      | **No.** **Official documentation unconfirmed**                | Not applicable                                                      | S-9            |
| Where new capabilities launch   | Not the target surface                                        | "new models and capabilities … will launch on the Interactions API" | S-1            |
| Stable `v1` route available     | **Official documentation unconfirmed** in the pages consulted | **Yes**: `POST /v1/interactions`                                    | S-3, S-5       |
| Extra versioning axis           | None                                                          | `Api-Revision` appears in samples only; not in the reference        | S-2, S-3, S-13 |

**Why "still supported" is not "suitable for a new project".** M4.0's third bullet
— "the `generateContent` method is still documented and current" — is true and
irrelevant. The relevant question for a service being built now is which surface
will still be the vendor's default when this code is two years old. Google answers
that directly: new models and new capabilities "will launch on the Interactions
API" (S-1). Choosing the legacy surface for greenfield work buys a migration later
and buys nothing now.

**No deprecation was found, and none is invented here.** The deprecations page
(S-9) contains no entry for `generateContent` and no retirement date. This
document therefore does **not** claim `generateContent` is being removed. It
claims only what Google states: it is legacy, and new work is directed elsewhere.

#### 11.6.4 Endpoint and HTTP contract comparison

Both interfaces share a host and an auth header. **Nothing else about their
schemas may be assumed to match** — this was the core of the user's instruction,
and the comparison below confirms the schemas are entirely different.

| Element             | `generateContent`                                             | Interactions API                                             | Source        |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| Host                | `generativelanguage.googleapis.com`                           | same                                                         | S-2, S-4      |
| Path                | `/v1beta/models/{model}:generateContent`                      | `/v1/interactions` (stable) or `/v1beta/interactions`        | S-2, S-3, S-4 |
| Method              | `POST`                                                        | `POST`                                                       | S-2           |
| Auth                | `x-goog-api-key`                                              | `x-goog-api-key`                                             | S-2, S-4      |
| Content-Type        | `application/json`                                            | `application/json`                                           | S-4           |
| `Api-Revision`      | not used                                                      | appears in samples only, not in reference                    | S-13, S-2     |
| Model selection     | **in the path** (`{model}:generateContent`)                   | **in the body** (`"model"`)                                  | S-2, S-4      |
| Prompt field        | `contents[].parts[].text`                                     | `input` (string, `Content`, or `Step[]`)                     | S-4           |
| System instruction  | `systemInstruction` (camelCase)                               | `system_instruction` (snake_case)                            | S-2, S-4      |
| Generation config   | `generationConfig` (camelCase)                                | `generation_config` (snake_case)                             | S-2, S-4      |
| Max output tokens   | `generationConfig.maxOutputTokens`                            | `generation_config.max_output_tokens`                        | S-2, S-4      |
| Response shape      | `candidates[]` + `usageMetadata`                              | `Interaction` with `steps[]` + `usage`                       | S-4           |
| Text location       | `candidates[0].content.parts[].text`                          | `steps[type=model_output].content[].text`                    | S-4           |
| Stop reason         | `candidates[0].finishReason`                                  | **no per-candidate field**; `Interaction.status`             | S-2, S-4      |
| Usage fields        | `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount` | `total_input_tokens`, `total_output_tokens`, `total_tokens`  | S-2, S-4      |
| Error format        | (legacy surface; not re-verified in this milestone)           | `{ "error": { "code", "message" } }`, `code` in `snake_case` | S-6           |
| Default persistence | Stateless                                                     | **Stateful by default** (`store=true`)                       | S-1           |

**The error-format asymmetry matters and is not glossed over.** Google publishes a
complete, normative error taxonomy for the Interactions API (S-6): a `code` string
in `snake_case`, a `message`, and a documented mapping to HTTP status. It does not
publish an equivalent taxonomy page for `generateContent` in the pages consulted.
That is a real advantage for the adopted interface: error classification becomes a
lookup of documented values rather than an inference from HTTP status alone.

#### 11.6.4.1 Request body the adapter will send

Derived from the `Interaction` request schema (S-2, S-3) and the migration guide's
before/after samples (S-4). Field names are snake_case, as the reference documents.

```json
{
  "model": "<vendor model id from the alias table>",
  "input": "<LlmRequest.prompt, verbatim>",
  "system_instruction": "<LlmRequest.systemInstruction, omitted when undefined>",
  "generation_config": { "max_output_tokens": "<LlmRequest.maxOutputTokens>" },
  "store": false
}
```

Notes, each traceable to a source:

- `model` is the mapped vendor id, never the logical alias (Section 11.1.1).
- `system_instruction` is documented as a plain `string` on this interface (S-2),
  not the structured object `generateContent` uses.
- `generation_config` carries **only** `max_output_tokens`. `temperature` is
  omitted by policy (Section 11.1.2), and no other sampling field is sent.
- `store: false` is explicit and mandatory in this design (Section 11.1.3).
- The request is sent with `Content-Type: application/json`, matching the JSON body
  above and the header table in Section 11.1.3. The adapter sets this header; the
  transport adds only `x-goog-api-key` (Section 11.1.4).
- `stream` is not sent; it defaults to non-streaming, which is what Phase 4 needs
  (Section 11.6.4.4).

#### 11.6.4.2 Response handling

```text
POST /v1/interactions
  → 2xx: Interaction JSON
      status === 'completed' | 'incomplete' | 'failed' | ...
      steps[]: polymorphic; only type === 'model_output' contributes text
      usage:   total_input_tokens / total_output_tokens / total_tokens
  → non-2xx: { "error": { "code", "message" } }
```

#### 11.6.4.3 Truncation mapping — a substantive change from M4.0

`generateContent` reports a stop reason per candidate (`finishReason`). The
Interactions API has **no per-candidate stop reason field**; the reference
documents `status` on the `Interaction` instead (S-2). M4.0's truncation table
(§11.1) keys off a field that does not exist on the adopted interface, so it is
restated here.

| Documented `status`     | Meaning per the reference                                              | `LlmResponse.truncated` |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------- |
| `completed`             | The interaction is completed                                           | `false`                 |
| `incomplete`            | Completed, "but contains incomplete results (e.g. hitting max_tokens)" | `true`                  |
| `failed`                | The interaction failed                                                 | error, not a response   |
| `cancelled`             | The interaction was cancelled                                          | error (`timeout`/abort) |
| `in_progress`           | Not terminal (should not appear on a non-streaming 2xx)                | `null`                  |
| `requires_action`       | Needs caller input; Phase 4 declares no tools                          | `invalid_response`      |
| `requires_continuation` | Needs a follow-up request with `continuation_token`                    | `invalid_response`      |
| absent or unrecognised  | No reliable signal                                                     | `null`                  |

The three-valued rule from §11.1 is preserved exactly: a normal stop is `false`, a
length stop is `true`, and anything unknown is `null` — never collapsed to
`false`. T-17's assertion set is unchanged; only the field it reads changes.

`requires_continuation` deserves a note. Google documents it for long decodes that
must be resumed with a `continuation_token`. Phase 4 never requests long decode, so
receiving it would mean the service is not getting what it asked for. Treating it
as `invalid_response` — rather than silently joining steps across a second request
— keeps the single-request contract intact.

#### 11.6.4.4 Execution modes

| Mode                           | `generateContent` | Interactions API                         | Phase 4 needs it?   |
| ------------------------------ | ----------------- | ---------------------------------------- | ------------------- |
| Synchronous request/response   | Yes               | Yes (default)                            | **Yes — only this** |
| Streaming                      | Yes               | Yes (`stream: true`, SSE)                | No                  |
| Background execution           | Not applicable    | Yes (`background: true`)                 | No                  |
| Poll / fetch later             | Not applicable    | Yes (`GET /v1/interactions/{id}`)        | No                  |
| Server-side conversation state | No (stateless)    | Yes (`previous_interaction_id`, `store`) | No                  |

Sources: S-1, S-2, S-4.

**Phase 4 scope is not expanded.** The Interactions API can stream, run in the
background, poll and hold conversations. Kou News Engine Phase 4 needs exactly one
thing: a single non-streaming text generation per call. The specification therefore
sets `store: false`, omits `stream`, omits `background`, and never calls `GET`,
`POST /cancel` or `DELETE` on an interaction. Extra capability that is documented
but unused is not a reason to use it, and adopting it would violate the milestone
boundary.

One consequence is recorded honestly: because the service is stateless by choice,
it forgoes the implicit context caching benefit Google describes for multi-turn
stateful use (S-1). For single-shot article translation there is no conversation to
cache, so nothing is lost.

#### 11.6.5 Request and response mapping, field by field

| Concern                 | `generateContent`                     | Interactions API                          | Adopted mapping                                |
| ----------------------- | ------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Model id                | path segment                          | `model` body field                        | `model` = mapped vendor id (§11.1.1)           |
| Prompt                  | `contents[].parts[].text`             | `input`                                   | `input` = `LlmRequest.prompt` verbatim         |
| System instruction      | `systemInstruction` object            | `system_instruction` string               | sent only when defined                         |
| Generation config       | `generationConfig`                    | `generation_config`                       | `{ max_output_tokens }` only                   |
| Max output tokens       | `generationConfig.maxOutputTokens`    | `generation_config.max_output_tokens`     | copied unmodified, never clamped               |
| Response text           | `candidates[0].content.parts[].text`  | `steps[type=model_output].content[].text` | joined over `model_output` steps only          |
| Structured output       | `responseMimeType` / `responseSchema` | top-level `response_format`               | **not used** in Phase 4                        |
| Tool / function calling | `tools`                               | `tools`, typed execution steps            | **not used** in Phase 4                        |
| Response metadata       | `candidates[]`, `promptFeedback`      | `id`, `status`, `steps[]`, `created`      | `status` used; `id` logged as an opaque handle |
| Usage accounting        | `usageMetadata.*TokenCount`           | `usage.total_*_tokens`                    | mapped to `LlmUsage`; absent → `null`          |
| Truncation              | `finishReason`                        | `status`                                  | §11.6.4.3                                      |

**`LLM_MAX_OUTPUT_TOKENS` under both interfaces.** This answers the specific
question the milestone asked. The application-level contract is unchanged: the env
value is parsed and bounded (`T-16a`), copied into `LlmRequest.maxOutputTokens` by
the composition layer (`T-16b`), and written to the vendor field by the adapter
(`T-16c`). Only the destination field name changes —
`generationConfig.maxOutputTokens` becomes `generation_config.max_output_tokens`.
No layer gains or loses responsibility, so **T-16a/b/c keep their assertions and
their count**. Only T-16c's expected field path changes.

**Structured output and tools are recorded, not adopted.** The Interactions API
moves schema control to a top-level `response_format` and expresses tool calls as
typed steps rather than parts (S-4). Kou News Engine does not use either in Phase
4 — the design explicitly forbids parsing model output as JSON (§6.6). Recording
the mapping prevents a future milestone from assuming the `generateContent` shapes
still apply, without expanding scope now.

#### 11.6.5.1 Sampling parameter policy

This answers Section 七 of the milestone: for each parameter, what does the
**schema** accept, what does the **model** support, and what does the API do with
it. The two axes are independent, and conflating them is how the M4.0 conflict
arose.

| Parameter         | In `generateContent` schema | In Interactions `generation_config` | Honoured by the three proposed models | Adapter policy                                 |
| ----------------- | --------------------------- | ----------------------------------- | ------------------------------------- | ---------------------------------------------- |
| `temperature`     | Yes                         | **No** (not documented)             | **No** — ignored on Gemini 3.6+ and 4 | **Never sent.** Dropped (§11.1.2)              |
| `topP`            | Yes                         | **No** (not documented)             | **No** — ignored on Gemini 3.6+ and 4 | Never sent; not exposed on `LlmRequest` either |
| `topK`            | Yes                         | **No** (not documented)             | Not confirmed for these models        | Never sent; not exposed on `LlmRequest`        |
| `maxOutputTokens` | Yes (`maxOutputTokens`)     | **Yes** (`max_output_tokens`)       | **Yes** — bounded per model           | **Always sent**, unmodified (§11.6.5)          |
| `seed`            | Yes                         | Yes                                 | Not confirmed                         | Not sent; not exposed on `LlmRequest`          |
| `stopSequences`   | Yes                         | Yes (`stop_sequences`)              | Not confirmed                         | Not sent; not exposed on `LlmRequest`          |
| `candidateCount`  | Yes                         | Not used                            | **Unsupported on Gemini 3 and 4**     | Not sent; not exposed on `LlmRequest`          |

Sources: S-2 (Interactions schema), S-7 (parameter ranges and "ignored on Gemini
3.6+ and 4"), S-1/S-4 (samples).

**The four questions the milestone asked, answered explicitly.**

1. **Should unsupported parameters be omitted?** Yes. `temperature` is omitted
   because the adopted schema does not document it and the models ignore it. This
   is stronger than "the model ignores it": the field is not even in the schema of
   the interface being called, and sending an undocumented field risks
   `parameter_unknown` (400) rather than a silent no-op.
2. **Is per-model capability mapping needed?** **No, not in Phase 4.** Every model
   this design proposes is in the ignored range for sampling parameters, so a
   capability table would have one row of behaviour and three model names. It would
   be dead weight that must be maintained as models change, and it would imply a
   precision the vendor does not offer. See item 5 below for when it _would_ become
   necessary.
3. **Should incompatible parameters be rejected at configuration time?** **No.**
   Rejecting would break callers that legitimately set `temperature` for the `fake`
   provider or for a future provider that honours it, and `temperature` remains a
   valid field on the vendor-free `LlmRequest` type. The adapter's job is to map to
   the vendor it implements; dropping an unsupported field is mapping, not
   validation failure.
4. **Should the existing `temperature` default be removed?** There is **no default
   to remove**. `LlmRequest.temperature` is `?: number | undefined` and the design
   sends nothing when it is undefined. No configuration layer supplies one. The
   only change is that the adapter now drops it even when a caller supplies it.

5. **When capability mapping would be required.** If a future milestone adds a
   model that _does_ honour sampling — an earlier Gemini 3 model, or a non-Gemini
   provider behind the same interface — then a per-model capability table becomes
   necessary, because the same `LlmRequest` would need different wire treatment.
   That is recorded here as a known trigger, not implemented now.

**Behaviour if the vendor ever rejects an unknown field.** If Google starts
returning `parameter_unknown` for a field this adapter sends, that is a **loud
failure** — a 400 the adapter maps to `invalid_request` — not a silent wrong
answer. This is the property that makes "send nothing undocumented" the safe
default: the failure mode is visible.

#### 11.6.6 Error handling and `LlmError` mapping

Google publishes a normative error taxonomy for the Interactions API (S-6): a
`code` string in `snake_case` plus a `message`, delivered with a standard HTTP
status. This replaces status-code guessing with a documented lookup.

| Vendor `code`                                                                                         | HTTP       | `LlmError` kind         | Retryable | Notes                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------- | --------- | --------------------------------------------------------------- |
| `authentication`                                                                                      | 401        | `authentication`        | No        | Key missing, invalid or expired                                 |
| `permission_denied`                                                                                   | 403        | `authentication`        | No        | Key lacks permission; do not retry                              |
| `invalid_request`                                                                                     | 400        | `invalid_request`       | No        | Malformed payload or parameters                                 |
| `failed_precondition`                                                                                 | 400        | `invalid_request`       | No        | e.g. billing not enabled                                        |
| `parameter_unknown`                                                                                   | 400        | `invalid_request`       | No        | Directly relevant to §11.1.2                                    |
| `out_of_range`                                                                                        | 416        | `invalid_request`       | No        | Parameter outside valid range                                   |
| `not_found`                                                                                           | 404        | `invalid_request`       | No        | Resource path wrong                                             |
| `model_not_found`                                                                                     | 404        | `invalid_request`       | No        | Alias table points at a dead model                              |
| `already_exists`                                                                                      | 409        | `invalid_request`       | No        | Not expected on `create`                                        |
| `aborted`                                                                                             | 409        | `timeout`               | Yes       | Retry at a higher level                                         |
| `rate_limit_exceeded`                                                                                 | 429        | `rate_limit`            | Yes       | Back off                                                        |
| `quota_exceeded`                                                                                      | 429        | `rate_limit`            | Yes       | Daily quota; back off longer                                    |
| `too_many_requests`                                                                                   | 429        | `rate_limit`            | Yes       | Short-window burst                                              |
| `cancelled`                                                                                           | 499        | `timeout`               | Yes       | Client disconnected; retryable because kind `timeout` is (§6.2) |
| `api_error`                                                                                           | 500        | `unavailable`           | Yes       | Unexpected server error                                         |
| `unimplemented`                                                                                       | 501        | `invalid_request`       | No        | Feature unsupported; a config bug                               |
| `service_unavailable`                                                                                 | 503        | `unavailable`           | Yes       | Overloaded or down                                              |
| `deadline_exceeded`                                                                                   | 504        | `timeout`               | Yes       | Server-side deadline                                            |
| generation-blocked (`safety`, `recitation`, `language`, `prohibited_content`, `spii`, `blocklist`, …) | 2xx or 4xx | `invalid_response`      | No        | Never fabricated as text (§11.1.3)                              |
| generation-error (`malformed_function_call`, `unexpected_tool_call`, …)                               | —          | `invalid_response`      | No        | Tools unused; indicates a contract break                        |
| unlisted code                                                                                         | any        | by HTTP status fallback | per class | Google documents a `snake_case` HTTP-status fallback            |
| unparseable body                                                                                      | 2xx        | `invalid_response`      | No        | `JSON.parse` failure                                            |
| body missing `status` / `steps`                                                                       | 2xx        | `invalid_response`      | No        | Structural check failed                                         |
| no `model_output` text                                                                                | 2xx        | `empty_response`        | Yes       | Empty output is an error; retryable once per §6.2               |

**Client-side conditions** that never reach the vendor:

| Condition                       | `LlmError` kind    |
| ------------------------------- | ------------------ |
| `AbortSignal` fired by caller   | `timeout`          |
| Local `timeoutMs` elapsed       | `timeout`          |
| Response exceeded size ceiling  | `invalid_response` |
| Non-JSON or truncated JSON body | `invalid_response` |

**The raw vendor body is never propagated.** This is unchanged from M4.0 and is
enforced by T-18: the transport returns only a status and a body string to the
adapter; the adapter maps to an `LlmError` whose `message` is a fixed,
adapter-authored string plus the _documented `code`_, never the vendor `message`
verbatim and never the body. Google's own error `message` can quote request
content — the documented `parameter_unknown` example echoes the offending value
back — so forwarding it would risk logging prompt text or, in the worst case, an
echoed credential.

#### 11.6.7 Security and transport compatibility

Both candidate interfaces were checked against the ten standing security
requirements. The adopted interface satisfies all ten **without weakening any of
them**, which is why the security posture is unchanged by this re-evaluation.

| #   | Requirement                     | Interactions API | Note                                                                  |
| --- | ------------------------------- | ---------------- | --------------------------------------------------------------------- |
| 1   | Fixed official endpoint         | Yes              | Host is a module constant; path is a literal                          |
| 2   | No caller-supplied URL          | Yes              | Model goes in the **body**, not the path — fewer injectable positions |
| 3   | Redirect rejection              | Yes              | Transport-level; unchanged from §11.1.5                               |
| 4   | Response body size limit        | Yes              | Ceilings in §11.6.8                                                   |
| 5   | Timeout                         | Yes              | Local `AbortSignal.timeout`, unchanged                                |
| 6   | `AbortSignal`                   | Yes              | Composed with the timeout signal, unchanged                           |
| 7   | API key isolation               | Yes              | `x-goog-api-key` set by transport only; T-18                          |
| 8   | No `Authorization` leakage      | Yes              | Header is adapter-set, never logged                                   |
| 9   | No sensitive body in logs       | Yes              | Only the documented `code` is surfaced (§11.6.6)                      |
| 10  | Offline testability with a fake | Yes              | `GeminiTransport` seam is interface-agnostic                          |

**Does the `GeminiTransport` interface need to change? No.** The existing
interface is:

```ts
send(
  url: string,
  init: {
    readonly body: string;
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly status: number; readonly body: string }>;
```

It is already transport-agnostic: it takes a fully-formed URL, an opaque body,
opaque headers and a signal, and returns a status and a body string. Switching from
`generateContent` to the Interactions API changes **what the adapter puts in the
string**, not the shape of the seam. The interface therefore stands unmodified,
which is itself evidence that the abstraction was drawn in the right place.

One improvement is _possible_ but **not required and not adopted**: passing a
structured `URL` plus a separate path, to make "host is constant" a type-level
guarantee rather than a convention. That would be a change to a `.ts` file, which
M4.0.1 is not authorised to make. It is recorded as an optional hardening item,
not a blocker.

**A note on `store: false` as a security control.** Choosing `store: false` means
the vendor does not retain request or response content beyond transient
processing. On a news-translation service that handles third-party article text,
that is a data-minimisation property worth stating explicitly, and T-10a asserts it
so a future change cannot silently turn retention back on.

#### 11.6.8 O-7: response body size limits (provisional specification)

**Provisional values, approved as working limits but not proven safe:**

| Limit                    | Value                       |
| ------------------------ | --------------------------- |
| Successful response body | **1 MiB** (1,048,576 bytes) |
| Error response body      | **64 KiB** (65,536 bytes)   |

These are recorded as provisional specification values. They are **not** presented
as proven safe. The capacity analysis below is a documented estimate, and §11.6.8.5
states exactly what implementation-stage verification must confirm.

**Correction to the M4.0.1 draft.** The previous version of this section derived the
limit from `maxOutputTokens = 8,192`. That figure was wrong: the validated bound on
`LLM_MAX_OUTPUT_TOKENS` is **1–32768** (Section 7.1, `src/config/constants.ts`),
with a default of `2048`. The derivation below uses the real bound, which changes
the worst case by 4× and is the reason the earlier "≈40× headroom" claim is
withdrawn.

#### 11.6.8.1 Basis: what the limit must accommodate

The success limit must accommodate the largest response the service can request,
not the largest response it usually receives.

| Input to the analysis           | Value                                                            | Source             |
| ------------------------------- | ---------------------------------------------------------------- | ------------------ |
| `LLM_MAX_OUTPUT_TOKENS` min     | 1                                                                | Section 7.1        |
| `LLM_MAX_OUTPUT_TOKENS` max     | **32,768**                                                       | Section 7.1        |
| `LLM_MAX_OUTPUT_TOKENS` default | 2,048                                                            | Section 7.1        |
| Mapping to wire                 | `generation_config.max_output_tokens`, unmodified, never clamped | §11.6.5, T-16c     |
| Output price basis              | output **includes thinking tokens**                              | S-8 (pricing page) |
| Streaming                       | never used; single non-streaming response                        | §11.6.4.4          |

**Why tokens cannot be converted to bytes by a fixed ratio.** A token is not a
byte and not a character. The payload here is Traditional Chinese, where a single
token commonly decodes to one CJK character occupying **3 bytes** in UTF-8, while
an ASCII token may decode to several characters. Any single "bytes per token"
number is an assumption, so the analysis uses a conservative value and then shows
sensitivity rather than pretending to precision.

#### 11.6.8.2 Text size at the maximum request

Using **4 bytes per token** as a conservative upper bound for CJK text and emoji
(UTF-8 maximum per code point is 4 bytes):

| Scenario                                                          | Output tokens | Text bytes (4 B/token) |
| ----------------------------------------------------------------- | ------------: | ---------------------: |
| Default configuration                                             |         2,048 |                  8 KiB |
| Maximum configuration                                             |        32,768 |                128 KiB |
| Maximum, if thinking is counted **in addition** to visible output |        65,536 |                256 KiB |

The third row is the honest worst case. Google documents `max_output_tokens` as
"the maximum number of tokens to include in the response", while pricing states
that output price includes thinking tokens. Whether thinking consumes the same
budget or sits alongside it is **not stated unambiguously** on the pages consulted,
so the analysis assumes it may double. This is an **official documentation
ambiguity**, recorded rather than resolved by assumption.

#### 11.6.8.3 JSON envelope overhead

The response is not bare text. It is an `Interaction` object containing `id`,
`status`, `created`, `updated`, `model`, `generation_config`, `usage`, and a
`steps[]` array whose text lives inside nested `content[]` entries. Overhead comes
from three sources:

1. **Structural overhead** — keys, braces, and the `steps[]`/`content[]` wrappers.
   Small in absolute terms (low single-digit KiB) because there are few steps.
2. **JSON string escaping** — quotes, backslashes and control characters expand.
   Normal prose expands negligibly; a pathological payload could expand up to 6
   bytes per character (`\uXXXX`). A **2× multiplier** is used as a working
   allowance, which is generous for real text and still bounded.
3. **Thought steps** — if `thinking_summaries` yields text steps, they add
   structure. Their tokens are already inside the token budget above, so they are
   not double-counted here; only their envelope is.

#### 11.6.8.4 Comparison against 1 MiB, and sensitivity

| Scenario                                        |    Text | ×2 JSON |   Total | Share of 1 MiB |
| ----------------------------------------------- | ------: | ------: | ------: | -------------: |
| Default (2,048 tokens, 4 B/token)               |   8 KiB |  16 KiB |  16 KiB |           1.6% |
| Maximum (32,768 tokens, 4 B/token)              | 128 KiB | 256 KiB | 256 KiB |            25% |
| Maximum + separate thinking (65,536, 4 B/token) | 256 KiB | 512 KiB | 512 KiB |            50% |
| Extreme (65,536 tokens, 8 B/token)              | 512 KiB |   1 MiB |   1 MiB |       **100%** |

**Reading the table honestly.** At the realistic worst case the limit has roughly
**2× headroom** (512 KiB of 1 MiB). The final row shows a corner where a
legitimate maximal response would reach the ceiling: it requires 8 bytes per token,
which is not realistic for prose but is not provably impossible for unusual
payloads. Therefore:

- 1 MiB is **adequate with margin** for the analysed realistic worst case;
- 1 MiB is **not proven** to accommodate every theoretically legal response;
- if the ceiling is reached, the correct behaviour is to **abort and fail** — never
  to truncate and parse a partial document (§11.6.8.6). A failed call is
  recoverable; a silently truncated translation is not.

#### 11.6.8.4a `LLM_MAX_OUTPUT_TOKENS` stays at 32,768 — decided

**Decision (M4.0.3): the maximum remains 32,768. It is not reduced to 16,384.**

The alternative was considered and rejected. Lowering the ceiling to 16,384 would
have halved the analysed worst case in §11.6.8.4 and reduced the concurrency
figures in §11.6.8.5. It is not adopted, for three reasons:

1. **The ceiling is a capability, not a safety valve.** `LLM_MAX_OUTPUT_TOKENS`
   bounds what a caller may request (Section 7.1). Lowering it to make a transport
   limit more comfortable would trade a product capability for an internal
   implementation margin, which is the wrong direction.
2. **The transport must be correct at the configured maximum, not the other way
   around.** The response-size limit exists to protect the reader; it must therefore
   hold at whatever maximum the configuration permits. Shrinking the configuration
   would hide the transport problem instead of solving it.
3. **32,768 is the already-validated bound.** It is the documented maximum in
   Section 7.1 and is covered by T-16a. Changing it would alter a validated
   configuration contract, which is out of scope for a transport specification.

**What this decision does NOT do.** It does not reduce the need to validate
response-size and concurrent-memory behaviour during implementation. The worst case
in §11.6.8.4 remains 65,536 output tokens (the maximum plus possible separate
thinking), and the 1 MiB success ceiling retains only about **2× headroom** against
the analysed realistic worst case. Both must still be confirmed at implementation
time (§11.6.8.8):

- measured bytes-per-token for real Traditional Chinese text;
- whether thinking tokens consume `max_output_tokens` or sit alongside it;
- actual `JSON.parse` overhead at the maximum;
- real concurrency × per-request memory against the deployment's heap budget.

**No configuration, parser, default, or test is changed by this decision.** It is
recorded as a decision only. The existing `1..32768` validation in
`src/config/env.ts` and the T-16a assertions stand exactly as they are.

#### 11.6.8.5 Memory: the limit is bytes on the wire, but strings are UTF-16

This is the part most easily got wrong, so it is stated explicitly.

**The 1 MiB limit counts bytes received from the socket.** JavaScript strings are
UTF-16, so the in-memory representation is not the same size as the wire bytes:

| Content type       | 1 MiB UTF-8 on the wire | Characters | JS string memory (UTF-16) |
| ------------------ | ----------------------: | ---------: | ------------------------: |
| ASCII              |               1,048,576 |  1,048,576 |                    ~2 MiB |
| CJK (3 bytes/char) |               1,048,576 |   ~349,525 |                  ~0.7 MiB |

So the worst-case memory for one buffered body is approximately **2 MiB**, not
1 MiB, and this is the figure the concurrency calculation must use. `JSON.parse`
then allocates the object graph on top of that; for a response dominated by a few
large strings this is modest, but it is not zero.

**Concurrency.** With **N** in-flight requests:

- worst-case buffered bytes ≈ `N × 1 MiB` (success) `+ N × 64 KiB` (error);
- worst-case JS heap for those bodies ≈ `N × 2 MiB` (UTF-16 expansion).

| Concurrent requests | Buffered bytes | Approx. heap (UTF-16) |
| ------------------: | -------------: | --------------------: |
|                   4 |       4.25 MiB |              ~8.3 MiB |
|                  10 |       10.6 MiB |             ~20.7 MiB |
|                  50 |         53 MiB |              ~103 MiB |

At 50 concurrent maximal responses the transient cost is on the order of 100 MiB.
That is not alarming against a modern Node heap, but it is not negligible either,
and it scales linearly with whatever concurrency the caller permits. **The limit
bounds a single response; it does not bound aggregate memory.** Concurrency policy
is the caller's responsibility and is unchanged by this milestone. If the service
later allows high concurrency, the ceiling and the concurrency limit must be
reviewed together — not independently.

#### 11.6.8.6 Detection and abort — no unbounded buffering

**The implementation must not buffer an unbounded response before checking its
size.** The rule is enforced during the read, not after it:

1. **Count as bytes arrive.** The response is consumed from `data` events; each
   chunk's byte length is added to a running total before the chunk is appended.
2. **Check before append.** If the running total would exceed the ceiling, the
   socket is destroyed immediately and the call fails as `invalid_response`.
3. **Bounded overshoot.** A single chunk can straddle the ceiling, so peak buffer
   is `ceiling + one chunk`, never unbounded. The chunk size is a transport
   constant, so the overshoot is known and small.
4. **Discard partial data.** The accumulated buffer is released, and a partially
   read JSON document is **never** parsed. There is no "best effort" path.
5. **No `Content-Length` trust.** A declared length is not a guarantee; the count
   is enforced on actual received bytes regardless of headers. A response that
   under-declares its length is still stopped at the ceiling.
6. **Same rule for errors.** The 64 KiB error ceiling is enforced identically, even
   though the body is discarded rather than parsed.

This reuses the byte-ceiling approach already proven in
`src/modules/extraction/http/body-reader.ts` (Section 11.1.6), which is the
existing precedent for counting bytes mid-stream rather than after buffering.

**Streaming is not a loophole.** Phase 4 never sets `stream: true` (§11.6.4.4), so
no SSE parser or incremental buffer exists. If streaming were ever enabled, this
ceiling would have to be re-derived, because a streamed response has no single
body to measure.

#### 11.6.8.7 How the limits are verified — T-19 (approved)

The limits are transport behaviour, so they are verified with a fake transport that
yields controlled byte streams. No network is involved and no real response is
needed.

**`T-19 — response body size ceilings` is an approved, registered Phase 4
acceptance test.** It was proposed in M4.0.2 and formally approved in M4.0.3. It
owns the eight assertions below; they are not folded into any other test, because
covering them inside an existing test would misrepresent that test's scope. T-10a
covers single egress, T-13/T-14 cover timeout and abort, and T-18 covers key
leakage — none of them covers body-size ceilings.

| #   | Assertion                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------ |
| 1   | A success body of exactly 1 MiB is accepted                                                            |
| 2   | A success body of 1 MiB + 1 byte is rejected as `invalid_response`                                     |
| 3   | An error body of exactly 64 KiB is accepted (then discarded); 64 KiB + 1 byte is rejected              |
| 4   | On exceeding the ceiling the stream is **destroyed** — the fake asserts `destroy` was called           |
| 5   | The reader never holds more than `ceiling + one chunk` before aborting (bounded-buffer assertion)      |
| 6   | A body truncated at the ceiling is **not** parsed; the error is `invalid_response`, not a short result |
| 7   | A body whose `Content-Length` under-declares its size is still stopped at the ceiling                  |
| 8   | A body that arrives in many small chunks is counted correctly (no per-chunk reset)                     |

All eight assertions are retained unchanged from M4.0.2. None is merged, weakened,
or reinterpreted by the approval.

**T-19 specification summary.**

| Field                       | Value                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| T-ID                        | **T-19**                                                                                                |
| Phase                       | **4**                                                                                                   |
| Kind                        | unit / transport                                                                                        |
| Purpose                     | Prove the reader enforces the 1 MiB / 64 KiB ceilings by bounded reading and abort, never by truncating |
| Precondition                | Adapter + fake transport yielding controlled byte streams                                               |
| Input                       | Bodies at, just under, and just over each ceiling; chunked deliveries; under-declared `Content-Length`  |
| Expected                    | Assertions 1–8 above                                                                                    |
| Security property verified  | A hostile or misrouted response cannot cause unbounded buffering or a silently truncated result         |
| External network            | **No**                                                                                                  |
| Fake transport allowed      | **Required**                                                                                            |
| Process-level egress denial | Not required                                                                                            |
| Acceptance criterion        | 17 (§12)                                                                                                |

**Counts after approval.** T-19 adds one Phase 4 test and one registered T-ID:

| Scope      | Before | After |
| ---------- | -----: | ----: |
| Phase 4    |      9 |    10 |
| In scope   |     24 |    25 |
| Deferred   |      2 |     2 |
| Registered |     26 |    27 |

These were the counts when T-19 was approved and are a historical record. They
are **superseded** by M4.4 Revision 1, which registered T-20..T-23 (§9.0b) and
raised Phase 4 to 14, in scope to 29 and registered to 31; §9, §11 and §12 carry
the current figures. **The limits themselves remain provisional** — approving a
test that verifies the reading behaviour does not prove the chosen ceiling values
are safe. That distinction is preserved in §11.6.8.8.

#### 11.6.8.8 Status

| Item                              | Status                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| 1 MiB success ceiling             | **Provisional** — approved as a working value, not proven safe                               |
| 64 KiB error ceiling              | **Provisional** — approved as a working value, not proven safe                               |
| Capacity analysis                 | Documented above; based on stated assumptions, including one vendor ambiguity                |
| Implementation-stage verification | **Required** — must confirm the UTF-16 and concurrency assumptions                           |
| Test coverage                     | **Closed as a specification gap.** `T-19` is approved and registered (Phase 4, criterion 17) |
| `LLM_MAX_OUTPUT_TOKENS` maximum   | **Retained at 32,768** by decision (§11.6.8.4a); not reduced to 16,384                       |

**Approving T-19 does not make the ceilings production-proven.** The test proves the
reader behaves correctly at whatever ceiling is configured. It does not prove that
1 MiB and 64 KiB are the right values, nor that the memory assumptions in §11.6.8.5
hold for real traffic. Those remain open until implementation-stage verification.

**What implementation-stage verification must confirm** before these values stop
being provisional (unchanged by the 32,768 decision — see §11.6.8.4a):

1. Measured bytes-per-token for real Traditional Chinese translations, replacing the
   4 B/token assumption.
2. Whether thinking tokens consume `max_output_tokens` or sit alongside it,
   replacing the ×2 worst case.
3. Actual `JSON.parse` overhead for a maximal response.
4. Whether a realistic maximal response approaches the ceiling in practice.

#### 11.6.9 O-5: network egress — approved initial approach

**Approved approach: direct HTTPS connection. No proxy support in this phase.**

Three options were considered. Only the first is approved for Phase 4.

| Option                                    | Fixed endpoint                            | TLS                                                | DNS                   | Verdict                       |
| ----------------------------------------- | ----------------------------------------- | -------------------------------------------------- | --------------------- | ----------------------------- |
| A. Direct connection, no proxy            | Preserved                                 | Node verifies the real host                        | System resolver       | **Approved — implemented**    |
| B. Explicitly configured deployment proxy | Preserved (a fixed, deployment-set value) | CONNECT tunnel; end-to-end TLS to Google preserved | Resolved by the proxy | **Not implemented.** Deferred |
| C. Arbitrary caller-supplied proxy URL    | **Broken**                                | Unverifiable                                       | Attacker-controlled   | **Rejected outright**         |

Option C is rejected permanently, not merely deferred. It would reintroduce exactly
the SSRF surface that §11.1.6 exists to close: a caller who can name the proxy can
name the destination, which defeats the fixed-endpoint rule at its root. This is a
design prohibition, not a scheduling choice.

**Approved scope for this phase, stated as prohibitions.** Phase 4:

- opens a direct TLS connection to the single constant host;
- adds **no** proxy configuration, proxy option, proxy environment-variable
  handling, `HTTP_PROXY`/`HTTPS_PROXY` reading, or `agent`/`dispatcher`
  substitution point;
- adds **no** caller-supplied URL, host, port, or path — the endpoint remains a
  module constant (§11.1.3);
- adds **no** retry or fallback endpoint.

A deployment may sit behind an operator-managed egress proxy in future, but that
would be option B: a deployment-level value, never a request parameter. It is not
part of this phase and would require its own B-6 entry (§11.2.2).

#### 11.6.9.1 Application-level restriction vs deployment-level enforcement

These are different mechanisms with different guarantees, and this document does
not blur them. The distinction is the reason B-6 remains blocked.

| Layer                             | What it is                                                                                                           | What it can guarantee                                                             | What it cannot guarantee                                                 | Status in Phase 4          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| **Application-level restriction** | Code-level rules: fixed endpoint constant, one transport seam, no dynamic import, no global `fetch`, no proxy option | That **this code** has exactly one intended egress path                           | That the **process** cannot reach the network by another route           | **Specified and testable** |
| **Deployment-level enforcement**  | OS/container/network policy: egress firewall, denied default route, proxy-only egress, CI sandbox with no network    | That the **process and everything it loads** is denied egress except as permitted | Nothing about code correctness — it is a boundary, not a proof of design | **Not established**        |

**The critical asymmetry.** Application-level restriction is a statement about
intent. Deployment-level enforcement is a statement about capability. A test can
prove the first; only the runtime environment can prove the second.

**This is precisely what N-1 vs N-2 means in §11.2.2.** N-1 is a deployment-level
mechanism. N-2 is an application-level approximation that intercepts known
networking surfaces and accounts for the rest. N-2 is weaker _because_ it is
application-level: it can only intercept what it enumerates, which is why the
uncovered surfaces in §11.2.2 matter.

#### 11.6.9.2 The deployment environment must provide egress control

**Requirement, stated plainly:** the deployment environment must provide an
effective outbound egress control mechanism. This is a **deployment obligation**,
not something the adapter can satisfy.

The adapter cannot enforce it, for three reasons:

1. It runs inside the same process it would need to constrain.
2. It cannot observe sockets opened by native addons or by a dependency it does
   not import.
3. A code-level rule is bypassed by any code path that does not go through it.

**What this obligation covers.** The deployment must ensure that the service
process can reach the Gemini endpoint and cannot reach arbitrary destinations.
Acceptable forms include a default-deny egress firewall with an allow-list, a
network namespace with no default route plus an explicit proxy, or a CI sandbox
that denies egress during tests. The specific mechanism is a deployment decision
and is not fixed by this document.

**What this obligation does NOT do.** It does **not** close B-6. B-6 requires
_evidence_ — a recorded mechanism plus the command or policy that establishes it
(§11.2.2). An obligation recorded in a design document is a requirement, not
evidence.

#### 11.6.9.3 Direct connection is not network isolation

**Direct connection alone does not provide network isolation, and this document
makes no such claim.**

What a direct connection does provide is narrower and must be stated precisely:

| Claim                                                          | True?  | Basis                                                      |
| -------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| The adapter has exactly one intended egress path               | Yes    | One transport seam; static checks (T-10a parts 1 and 3)    |
| The endpoint is a compile-time constant, not caller-controlled | Yes    | §11.1.3                                                    |
| No proxy option exists that a caller could redirect            | Yes    | §11.6.9 prohibitions                                       |
| **The process cannot reach any other host**                    | **No** | Not established. B-6 is BLOCKED                            |
| **The service is network-isolated**                            | **No** | Requires deployment-level enforcement, which is unverified |
| **T-10a assertion 4 has passed**                               | **No** | Remains BLOCKED (§11.2.2)                                  |

The first three are application-level properties that the test suite can assert.
The last three are process-level properties that require evidence this phase does
not have. Reading the first group as if it implied the second is exactly the
inference B-6 exists to prevent.

**Status: APPROVED (approach)** — direct HTTPS, no proxy support, deployment must
provide egress control. **B-6 remains BLOCKED**; this approval does not change it.

#### 11.6.10 O-6: DNS pinning

| Question                                        | Finding                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is a fixed hostname enough to reduce SSRF risk? | Largely yes. The host is a compile-time constant, so no attacker input reaches the destination. The residual risk is DNS, not URL construction                                                                                                                              |
| Realistic threat from DNS rebinding here        | **Low.** Rebinding requires an attacker to control resolution for `generativelanguage.googleapis.com`. That requires compromising Google's DNS or the resolver path — a far larger breach than this service's threat model                                                  |
| How does `node:https` resolve?                  | It calls the system resolver via `dns.lookup` at connect time; it does not re-resolve mid-connection for a new destination                                                                                                                                                  |
| Is a custom `lookup` needed?                    | **Not for correctness.** Optional hardening: pass a `lookup` that rejects non-public addresses, reusing `classifyIp` from `ip-guard.ts`                                                                                                                                     |
| Does pinning affect TLS verification?           | If done correctly, no: TLS `servername`/SNI must remain the hostname, so certificate validation still targets Google. A naive pin that connects to an IP while verifying the IP would break verification — this is why the existing `dns-pin.ts` keeps the hostname for TLS |
| Overlap with egress firewall / proxy            | **Complementary.** A firewall or proxy constrains _where_ packets may go; pinning constrains _which address a name resolves to_. Neither replaces the other                                                                                                                 |

**Risk rating: LOW** for the fixed-endpoint case, and **unchanged** from M4.0.

**Recommendation.** Keep DNS pinning **out of scope** for Phase 4, but do not
delete the issue. Record it as optional hardening that would reuse the existing
`dns-pin.ts` seam and `classifyIp`, to be reconsidered if B-6 is ever resolved via
N-2 with a resolver-level control. The threat it addresses is real in general and
marginal here, and pretending otherwise in either direction would be dishonest.

**Status: PROPOSED** — deferred, with a named implementation path.

#### 11.6.11 Impact on the Phase 4 test matrix

The interface change was checked against every in-scope Phase 4 test. **No test is
added, removed or renumbered, and the counts do not change.**

| Test  | Impact                  | Detail                                                                                                                         |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| T-10a | **Field paths only**    | Single-egress assertions are interface-agnostic. The recorded request is now `POST /v1/interactions`                           |
| T-11e | **None**                | Asserts lazy construction; independent of the interface                                                                        |
| T-13  | **None**                | Timeout behaviour is transport-level                                                                                           |
| T-14  | **None**                | Abort behaviour is transport-level                                                                                             |
| T-16a | **None**                | Env parsing and bounds are vendor-free                                                                                         |
| T-16b | **None**                | Composition copies the value; the field name is not asserted here                                                              |
| T-16c | **Expected field path** | Asserts `generation_config.max_output_tokens === 1234` instead of `generationConfig.maxOutputTokens`                           |
| T-17  | **Field read changes**  | Reads `status` (`completed`/`incomplete`) instead of `candidates[0].finishReason`; the three-valued assertion set is identical |
| T-18  | **None**                | Asserts the key never leaks, whatever the interface                                                                            |

**The interface swap itself added no tests: it changed no count.** At the time of
M4.0.1 the figures were Phase 4 = 9, in scope = 24, deferred = 2, registered = 26.
This is deliberate. The interface swap changes _which strings and field paths the
adapter handles_, not _what properties must be proven_. Adding tests there would
have inflated the matrix without adding coverage.

**Counts after M4.0.3 registered T-19 were: Phase 4 = 10, in scope = 25,
deferred = 2, registered = 27.** T-19 is unrelated to the interface choice — it
covers response body size ceilings (Section 11.6.8) — so it is an addition to the
matrix, not a consequence of the swap described above.

**M4.4 Revision 1 registers T-20..T-23 (§9.0b): Phase 4 = 14, in scope = 29,
deferred = 2, registered = 31.** Those four tests cover the ProviderCell lifecycle
specified in §11.1.8, which T-11e alone does not reach. This is the current count;
every other figure in this section that mentions 25 or 27 predates it and is
historical.

**The M4.2 reconciliation adds no T-ID and changes no count.** M4.2 allocates
`tests/unit/core/llm/gemini.provider.test.ts` and asserts the properties listed in
Section 11.5.1, but those are **local adapter unit tests**, not registered T-IDs.
T-16c, T-17 and T-18 stay assigned to M4.7; T-10a stays in its existing file with
assertion 4 BLOCKED. The registered total remained **27** at M4.2 (31 after M4.4
Revision 1).

Two new specification-level assertions are folded into **existing** tests rather
than new rows, because each is a property of an already-covered behaviour:

- **`store: false` is always sent** — folded into T-10a's expected-request
  assertion. A recorded request that omits `store` fails the test. T-10a remains
  in `tests/unit/core/llm/provider.factory.test.ts` and is **not** edited by M4.2;
  its assertion 4 stays BLOCKED. M4.2 additionally asserts `store: false` locally
  in `gemini.provider.test.ts` (Section 11.5.1, assertion 3), so the property is
  guarded during adapter development without claiming T-10a coverage.
- **`temperature` is never sent** — folded into T-16c, which already inspects the
  built request body. A body containing `temperature` fails the test. T-16c remains
  assigned to M4.7.

#### 11.6.12 Final recommendation

**Adopt the Interactions API: `POST https://generativelanguage.googleapis.com/v1/interactions`.**

The eight questions the milestone required answered:

1. **Which interface suits Phase 4 better?** The Interactions API. Google labels
   `generateContent` legacy and directs all new projects to the Interactions API,
   where new models and capabilities will launch (S-1, S-4). Building new code on
   the legacy surface guarantees a migration later for no present benefit.
2. **Does it fit Direct HTTP + `node:https`?** Yes, unchanged. One `POST` to one
   constant host, JSON in, JSON out, no SDK, no streaming, no polling.
3. **Does it add unnecessary complexity?** **No, and in two respects it reduces
   it.** Model selection moves into the body (one fewer string interpolated into a
   path), and errors become a documented `snake_case` lookup instead of an
   inference from HTTP status. The one genuinely new burden is `store: false`,
   which is a single constant field and is required for privacy regardless of
   interface.
4. **Does it fit the Provider abstraction?** Yes. `LlmProvider`, `LlmRequest`,
   `LlmResponse` and `LlmError` are vendor-free and unchanged. Only the adapter's
   internal wire handling changes.
5. **Must `GeminiTransport` change?** **No** (§11.6.7). It is already
   interface-agnostic.
6. **Effect on the tests?** T-16c and T-17 change the field they read; T-10a
   changes its expected request; T-11e, T-13, T-14, T-16a, T-16b and T-18 are
   unaffected. Counts unchanged (§11.6.11).
7. **New or modified test specs?** No new T-IDs. Two assertions are folded into
   T-10a and T-16c (§11.6.11).
8. **Residual lifecycle risk after this choice?** **Reduced but not eliminated.**
   The adopted surface is GA in `v1` and is where Google says new work goes, which
   removes the "will this be retired" risk that hung over `generateContent`.
   Remaining risks are real and are recorded in §11.6.13 rather than waved away.

**Why not keep `generateContent`.** It remains fully supported and would work
today. It is rejected because it is the surface Google explicitly calls legacy,
because new models will launch elsewhere, and because this service is greenfield —
the usual argument for staying on a legacy interface (existing integrations,
migration cost) does not apply. That is the whole of the argument; no claim is made
that `generateContent` is broken or about to be removed.

**What must change in this document because of this decision.** The M4.0 sections
that named `generateContent` are revised, not left standing:

| Section | Change                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------- |
| §11.1   | Request-mapping table now lists the Interactions field names, with the old names marked superseded |
| §11.1.2 | `temperature` is dropped, not merely ignored (§11.1.2)                                             |
| §11.1.3 | Endpoint, path, version, response fields and blocked-prompt handling rewritten                     |
| §11.6   | This section: the comparison, the recommendation and the risk register                             |

Sections §11.1.4–§11.1.8 are **unaffected**: API-key isolation, `node:https`
requirements, the SSRF posture, T-18 and lazy initialisation are all independent
of which endpoint is called.

#### 11.6.13 Residual risks and limitations of this decision

| #   | Risk                                                                 | Severity | Mitigation / status                                                                    |
| --- | -------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| R-1 | **No retirement date for `generateContent` is published**            | Low      | Irrelevant to the adopted interface; recorded for completeness                         |
| R-2 | **No retirement date for the Interactions API is published**         | Low      | It is GA in `v1`; `v1` is documented as supported for the major version's lifetime     |
| R-3 | **`Api-Revision` semantics are undocumented**                        | Low      | Not sent (§11.6.2.1). If it becomes required, one constant header                      |
| R-4 | **Google may change `status` enum values**                           | Medium   | Unknown values map to `null`/`invalid_response`, never silently to `false` (§11.6.4.3) |
| R-5 | **Model ids can be deprecated**                                      | Medium   | Alias indirection (§11.1.1); a dead id surfaces as `model_not_found`                   |
| R-6 | **`store: false` is a privacy control the vendor could change**      | Medium   | Asserted in T-10a and locally in M4.2; a change would fail the suite loudly            |
| R-7 | **The error taxonomy is documented for Interactions only**           | Low      | An advantage of the choice, but couples error mapping to one page                      |
| R-8 | **The response schema differs from every `generateContent` example** | Medium   | Fully specified in §11.6.4–11.6.5; T-16c and T-17 assert the new paths                 |

R-2 through R-8 are the honest cost of the choice. None of them is a reason to
prefer the legacy surface, and each has a named control.

**One risk is explicitly NOT introduced by this decision.** The interface change
does **not** address, reduce or replace the network-isolation problem. B-6 remains
**BLOCKED** (§11.2.2), T-10a assertion 4 remains blocked, and no part of this
re-evaluation may be cited as evidence that egress is contained.

---

## 12. Acceptance criteria

I7-1b is complete when all of the following hold. Each criterion names the test
that proves it. There are **29 in-scope tests** across Phases 1–4; all 29 appear in
at least one criterion (T-01 covers both the type surface and model identity, so it
appears in two).

T-12 and T-15 are **not** acceptance criteria for I7-1b. They are deferred to the
milestone that creates the consumer modules (Section 9.6), and this milestone
makes no claim about consumer independence.

1. `LlmProvider`, `LlmRequest`, `LlmResponse` and the error taxonomy exist and
   contain no vendor type. — T-01
2. `FakeProvider` passes T-01..T-06 and imports no networking module.
   — T-01, T-02, T-03, T-04, T-05, T-06
3. `createProvider` satisfies the factory contract: the fake path never reaches
   the credential stage, an unknown provider throws `LlmConfigurationError`,
   importing the factory constructs nothing, and the config type carries no
   `maxOutputTokens`. The fake path also **never invokes** a supplied
   `createTransport` callback (0 calls), and loads neither `gemini.transport.ts`
   nor a Gemini vendor SDK (Section 9.2.2). — T-07, T-08, T-10
4. A missing key throws `LlmConfigurationError` **at the factory call**, not at env
   load, and the failure happens **before** transport resolution: a supplied
   `createTransport` callback is called 0 times, `gemini.transport.ts` is never
   imported, and no network request occurs (Section 9.2.1). — T-09
5. The env schema does not require `GEMINI_API_KEY`: `loadEnv()` succeeds with
   `LLM_PROVIDER=gemini` and no key, and there is no `superRefine` or cross-field
   credential rule in `src/config/env.ts`. — T-09a
6. Both CLIs' `--help` paths exit 0, construct no provider, and load no
   environment configuration at all — `env.ts` is never evaluated, so
   `GEMINI_API_KEY` is neither read nor parsed. — T-11a, T-11b
7. Both CLIs' dry-runs construct no provider, never invoke `createProvider`, do not
   pass `GEMINI_API_KEY` into provider configuration, make no network request, and
   succeed with `GEMINI_API_KEY` unset. The dry-run **may** evaluate `env.ts` to
   resolve `DATABASE_PATH` and therefore **may** parse `GEMINI_API_KEY` as part of
   the environment object; the criterion is that the key is never consumed, not that
   it is never parsed. — T-11c, T-11d
8. `createRuntime()` starts with `GEMINI_API_KEY` unset and eagerly constructs and
   loads no Gemini provider and no Gemini transport: no provider is constructed, the
   `createTransport` callback is never invoked, and `providers/gemini.transport.ts`
   is absent from the module registry. "No vendor SDK loaded" is retained only as a
   forward-looking guard, because no SDK is installed (Section 9.0a). Verified in
   Phase 4, after the runtime composition this criterion guards is introduced.
   — T-11e (Phase 4)
9. The Gemini adapter has a single network egress, evidenced three ways and all
   three required: **runtime** (construction sends nothing; `calls.length === 0`;
   `complete()` used the recording double), **network isolation** (the test process
   demonstrably cannot reach the network — N-1, or N-2 with a fully accounted
   coverage table), and **static architecture** (both parts: the adapter dependency
   closure contains no networking API, no global `fetch`, no dynamic import, and no
   unlisted bare specifier; and the production composition path constructs no second
   transport or HTTP client). Missing any one of the three means T-10a fails. Until
   the network-isolation evidence exists, this criterion is **BLOCKED**. — T-10a
10. An adapter timeout surfaces as `LlmTimeoutError` with `kind: 'timeout'`, and an
    aborted `signal` rejects instead of resolving late. — T-13, T-14
11. `maxOutputTokens` is verified at all three layers separately: the env default
    parses and validates, the composition layer copies it into the request, and the
    adapter maps it to the vendor field unmodified. The factory never reads it.
    — T-16a, T-16b, T-16c
12. Truncation is reported three-valued: length stop → `true`, normal stop →
    `false`, unknown → `null`, with `null` never collapsed to `false`. — T-17
13. `typecheck`, `lint`, `format:check`, `build` and the full Vitest suite pass.
14. No secret appears in any log line, error message, or test output. This is
    **enforced by a test**, not merely asserted: a synthetic key that is echoed by
    the vendor response body must not reach an error message, a log line, or a
    propagated body (Section 11.1.4, Section 11.1.7). — T-18
15. No new environment variable is required for the current deployment to boot.
16. The adapter calls the adopted interface: exactly one `POST /v1/interactions`,
    with `store: false` always present and no `temperature` key in the body, and
    with the response read from `steps[type=model_output]` and `status`. A request
    to any `generateContent` path fails the suite. — T-10a, T-16c, T-17
17. Response bodies are read with a bounded byte counter, not buffered unbounded:
    a success body over 1 MiB and an error body over 64 KiB are rejected as
    `invalid_response` with the stream destroyed, a body truncated at the ceiling
    is never parsed, and a body with an under-declared `Content-Length` is still
    stopped. All eight assertions of Section 11.6.8.7 hold. — T-19
18. The runtime's provider cell behaves as Section 11.1.8 and Section 11.1.8.2
    specify, proven by four independent tests rather than by the startup check
    alone. **Lazy startup is not sufficient for this criterion.** All of the
    following hold:

    - **Concurrent initialisation sharing (runtime evidence).** Concurrent
      `getProvider()` calls share exactly one `createProvider` invocation, return
      **distinct** wrapper promises (`promiseA !== promiseB`), and resolve to the
      **same** provider instance — proven by T-20 through the public API and the
      factory's call count alone;
    - **Wrapper is not the internal attempt (implementation-review evidence).**
      `ProviderCell.pending.attempt` is shared and is never returned directly, and
      each call returns its own wrapper. T-20 **cannot** observe that private
      promise; the separation is verified by inspecting `src/runtime.ts` during
      implementation acceptance, and no test seam may be added to expose it;
    - **Retry after failure is externally observable.** A failed initialisation is
      not cached; a later call starts a new attempt and succeeds, proven by the
      injected factory's call count and the public API's results alone, with no
      private cell state inspected and no test-only accessor added — T-21;
    - **Disposal does not wait.** `dispose()` during a pending initialisation
      completes without awaiting the build, and a late resolution or rejection
      neither resurrects the cell nor produces an unhandled rejection — T-22;
    - **In-flight caller is rejected by disposal.** A `getProvider()` promise
      returned **before** disposal but still **unsettled** when disposal begins
      rejects with `RuntimeDisposedError`, and `kind === 'disposed'` is asserted
      without matching message text. A late initialisation success cannot publish a
      provider to that caller, and a late initialisation rejection cannot override
      the disposal result — T-22;
    - **Post-disposal calls reject.** `getProvider()` after disposal rejects with
      `RuntimeDisposedError` carrying `kind === 'disposed'`
      (`instanceof LlmError === false`) and invokes neither `createProvider` nor the
      transport seam — T-23;
    - **No provider is retroactively revoked.** A provider delivered to a caller
      whose wrapper settled **before** disposal began is not invalidated by a later
      disposal; the guarantee is scoped to unsettled calls only.

    The 33 pre-existing `tests/integration/runtime.test.ts` cases and the existing
    `tests/unit/core/llm/` tests remain green; M4.4 must not weaken them to obtain a
    pass. — T-20, T-21, T-22, T-23

### 12.1 T-ID → Phase → Acceptance criterion

| Test  | Phase      | Acceptance criterion |
| ----- | ---------- | -------------------- |
| T-01  | 1          | 1, 2                 |
| T-02  | 1          | 2                    |
| T-03  | 1          | 2                    |
| T-04  | 1          | 2                    |
| T-05  | 1          | 2                    |
| T-06  | 1          | 2                    |
| T-07  | 2          | 3                    |
| T-08  | 2          | 3                    |
| T-09  | 2          | 4                    |
| T-09a | 2          | 5                    |
| T-10  | 2          | 3                    |
| T-11a | 3          | 6                    |
| T-11b | 3          | 6                    |
| T-11c | 3          | 7                    |
| T-11d | 3          | 7                    |
| T-11e | 4          | 8                    |
| T-10a | 4          | 9, 16                |
| T-13  | 4          | 10                   |
| T-14  | 4          | 10                   |
| T-16a | 4          | 11                   |
| T-16b | 4          | 11                   |
| T-16c | 4          | 11, 16               |
| T-17  | 4          | 12, 16               |
| T-18  | 4          | 14                   |
| T-19  | 4          | 17                   |
| T-20  | 4          | 18                   |
| T-21  | 4          | 18                   |
| T-22  | 4          | 18                   |
| T-23  | 4          | 18                   |
| T-12  | — deferred | none (Section 9.6)   |
| T-15  | — deferred | none (Section 9.6)   |

All 29 in-scope tests are mapped, and no criterion is orphaned. Criteria 13 and 15
are process gates rather than test cases, which is why they have no T-ID. Criterion
16 is proven by T-10a, T-16c and T-17, which are already counted; criterion 17 is
proven by T-19. T-12 and T-15 are listed for completeness, are marked deferred, and
deliberately map to no criterion — they carry no acceptance criterion because I7-1b
does not run them.

| Scope      | Count |
| ---------- | ----: |
| In scope   |    29 |
| Deferred   |     2 |
| Registered |    31 |

---

## 13. Approved design decisions

These seven were reviewed and approved. They are settled: implementation follows
them, and they are not to be reopened as open questions.

| #   | Decision                    | Approved outcome                                                                                                                         | Where specified  |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| D-1 | Default provider            | `fake`. Nothing contacts a vendor unless an operator opts in.                                                                            | 7.1, 7.2 rule 5  |
| D-2 | Gemini API key validation   | Deferred to the Provider Factory, at the moment the Gemini provider is actually built. **Not** in the global env schema's `superRefine`. | 5.2 stage 4, 7.2 |
| D-3 | Cancellation mechanism      | The Provider Interface accepts `AbortSignal`; the existing `cancellation.ts` mechanism is **not** rewritten.                             | 4.1, 6.4         |
| D-4 | Model naming                | Independent logical model names, mapped to vendor model ids by the adapter.                                                              | 4.1, 4.3         |
| D-5 | Retry responsibility        | The caller manages retries; the provider only classifies errors as retryable or not.                                                     | 1.2, 6.2         |
| D-6 | Structured output           | Not supported in V1. Text in, text out. Revisited only on concrete business need.                                                        | 1.2              |
| D-7 | Token usage when unreported | `null`, never `0`, so "not reported" is distinguishable from "used nothing".                                                             | 4.2              |

### 13.1 Still open

Only the following remain undecided. Everything above is closed. None of these
reopens a D-1..D-7 decision; each is a value or vocabulary question that sits
_inside_ an approved decision.

1. **`LLM_MODEL` logical name vocabulary.** D-4 approves the _mechanism_ —
   logical names, mapped by the adapter — and Section 11.1 proposes
   `default` / `fast` / `high-quality`. What is not yet ratified is whether that
   is the final set. The proposed names are usable now; a different vocabulary
   would change the table in 11.1, not the design.
2. **Concrete vendor model id per logical name.** **Resolved and ratified (O-1).**
   Section 11.1.1 records verified vendor ids for all three aliases, with the
   official documentation URLs and the verification date (2026-11-18). Mapping
   _ownership_ was already settled (Section 4.4); the three values were approved in
   the M4.2 reconciliation, so O-1 (Section 11.4) is closed.
3. **Production values for the proposed defaults.** `LLM_TIMEOUT_MS = 30000` and
   `LLM_MAX_OUTPUT_TOKENS = 2048` are adopted as working defaults (Section 7.1,
   marked "Proposed"), so the design is complete and implementable. They need
   sign-off as production values once real article lengths are known. This is a
   tuning question, not a missing design.
4. **Response body size ceilings.** Approved as **provisional** by M4.0.2: 1 MiB
   for a success body and 64 KiB for an error body, with the capacity analysis in
   Section 11.6.8. They remain provisional because the UTF-16 and concurrency
   assumptions are estimates pending implementation-stage verification
   (Section 11.6.8.8). The values are authorised; their safety is not yet proven.
   M4.0.3 registered **T-19** to verify the bounded-reading and abort behaviour
   (Section 11.6.8.7) and retained the 32,768 output-token maximum
   (Section 11.6.8.4a). Neither action upgrades these values from provisional.
5. **API interface.** Closed by M4.0.1: the Interactions API is adopted
   (Section 11.6.12). It is listed here only so a reader arriving from an older
   draft knows the question is no longer open.

> Note: an earlier draft listed the seven approved decisions above as open
> questions. That was superseded by the approval recorded in this section.

Three questions that were **not** open decisions but genuine specification gaps
were closed by M4.4 Revision 1 and must not be reopened as open questions: the
provider accessor is named `getProvider()` (§11.1.8), the provider configuration
is projected once from `env` at `createRuntime()` time (§11.1.8.1), and the
disposed-state error is `RuntimeDisposedError` in `src/runtime.ts` (§6.1,
§11.1.8).

Two further gaps were closed by M4.4 Revision 2 and are equally settled. First,
`getProvider()` returns a **per-caller disposal-aware wrapper**, never the raw
internal initialisation attempt, and a caller whose call is still unsettled when
disposal begins rejects with `RuntimeDisposedError` (§11.1.8.2, T-22). A provider
already delivered before disposal is not retroactively revoked. Second, the
ProviderCell is private and is proven by observable API behaviour only; no test-only
accessor or debug hook may be introduced (§9.0b T-21, §11.5.3 B).

M4.4 Revision 3 closed the three precision gaps that remained. T-20 asserts
**distinct wrapper promises** over one shared attempt, never a shared Promise object
(§9.0b T-20). "Settled" is defined as the wrapper's own arbitration commit, with an
explicit four-invariant ordering rule covering same-tick and microtask interleavings
(§11.1.8.2). The `ready` fast path performs the disposal check before reading the
stored provider and still returns a fresh wrapper (§11.1.8).

M4.4 Revision 4 separated T-20's evidence into two kinds. **Runtime assertions** —
one `createProvider` call, distinct wrapper promises, one identical resolved provider,
no second initialisation — are proven by T-20 through the public API. **Architectural
invariants** — the attempt lives in `ProviderCell.pending.attempt`, is shared, is
never returned directly, and no wrapper _is_ the attempt — are verified by
implementation review of `src/runtime.ts` at acceptance, because the private promise
is unobservable by design and no test seam may expose it (§9.0b T-20, §12 criterion
18).

---

## Appendix A — Files inspected for this design

Read-only inspection; no file was modified to produce this document.

- `src/config/env.ts`, `src/config/constants.ts`
- `src/core/errors.ts`, `src/core/logger.ts`
- `src/core/lifecycle/cancellation.ts`
- `src/core/persistence/sqlite.ts`, `src/core/persistence/read-only.ts`,
  `src/core/persistence/migrations.ts`
- `src/modules/extraction/` — `clock.ts`, `extraction.constants.ts`,
  `extraction.errors.ts`, `extraction.types.ts`, `extraction.service.ts`,
  `http/safe-fetch.ts`
- `src/modules/ingestion/feed/feed.client.ts`,
  `src/modules/ingestion/repository/article.repository.ts`
- `src/cli/args.ts`, `src/cli/usage.ts`, `src/cli/extract.ts`, `src/cli/ingest.ts`,
  `src/cli/extraction.cli.ts`, `src/cli/ingestion.cli.ts`
- `src/runtime.ts`
- `docs/architecture.md`
- `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `package.json`,
  `vitest.config.ts`, `.env.example`
- `tests/helpers/env.ts`, `tests/unit/cli/extraction-exit-codes.test.ts`,
  `tests/integration/cli/dry-run.test.ts`
