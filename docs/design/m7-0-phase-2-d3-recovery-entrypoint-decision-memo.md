# M7.0 Phase 2 — D-3: Processing Recovery Entrypoint — Owner Decision Record

| Field | Value |
| --- | --- |
| Document | D-3 Processing Recovery Entrypoint — Owner Decision Record |
| Status | **`RESOLVED — OWNER DECISION B (EXTERNAL SCHEDULER RECOVERY CLI)`** |
| Decision | **D-3 — RESOLVED.** Policy only. |
| Phase | Phase 2 — planning |
| Nature | Decision record. **No implementation is authorized by this document.** |
| Parent specification | `docs/design/m7-0-ai-news-processing-pipeline.md` (M7.0), SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`, HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| Decision date | 2026-11-27 |
| Related documents | S1 — `m7-0-phase-2-processing-state-data-model.md`; D-1 — `m7-0-phase-2-d1-exhaustion-sequencing-decision-memo.md`; D-2 — `m7-0-phase-2-d2-lifecycle-opening-decision-memo.md`; S0a — `m7-0-phase-2-l01-terminal-reason-decision-memo.md`; S0b — `m7-0-phase-2-governance-decision-memo.md` |

**Label legend.** `[OD]` confirmed Owner decision · `[DR]` documented requirement · `[IF]` current implementation fact · `[AF]` finding recorded from the D-3 read-only analysis (reported there; not re-verified by this document) · `[TO]` technical observation · `[RC]` recommendation (non-binding) · `[ODR]` Owner decision required.

---

## 1. Decision metadata

| Item | Value |
| --- | --- |
| Project | Kou News Engine |
| Milestone | M7.0 |
| Phase | Phase 2 |
| Decision ID | D-3 |
| Topic | Processing Recovery invocation entrypoint and trigger |
| Decision date | 2026-11-27 |
| Status | `RESOLVED` |
| Selected option | **Option B — Dedicated External Scheduler Recovery CLI** |
| Decision type | Policy decision only; **not** implementation authorization |

## 2. Owner decision

`[OD]` Processing Recovery (`reopenExpired`) shall be invoked through a **dedicated one-shot CLI command executed by an external scheduler**.

`[OD]` The following execution patterns are **prohibited**:

1. Recovery during HTTP Server startup.
2. A long-running internal Recovery polling process.
3. Recovery as an automatic operation on every Worker Claim.

`[OD]` Any future integration of Recovery as the first step of a Processing Run (**Option E**) requires a **separate explicit Owner decision**. D-3 neither authorizes nor implies Option E.

`[TO]` The decision fixes *where Recovery is triggered from*. It does not fix the command's flags, its exit-code mapping, its dry-run behaviour or the scheduler's cadence; those remain open (§7).

## 3. Decision rationale

`[AF]` The following findings come from the D-3 read-only repository analysis and are recorded here as its conclusions:

- The existing architecture specifies **External Scheduler Only**: the repository contains no built-in scheduler, and an external scheduler — cron, a systemd timer, a container orchestrator job or a CI schedule — is expected to invoke the CLI.
- The current production entry points are the **HTTP Server**, the **Ingestion CLI** and the **Extraction CLI**.
- **No production Processing Worker, Processing Service or Processing CLI exists** today.
- The existing CLI infrastructure provides reusable conventions for **dependency injection, database lifecycle, signal handling, structured run summaries and exit codes**.
- `reopenExpired` is implemented and integration-tested in the Processing Repository but has **no production caller**.
- Its transaction and conditional-update semantics provide a basis for **safe coordination with Claim**.
- **No actual external Scheduler deployment configuration or cadence has been identified in the repository.**

`[TO]` The consequence of the last point is explicit: creating a Recovery CLI would not mean a schedule exists or is running. Deployment of any scheduler is a separate, unauthorised concern.

## 4. Existing Recovery semantics that must remain unchanged

`[OD]` The future CLI must **preserve Batch 3 behaviour exactly**. Recovery:

- runs through `reopenExpired`;
- keeps its `BEGIN IMMEDIATE` transaction semantics;
- runs `CLM-19` superseded-job retirement **before** reopening eligible jobs;
- considers only **expired running** jobs with **`attempts < 3`**;
- uses the existing strict lease-expiry condition **`lease_expires_at < now`** (equality is not expired);
- returns reopened jobs to **`pending`**;
- clears lease owner, lease token and lease expiry;
- preserves `attempts` and existing failure metadata;
- excludes **closed** and **abandoned** lifecycles;
- excludes jobs below the lifecycle's published processing version, or retires them according to existing `CLM-19` semantics;
- remains **idempotent**.

`[OD]` The implementation must not redesign the Recovery SQL or alter these semantics in order to add a CLI.

## 5. D-1 compatibility

`[OD]` Jobs with `attempts >= 3`:

- **must not be reopened**;
- **must not be automatically terminalized** by this Recovery operation;
- **must not generate an Alert** through an incomplete or unreliable persistence mechanism.

`[OD]` D-1 remains in force: exhausted-job terminalization is deferred until reliable Outbox-backed Alert persistence is available. The Recovery CLI authorized in principle here does not change that sequencing.

## 6. Future implementation scope — not yet authorized

`[RC]` The following files are the **anticipated** implementation surface, recorded as planning information only. Nothing here is approved for modification:

| Item | Anticipated role |
| --- | --- |
| `src/cli/recover.ts` | Thin executable entry point, following the existing pattern of parsing arguments before importing environment or persistence modules |
| `src/cli/recovery.cli.ts` | CLI execution logic: open the database, construct the repository, invoke `reopenExpired`, report the number of reopened jobs and the run outcome |
| `package.json` scripts | `recover` and `recover:prod`, mirroring the existing `ingest` / `extract` script pairs |
| CLI usage documentation | Only if the existing CLI conventions require an entry in the shared usage text |

`[OD]` **D-3 is a policy decision, not implementation authorization.** No code, test, schema, migration, package manifest or scheduler configuration is authorized by this memo. Implementation requires a separate explicit Owner authorization that names the exact files and test scope.

## 7. Explicitly unresolved items

`[OD]` The following remain `OPEN`. D-3 does not answer them and no answer may be inferred from this memo:

| Item | Status | What remains open |
| --- | --- | --- |
| `SPEC-GAP-08` | **OPEN** | Recovery ordering and multi-process safeguards |
| `SPEC-GAP-11` | **OPEN** | Lease and Recovery configuration names and defaults |
| External Scheduler type and deployment configuration | **OPEN** | Which scheduler; whether any exists |
| Scheduler execution cadence | **OPEN** | Actual invocation period |
| `--execute` and dry-run semantics | **OPEN** | Whether the existing execution gate applies; whether a read-only preview is required and how the anticipated count is computed |
| `SQLITE_BUSY` retry, failure and exit-code behaviour | **OPEN** | Retry policy, failure classification and exit codes when the write lock is contended |
| `SPEC-GAP-04`, `SPEC-GAP-05`, `CLM-9` | **OPEN** | Future Processing Worker / Processing Run model |
| Option E integration | **OPEN** | Requires a separate Owner decision; not implied by D-3 |

## 8. Implementation boundary

`[OD]` This memo records the Owner's D-3 decision only. It does **not** authorize:

- Recovery CLI implementation, in whole or in part.
- Changes to `reopenExpired` or to any Processing Repository behaviour.
- HTTP server startup integration, internal polling, timers or schedulers.
- Exhausted-job terminalization or any Alert mechanism.
- Changes to Processing Lifecycle, Claim, lease or attempt rules.
- Any Processing Worker execution model.
- Scheduler configuration, deployment files or infrastructure changes.

`[TO]` Policy approval and implementation authorization are separate acts under the project's governance, as recorded in S0b. D-3 settles *where Recovery is triggered from*; it does not settle *when the work may begin*.

## 9. Relationship to other decisions

| Decision | Relationship |
| --- | --- |
| D-1 — exhausted-job terminalization deferred | Independent and still in force; the Recovery CLI must not terminalize exhausted jobs (§5) |
| D-2 — lifecycle opened at first claim | Independent; Recovery only ever operates on jobs that already exist, so it neither opens nor requires a lifecycle-opening path |
| Batch 1 / 2 / 3 (accepted) | Unchanged. D-3 adds no behaviour to the repository and requires no rework of accepted batches |
| S0b — governance for closing `OPEN` items | D-3 closes a Phase 2 decision, not a `SPEC-GAP`; every `SPEC-GAP` listed in §7 stays `OPEN` |

## 10. Change history

| Date | Change | Authority |
| --- | --- | --- |
| 2026-11-27 | D-3 formalized. The Owner selected **Option B — Dedicated External Scheduler Recovery CLI**: Recovery is invoked by a dedicated one-shot CLI command executed by an external scheduler. HTTP-startup recovery, internal polling and per-Claim recovery are prohibited. Option E requires a separate decision. Exhausted-job handling remains governed by D-1. No implementation authorized. | Owner decision, this authorization (documentation only) |

## 11. Verification of this record

`[TO]` This document was created without modifying any existing file. At the time of creation the M7.0 specification, S1, S0a, S0b, the D-1 and D-2 memos, `docs/architecture.md`, `PROJECT_STATUS.md`, `package.json` and `package-lock.json` retained their hashes, and no source, test, schema, migration, package manifest or other document was touched. No test, build, migration, database operation or Git write was performed.
