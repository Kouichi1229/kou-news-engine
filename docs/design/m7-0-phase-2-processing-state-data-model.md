# M7.0 Phase 2 — S1: Processing State Data Model Design

| Field | Value |
| --- | --- |
| Document | S1 — Processing State Data Model Design |
| Status | **`PROPOSED — OWNER REVIEW REQUIRED`** |
| Phase | Phase 2 — planning |
| Nature | Design **proposal**. Not an approved schema, not a migration plan, not an implementation. **No implementation is authorized by this document.** |
| Parent specification | `docs/design/m7-0-ai-news-processing-pipeline.md` (M7.0), untracked working-tree file, SHA256 `9948c8f11013332efd9fc8d379e8ede6a22e402c659008b8ce19b118dede12d5` |
| Baseline | branch `main`, HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| Date | 2026-11-26 |
| Related documents | S0a — `m7-0-phase-2-l01-terminal-reason-decision-memo.md`; S0b — `m7-0-phase-2-governance-decision-memo.md` |

**Label legend.** `[OD]` confirmed Owner decision · `[DR]` documented requirement · `[IF]` current implementation fact · `[TO]` technical observation · `[RC]` recommendation (non-binding) · `[ODR]` Owner decision required.

Line numbers refer to the M7.0 document at the baseline above; identifiers (`CLM-19`, `OUT-25`, `SPEC-GAP-15`, `A.4`) are the stable reference and take precedence over line numbers.

**OPEN status preserved.** Every `OPEN` and `SPEC-GAP` identifier referenced here remains `OPEN`. This document closes none of them; L-01 and L-02 remain `OPEN`, and the model below is a candidate, not an approved schema.

---

## 1. Purpose and scope

This document turns the Phase 2 readiness assessment into a reviewable conceptual data model for Processing State and the entities around it. It exists so that the Owner can review one artefact instead of reconstructing a schema from twenty register entries. `[TO]`

In scope: entity inventory, responsibility boundaries, cardinality, candidate attributes, uniqueness and indexing requirements, ownership of claim tokens and attempts, retention ownership, and the `last_seen_at` data flow.

Out of scope: SQL, DDL, migration files, index definitions in executable form, runtime behaviour, and any claim that a table "exists" or is "approved". Where the specification leaves a question open, this document names it and stops.

## 2. Design principles

1. **Processing State is not content.** `[DR]` `CLM-14` (L426) confines `article_derived` to successful content; failures, claims, leases and terminal state live elsewhere. `[DR]` `SPEC-GAP-15` (L792) requires a separate table.
2. **One row per version, one lifecycle identity.** `[OD]` Versions are monotonically increasing and each has its own attempt budget (`CLM-10`, L422; `SPEC-GAP-05`, L782). `[OD]` `aggregate_id` is the Article Lifecycle, not a processing run (`OUT-17`, L615).
3. **Soft references outward, hard uniqueness inward.** `[DR]` `A.10` (L1222) makes article references soft so that deleting the article cannot delete processing history or notification payloads.
4. **Terminality is a marker, not a deletion.** `[DR]` `CLM-1` (L413) makes `terminal_reason IS NOT NULL` the terminal marker; `CLM-2` (L414) excludes such rows from Claim. Neither clause deletes anything.
5. **Every state change is fenced.** `[OD]` `CLM-12` (L424) and `CLM-19` (L431) require token, lease, state and version validation on every Worker write.
6. **Nothing here is approved.** Every table and column below is a candidate.

## 3. Confirmed Owner decisions and documented requirements

| Requirement | Source | Label |
| --- | --- | --- |
| Terminal marker `terminal_reason IS NOT NULL`; permanent Claim exclusion | `CLM-1` L413, `CLM-2` L414 | [OD] |
| Attempts count claims; a claim consumes one; no refund; no Release | `CLM-5` L417, `CLM-6` L418, `CLM-7` L419 | [OD] |
| 3 attempts per version, independent per version | `CLM-10` L422 | [OD] |
| Token/lease/state/version validation on every write | `CLM-12` L424, `CLM-19` L431 | [OD] |
| Recovery reopens only non-terminal, attempt-bearing, non-stale jobs | `CLM-13` L425 | [OD] |
| Terminalize + persist alert before original content is deleted | `CLM-15` L427 | [OD] |
| Success content only in derived storage | `CLM-14` L426 | [OD] |
| Lifecycle abandonment stops processing; persisted Outbox continues | `CLM-18` L430 | [OD] |
| Lifecycle identity is generated, never derived from the URL; one open lifecycle per article | `A.1` L1050 (proposal vehicle), `OUT-17` L615 | [DR] |
| `published_version` is a high-water mark; publication requires a strictly greater version | `A.3` L1078 | [DR] |
| Outbox: 18 columns, PK `event_id`, unique `(event_type, aggregate_id, notification_key)` | `OUT-1` L599 | [OD] |
| Outbox payloads are self-contained; no FK dependency on article, lifecycle or correction | `OUT-26` L624, `A.10` L1222 | [OD] |
| Raw retention 168 h from the most recent observation | `RET-1` L334, `RET-2` L335; `docs/architecture.md` §*Original-content retention (planned)* L649 | [OD] |
| Derived content 720 h from successful generation | `RET-3` L336 | [OD] |
| Correction evidence 720 h; AI summary only | `OUT-22` L620, `OUT-23` L621 | [OD] |
| Outbox retention independent of raw deletion; duration undecided | `OUT-25` L623, `OUT-14` L612 | [OD]/[DR] |
| No tombstone; rediscovery after deletion opens a new lifecycle | `SPEC-GAP-02` L779, `OUT-17` L615 | [OD] |

