# M7.0 Phase 2 — D-1: Exhausted Processing Job Terminalization vs. Alert Sequencing — Owner Decision Record

| Field | Value |
| --- | --- |
| Document | D-1 Exhausted Processing Job Terminalization vs. Alert Sequencing — Owner Decision Record |
| Status | **`RESOLVED — OWNER DECISION A`** |
| Decision | **D-1 — RESOLVED.** Policy only. |
| Phase | Phase 2 — planning |
| Nature | Decision record. **No implementation is authorized by this document.** |
| Parent specification | `docs/design/m7-0-ai-news-processing-pipeline.md` (M7.0), SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`, HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| Decision date | 2026-11-27 |
| Related documents | S1 — `m7-0-phase-2-processing-state-data-model.md`; S0a — `m7-0-phase-2-l01-terminal-reason-decision-memo.md`; S0b — `m7-0-phase-2-governance-decision-memo.md` |

**Label legend.** `[OD]` confirmed Owner decision · `[DR]` documented requirement · `[IF]` current implementation fact · `[TO]` technical observation · `[RC]` recommendation (non-binding) · `[ODR]` Owner decision required.

---

## 1. Decision title and status

**Title:** What happens to an expired Processing Job that has exhausted its attempt budget, given that no Alert persistence mechanism exists yet.

**Status:** `RESOLVED` — Owner Decision **A**. `[OD]`

**Scope.** D-1 covers exactly one situation: a job whose lease has expired and whose `attempts` have reached the ceiling of 3, while the Alert Outbox does not yet exist. It does not settle the Outbox schema, the Alert payload, the delivery mechanism, the retention of Alert events, the location from which Recovery is invoked, or the precedence between terminal labels. Those remain open (§8).

**Nature.** This document records a policy decision. It grants no implementation authorization of any kind (§9).

## 2. Background

`[DR]` `CLM-8` states that an expired lease with exhausted attempts transitions to `failed`, records a non-NULL `terminal_reason`, preserves attempts and error information, remains stored, is permanently excluded from automatic Claim, and **requires alerting** — unless the job's Processing version is below the lifecycle's `published_version`, in which case `CLM-19` retires it as `superseded` instead.

`[DR]` `CLM-13` requires a startup recovery check that reopens work with attempts remaining and never reopens a job that already carries a terminal outcome or that sits below `published_version`.

`[DR]` `CLM-15` requires Recovery and retention to be coordinated so that an eligible exhausted job cannot disappear before it is terminalized **and** its alert event is durably persisted, and requires that before an article's original content is deleted the job is marked failed with a non-NULL `terminal_reason` and a self-contained alert Outbox event is durably persisted — with the `CLM-19` retirement exception, for which no alert event is required.

`[TO]` Those three clauses together make terminalization and alerting one obligation, not two: a `failed_terminal` outcome is defined by its alert, and an alert that is created after the content is gone, or through a mechanism that can fail silently, does not satisfy `CLM-8` or `CLM-15`.

`[TO]` At the time of this decision the Alert Outbox does not exist. `[IF]` The database has no outbox table, no notification table and no delivery code; the Processing module has no alerting path at all. Implementing exhausted-job terminalization first and alerting later would therefore create exactly the window `CLM-15` forbids: terminal rows whose alert can never be persisted reliably.

`[ODR]` D-1 asked the Owner which of three courses to take: defer terminalization until the Outbox exists, terminalize now and backfill alerts later, or build a minimal Outbox first.

## 3. Confirmed decisions this decision builds on

| Decision | Content | Relevance to D-1 |
| --- | --- | --- |
| `CLM-8` | exhausted + expired → `failed`, marker recorded, attempts preserved, permanently excluded, alerting required | the obligation D-1 sequences |
| `CLM-15` | Alert Outbox event persisted before content deletion | forbids alert-after-delete |
| `CLM-13` | recovery reopens only work with attempts remaining | the boundary D-1 leaves untouched |
| `CLM-19` | retirement beats exhaustion; committed history never rewritten | retirement still outranks exhaustion after D-1 |
| `CLM-7` | no refund, no Release | attempts stay spent |
| `CLM-10` | three attempts per Processing Version | the ceiling D-1 references |
| §3.4 | only `failed_terminal` alerts | the only outcome D-1 governs |
| `CLM-9` / L-01 | terminal marker vocabulary and precedence undecided | untouched by D-1 (§8) |

## 4. The Owner decision

`[OD]` The Owner selected:

> **A — Defer exhausted-job terminalization until the Outbox provides reliable Alert persistence capability.**

`[OD]` For an expired Processing job with `attempts >= 3`:

1. **Do not reopen it.** Recovery must leave the job closed to automatic processing.
2. **Do not automatically terminalize it as `failed_terminal`** before the Outbox-backed workflow exists.
3. **Do not create an Alert through an unpersisted or incomplete mechanism.** No substitute channel, log line, counter or best-effort notification may stand in for a persisted Alert event.
4. **Preserve its current state** pending the Outbox-backed exhausted-job handling workflow. The job keeps its stored row, its attempts, its failure metadata and its expired lease.
5. **Once the Outbox is implemented**, exhausted-job terminalization and Alert persistence must be designed as one reliable workflow, not as two steps performed at different times.

## 5. Core principle

`[OD]` Job terminalization and Alert persistence must have reliable data-consistency guarantees. **Alert events must not be silently lost due to notification failures.**

`[TO]` The principle is what makes the decision binding rather than incidental: any later proposal that terminalizes an exhausted job while leaving its alert to a best-effort path contradicts the decision, even if it names the Outbox.

## 6. Relationship to existing policies

`[OD]` This decision changes none of the following, and this document restates them so that no future reader infers a change:

- **Maximum attempts per Processing Version remains 3.** `[IF]` `MAX_PROCESSING_ATTEMPTS = 3` in `src/modules/processing/processing.constants.ts`.
- **Claim consumes an attempt.** `[IF]` the Claim statement increments `attempts` and refuses a row at the ceiling.
- **Attempts are not refunded.** `[IF]` `requeue` leaves `attempts` untouched; there is no Release path in the Processing module.
- **`reopenExpired` only reopens jobs with `attempts < 3`.** `[IF]` the reopen predicate contains `attempts < MAX_PROCESSING_ATTEMPTS`.
- **Batch 3 remains accepted and requires no modification.** `[OD]` the Batch 3 `reopenExpired` implementation was accepted as compliant with this decision without change.
- **No retry policy or Claim semantics change.** D-1 alters only *what happens after* the ceiling is reached and the lease has expired.

`[TO]` D-1 therefore leaves the exhausted job in a state the current schema permits (`running` with an expired lease) rather than inventing a new state for it. That is a deliberate consequence of Decision A, not an oversight.

## 7. Consequences for batch planning

`[OD]` The following planning consequences follow from Decision A:

1. The former separate "exhausted-job terminalization" work and the Outbox work are **consolidated into one future batch: `Outbox-backed exhausted-job handling`.**
2. The implementation **must not be split** into "terminalize now, add Alert later".
3. The former fallback option — terminalize first and defer Alert persistence — is **excluded** and may not be proposed again as an alternative.
4. Batch 4 remains **blocked** until the Outbox design gaps in §8 are resolved by Owner decisions.
5. This decision alone **does not authorize Batch 4 implementation.**

## 8. Remaining design gaps — none resolved by this document

`[OD]` The gaps below remain `OPEN`. Recording D-1 does not close, narrow or pre-judge any of them, and no field set, state machine, retention period or delivery mechanism may be inferred from this memo.

| Identifier | Remaining question | Status |
| --- | --- | --- |
| `SPEC-GAP-07` | Outbox table field set | **OPEN** |
| `OUT-11`–`OUT-16` | payload self-containment, state machine, retention, drain cadence and related Outbox behaviour | **OPEN** |
| `SPEC-GAP-10` / `OUT-13` | delivery channel and mechanism | **OPEN** |
| `OUT-9` / `OUT-10` | dead-event and manual-intervention workflow | **OPEN** |
| `SPEC-GAP-15` | Outbox and lifecycle cleanup responsibility boundary | **OPEN** |

`[OD]` Also still open and unaffected by this record: **D-2** (Article Lifecycle opening timing), **D-3** (Recovery invocation location), **L-01** (terminal reason precedence), **L-02** (abandonment representation), **C-01** (rewriting a committed `failed_terminal` after abandonment), **M-4** (governance for closing `OPEN` items), and every other unresolved `SPEC-GAP` in the M7.0 register.

`[TO]` `CLM-19` continues to outrank exhaustion: a job that is simultaneously stale and exhausted is retired as `superseded` by the retirement pass, which consumes no attempt and raises no alert. D-1 governs only the exhausted-but-not-stale case.

## 9. Authorization boundary

`[OD]` This memo records the Owner's D-1 decision only. It does **not** authorize:

- Outbox implementation, in whole or in part.
- Processing exhausted-job terminalization implementation.
- Alert creation, persistence or delivery implementation.
- Schema or migration changes of any kind.
- Recovery startup integration, including the invocation point reserved to D-3.
- CLI or Scheduler changes.
- Batch 4 or any later batch implementation.

`[TO]` Policy approval and implementation authorization are separate acts under the project's governance. Approving Decision A settles *what* must happen; it does not settle *when* the work may begin, which remains subject to the Owner's batch authorization and to §8.

## 10. Current implementation conformance

`[IF]` Recorded at baseline `5ce56d7f…194a`, for auditability. These are observations about the code, not new requirements.

| Observation | Location |
| --- | --- |
| No code path terminalizes a job because its attempts are exhausted | `src/modules/processing/` contains no such statement |
| `claim` increments `attempts` and refuses a row at the ceiling | `claimSql()` in `sqlite-processing-job.repository.ts` |
| `reopenExpired` refuses rows at the ceiling and terminalizes nothing | `reopenExpiredSql()` predicate `attempts < MAX_PROCESSING_ATTEMPTS` |
| `markTerminal` writes a caller-supplied marker and has no production caller | `markTerminal()`; no non-repository call site exists |
| No Outbox, notification or delivery code exists | absent from `src/` and from migrations v1–v5 |
| `published_version` has no production writer, so the retirement path is not yet reachable in production | `processing_lifecycle` is written only by tests |

`[TO]` The current code therefore already satisfies Decision A: exhausted expired jobs are neither reopened nor terminalized, and no alert is produced by any mechanism. No change to Batches 1–3 is implied.

## 11. Audit trail

| Item | Record |
| --- | --- |
| Decision identifier | D-1 |
| Decision date | 2026-11-27 |
| Owner decision | A — defer terminalization until Outbox-backed Alert persistence exists |
| Status at recording | `RESOLVED` |
| Supersedes | none |
| Superseded by | none |
| Earlier material | D-1 was raised as a blocking question in the Phase 2 Recovery/Lifecycle integration plan, where it blocked the exhausted-job terminalization batch |
| Effect on Batch 3 | none — `reopenExpired` remains accepted as implemented |

`[TO]` If a later Owner decision changes this one, it is recorded as a new dated entry that supersedes D-1; this record is not rewritten.

## 12. Verification of this record

`[TO]` This document was created without modifying any existing file. The three previously approved Phase 2 documents (S1 `37937240934f…`, S0a `1fe4ba8fcfc7…`, S0b `7dbdcb95d5e6…`), the M7.0 specification, `docs/architecture.md`, `PROJECT_STATUS.md`, `package.json` and `package-lock.json` retained their hashes at the time of creation, and no source, test, schema or migration file was touched.
