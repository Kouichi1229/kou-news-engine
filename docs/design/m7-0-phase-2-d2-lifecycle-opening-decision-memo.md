# M7.0 Phase 2 — D-2: Article Lifecycle Opening Timing — Owner Decision Record

| Field | Value |
| --- | --- |
| Document | D-2 Article Lifecycle Opening Timing — Owner Decision Record |
| Status | **`RESOLVED — OWNER DECISION A (FIRST CLAIM)`** |
| Decision | **D-2 — RESOLVED.** Policy only. |
| Phase | Phase 2 — planning |
| Nature | Decision record. **No implementation is authorized by this document.** |
| Parent specification | `docs/design/m7-0-ai-news-processing-pipeline.md` (M7.0), SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`, HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| Decision date | 2026-11-27 |
| Related documents | S1 — `m7-0-phase-2-processing-state-data-model.md`; D-1 — `m7-0-phase-2-d1-exhaustion-sequencing-decision-memo.md`; S0a — `m7-0-phase-2-l01-terminal-reason-decision-memo.md`; S0b — `m7-0-phase-2-governance-decision-memo.md` |

**Label legend.** `[OD]` confirmed Owner decision · `[DR]` documented requirement · `[IF]` current implementation fact · `[TO]` technical observation · `[RC]` recommendation (non-binding) · `[ODR]` Owner decision required.

---

## A. Decision metadata

| Item | Value |
| --- | --- |
| Decision ID | D-2 |
| Topic | Article Lifecycle Opening Timing |
| Decision date | 2026-11-27 |
| Owner decision | **Option A — First Claim** |
| Status | `RESOLVED` |
| Decision type | Policy decision only; **not** implementation authorization |

**Question decided.** At what point is an Article Lifecycle row created in the Processing State store?

**Answer recorded.** When Processing first claims work for an Article — at no other point.

## B. Owner decision

`[OD]` An Article Lifecycle is opened when Processing **first claims work for an Article**.

`[OD]` It is **not** opened during Ingestion, and it is **not** opened merely when a Processing Job is created.

`[OD]` The two alternatives considered were therefore rejected as lifecycle-opening triggers:

| Option | Rejected because |
| --- | --- |
| B — Article insertion during Ingestion | Ingestion would depend on Processing, would need to distinguish a new Article from an update, and would create lifecycle rows that no claim has earned |
| C — Processing Job creation | Creates an open lifecycle before any work is actually taken, and leaves an open lifecycle behind whenever a created job is never claimed |

`[TO]` The decision is about *when a row appears*, not about *what a lifecycle contains*. It says nothing about version numbering, closure, abandonment or retention.

## C. Required atomic flow

`[OD]` The lifecycle-opening behaviour required by D-2 is one transaction with the following conceptual steps:

1. Begin a `BEGIN IMMEDIATE` transaction.
2. Look up the currently open Lifecycle for the Article.
3. Reuse the existing open Lifecycle if one exists.
4. Otherwise create a new Lifecycle whose identity is a UUIDv4.
5. Create the corresponding Processing Job.
6. Execute the Claim.
7. Commit the transaction.

`[OD]` The lookup-or-create of the Lifecycle, the creation of the Processing Job and the Claim **must be atomic**. If any step fails, the transaction must roll back. The implementation must not leave a partially created Lifecycle, an orphaned Job, or a partially completed Claim.

`[TO]` The transaction mode is the one the Processing repository already uses for its state-changing operations: `BEGIN IMMEDIATE` (`[IF]` `sqlite-processing-job.repository.ts:85`). Ingestion uses a deferred `BEGIN` (`[IF]` `sqlite.ts:370`); the two must not be nested on the same connection.

`[TO]` No pseudocode, method signature or method name in this memo is an approved API. Where a name is mentioned for readability it is **illustrative only** (see §D).

## D. Identity and architecture rules

`[OD]` Lifecycle identity is a **UUIDv4**, generated when the Lifecycle is created.

`[OD]` Lifecycle identity **must never be derived** from the Article URL.

`[OD]` An existing open Lifecycle for the Article is **reused**; a new Lifecycle is created **only** when no open Lifecycle exists.

`[OD]` **Ingestion remains independent of Processing** and does not create Lifecycle records. Nothing in the ingestion write path may acquire a dependency on the Processing module as a result of D-2.

`[OD]` Processing versions belonging to the same Lifecycle retain the **same Lifecycle identity** (`OUT-17`).

`[IF]` The existing targeted `claim()` API only updates an existing Job (`[IF]` `sqlite-processing-job.repository.ts:298`; its statement is an `UPDATE … WHERE lifecycle_id = ? AND processing_version = ?`). It cannot create a Lifecycle or a Job, so it cannot by itself implement First Claim lifecycle creation.

`[TO]` A future implementation therefore needs an **atomic claim-or-open entry point**. Any name used for it in later design work — for example a name of the shape "claim or open" — is **illustrative, not approved API naming**.

`[IF]` Lifecycle and Job creation currently exist as separate, non-transactional single statements (`openLifecycle`, `createJob`) and have **no production caller**. Nothing today performs the flow in §C.

## E. Concurrency and failure requirements

`[OD]` Concurrent first claims for the same Article must be **safe** under the existing uniqueness constraint: at most one open Lifecycle per Article (`[IF]` partial unique index `idx_processing_lifecycle_open ON processing_lifecycle (article_id) WHERE closed_at IS NULL`).

`[OD]` The future implementation **must define and test** conflict handling and retry behaviour so that concurrent attempts do not create duplicate open Lifecycles and do not leave partial records.

`[OD]` No specific retry policy, backoff, attempt count or error-surfacing convention is approved by this decision. Choosing one is part of the implementation authorization, not of D-2.

`[TO]` The database configuration already provides the substrate for this: `PRAGMA busy_timeout` and WAL are applied per connection (`[IF]` `sqlite.ts:333-342`), so a losing writer waits rather than failing instantly, and the unique index is the final arbiter.

## F. Explicitly unresolved matters

`[OD]` D-2 does **not** resolve any of the following, and none may be inferred from it:

- Lifecycle closure timing.
- Article deletion and Lifecycle closure coordination.
- Same-URL rediscovery after Article deletion.
- `SPEC-GAP-15` — cleanup responsibility for closed Lifecycle rows and their Jobs.
- `SPEC-GAP-05` — the conditions under which a new Processing Version is created.
- Current-version policy (whether a Lifecycle needs a pointer to its current version).
- D-3 — Recovery invocation location.
- Any other previously open `SPEC-GAP` or Owner decision, including L-01, L-02, C-01 and M-4.

`[TO]` The partial unique index on open Lifecycle rows has a consequence D-2 does not solve: if an Article is deleted while its Lifecycle is still open, a rediscovery of the same URL cannot open a new Lifecycle until the old one is closed. Closure and deletion coordination is required before rediscovery can work, and that coordination is unresolved (`A.9` is a `[T]` proposal; no deletion path exists in code today). **D-2 neither causes nor fixes this problem** — it is identical under all three options.

## G. Implementation boundary

`[OD]` D-2 is a **policy decision**, not implementation authorization.

`[OD]` No code, schema, migration, test, or production behaviour is authorized by this decision memo.

`[OD]` Any implementation requires separate explicit authorization.

`[OD]` A future implementation must preserve existing confirmed semantics unchanged, in particular:

- `CLM-18` — abandonment stops processing, cancels queued work, invalidates claims, blocks publishing.
- `CLM-19` — retirement of stale versions outranks exhaustion; committed history is never rewritten.
- `CLM-13` — Recovery reopens only work with attempts remaining and no terminal outcome.

`[OD]` No unresolved policy may be silently inferred from D-2. Where the flow in §C meets an unresolved question — closure, deletion, version creation, current-version policy — the implementation must stop and obtain a decision rather than choose one.

## H. Relationship to existing design documents

| Source | What it contributes | Status after D-2 |
| --- | --- | --- |
| M7.0 `A.1` (L1049-1066) | Describes lifecycle identity generated at "lifecycle opening (first claim)", and states that `articles.id` is URL-derived and therefore unusable as an aggregate identity | **`[T]` proposal, not previously approved policy.** D-2 now adopts its First Claim timing as an Owner decision; the rest of `A.1` remains a proposal |
| `OUT-17` (L615) | `aggregate_id` is the Article Lifecycle; a rediscovery after deletion creates a new Lifecycle with a new `aggregate_id` | `CONFIRMED` — unchanged |
| S1 (`m7-0-phase-2-processing-state-data-model.md`) | Lifecycle entity, one open Lifecycle per Article, versions per Lifecycle | `[DR]` — unchanged; D-2 supplies the opening trigger S1 leaves open |
| D-1 memo | Exhausted-job terminalization deferred until Outbox-backed Alert persistence exists | `RESOLVED` — independent of D-2; nothing here alters it |
| `A.9`, `A.10` | Closure-in-one-transaction and soft-reference rules | `[T]` proposals — unchanged and **not** adopted by D-2 |

`[TO]` This record does not retroactively describe the former `A.1` proposal as previously approved policy. Before D-2, the opening trigger was a `[T]` proposal only; D-2 is the act that makes First Claim an Owner decision.

## I. Change history

| Date | Change | Authority |
| --- | --- | --- |
| 2026-11-27 | D-2 formalized. The Owner selected **Option A — First Claim**: an Article Lifecycle is opened when Processing first claims work for an Article, atomically with Job creation and the Claim. Option B (Ingestion insertion) and Option C (Job creation) rejected as opening triggers. Closure, deletion, rediscovery, version creation, current-version policy and D-3 explicitly left open. No implementation authorized. | Owner decision, this authorization (documentation only) |

`[TO]` This document was created without modifying any existing file. The M7.0 specification, S1, S0a, S0b, the D-1 memo, `docs/architecture.md`, `PROJECT_STATUS.md`, `package.json` and `package-lock.json` retained their hashes at the time of creation. No source, test, schema, migration or other document was touched.