## 4. Existing implementation reality

Verified by static inspection only. **No code was executed and no runtime behaviour is asserted.** `[IF]`

| Fact | Evidence |
| --- | --- |
| Four migrations create `articles`, `article_sources`, `article_contents` (+ view) | `src/core/persistence/migrations.ts` (v1–v4) |
| `article_contents` already models a per-version claim: `attempts INTEGER` with `CHECK (attempts BETWEEN 0 AND 3)`, `lease_owner`, `lease_token`, `lease_expires_at`, partial unique index on `lease_token`, claimability index on `(status, extractor_version, attempts)` | migration v4 |
| Article identity is `"a1:" + sha256(canonicalUrl)` | `src/modules/ingestion/dedupe/dedupe.ts:241–243` |
| `articles` has `canonical_url UNIQUE`, `fetched_at`, and no observation-clock column; `article_sources` has `first_seen_at` per provenance row | migration v1 |
| **No** `last_seen_at` exists anywhere in `src/` | repository-wide search |
| No processing-state, derived, correction or outbox tables exist | migration list ends at v4 |
| SQLite configured with `busy_timeout`, `foreign_keys = ON`, `journal_mode = WAL` | `src/core/persistence/sqlite.ts:333–342` |
| Partial unique indexes already in use (`WHERE lease_token IS NOT NULL`, `WHERE is_primary = 1`) | migrations v2–v4 |
| `article_contents.article_id` declares `ON DELETE CASCADE` toward `articles` | migration v4 |
| No shared transaction helper; `BEGIN IMMEDIATE` wrapped privately per repository | `sqlite-article-content.repository.ts` (claim path), `TXN-1` L526 |
| Extraction release path decrements `attempts` — a **known discrepancy** against `CLM-7`, separate technical debt outside Processing scope | `releaseSql()` L225, `release()` L351; reported in M7.0 §5.4 (L935) |

`[TO]` The extraction repository is a working precedent for the exact pattern M7.0 needs (per-version lease, partial unique token, terminal guard, claimability index), and it is simultaneously the precedent that carries the `CLM-7` divergence. Any new module must not inherit `release()`.

## 5. Entity inventory

| # | Entity | Exists in code today | Proposed physical form |
| --- | --- | --- | --- |
| E1 | Article Lifecycle | no | one row per lifecycle |
| E2 | Processing Job (Processing State) | no | one row per (lifecycle, version) |
| E3 | Derived Publication | no | one row per (lifecycle, revision) |
| E4 | Correction Event | no | one row per (lifecycle, revision, fact item) |
| E5 | Outbox Event | no | one row per event (18 columns per `OUT-1`) |
| E6 | Manual-intervention record | no | representation undecided (S0b/Topic C) |

`[TO]` E3 and E4 may share a table or stay separate; the choice is a design decision, not a policy one. E6 may be a column pair on E5 rather than a table (`A.12` proposes two dimensions: delivery outcome and intervention outcome).

## 6. Entity responsibility boundaries

### E1 — Article Lifecycle

- **Why it exists.** It is the notification identity (`[OD]` `OUT-17`) and the scope of abandonment (`[OD]` `CLM-18`) and of the publication high-water mark (`[DR]` `A.3`).
- **Owns.** Lifecycle identity, article reference (soft), open/closed/abandoned timestamps, `published_version`, `published_revision`.
- **Must not own.** Attempt counters, claim tokens, content, notification payloads, correction evidence.
- **Relationships.** 1→N E2; 1→N E3; 1→N E4; 1→N E5 (via `aggregate_id`, soft).
- **Retention.** Undecided duration; removal must not extend or shorten raw retention (`A.9` L1197).
- **FK or logical?** Logical to `articles` (`A.10`), enforced uniqueness internally.
- **Abandonment.** `abandoned_at` records the *decision* only. Enforcement is separate and is set out in §6.1; the column alone satisfies none of the six consequences in `CLM-18`.

### E2 — Processing Job / Processing State

- **Why it exists.** Holds per-version claim, lease, attempt and terminal state, which `CLM-14` forbids storing with content.
- **Owns.** `state`, `attempts`, token, lease owner/expiry, `failure_code`, `terminal_reason`, version, timestamps.
- **Must not own.** Derived text, summaries, correction evidence, payloads, `published_version` (that is lifecycle-scoped).
- **Relationships.** N→1 E1; 1→0..1 E3 per successful version.
- **Retention.** Undecided; `CLM-2` excludes terminal rows from Claim but says nothing about deletion.
- **FK or logical?** Internal FK to E1 is acceptable; external references soft.

### E3 — Derived Publication

- **Why it exists.** Stores the successfully generated content and its retention anchor (`RET-3`), and provides the published baseline for correction comparison (`A.3`).
- **Owns.** Revision, generation timestamp, content reference, expiry anchor.
- **Must not own.** Claim/lease/attempt state, notification state, lifecycle status.
- **Relationships.** N→1 E1; corrections are derived from consecutive revisions.
- **Retention.** 720 h from generation `[OD]`.
- **FK or logical?** Internal FK to E1 acceptable; must not cascade from `articles`.

