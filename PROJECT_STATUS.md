# Kou News Engine — Project Status & Handoff

Last updated: 2026-11-18 (M5.0-R2: Owner M4.5 decision recorded, decision numbering and cross-references corrected; verification pending review. GOV-1: Single-Maintainer Governance Model adopted as documentation — platform configuration not performed)

## 1. Purpose

This document is the persistent handoff entry point for future development sessions.

Before starting any new milestone, read this file and verify the actual repository state. Do not treat historical information in this document as proof of the current working tree.

The project uses milestone-based development with explicit scope authorization and evidence-based acceptance.

## 2. Engineering Collaboration Rules

### 2.1 Milestone workflow

Every milestone should follow this process:

1. Specification preflight:
   - Inspect relevant design documents, source code, tests, and cross-module dependencies.
   - Identify contradictions and missing decisions before implementation.
2. Consolidated authorization:
   - Explicitly list authorized files.
   - Define prohibited changes, tests, acceptance criteria, and stop conditions.
3. Batch implementation:
   - Complete all authorized implementation and tests within the approved scope.
   - Avoid unnecessary interruptions for minor steps.
4. Consolidated acceptance:
   - Report complete diffs, file hashes, test results, Git status, and limitations.
   - Do not claim PASS without supporting evidence.

### 2.2 Safety restrictions

Unless explicitly authorized by the user:

- No `git add`, `commit`, `push`, `fetch`, `pull`, `reset`, `restore`, `stash`, or other Git state-changing operations.
- No modifications outside the authorized file list.
- No production database, WAL, or SHM operations.
- No real Gemini API key usage or real Gemini API calls.
- No unapproved Factory, Runtime, deployment, or cross-milestone changes.
- Never relabel BLOCKED items as PASS.
- Never silently expand milestone scope.

### 2.3 Evidence requirements

For every milestone, report:

- Exact files changed.
- SHA-256 hashes where applicable.
- Relevant test commands and results.
- TypeScript, lint, and formatting results where applicable.
- Git branch, HEAD, and working-tree status.
- Explicit confirmation of prohibited operations not performed.
- Remaining limitations and blockers.

## 3. Historical Git Baseline

The following values are historical evidence from the M4.2 acceptance period. They
must be re-verified before use. They are **not** the current state; see the
"Current working tree (post-M4.4)" table below.

| Item             | Historical value                           |
| ---------------- | ------------------------------------------ |
| Branch           | `main`                                     |
| HEAD             | `40bd62df75289e639ea809e058a4d6077d22d620` |
| Staged changes   | 0                                          |
| Unstaged changes | 9                                          |
| Untracked files  | 12                                         |

Current working tree (post-M4.4 acceptance, measured at revision-plan time):

| Item             | Current value                              |
| ---------------- | ------------------------------------------ |
| Branch           | `main`                                     |
| HEAD             | `40bd62df75289e639ea809e058a4d6077d22d620` |
| Staged changes   | 0                                          |
| Unstaged changes | 11                                         |
| Untracked files  | 13                                         |

None of the 24 pending files (11 modified, 13 untracked) has been committed. HEAD
remains the pre-M4.4 commit `40bd62d`. The entire LLM layer under
`src/core/llm/`, its tests, this design document, and this status file exist only
in the working tree and cannot be recovered from HEAD. A checkpoint commit has
not been created.

Historical file hashes:

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `docs/design/i7-1b-llm-provider.md` | `f95739063732308b46222ead07f1bc1f7d0d4dac8399528d2dc7f945c9ef26c4` |
| Gemini Adapter source               | `dffbe0fdb874e394de7d9e034202f66ed7e6e468028d68afeac7839420dcf85b` |
| Gemini Adapter test                 | `33bc32edbb4e1077ca2deac43f8d77b68c99b9492bd922bcd3967a37dc0096a6` |
| `llm.errors.ts`                     | `29eea0c1c7423afbef78518fb64a9d84c59e929e560b057d49ad6db6cf56b141` |
| `provider.factory.test.ts`          | `4f04f03715b6feaaa4a8fe3ce570733a662fff954c0185092764be8f616cb7b5` |

Do not overwrite these historical values with guesses. Update them only after an explicitly authorized status refresh.

## 4. Completed Milestones

### M4.0 — Specification Reconciliation

Completed and accepted.

### M4.1 — Gemini HTTP Transport

Completed.

The transport implementation and its tests passed. M4.1.1 subsequently reconciled the Factory type-only tests and design documentation.

