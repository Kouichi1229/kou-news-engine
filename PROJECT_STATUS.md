# Kou News Engine — Project Status & Handoff

Last updated: 2026-11-26 (Phase 1.15 documentation-only M-01 cross-section policy consistency correction, independently audited at Phase 1.16 with the verdict PASS WITH FINDINGS — L-01 and L-02 remain OPEN and are carried into Phase 2 planning prerequisites. Every Processing, Recovery, Claim, Outbox delivery, correction, alert and retention feature remains NOT IMPLEMENTED — see §6)
Previous update: 2026-11-24 (M6.0 documentation reconciliation: status refreshed against verified post-merge repository state — ruleset active, PR #1 merged, M5.1 reclassified PARTIAL, retention requirements recorded, Gemini model-ID validity recorded as unverified)

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

> **The paragraph above is a historical record of the M4.4 period and is no
> longer true.** It is preserved verbatim because this document does not rewrite
> history. The current state is recorded below.

### Current state (M6.0 reconciliation)

| Item | Current value |
| --- | --- |
| Local branch | `docs/m6-0-reconciliation` (created for M6.0) |
| Local branch base | `17a8c1cfbd28903fa204f0aa75baedac8c006e8f` |
| Remote `main` | `17a8c1cfbd28903fa204f0aa75baedac8c006e8f` |
| Working tree | Clean — 0 modified, 0 staged, 0 untracked |

- **PR #1 was merged into `main`** at merge commit
  `17a8c1cfbd28903fa204f0aa75baedac8c006e8f`. The merge is a true two-parent
  merge commit; its first parent is the previous `main` head `fd3a37b` and its
  second parent is the source branch head `82db0314`.
- **The local `feat/bootstrap-publication` branch has not moved to `main`.** It
  still points at `82db0314d8dbfe5d1e595ad537bd0e4096d5ba91`. Its tree is
  identical to the merge commit's tree, but the branch reference itself is
  unchanged.
- **The LLM layer, its tests, the design document and this status file are all
  committed and present in `HEAD`.** The earlier statement that they "cannot be
  recovered from HEAD" is historical only.
- This table records a point-in-time observation. Re-verify before relying on it;
  see §8.

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

### M0 — Project scaffolding

Completed. Recorded retroactively during M6.0 from repository evidence; no new
verification was performed for this entry.

Scope as evidenced by commit `d7f642b` ("Add Milestone 0 implementation and
ingestion module") and the current `src/` tree:

- Project scaffolding: `package.json`, TypeScript configuration, ESLint and
  Prettier configuration, `.editorconfig`, `.nvmrc`.
- Express bootstrap: `src/app.ts`, `src/index.ts`, `src/server.ts`.
- Environment validation (`src/config/`, Zod) and `.env.example`.
- Health and readiness endpoints (`/api/health`, `/api/ready`).
- Centralized error handling and a consistent error envelope.
- Unit and integration test suite with coverage reporting (Vitest, Supertest).
- Initial feed-ingestion module and SQLite persistence.

No M0 acceptance report exists in this document's history; this entry records
scope only. It makes no claim about which checks were run at the time.

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

**Verification status: `NOT VERIFIED`.** The three vendor identifiers above have
not been independently verified against Google's published model catalogue, and
no Gemini API call has been made to confirm them. This is recorded as a known
verification risk. It does **not** assert that any identifier is invalid, and it
does not authorize a change: the mapping above remains in force and any change
still requires explicit Owner approval. See §6.

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
- **Original-content retention: `NOT IMPLEMENTED` — requirement recorded only.**
  The authoritative rules are stated in `docs/architecture.md` under
  _Original-content retention (planned)_; this file does not restate them. The
  168-hour period now runs from the **most recent discovery** of an article, so
  rediscovery extends it, while the first discovery is recorded once per data
  lifecycle and is never overwritten (the `first_seen_at` / `last_seen_at`
  concepts; their column names, tables and types are undecided). No retention
  behaviour exists and no schema supports it yet. **The deletion scope is
  Owner-decided** — full deletion of the content, the system-managed copies of
  the original media, the identifying records and the timestamp records, with no
  tombstone — but the **physical deletion mechanism and its verification standard
  are still to be specified**; WAL, freelist, backups and external media remain
  unresolved, and none of this is a secure-erasure guarantee. Derived-content
  retention is unchanged: 720 hours from successful generation and persistence,
  never removed by original-content expiry, with the source URL kept for the
  derived record's lifetime. The derived record stores **its own copy** of that
  URL and the Traditional Chinese title, so it does not depend on the article row;
  the original title is not required. Empty, failed and pending rows follow the
  same 168-hour clock. If the same news item is discovered again after deletion, a
  new lifecycle and new derived records may result, and that duplication is
  accepted, not an error. Open technical details are tracked as `SPEC-GAP-01`
  and `SPEC-GAP-02` in
  `docs/design/m7-0-ai-news-processing-pipeline.md`.
- **Notification, correction and alert policy: `NOT IMPLEMENTED` — decisions recorded only.**
  M7.0 now fixes the Article Lifecycle identity the Outbox stores, at most one
  initial-success notification per lifecycle, AI-judged major-correction
  notifications with their own evidence and 720-hour retention, persistence before
  sending, and the requirement that an exhausted-attempts alert be durably
  persisted before original content is deleted. None of this exists: there is no
  outbox table, no delivery path, no correction record and no alert channel.
  `OUT-1`'s original unique key was superseded on 2026-11-26 by one that treats the
  processing version as provenance rather than as notification identity. On the same
  date the Owner fixed three further points: correction evidence is an AI-generated
  summary only, with verbatim text and excerpts prohibited; Outbox retention is
  independent of the 168-hour deletion set, so no Outbox event or payload is deleted
  with the article, and an alert awaiting manual intervention is never silently
  deleted; and abandonment stops all subsequent automatic processing for the
  lifecycle, cancelling queued work, invalidating claims, and allowing already-
  persisted Outbox events to finish. M7.0 also carries a **non-normative** technical
  design appendix (lifecycle identity, publication protocol, correction identity,
  superseded and expired-unprocessed jobs, retention boundaries); it is a proposal
  only.
  A further Owner decision (2026-11-26, Phase 1.9) covers the case where an ordinary
  notification's automatic retries are exhausted: the event enters manual intervention
  (retry, hold or abandon), is retained until that intervention is completed, and only
  then starts its independent Outbox retention period. It stays a separate event type
  from an alert, and delivery remains at-least-once. `OUT-26` additionally requires
  every Outbox payload to be self-contained, so delivery never depends on the article,
  lifecycle or correction row still existing, and never carries verbatim original text.
  Processing jobs now have four distinguished terminal outcomes — `failed_terminal`,
  `superseded`, `expired-unprocessed` and `cancelled` — only the first of which raises
  an alert.
  The Phase 1.11 closure adds three documentation rules, none of them implemented.
  `CLM-19` makes version retirement a rule wherever a job is met, not only at
  publication: once a version publishes, every unfinished lower-version job is
  terminalized as `superseded` at Claim, at the startup recovery check and at
  publication, consuming no attempt and raising no alert, while a job whose version
  equals the published version is treated as already succeeded. `OUT-25` now states
  that the delivery outcome and the manual-intervention outcome are separate, so an
  abandoned event is never recorded as `sent` and cleanup tests the two conditions
  separately; a manual retry neither resets nor extends `OUT-6`..`OUT-8`, and how it is
  accounted for remains open. `SPEC-GAP-08` and `-18` carry the corresponding open
  detail.
  Phase 1.13 then closed three state-machine gaps in the documentation only. Version
  retirement now takes precedence over attempt exhaustion for a job with no committed
  terminal outcome, so an exhausted but stale job becomes `superseded` without an
  alert, while a `failed_terminal` or `succeeded` committed earlier is never
  retroactively rewritten. Every Worker write — success, retryable failure,
  non-retryable failure or exhaustion report — is subject to the same token, lease and
  version guard, so a stale Worker cannot manufacture a `failed_terminal` outcome or
  its alert. The two meanings of abandonment are stated as independent: abandoning an
  Article Lifecycle stops automatic processing for that lifecycle without abandoning
  any notification, and abandoning one Outbox notification affects only that event
  without abandoning the lifecycle. None of this is implemented; the transaction
  mechanism and its ordering remain `SPEC-GAP-08`, and Phase 1 closure has not yet
  been independently verified.
  Explicitly `NOT IMPLEMENTED`: the Processing pipeline and its state store, claim and
  lease fencing for Processing, the publication protocol, the Outbox table and every
  delivery path, correction records and correction notifications, the alert channel,
  any manual-intervention interface (for alerts or for dead notifications), and every
  retention or cleanup job. No retention duration for the Outbox has been chosen. Open
  technical details are tracked as `SPEC-GAP-05`, `-07`, `-08`, `-10`, `-15`, `-17`
  and `-18` in `docs/design/m7-0-ai-news-processing-pipeline.md`.
- **Gemini model-ID validity: `NOT VERIFIED`.** The approved mapping in §5 uses
  the identifiers `gemini-3.8-flash`, `gemini-3.5-flash-lite` and
  `gemini-4-argon`. Their validity has **not** been independently verified, and
  no Gemini API call has been made to check them. This is recorded as a known
  verification risk only. The identifiers are **not** asserted to be invalid, and
  the mapping must not be changed without explicit Owner approval.

These items must not be silently marked as completed.

## 7. Current Next Milestone

### M5.0 — PR CI Security Specification

Status: **SPECIFICATION COMPLETE; SPECIFICATION DELIVERABLE VERIFIED PRESENT.**

M5.0 adds a _separate_ CI security objective without altering any M4.6 result.
It defines Assertion 4-A (credential and test-transport isolation) and Assertion
4-B (untrusted fork PR execution boundary) in
`docs/design/i7-1b-llm-provider.md` §9.5.3.7, records the Owner's D1–D13 / G1–G2 /
G7 decisions in §13.0a, and creates `docs/security/ci-security-model.md`.

The M5.0 **deliverable** — the specification text and the security model document
— is verified present in the merged tree. That is a statement about the presence
of the specification, not an assessment of whether the controls it describes are
effective.

M5.0 is a **scope revision, not a finding revision.** It does not produce
network-isolation evidence and does not discharge B-6.

### M5.1 — GitHub Actions CI Foundation

Status: **PARTIAL — criteria 19 and 20 verified at source level; criterion 21 NOT
VERIFIED. Not fully accepted.**

Adds `.github/workflows/ci.yml`, `.github/CODEOWNERS`, and two test files
(`tests/unit/core/llm/no-real-transport.test.ts`,
`tests/unit/ci/workflow-policy.test.ts`). No `src/**` change is required: the
Fake-transport seam already exists.

Per-criterion status, against the criteria in `docs/design/i7-1b-llm-provider.md`
§12.0a:

| Criterion | Subject | Status | Evidence |
| --- | --- | --- | --- |
| 19 | 4-A credential and test-transport isolation | **Verified at source level** | `tests/unit/core/llm/no-real-transport.test.ts` — the factory returns `FakeProvider` for an explicit fake selection with no credential; the transport seam is a throwing double that is never invoked; unknown provider and keyless `gemini` both throw rather than fall back |
| 20 | 4-B workflow declaration boundary | **Declaration half verified** | `.github/workflows/ci.yml` — `runs-on: ubuntu-24.04`, `permissions: contents: read`, no `secrets.*`, no `id-token`, `package-manager-cache: false`, no `actions/cache`, both actions pinned to full 40-character SHAs; enforced by `tests/unit/ci/workflow-policy.test.ts` |
| 21 | 4-B manual settings half (S1–S8) | **NOT VERIFIED** | Requires repository settings access; not observable through the Ruleset object and not read during this revision |

**Criteria 19 and 20 are code-level and workflow-declaration evidence only.** They
show what the code and the workflow file ask for. They do **not** establish
independent security assurance, they do **not** prove what the repository
permits, and they are **not** network-isolation evidence.

**M5.1 is therefore PARTIAL, not accepted.** Its repository settings controls are
listed as a manual checklist in `docs/security/ci-security-model.md` §7. Until
that checklist is verified, 4-B is only half established.

### GOV-1 — Single-Maintainer Governance Model

Status: **GOVERNANCE TEXT ADOPTED; RULESET CONFIGURED AND VERIFIED; OTHER SECURITY
SETTINGS NOT VERIFIED.**

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
- **The `main` Ruleset is now configured and verified.** Ruleset
  `main-protection-single-maintainer` (id `27986448`) is active, targets
  `refs/heads/main`, and carries four rules: `deletion`, `non_fast_forward`,
  `pull_request`, and `required_status_checks`. The `pull_request` rule sets
  required approving reviews to **0** with Code Owner review **off**; the
  `required_status_checks` rule requires **`verify`** with
  `strict_required_status_checks_policy: true`; the bypass actor list is
  **empty**.
- **S1, S2, S5, S6, S7 and S8 remain NOT VERIFIED.** They are not observable
  through the Ruleset object and were not read. An empty bypass list is a current
  configuration, not an immutable guarantee: the Owner retains the ability to
  modify or delete the Ruleset.
- **First publication used PR-first bootstrap** and is complete: PR #1 was merged
  into `main` at `17a8c1c`. **No direct push to `main` and no bootstrap exception
  was authorized.**

GOV-1 changes governance text only. It reclassifies no finding: Assertion 4,
B-6, O-3 and T-10a remain **BLOCKED**. The active Ruleset resolves **none** of
the network-isolation findings.

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