### E4 — Correction Event

- **Why it exists.** Records a distinct major core-fact change and its evidence (`OUT-21`, `OUT-22`).
- **Owns.** Fact item, previous value, corrected value, source URL, AI evidence summary, revision linkage.
- **Must not own.** Verbatim source text `[OD]` prohibition, delivery state, claim state.
- **Relationships.** N→1 E1; 1→1 notification via E5 notification key.
- **Retention.** 720 h `[OD]` (`OUT-23`).
- **FK or logical?** Internal to E1/E3 acceptable; Outbox must not depend on it (`OUT-26`).

### E5 — Outbox Event

- **Why it exists.** Durable at-least-once delivery with its own retry budget (`OUT-3`–`OUT-10`).
- **Owns.** Event identity, type, `aggregate_id` (lifecycle id), notification key, self-contained payload, status, attempts, next attempt time, errors.
- **Must not own.** Processing state, derived content, lifecycle status; it must be readable without any other row (`OUT-26`).
- **Relationships.** N→1 lifecycle by value only; no FK.
- **Retention.** Independent; duration undecided (`OUT-14`), gated by intervention state (`OUT-25`).
- **FK or logical?** Logical only — this is the point of `OUT-26` and `A.10`.

### E6 — Manual-intervention record

- **Why it exists.** `[OD]` a dead ordinary notification and a dead alert are retained for inspection until intervention completes (`OUT-25`, `CLM-16`).
- **Owns.** Delivery outcome, intervention outcome, operator action history.
- **Must not own.** Delivery success — `abandon` is never `sent` (`A.12`).
- **Relationships.** 1→1 with E5 (per event).
- **Retention.** Alert path: retained while intervention is outstanding `[OD]`; ordinary path: duration undecided.
- **FK or logical?** Internal to E5 if a column pair, otherwise 1:1 table.

### 6.1 Lifecycle abandonment — the six enforced consequences

`[OD]` `CLM-18` (L430) is not met by a timestamp alone. `abandoned_at` records that the lifecycle was abandoned; it does not itself stop anything. The policy lists six consequences, and each must be enforced somewhere concrete.

| # | Required consequence (`CLM-18`) | Enforced where | Conceptual representation | Status |
| --- | --- | --- | --- | --- |
| A1 | Stop all automatic processing for the current lifecycle | Claim eligibility | the claim predicate reads the lifecycle's abandonment marker | `design pending` |
| A2 | Cancel queued Processing Jobs | Job state | each unfinished job transitions to terminal `cancelled` | `design pending` |
| A3 | Invalidate active claims | Job row | the live claim is invalidated and its token cleared | `design pending` |
| A4 | Prevent stale Workers from publishing | Worker write guard | token + state + version guard rejects the write | `design pending` |
| A5 | Prevent new Correction Notifications for that lifecycle | Correction generation and Outbox insert | no correction event or outbox row is created after abandonment | `design pending` |
| A6 | Allow already-persisted Outbox events to continue delivery | Delivery path | delivery never reads the lifecycle (`OUT-26` payload) | `conceptually covered` |

`[TO]` A6 is the only consequence the model already guarantees structurally: because no foreign key points from the Outbox into E1–E4 (§15), lifecycle state cannot stop a delivery. The other five are behavioural and undesigned.

`[TO]` A1 and A2 interact in a way that is easy to miss: a claim predicate that excludes an abandoned lifecycle leaves its unfinished jobs untouched. Exclusion is not cancellation — cancellation is a write.

`[TO]` A4 and A5 differ in scope: A4 rejects a write from a Worker that already holds a claim, while A5 prevents a *new* event from being created. The second does not follow from the first, because correction generation may run outside any claim.

`[ODR]` None of A1–A5 is an Owner question; the policy is fixed. What remains open is *when* queued jobs are cancelled — inside the abandonment transaction, in the next sweep, or lazily on the next encounter — which belongs to `SPEC-GAP-08`.

## 7. Conceptual ER model

```
articles (existing, hard-deleted at 168 h)
  |  logical reference only (no FK)
  v
processing_lifecycle  (lifecycle_id, article_id, published_version, published_revision,
                       opened_at, closed_at, abandoned_at)
  |1                      |1                     |1
  |N                      |N                     |N
processing_job        derived_publication    correction_event
 (lifecycle_id,        (lifecycle_id,          (lifecycle_id, revision,
  processing_version)   revision)               fact_item)
  |
  |  (no FK)
  v
outbox_event (event_id, event_type, aggregate_id = lifecycle_id, notification_key, payload, status, ...)
  |
  |1
  v
manual-intervention record  (delivery outcome × intervention outcome)
```

`[TO]` Every arrow from the Outbox is by value. If any arrow into the Outbox became a foreign key, article or lifecycle cleanup could delete a notification that `OUT-25` requires to survive.

`[TO]` Lifecycle abandonment is a **value on E1**, not an edge. None of the A1–A5 consequences in §6.1 can be expressed as a constraint in this diagram, which is why they are listed as behaviour rather than as relationships. Only A6 follows from the absence of an edge.

## 8. Cardinality and relationship analysis