Reported verification:

- Factory tests: 38/38 PASS
- Transport tests: 16/16 PASS
- Full test suite: 1522/1522 PASS
- TypeScript, ESLint, and Prettier: PASS

No production source changes were made in M4.1.1.

### M4.2 — Gemini Adapter

Completed and formally accepted.

Authorized implementation files:

- `src/core/llm/providers/gemini.provider.ts`
- `tests/unit/core/llm/gemini.provider.test.ts`

Approved design decisions:

- Constructor: `new GeminiProvider(config, { transport })`
- `GeminiProviderConfig = Omit<LlmProviderConfig, 'apiKey'>`
- `GeminiProviderDeps.transport` is required.
- Gemini API communication occurs only through the transport abstraction.
- `store: false` is explicitly sent.
- Only text from `steps[type=model_output].content[].text` is merged.
- Missing usage values map to null.
- Truncated state preserves three-valued semantics.

Reported verification:

- Gemini Adapter tests: 76/76 PASS
- Transport tests: 16/16 PASS
- Factory tests: 38/38 PASS
- Fake provider tests: 48/48 PASS
- Full Vitest suite: 1598/1598 PASS, 62 files
- TypeScript, lint, Prettier: PASS
- Mutation testing detected the specified regressions; mutations were reverted and hashes verified.

No real Gemini API key or real Gemini API call was used.

Factory wiring was explicitly outside M4.2 and remains incomplete.

### M4.2 — Documentation Reconciliation

Completed and formally accepted.

Final reported design document hash:

`f95739063732308b46222ead07f1bc1f7d0d4dac8399528d2dc7f945c9ef26c4`

Document reconciliations included:

- HTTP 499 cancellation retryability aligned with the shared retryability mapping.
- `Content-Type: application/json` responsibility documented.
- Whitespace-only output classified as `empty_response`; original non-whitespace text is preserved.
- No model-output text classification aligned with retry policy.
- 23 classification rows compared against `RETRYABLE_BY_KIND`, with zero mismatches.

No production source or test files were changed during these documentation-only reconciliations.

### M4.3 — Factory Wiring

**M4.3 ACCEPTED — PASS.** M4.3 is independently completed and formally accepted;
it is not folded into M4.4.

Authorized implementation files:

- `src/core/llm/provider.factory.ts`
- `tests/unit/core/llm/provider.factory.test.ts`

Implementation summary:

- The `gemini` branch of `createProvider` no longer terminates with a
  not-implemented `LlmConfigurationError`. It validates the credential, validates
  the `createTransport` seam, lazily imports the adapter, narrows the config so
  `apiKey` is not forwarded, resolves the transport exactly once, and returns a
  constructed `GeminiProvider`.
- Three factory tests were authorized to change: one replaced by a runtime
  credential-isolation test, one replaced by the approved Gemini success-path
  test, and one strengthened to use a successful transport double.
- Credential-validation order relative to transport resolution is unchanged.
- `fake`-provider and unknown-provider behaviour are unchanged.
- Test 164's original subject (a key never appearing in an error) is retired from
  the factory file and remains T-18's responsibility under M4.7. M4.3 neither
  completes nor narrows T-18.

Not closed by M4.3: T-10a assertion 4 and B-6 remain BLOCKED; T-16c, T-17 and
T-18 remain deferred to M4.7.

### M4.4 — Runtime Lazy Composition

Formally accepted: **M4.4 ACCEPTANCE — PASS**.

Authorized implementation files (exactly two, both tracked in HEAD):

- `src/runtime.ts`
- `tests/integration/runtime.test.ts`

Implementation summary:

- `Runtime.getProvider(): Promise<LlmProvider>` added to the `Runtime` interface.
- Lazy provider initialization: `createRuntime()` builds no provider. The first
  `getProvider()` call performs a synchronous `idle → pending` transition and
  starts the initialization attempt.
- Concurrent callers share one internal initialization attempt but each receives
  its own disposal-aware wrapper promise. The internal attempt is never returned
  directly.
- `RuntimeDisposedError` (with `RuntimeErrorKind = 'disposed'`) extends plain
  `Error`, deliberately outside the `LlmError` hierarchy, so `LlmError`
  classifiers cannot swallow a lifecycle condition. `kind` is `'disposed'`; no
  new `LlmErrorKind` was introduced.
