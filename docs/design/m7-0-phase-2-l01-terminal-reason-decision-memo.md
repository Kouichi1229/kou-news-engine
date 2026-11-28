# M7.0 Phase 2 — S0a: L-01 Terminal Reason Precedence — Decision Memo

| Field | Value |
| --- | --- |
| Document | S0a — L-01 Terminal Reason Precedence Decision Memo |
| Status | **`PROPOSED — OWNER REVIEW REQUIRED`** |
| Finding | **L-01 — OPEN. This memo does not resolve it.** |
| Phase | Phase 2 — planning |
| Nature | Decision support. **No implementation is authorized by this document.** |
| Parent specification | `docs/design/m7-0-ai-news-processing-pipeline.md` (M7.0), SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`, HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| Date | 2026-11-26 |
| Related documents | S1 — `m7-0-phase-2-processing-state-data-model.md`; S0b — `m7-0-phase-2-governance-decision-memo.md` |

**Label legend.** `[OD]` confirmed Owner decision · `[DR]` documented requirement · `[IF]` current implementation fact · `[TO]` technical observation · `[RC]` recommendation (non-binding) · `[ODR]` Owner decision required.

---

## 1. Decision title and status

**Title:** Which `terminal_reason` is recorded when a Processing Job satisfies more than one non-alert terminal condition at the moment it is terminalized.

**Status:** `OPEN` (finding L-01, carried from the Phase 1.14 audit and accepted as OPEN by the Owner in Phase 1.17). Nothing in this memo changes that status.

**Scope.** L-01 is one question: which of `superseded`, `cancelled`, `expired-unprocessed` is recorded when more than one is true. Whether a **committed** `failed_terminal` can later be rewritten by cancellation is a different question with different consequences — it is recorded in §8 as decision requirement **C-01** and is not part of L-01.

## 2. Background

`[OD]` Four terminal outcomes exist and must not be conflated (§3.4, L483–495): `failed_terminal`, `superseded`, `expired-unprocessed`, `cancelled`. Three of them are non-alert outcomes that consume no further attempt.

`[OD]` `CLM-19` (L431) fixes precedence for exactly one pair: retirement over attempt exhaustion, plus a commit-order rule and a non-retroactivity rule for already-committed terminal outcomes.

`[TO]` No clause states what happens when the three non-alert outcomes coincide. The M7.0 register records the vocabulary itself as undecided (`CLM-9` L421; §3.4 note; `A.7` L1157 `[U]`), so the precedence question and the vocabulary question are adjacent but distinct: the vocabulary asks *what strings exist*; L-01 asks *which one wins*.

`[TO]` Because all three outcomes are terminal, non-alerting and non-attempt-consuming, the practical blast radius is the recorded cause, the audit trail and any metric derived from it. That is why the finding is Low severity and why it is still worth a decision: a wrong label is invisible until someone reconstructs why a job never published.

## 3. Existing confirmed Owner decisions

| Decision | Content | Relevance |
| --- | --- | --- |
| `CLM-1` (L413) | `terminal_reason IS NOT NULL` is the terminal marker | a single non-NULL value is all the schema requires |
| `CLM-2` (L414) | terminal rows are permanently excluded from Claim | all three outcomes are equally terminal |
| `CLM-7` (L419) | no refund, no Release | no outcome returns an attempt |
| `CLM-19` (L431) | retirement beats exhaustion; commit order; history never rewritten | covers `superseded` vs `failed_terminal` only |
| `CLM-18` (L430) | abandonment stops processing, cancels queued work, invalidates claims, blocks publishing | produces `cancelled` |
| §3.4 (L483–495) | the four outcomes; only `failed_terminal` alerts | the three in question are all alert-free |
| `A.7` (L1157) | outcome table; vocabulary `[U]` | the reason strings are not fixed |
| `RET-1`/`RET-2` (L334–335) | 168 h from the most recent observation | produces `expired-unprocessed` |

## 4. Exact unresolved question

> When a job that has not yet reached a terminal outcome simultaneously satisfies (a) `version < published_version`, (b) the article's 168-hour window has closed, and/or (c) its lifecycle has been abandoned — which single `terminal_reason` is recorded?

Sub-questions that the same decision must settle:

1. Does the answer depend on the order in which the three conditions became true, or only on which are true at terminalization time?
2. Does the answer differ between a job met by the startup recovery sweep and a job met by a Worker write or a claim attempt?
3. *(Outside L-01.)* Whether an already-committed `failed_terminal` can later be rewritten by cancellation is **not** an L-01 sub-question. It is recorded separately in §8 as C-01.

## 5. Scenarios producing overlapping conditions

| # | Scenario | Conditions true | Competing labels |
| --- | --- | --- | --- |
| S1 | A lower-version job is unfinished when the article reaches 168 h | (a) + (b) | `superseded` / `expired-unprocessed` |
| S2 | Version 3 published, then the lifecycle is abandoned while version 2 is unfinished | (a) + (c) | `superseded` / `cancelled` |
| S3 | Lifecycle abandoned in the same sweep pass in which the article expires | (b) + (c) | `cancelled` / `expired-unprocessed` |
| S4 | Stale job, article expired, lifecycle abandoned before any sweep runs | (a) + (b) + (c) | all three |
`[TO]` Scenarios involving `failed_terminal` — abandonment while a job is failing, or abandonment after a failure has committed — are **outside L-01** and are recorded in §8. They are kept out of the table above so that L-01 remains a question about three non-alert labels.

`[TO]` The table has no row where `failed_terminal` competes with the three, because that competition is already settled for retirement by `CLM-19` and is not settled for cancellation at all (§8).

## 6. Candidate precedence models

All four candidates are analysed. None is eliminated.

| Model | Rule | One-line rationale |
| --- | --- | --- |
| **P-1** | `superseded` > `cancelled` > `expired-unprocessed` | a published newer version is the most specific, most consequential fact |
| **P-2** | `cancelled` > `superseded` > `expired-unprocessed` | an operator decision outranks everything automatic |
| **P-3** | `expired-unprocessed` > `superseded` > `cancelled` | the clock is the only condition derivable from data alone |
| **P-4** | composite: primary + secondary reason recorded | preserves every true condition instead of discarding two |

`[TO]` P-4 is **not** excluded by `CLM-1`: the clause requires a non-NULL marker, not a scalar enum. It would, however, change how equality comparisons, metrics and audit queries are written.

## 7. Detailed consequences of each model

### P-1 — `superseded` > `cancelled` > `expired-unprocessed`

- Consistent with `CLM-19`'s existing style (version facts outrank lifecycle facts). `[TO]`
- Every job retired because of a publication is labelled the same way regardless of what else was true, which makes "how often did a newer version strand work" a single query.
- **Cost:** a lifecycle abandonment can be invisible in the job's reason even when the operator's intent was to stop everything; the abandonment is still visible on the lifecycle row.
- **Cost:** an expired-before-processing count under-reports, because stale jobs at expiry are labelled `superseded`.

### P-2 — `cancelled` > `superseded` > `expired-unprocessed`

- Matches the plain reading of `CLM-18` ("abandonment stops all subsequent automatic processing"). `[TO]`
- Preserves operator intent in the most visible field.
- **Cost:** after abandonment, the fact that a newer version had published is lost from the job row; reconstructing it requires joining the lifecycle's `published_version` and the job's version.
- **Cost:** an abandoned lifecycle with many unfinished versions produces many identical `cancelled` rows, hiding that some were already superseded before abandonment.

### P-3 — `expired-unprocessed` > `superseded` > `cancelled`

- Fully deterministic from stored data: no ordering of events needs to be known. `[TO]`
- Makes the "content expired while work was outstanding" metric exact.
- **Cost:** hides the more actionable cause (a published newer version, or an operator stop) behind a time condition that is true for every job at that moment.
- **Cost:** conflicts in spirit with `CLM-19`'s statement that retirement is not a publication-only rule and applies "wherever encountered".

### P-4 — composite primary + secondary

- Maximum audit fidelity: nothing true is discarded. `[TO]`
- Allows later re-derivation of metrics without re-reading history.
- **Cost:** every consumer must define primary-key semantics anyway — the ambiguity is moved, not removed, unless a canonical ordering is also chosen.
- **Cost:** the marker becomes a structured value, so `CLM-1`'s simple non-NULL test still works but equality tests and dashboards must handle compounds.
- `[TO]` If P-4 is chosen, the "primary" component still needs one of P-1…P-3 to order the components.

**What P-4 does not settle.** Recording more than one reason does not answer any of the following, and this memo does not assume an answer:

| Question | Why it survives P-4 |
| --- | --- |
| Is a primary reason mandatory? | a composite may be an unordered set, in which case "the" terminal reason no longer exists for consumers that expect one |
| What do secondary reasons mean? | "also true at the time" differs from "applied afterwards" — the two readings produce different histories |
| Are reasons recorded simultaneously or sequentially? | simultaneous recording implies a single evaluation instant; sequential implies one condition was acted on and another observed later |
| Does ordering carry operational significance? | if yes, the order must be stable and defined; if no, the marker is a set and `CLM-1`'s single-value habit is misleading |
| How do reporting and recovery interpret multiple reasons? | recovery must not treat a secondary `expired-unprocessed` as a reopen signal, and metrics must not double-count one job under two labels |

`[ODR]` These five are part of the L-01 answer if P-4 is chosen; they are not separate decisions.

`[TO]` One consequence is easy to miss: choosing P-4 does **not** settle whether a canonical precedence among the components is still required. A composite marker can only be ordered by something, and the only orderings available today are P-1…P-3. So P-4 defers that choice rather than removing it.

## 8. Boundary with `failed_terminal` — outside L-01

`[OD]` `CLM-19` settles `superseded` versus `failed_terminal` for **unfinished** jobs: retirement wins when no terminal outcome is committed, and a committed `failed_terminal` is never rewritten. Nothing in this memo alters that rule.

`[TO]` It does **not** settle what happens once a failure has already committed. That is a different question from L-01: L-01 asks which of three *non-alert* labels wins for a job with no committed outcome, while this section asks whether a *committed, alerting* outcome can later be changed. The consequences differ, so the questions are recorded separately.

### 8.1 Decision requirement C-01 (provisional reference, not an assigned identifier)

`[ODR]` **C-01 — OPEN, outside L-01.** No identifier has been assigned; the label is a working reference used by this memo only.

**S5a is settled by existing policy, not by C-01.** The governing clauses are explicit:

- `CLM-12` (L424): "Every Worker write must validate the claim token it holds. **A Worker whose claim is no longer valid must not write results or state.**"
- `CLM-18` (L430): abandonment means "Queued work is cancelled, **active claims are invalidated**, and **a stale Worker must not publish results or state**".

`[DR]` Read together: once abandonment has committed, the claim is no longer valid, so a later failure write by that Worker is refused — by `CLM-12`, on the invalidation `CLM-18` requires. This is **not** a new Owner decision and **not** a C-01 question. `[TO]` What the refusal does not settle is the job's eventual label: with no committed terminal outcome that is L-01's question (which of `superseded` / `cancelled` / `expired-unprocessed` wins); with a committed outcome it is S5b below.

`[TO]` **The remaining S5a question is ordering, not permission.** If the Worker write and the abandonment commit concurrently, the result depends on which commits first, and the mechanism for that is `SPEC-GAP-08`. That is a concurrency question; it belongs to neither L-01 nor C-01 and must not be answered by choosing a precedence rule.

**The open C-01 questions are S5b and S6.**

| Sub-case | Question | Why it stays open |
| --- | --- | --- |
| S5b — failure commits first, cancellation commits second | does the job stay `failed_terminal`, or become `cancelled`? | `CLM-19` reads "**Retirement** is never retroactive: a job already committed as `failed_terminal` stays `failed_terminal`, with its recorded failure history and alert handling intact … neither is converted to `superseded`." Its subject is retirement and the conversion it forbids is *to `superseded`*; it says nothing about conversion to `cancelled` |
| S6 — abandonment after a committed `failed_terminal` | unchanged, or affected? | `CLM-18` stops "all subsequent automatic processing"; it does not state that a past outcome is rewritten. Silence is not a rule |

### 8.2 Why rewriting a committed `failed_terminal` conflicts with a persisted alert

`[OD]` `CLM-15` requires the alert Outbox event to be durably persisted before the article's content is deleted. `[OD]` `OUT-25` and `A.12` require a dead alert to be retained while its intervention is outstanding, and `abandon` is never recorded as `sent`.

`[TO]` If a committed `failed_terminal` were later relabelled `cancelled`, three records would disagree:

1. the job row would say the job was cancelled, which by §3.4 implies no failure occurred;
2. an alert event would exist for a failure the job record denies;
3. an operator may already have acted on that alert — reprocessed, held, or abandoned it.

`[TO]` Relabelling cannot repair any of these. The alert is self-contained (`OUT-26`) and may already have been delivered, so rewriting the job state does not remove it; it only leaves the alert unexplained.

`[TO]` That is why "history protection extends to cancellation" is the safer default — but it is a recommendation, not a decision, and C-01 is where it would be decided.

### 8.3 What C-01 would need to answer

1. Does the `CLM-19` non-retroactivity protection extend from *retirement* to *cancellation*, so that a committed `failed_terminal` is never relabelled `cancelled`?
2. If a committed `failed_terminal` exists and the lifecycle is then abandoned, is the already-persisted alert retained unchanged, reclassified, or otherwise affected?
3. If cancellation and a failure commit in the same transaction or the same instant, which outcome stands — and is that a policy answer or a `SPEC-GAP-08` mechanism answer?

`[ODR]` C-01 is not answered here. Closing L-01 will not close C-01.

## 9. Impact on Attempts

| Model | Effect on the attempt counter |
| --- | --- |
| P-1, P-2, P-3, P-4 | **None.** All three outcomes consume no further attempt (§3.4, L490–495); the attempt already spent at claim is never refunded (`CLM-7`). |

`[TO]` The label does not change `attempts`; it only records why the row is terminal. No model makes a job claimable again.

## 10. Impact on Alert Outbox events

| Model | Effect |
| --- | --- |
| P-1, P-2, P-3, P-4 | **None directly** — none of the three outcomes raises an alert. |

`[TO]` The indirect risk sits in §8.2 and belongs to C-01, not to L-01: if a committed `failed_terminal` were relabelled `cancelled`, the alert it already produced would contradict the record. That argues for keeping history protection; it does not favour any P-option.

## 11. Impact on recovery and retention

- **Recovery.** `[OD]` `CLM-13` (L425) reopens only non-terminal, attempt-bearing, non-stale jobs. All three labels are terminal, so the reopen predicate is unaffected by the choice. `[TO]`
- **Retention.** `[OD]` `CLM-15` (L427) requires terminalization and alert persistence before content deletion. Any label satisfies the ordering; only the recorded cause differs. `[TO]`
- **Metrics.** `expired-unprocessed` is the only label that measures "content expired before processing finished"; P-1 and P-2 reduce that count whenever another condition is also true. `[TO]`

## 12. Impact on audit history and metrics

| Model | Audit property | Metric property |
| --- | --- | --- |
| P-1 | shows the publication fact; hides abandonment and expiry | "stranded by newer version" exact; "expired" under-counted |
| P-2 | shows the operator fact; hides publication and expiry | "abandoned with work outstanding" exact |
| P-3 | shows the clock; hides intent and publication | "expired" exact; other counts under-counted |
| P-4 | shows all true conditions | exact for everything, at the cost of compound queries |

`[TO]` Because these outcomes are silent (no alert), the label is the **only** signal available to a future reader. That is the strongest argument for P-4 and the strongest argument against any model that discards information without recording it elsewhere.

## 13. Recommendation, clearly labelled as non-binding

`[RC]` **Non-binding.** If the Owner wants a single-value answer, P-1 is the least disruptive: it needs no schema change, matches the precedence style already established by `CLM-19`, and keeps a one-value marker.

`[RC]` If audit fidelity matters more than simplicity — which is defensible precisely because these outcomes are silent — P-4 with P-1 as the component ordering is the better long-term choice.

`[RC]` C-01 (§8) should also be decided, because that gap produces a *visible* inconsistency — an alert whose record says the job was cancelled. It is a separate decision: closing L-01 does not close C-01, and closing C-01 does not close L-01.

**This memo does not choose. L-01 remains OPEN.**

## 14. Exact Owner approval questions

Answering Q-L01-1 closes L-01 as a label rule; Q-L01-2 applies only if P-4 is chosen. Q-L01-3 and Q-L01-4 shape how the answer is applied.

**The former Q-L01-3 (cancellation versus a committed `failed_terminal`) has moved to C-01 in §8.1 and is not part of this list.**

1. **Q-L01-1.** Which precedence applies among `superseded`, `cancelled`, `expired-unprocessed` — P-1, P-2, P-3, or P-4 (composite)?
2. **Q-L01-2.** If P-4, what is the component ordering, is a primary reason mandatory, and is the marker stored as one compound value or as two fields?
3. **Q-L01-3.** Does the rule apply uniformly to recovery, claim and Worker-write encounter points, or may it differ by encounter point?
4. **Q-L01-4.** Where should the decision be recorded (M7.0 §3.4 note, `A.7`, a new `CLM-20`, or a Phase 2 decision record), given the governance model chosen in S0b?

## 15. Decision-record template

To be completed by the Owner or by the governance route approved in S0b. Not pre-filled.

| Field | Value |
| --- | --- |
| Decision ID | `L01-DR-01` |
| Date | *(to be set)* |
| Question | Q-L01-1 … Q-L01-4 |
| Chosen option | *(P-1 / P-2 / P-3 / P-4)* |
| Component ordering (if P-4) | *(to be set)* |
| Related decision (separate record) | C-01 — cancellation versus a committed `failed_terminal`; not part of this decision |
| Encounter-point uniformity | *(uniform / differs)* |
| Rationale | *(Owner's words)* |
| Consequences accepted | *(e.g. "expired" metric under-counts)* |
| Documents to update | M7.0 §3.4 note, `A.7`, §7 history, `PROJECT_STATUS.md` |
| Identifier effect | L-01 status change only; no `SPEC-GAP` closed |
| Implementation authorized | **No** — separate gate |