| Relationship | Cardinality | Rationale | Open question |
| --- | --- | --- | --- |
| Lifecycle → Job | 1:N | one row per version; independent budgets (`CLM-10`) | none |
| Lifecycle → open job | 0..1 "current" | not required by any clause; multiple non-terminal versions may coexist | whether a "current version" pointer is needed |
| Job → Publication | 0..1 | only a `succeeded` job publishes | whether the linkage is stored or derived from version |
| Lifecycle → Publication | 1:N | monotonic revisions (`A.3`) | whether revision numbering is contiguous |
| Publication → Correction | 1:N | corrections compare against the published baseline | whether a correction references two revisions or one |
| Lifecycle → Outbox | 1:N | `aggregate_id` = lifecycle (`OUT-17`) | none |
| Outbox → Intervention | 1:0..1 | only dead items enter intervention | representation undecided |
| Article → Lifecycle | 1:0..N over time | a new lifecycle after deletion (`OUT-17`) | when closed rows are removed |

`[TO]` One article may have several lifecycle rows over its lifetime, but at most one open at a time (`A.1` partial unique index). That constraint is what makes "new lifecycle after rediscovery" work without a tombstone.

## 9. Candidate attributes and field responsibilities

Conceptual only — not DDL, not approved. `[RC]`

**E1 `processing_lifecycle` (candidate)**

| Attribute | Responsibility | Constraint source |
| --- | --- | --- |
| `lifecycle_id` | notification identity | `OUT-17` [OD] |
| `article_id` | soft reference to the article | `A.1`, `A.10` [DR] |
| `opened_at` | lifecycle start | `A.1` [DR] |
| `published_version` | publication high-water mark | `A.3` [DR] |
| `published_revision` | monotonic publication counter | `A.3` [DR] |
| `closed_at` | lifecycle closed | `A.9` [DR] |
| `abandoned_at` | abandonment *decision* marker; enforcement is separate (§6.1) | `CLM-18` [OD] |

**E2 `processing_job` (candidate)**

| Attribute | Responsibility | Constraint source |
| --- | --- | --- |
| `lifecycle_id`, `processing_version` | identity of a version | `A.2` [DR] |
| `state` | running / terminal carrier | `CLM-1`, `CLM-19` [OD] |
| `attempts` | claim count, 0..3 | `CLM-5`, `CLM-10` [OD] |
| `lease_owner`, `lease_token`, `lease_expires_at` | fencing | `CLM-12` [OD] |
| `failure_code` | `LlmErrorKind` vocabulary | `CLM-4` [OD] |
| `terminal_reason` | terminal marker and cause | `CLM-1`, `CLM-9` [OD] |
| `created_at`, `updated_at` | audit | none (design) |

**E3 `derived_publication` (candidate):** `lifecycle_id`, `revision`, `processing_version`, `generated_at`, `expires_at`, content reference. `[DR]` `RET-3`, `A.3`.

**E4 `correction_event` (candidate):** `lifecycle_id`, `revision`, `fact_item`, `previous_value`, `corrected_value`, `source_url`, `evidence_summary`, `created_at`. `[OD]` `OUT-22`.

**E5 `outbox_event` (candidate):** 18 columns `[OD]` `OUT-1`; names not enumerated (`SPEC-GAP-07`, L784). Only `event_id`, `event_type`, `aggregate_id`, `notification_key` are fixed by identity.

**E6 intervention (candidate):** delivery outcome (`pending`/`sent`/`dead`) and intervention outcome (`none`/`retry`/`hold`/`abandoned`) as proposed in `A.12`. `[DR]`/`[T]`

`[TO]` `terminal_reason` currently has no vocabulary (`CLM-9` L421 and `A.7` L1157 leave it `[U]`). Any field here that carries a reason value is therefore blocked by the L-01 decision memo (S0a) for its *values*, not for its existence.

## 10. Index and uniqueness requirements

| Requirement | Source | Purpose |
| --- | --- | --- |
| unique `(lifecycle_id, processing_version)` | `A.2` | one row per version |
| partial unique `lease_token WHERE lease_token IS NOT NULL` | `CLM-12`; existing v4 precedent | one active claim per token |
| partial unique `(article_id) WHERE closed_at IS NULL` | `A.1` | one open lifecycle per article |
| unique `(lifecycle_id, revision)` | `A.3` | monotonic revisions |
| unique `(event_type, aggregate_id, notification_key)` | `OUT-1` | at most one event per key |
| claimability index on `(state, processing_version, attempts)` | design `[RC]` | claim scan |
| index on `aggregate_id` | design `[RC]` | outbox lookup by lifecycle |

`[TO]` Index **names**, column types and the final set are `SPEC-GAP-15`; only the uniqueness semantics above are required. `[TO]` Partial-index support is `A.1`'s `[U]`, though migrations v2–v4 already rely on it.

`[TO]` The `lease_token` unique index is a backstop against **token reuse**. It is not the mechanism that limits a job to one active claim: two *different* tokens written to the same job row are still possible unless the claiming update is itself conditional on the row being claimable. See §11.1.

`[TO]` The same distinction applies to the revision key. Unique `(lifecycle_id, revision)` guarantees one row per revision; it does **not** enforce one publication per processing version, because two different revisions could in principle carry the same version. See §13.1.

## 11. Claim Token and Worker ownership model

`[OD]` `CLM-12`: every write validates the token the Worker holds; a Worker whose claim is invalid must not write results or state; a version-failing write is rejected and the job follows the `superseded` path.

Candidate model `[RC]`:

- Token is per **job row**, not per lifecycle (`A.2`: each version has its own claim token and lease).
- Claim assigns token + owner + expiry and increments `attempts` in one transaction (`CLM-5`, `CLM-6`).
- Clearing the token is part of every terminal transition, so a late write fails on token ownership before any state is touched.
- Lease expiry alone does not clear the token; recovery decides (`CLM-13`).
- The version comparison is evaluated in the same write as the token check, because `CLM-19` requires that a rejected write leave the job retired rather than half-updated.

### 11.1 Six distinct guarantees

`[TO]` A unique index on `lease_token` is one guarantee among six. Conflating them is the most likely way to build a claim path that looks correct and is not.

| # | Guarantee | Mechanism (conceptual) | What it does **not** provide |
| --- | --- | --- | --- |
| G1 | Token uniqueness | unique index on `lease_token` where non-null | any statement about which job holds the token |
| G2 | At most one active claim **per job** | one conditional update whose predicate requires the row to be claimable (non-terminal, attempt available, token empty) | a token index cannot express this; only the row predicate can |
| G3 | Atomic acquisition | candidate selection and the claiming update inside one immediate transaction | ordering between competing claimers beyond that transaction |
| G4 | Claim-time state predicates | lifecycle open and not abandoned; job non-terminal; `attempts < 3`; `version >= published_version` | retroactive safety: a job can become stale *after* it was claimed |
| G5 | Fencing on every state-changing write | every write carries token, owner, lease validity and current state | prevention of a stale Worker *attempting* a write |
| G6 | Rejection of stale writes | a fenced write matching zero rows, reported back to the Worker as an invalid claim | terminalization: rejection alone does not make the job `superseded` |

`[TO]` G2 is the guarantee the index cannot supply. The index prevents two claims sharing one token; it does not prevent two different tokens being written to one job row. Only a conditional update — "this row is claimable *now*" — does that, and the condition must include every G4 predicate, otherwise a stale or abandoned job can be claimed.

`[TO]` G1 is therefore an **additional constraint** layered on top, not the acquisition mechanism. The per-job guarantee comes from G2 executed inside G3's transaction boundary; removing G1 would weaken token hygiene but would not, by itself, allow two active claims on one job row.

`[TO]` G6 and the `superseded` transition must be one write (`CLM-12` L424, `CLM-19` L431). If they are separate, a job can exist briefly in a state that is neither running nor terminal, and two concurrent rejections can both attempt the transition. The mechanism is `SPEC-GAP-08`; the requirement that there be one outcome is not.

`[TO]` G5 is stated as "every write", not "every successful write". A rejected write still validated the token, which is what makes the rejection trustworthy.

`[ODR]` None. Lease duration, the overdue test and recovery ordering are `SPEC-GAP-08` (technical, S0b).

## 12. Processing attempts and terminal-state representation

- `[OD]` Attempts are counted per version, capped at 3, consumed at claim, never refunded (`CLM-5`, `CLM-6`, `CLM-7`, `CLM-10`).
- `[OD]` A terminal row carries a non-NULL terminal marker and is permanently excluded from Claim (`CLM-1`, `CLM-2`).
- `[OD]` Four terminal outcomes exist and must not be conflated: `failed_terminal`, `superseded`, `expired-unprocessed`, `cancelled` (§3.4, L483–495).
- `[TO]` Only `failed_terminal` raises an alert (§3.4, L486–488); the other three consume no attempt and raise none.
- `[ODR]` Which of the three non-alert outcomes wins when several apply is L-01 — see S0a. This document therefore models `terminal_reason` as a single value with an undecided vocabulary, and does not pre-empt the precedence question.
- `[RC]` Attempt history (who consumed what) is not required by any clause; the counter plus timestamps is sufficient. A separate attempt-log table would be an unrequested addition.

## 13. Published version and publication relationship

- `[DR]` `A.3`: `published_version` is a high-water mark on the lifecycle; a publication is accepted only when `processing_version > published_version`.
- `[OD]` A new version replaces old successful content only after generation **and** persistence both succeed (`SPEC-GAP-05`, L782; `VER-*`, L399–401).
- `[OD]` A failed new version preserves prior successful content (`VER-*`).
- `[OD]` `CLM-19`: once any version publishes, unfinished lower-version jobs are terminalized `superseded` wherever met.
- `[TO]` The high-water mark is lifecycle-scoped, so the *comparison* is a lifecycle read inside the job's write transaction. Two writes on different jobs of the same lifecycle therefore contend on one row — which is exactly what serialises concurrent publications.

### 13.1 Publication idempotency

`[TO]` Three facts are easy to conflate: the **processing version** identifies the work, the **revision** identifies a published result, and the **high-water mark** decides whether a publication is allowed at all. They are related but not interchangeable.

| Attempt | Precondition observed | Outcome | Second logical publication? |
| --- | --- | --- | --- |
| First publication of version *v* | `v > published_version` | revision *r+1* inserted; high-water mark → *v*; job `succeeded` | no |
| Retry of the same commit after a crash before commit | nothing was persisted | identical to the first attempt | no |
| Retry after the transaction committed (replay) | `v == published_version` | `A.4`'s `==` branch: job already `succeeded`, no new row | no |
| Concurrent duplicate attempt for the same version | the loser observes `v == published_version` | idempotent replay | no |
| Attempt for a version below the high-water mark | `v < published_version` | terminalized `superseded`, nothing published | no |