- Disposal and settlement arbitration: `dispose()` does not await a pending
  initialization; unsettled callers are settled with `RuntimeDisposedError`; a
  late success cannot resurrect a disposed runtime, and a late rejection neither
  resurrects nor escapes as an unhandled rejection. A provider already committed
  before disposal is not revoked.
- LLM configuration projection at runtime creation: `LLM_PROVIDER`, `LLM_MODEL`,
  `LLM_TIMEOUT_MS` and `GEMINI_API_KEY` are captured once and passed to
  `createProvider`. The transport module is loaded dynamically only when the
  `gemini` adapter is selected.

Verification results — **last verified at M4.4 acceptance; not re-executed for
this documentation revision**:

- Runtime integration tests: 50/50 PASS
- Full Vitest suite: 1615 tests across 62 files, PASS
- `tsc --noEmit`, ESLint, Prettier `--check` (both files), and
  `tsc --noEmit -p tsconfig.build.json`: PASS
- No real Gemini API key and no real Gemini API call were used.

## 5. Approved Gemini Model Mapping

The following mapping was explicitly approved:

| Model profile  | Gemini model            |
| -------------- | ----------------------- |
| `default`      | `gemini-3.8-flash`      |
| `fast`         | `gemini-3.5-flash-lite` |
| `high-quality` | `gemini-4-argon`        |

Do not change this mapping without explicit user approval.

## 6. Outstanding Blockers and Deferred Work

The following items remain unresolved. Unless a line says otherwise, each was
explicitly not resolved by M4.2 and has not been closed since.

- T-10a assertion 4: BLOCKED.
- B-6: BLOCKED.
- O-3: BLOCKED (whether N-1 egress denial is available).
- Network isolation evidence (N-1 / N-2): **not established.**
- B-5: `OPEN — implementation`. **Not** closed by the M4.5 acceptance; requires
  separate evidence-based reconciliation (see §7).
- M4.5 audit limitations: **preserved, not discharged** by acceptance — see §7.
- T-16c, T-17, T-18: assigned to M4.7.
- Gemini Provider Factory wiring: **completed** in M4.3 — the `gemini` branch of
  `createProvider` now validates the key and transport seam and constructs
  `GeminiProvider`. (Was outstanding at M4.2.)
- Runtime integration: **completed** in M4.4 as `Runtime.getProvider()`. It is
  exposed but not called by any production path; wiring a consumer is a later
  milestone. (Was unassigned at M4.2.)

These items must not be silently marked as completed.

## 7. Current Next Milestone

### M5.0 — PR CI Security Specification

Status: **SPECIFICATION COMPLETE; VERIFICATION PENDING REVIEW.**

M5.0 adds a _separate_ CI security objective without altering any M4.6 result.
It defines Assertion 4-A (credential and test-transport isolation) and Assertion
4-B (untrusted fork PR execution boundary) in
`docs/design/i7-1b-llm-provider.md` §9.5.3.7, records the Owner's D1–D13 / G1–G2 /
G7 decisions in §13.0a, and creates `docs/security/ci-security-model.md`.

M5.0 is a **scope revision, not a finding revision.** It does not produce
network-isolation evidence and does not discharge B-6.

### M5.1 — GitHub Actions CI Foundation

Status: **IMPLEMENTED; VERIFICATION PENDING REVIEW.**

Adds `.github/workflows/ci.yml`, `.github/CODEOWNERS`, and two test files
(`tests/unit/core/llm/no-real-transport.test.ts`,
`tests/unit/ci/workflow-policy.test.ts`). No `src/**` change is required: the
Fake-transport seam already exists.

**M5.1's workflow-declared controls are verifiable in-repository. Its repository
settings controls are not**, and are listed as a manual checklist in
`docs/security/ci-security-model.md` §7. Until that checklist is verified, 4-B is
only half established.

### GOV-1 — Single-Maintainer Governance Model

Status: **DOCUMENTATION ADOPTED; PLATFORM CONFIGURATION NOT PERFORMED.**

The Owner adopted a **Single-Maintainer Governance Model**. The project is
independently maintained and no qualified independent technical reviewer is
currently available.

- **D7 and D8 are superseded** for the sole-owner case by the Owner-approved
  policy recorded in `docs/design/i7-1b-llm-provider.md` §13.0a. The previous
  "defer rather than self-approve" disposition no longer governs that case.
- **`.github/CODEOWNERS` is retained as ownership and responsibility metadata.**
  Mandatory Code Owner approval is **deferred, not abolished**, and is to be
  reconsidered when a qualified independent reviewer becomes available.