`[RC]` The expected result is **one logical publication per (lifecycle, processing_version)**. `[TO]` That expectation follows from `A.4`'s `==` branch together with `OUT-19`'s single initial success; it is not a separate policy statement, and this document does not add one.

`[TO]` **What is not decided.** The model does not settle which key enforces the expectation:

- unique `(lifecycle_id, revision)` guarantees one row per revision and says nothing about two revisions for one version;
- a unique `(lifecycle_id, processing_version)` would enforce the expectation directly, but no such key is stated and the choice belongs to `SPEC-GAP-05` / `SPEC-GAP-15`;
- whether `revision` is allocated inside the publication transaction, and whether a rolled-back attempt may leave a numbering gap, is undecided;
- whether the publication row and the job's `succeeded` transition must share one transaction is required for ordering (`A.4`, `CLM-15`) but not designed.

`[ODR]` None for the expectation itself. The enforcement key and revision allocation are technical gaps under `SPEC-GAP-05` and `SPEC-GAP-15`, closable through the governance route in S0b.

## 14. Correction Event relationship

- `[OD]` A correction event preserves fact item, previous value, corrected value, source URL and AI evidence summary; verbatim excerpts are prohibited (`OUT-22`).
- `[OD]` Every distinct major change is a separate event; a reversal is a new event (`OUT-21`).
- `[OD]` Correction records and evidence follow the 720-hour derived rule (`OUT-23`).
- `[DR]` `A.5` proposes a unique key on `(lifecycle_id, revision, fact_item)`; the concrete key is `SPEC-GAP-17` (L794).
- `[TO]` Corrections compare against the *published baseline* (`A.3`), so a correction row is meaningless without the revision it was computed against. Storing the revision is a requirement of the comparison, not an extra field.

## 15. Outbox independence

`[OD]` `OUT-26`: a payload must be self-contained; delivery must not depend on the article row, the lifecycle row or a correction row. `[OD]` `OUT-18`: events may outlive the article and continue delivery. `[OD]` `OUT-25`: Outbox retention is independent of the 168-hour deletion.

`[TO]` Consequence for this model: **no foreign key may point from the Outbox into E1–E4.** `aggregate_id` is a value. Any design that joins the Outbox to a lifecycle at delivery time violates `OUT-26`, even if it happens to work while the rows exist.

## 16. Retention ownership and lifecycle

| Data | Confirmed requirement | Proposed retention owner | Duration status | Physical deletion |
| --- | --- | --- | --- | --- |
| Raw article content, media, identifying and timestamp records | 168 h from most recent observation `[OD]` | `docs/architecture.md` (sole authority) | **Confirmed** | `DELETE` only; not secure erasure (`RET-7`) |
| Article Lifecycle records | must not extend raw retention `[DR]` | Processing State module | **Unresolved** (`A.9`, `SPEC-GAP-15`) | timing `[U]` |
| Processing Job records | terminal rows never re-claimable `[OD]` | Processing State module | **Unresolved** | must not be removed while an alert depends on it (`CLM-15`) |
| Derived Publication | 720 h from generation `[OD]` | M7.0 (derived retention) | **Confirmed** | mechanism `[U]` |
| Correction Event + evidence | 720 h `[OD]` | M7.0 | **Confirmed** | mechanism `[U]` |
| Outbox Event | independent of raw deletion `[OD]` | M7.0 | **Unresolved** (`OUT-14`) | mechanism `[U]` (`OUT-16`) |
| Manual-intervention records | retained while intervention outstanding `[OD]` for alerts | M7.0 | **Unresolved** for ordinary notifications | must not be removed while outstanding |

`[TO]` Three separate concerns are frequently conflated and must not be: **eligibility** (`CLM-2`), **retention duration**, and **physical deletion mechanism** (`RET-7`). None of them implies the others.

## 17. `last_seen_at` data-flow requirements

`[OD]` The decision already exists: `first_seen_at` is written once per lifecycle and never modified; the most recent observation advances on every rediscovery, regardless of download or extraction success; raw retention runs from the most recent observation; rediscovery after deletion opens a new lifecycle (`RET-1` L334, `RET-2` L335, `SPEC-GAP-01` L778, `SPEC-GAP-02` L779).

`[IF]` No `last_seen_at` column exists in the codebase. `articles.fetched_at` exists but its update semantics on rediscovery were **not** verified — a column name is not evidence of behaviour.

`[TO]` This is an **implementation gap**, not a policy question. Candidate placements:

| Option | Where the clock lives | Trade-off |
| --- | --- | --- |
| L-1 | column on `articles`, advanced on every rediscovery | simplest; dies with the article row, which is fine because the row is what the clock governs |
| L-2 | observation table keyed by (article, source) | preserves per-source observation history; more rows, more complexity |
| L-3 | mirrored onto `processing_lifecycle` for `expired-unprocessed` evaluation | avoids reading the article inside processing transactions; duplicates a fact |

`[RC]` L-1 for the retention clock, with the processing module reading it while the row exists. `[TO]` Under L-1 the `expired-unprocessed` outcome can only be evaluated while the article row exists — which is consistent with the outcome meaning "the content expired before processing finished". `[ODR]` None: placement is `SPEC-GAP-01`, a technical gap, closable under S0b.

## 18. Transaction and concurrency implications

| Operation | Transaction shape | Why |
| --- | --- | --- |
| Claim | one `BEGIN IMMEDIATE`: select candidate → retirement check → `attempts+1` → token/lease | `CLM-5`, `CLM-6`, `CLM-19` |
| Worker write | one transaction: token/lease/state/version guard → write → terminal transition if applicable | `CLM-12`, `CLM-19` |
| Publication | one transaction: guard → retire stale siblings → insert publication/corrections/outbox → bump high-water mark → `succeeded` | `A.3`, `A.4`, `OUT-24` |
| Lifecycle abandonment | one transaction (timing undecided): mark the lifecycle abandoned → cancel unfinished jobs → invalidate the live claim | `CLM-18`; *when* this runs is `SPEC-GAP-08` |
| Recovery, per job | one transaction per job | avoids long locks; ordering is `SPEC-GAP-08` |
| Retention of one article | one transaction: terminalize → persist alert → delete | `CLM-15` |

`[TO]` Two concurrency facts follow from the model rather than from policy: the high-water mark serialises publications on one lifecycle, and the partial unique token index makes double-claim a constraint violation rather than a race.

`[TO]` The abandonment row is listed for completeness, not as a settled design. Whether cancellation happens inside the abandonment transaction, in the next sweep pass, or lazily on the next encounter is exactly the kind of ordering question `SPEC-GAP-08` holds open; §6.1 records the six consequences without choosing a timing.

## 19. Alternatives and trade-offs

| Decision | Option A | Option B | Assessment |
| --- | --- | --- | --- |
| Job vs separate attempt table | job row holds counter | attempt-log table | A is sufficient (`CLM-5` counts claims, not calls) `[RC]` |
| Lifecycle vs per-version lifecycle rows | one lifecycle, many jobs | one row per version | A is required by `OUT-17` (`aggregate_id` = lifecycle) `[OD]` |
| Publication storage | own table | columns on job row | own table keeps 720-hour retention independent of job retention `[RC]` |
| Intervention representation | column pair on outbox | separate table | column pair is smaller; separate table gives audit history — **open**, S0b |
| Observation clock | on `articles` | mirrored on lifecycle | mirroring duplicates; see §17 `[RC]` |
| Terminal reason | single value | primary + secondary | S0a's P-4 option; cannot be decided here |

## 20. Unresolved specification gaps

Every row below is `OPEN` in M7.0 and stays `OPEN` after this document. The column states only what each gap blocks in the proposed model.

| Gap | Question | Blocks |
| --- | --- | --- |
| `SPEC-GAP-15` (L792) | columns, types, index set, removal timing | this model's approval |
| `SPEC-GAP-07` (L784) | outbox column enumeration and `aggregate_id` type/generation | E5 attributes |
| `SPEC-GAP-05` (L782) | version creation rules | E2 lifecycle of versions |
| `SPEC-GAP-17` (L794) | correction record schema | E4 |
| `SPEC-GAP-01` (L778) | storage of the two observation timestamps | §17 |
| `SPEC-GAP-04` (L781) | where derived content physically lives | E3 content reference |
| `SPEC-GAP-08` (L785) | transaction mechanism, ordering, lease duration | §18 |
| `SPEC-GAP-18` (L795) | intervention representation | E6 |
| L-01 | terminal reason precedence | `terminal_reason` values |
| L-02 | abandonment naming | E6 and lifecycle field naming |

## 21. Requirement-to-entity/field traceability matrix

**Status vocabulary.** No row below asserts runtime compliance; nothing has been implemented or executed, and no code was run to produce this matrix. Three values are used:

- `conceptually covered` — the candidate model contains a field or rule that would satisfy the clause. The mapping is a design claim, not evidence.
- `design pending` — the clause needs behaviour (ordering, enforcement points, transactions) that this model does not yet specify.
- `implementation unverified` — the clause depends on code that does not exist, or on existing code whose behaviour was not verified here.

| Requirement | Entity.field | Status |
| --- | --- | --- |
| `CLM-1` terminal marker | E2.`terminal_reason` | `conceptually covered` |
| `CLM-2` permanent exclusion | E2.`state` + `terminal_reason` | `conceptually covered` |
| `CLM-5`/`CLM-6` claim counting | E2.`attempts` | `conceptually covered` |
| `CLM-7` no refund | no release path in the candidate model | `implementation unverified` — **split**: Processing has no code, so its compliance is unverified; existing extraction **does** have a release path that decrements attempts and conflicts with the policy (see the note below) |
| `CLM-10` 3 per version | E2.`attempts` + `CHECK`-equivalent constraint | `conceptually covered` |
| `CLM-12` fencing | E2.`lease_token`/`lease_owner`/`lease_expires_at` | `conceptually covered` — six guarantees in §11.1 |
| `CLM-13` recovery predicate | E2.`state`, E2.`attempts`, E1.`published_version` | `conceptually covered` |
| `CLM-15` alert before deletion | E2 terminal transition + E5 insert in one transaction | `design pending` |
| `CLM-18` lifecycle abandonment | E1.`abandoned_at` plus the §6.1 enforcement | `design pending` — the marker records intent; five of the six consequences are undesigned |
| `CLM-19` retirement | E1.`published_version` compared in every write | `conceptually covered` for the rule, `design pending` for encounter-point enforcement |
| `OUT-1` outbox identity | E5.`event_id`, unique key | `conceptually covered` |
| `OUT-17` lifecycle identity | E1.`lifecycle_id` = E5.`aggregate_id` | `conceptually covered` |
| `OUT-19` one initial success | unique key with lifecycle-constant notification key | `conceptually covered` |
| `OUT-22` correction evidence | E4 fields | `conceptually covered` |
| `OUT-23` 720 h | E4 expiry anchor | `conceptually covered` |
| `OUT-25` independence | no FK from E5 | `conceptually covered` |
| `OUT-26` self-containment | E5 payload completeness | `conceptually covered` |
| `RET-1`/`RET-2` clock | `articles` clock (§17, L-1) | `implementation unverified` — the clock column does not exist |
| `RET-3` 720 h derived | E3.`generated_at`/`expires_at` | `conceptually covered` |
| `SPEC-GAP-02` no tombstone | no tombstone row in any entity | `conceptually covered` |