- **Owner self-review plus required CI are the normal merge prerequisites.** The
  Owner may merge their own PR through the normal configured merge path with
  required approving reviews at **zero**. Administrator bypass is not the routine
  mechanism, and the bypass list is intended to remain empty.
- **Self-review is not independent review** and must never be described as such.
  A self-review record is required in the PR description for CODEOWNERS-listed
  paths. This is a maintainer operating procedure; GitHub Rulesets do **not**
  natively enforce PR description content.
- **R3 keeps its existing rating and acceptance status.** Only its mitigation and
  residual-risk descriptions were corrected, to distinguish external-contributor
  PRs (independent review possible but not mandatory) from Owner-authored PRs
  (self-review only, with false-green CI not eliminated). See
  `docs/security/ci-security-model.md` §6.3.
- **GitHub Ruleset configuration remains unverified and unconfigured.** It
  requires separate authorization. S3/S4 record intended values only; no
  required status check is active and no bypass configuration has been applied.
- **First publication is intended to use PR-first bootstrap**, subject to
  successful empirical validation of the first `pull_request` CI run. **No direct
  push to `main` and no bootstrap exception is authorized.**

GOV-1 changes governance text only. It reclassifies no finding: Assertion 4,
B-6, O-3 and T-10a remain **BLOCKED**, and the repository has **not** been
published.

### M4.5 — Static Architecture Evidence (B-5) — accepted with audit limitations

Status: **ACCEPTED WITH AUDIT LIMITATIONS** (Owner decision, M5.0-R2).

The milestone is accepted. The acceptance is **scoped**: it is not unconditional,
not a full verification, and not free of audit limitations. The preserved
limitations are recorded in `docs/design/i7-1b-llm-provider.md` §11.5.4a:

1. Historical byte-level provenance of the design document was not established.
2. N19 does not independently detect an edge-kind-only deduplication mutation.
3. N21 lacks a non-empty guard, allowing vacuous success if `expressEdges` is empty.
4. Historical unauthorized Git restoration and test-helper mutation incidents
   remain part of the audit history; final hashes do not prove exact historical
   recovery.
5. The previously identified formatting discrepancy remains an audit limitation.

Per the design document (§11.5), M4.5 depends on M4.2 and M4.4 and stops if a bare
specifier cannot be justified.

**M4.5 acceptance does not close B-5.** B-5 remains `OPEN — implementation` and
requires separate, evidence-based reconciliation against the allow-list artifact.
The milestone acceptance is a decision about the *milestone*; B-5 is a condition
about the *evidence*. See `docs/design/i7-1b-llm-provider.md` §11.2.1 and §11.5.4a.
Do not infer `RESOLVED` for B-5 from this acceptance.

<details>
<summary>Historical: M4.3 candidate specification preflight (superseded)</summary>

### M4.3 — Candidate Milestone Specification Preflight

Status: PRE-FLIGHT PENDING REVIEW

The planned next activity is a read-only specification preflight.

The preflight must:

1. Read this document first.
2. Verify the actual branch, HEAD, and working-tree state.
3. Inspect the formal M4.3 milestone definition.
4. Inspect relevant sections of `docs/design/i7-1b-llm-provider.md`.
5. Inspect Gemini Transport, Adapter, Factory, Runtime, error classification, types, and relevant tests.
6. Check cross-document and cross-module consistency.
7. Identify missing decisions, test coverage gaps, and scope conflicts.
8. Recommend the minimum implementation authorization scope.

The preflight is NOT implementation authorization.

Do not modify files during the preflight.

Do not assume M4.3 includes Factory wiring or Runtime integration until the formal specification confirms it.

The preflight report must conclude with one of:

- READY
- BLOCKED
- NEEDS DESIGN REVISION

Stop after delivering the report.

</details>

## 8. Project Handoff Rules for New Sessions

At the beginning of each new OpenHands session:

1. Read `PROJECT_STATUS.md`.
2. Verify the current repository root, branch, HEAD, and Git status.
3. Compare the actual state against the historical baseline.
4. Identify the latest accepted milestone.
5. Identify unresolved blockers and approved decisions.
6. Ask for or follow explicit milestone authorization.
7. Never infer authorization from historical work.

If actual repository evidence conflicts with this document, report the conflict rather than silently changing the document.

This file is a handoff record, not an authorization to perform future work.