`[TO]` **`CLM-7` status has two scopes, and they must not be merged.**

| Scope | Status | Basis |
| --- | --- | --- |
| **Policy requirement** | decided: no refund, no Release (`CLM-7` L419) | Owner decision |
| **New Processing implementation** | **not implemented**; `CLM-7` compliance is therefore **unverified** | no Processing code exists |
| **Existing extraction implementation** | a release path exists and **decrements `attempts`**, which contradicts the policy | `releaseSql()` (`src/modules/extraction/repository/sqlite-article-content.repository.ts`), documented in M7.0 §5.4 |
| **Remediation of that path** | **separate technical debt**, not authorized by this document and not part of the Processing scope | this document records the fact only |

`[TO]` The precise reading is therefore *not* "no relevant code exists". A code path that violates `CLM-7` does exist, in another module. It is recorded here for traceability only: this document neither fixes it nor brings it into the Processing implementation scope, and the Processing module must not reuse that path or treat its existence as precedent.

## 22. Design risks

| Risk | Description | Impact | Mitigation |
| --- | --- | --- | --- |
| D-01 | Lifecycle row deleted while an alert still references the lifecycle | undeliverable alert | `OUT-26` payloads; `CLM-15` ordering |
| D-02 | Outbox given an FK "for integrity" | payload loss on cleanup | state the prohibition in review checklist |
| D-03 | Job table inherits `release()` from extraction | `CLM-7` violation in the new module | explicit test that no Processing path decrements attempts; the existing extraction path is separate debt (M7.0 §5.4), neither fixed nor in scope here |
| D-04 | `terminal_reason` populated before L-01 is decided | inconsistent history | S0a decision first |
| D-05 | Clock stored only on `articles` and needed after deletion | `expired-unprocessed` uncomputable | decide L-1 vs L-3 in design review |
| D-06 | Publication and outbox inserts in separate transactions | lost notification | single transaction (§18) |
| D-07 | Superseded rows accumulate with no removal rule | unbounded growth | retention decision (`A.9`) |

## 23. Decisions requiring Owner approval

| # | Decision | Why Owner, not design |
| --- | --- | --- |
| O-1 | Terminal-reason precedence (L-01) | changes recorded audit history; see S0a |
| O-2 | Abandonment naming/representation (L-02) | operator-facing semantics; see S0b/Topic C |
| O-3 | Whether closed lifecycle rows and their jobs may be deleted at all, and when | retention of history is a policy question, not a schema one |

`[TO]` O-3 is the one place where this document deliberately refuses to recommend: `A.9` states the boundaries but not the duration, and deleting job history has audit consequences that no technical argument settles.

## 24. Implementation-readiness assessment

| Aspect | Status |
| --- | --- |
| Policy completeness | **Owner policy is recorded** for the behaviours in §3. This is *not* design or implementation completeness — see the four levels below. `terminal_reason` values remain blocked by L-01 |
| Schema determinacy | **Partial** — attribute sets are candidate; types/indexes are `SPEC-GAP-15` |
| Reusable precedent | **Yes** — extraction module's lease/attempt pattern |
| Blocking Owner decisions | O-1 (L-01), O-2 (L-02), O-3 (retention of history) |
| Blocking technical gaps | `SPEC-GAP-15`, `-07`, `-05`, `-17`, `-01`, `-04`, `-08` |
| Classification | **READY FOR IMPLEMENTATION PLANNING**; not ready for implementation |

**What "policy completeness" does not mean.** Four different things are easy to merge into one word; this document keeps them apart:

1. **Owner policy** — recorded in M7.0 for the behaviours listed in §3. That is the only sense in which anything here is complete.
2. **Conceptual coverage** — this proposal maps those behaviours onto candidate entities and fields (§21). Coverage is a design claim, not evidence.
3. **Technical design** — still open: `CLM-15`'s transaction and persistence ordering, five of `CLM-18`'s six enforcement consequences, `CLM-19`'s encounter-point enforcement, and the whole of `SPEC-GAP-08`, `-15`, `-07`, `-05`, `-17`, `-01` and `-04`.
4. **Implementation and runtime verification** — have not occurred. No Processing code exists and nothing in this document was executed.

`[TO]` "READY FOR IMPLEMENTATION PLANNING" therefore means the planning inputs are sufficient to write a plan. It does not mean the design is finished, and it does not authorise implementation.

**No implementation is authorized by this document.** Closing any identifier requires the governance route described in S0b.
