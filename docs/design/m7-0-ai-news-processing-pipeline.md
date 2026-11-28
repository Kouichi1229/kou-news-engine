# M7.0 — AI News Processing Pipeline: Specification (Reconstructed)

> **Reconstruction notice.**
> This document is a **new reconstruction** of the M7.0 specification. The previous
> M7.0 specification file is unavailable. It was **not** recovered, and nothing in
> this document is claimed to reproduce its exact contents, wording, ordering, or
> completeness.
>
> The content below is derived from exactly two sources:
>
> 1. **Owner decisions confirmed for this reconstruction**, recorded in §3 with
>    their exact meaning preserved.
> 2. **Documentation and source code verifiable in this repository** at the
>    baseline commit, used only to state what exists today (§5).
>
> Everything else is marked `OPEN` (an unresolved requirement) or `UNSPECIFIED`
> (a chapter with no decided requirement content). No requirement, schema field,
> SQL, API, CLI command, configuration value, or acceptance criterion has been
> invented to make the outline look complete.
>
> **Normative authority.** `docs/architecture.md` is the sole authoritative source
> for original-content retention requirements. This document references those
> requirements and does not restate them (§3.1). That authority does not extend to
> derived-content retention, which this document owns, or to any other M7.0
> requirement.

## 0. Document control

| Field | Value |
| --- | --- |
| Title | M7.0 — AI News Processing Pipeline |
| Path | `docs/design/m7-0-ai-news-processing-pipeline.md` |
| Nature | Reconstructed specification (not a recovered original) |
| Phase | Phase 1.15 — M-01 cross-section policy consistency correction (documentation only); independently audited at Phase 1.16, verdict **PASS WITH FINDINGS**, with L-01 and L-02 accepted as `OPEN` Phase 2 prerequisites; nothing implemented |
| Reconstruction date | 2026-11-26 |
| Baseline branch | `main` |
| Baseline HEAD | `5ce56d7f070010b102540a10ba6633246544194a` |
| Repository | `Kouichi1229/kou-news-engine` |
| Predecessor M7.0 document | Unavailable; not recovered |
| Authority | Owner, explicit Phase 1 / 1.1 / 1.2 / 1.4 / 1.7 / 1.9 / 1.11 / 1.13 authorization, plus the intervening Batch B, Task A and Task B documentation corrections (documentation only) |
| Batch A policy decisions | Owner, 2026-11-26 — seven decisions recorded in §3.11; `docs/architecture.md` amended for the retention clock and deletion scope |
| Notification, alert and lifecycle policy | Owner, 2026-11-26 — `OUT-17`..`OUT-24` and `CLM-15`..`CLM-18` recorded; `OUT-1`'s unique constraint superseded; `docs/architecture.md` gains a deletion-sequencing cross-reference |
| Phase 1.7 decisions | Owner, 2026-11-26 — Q1 correction evidence is an AI-generated summary only; Q2 Outbox retention is independent of the 168-hour deletion set; Q3 abandonment stops the lifecycle. Recorded in `OUT-22`, `OUT-23`, `OUT-25` and `CLM-18` |
| Technical design appendix | Appendix A is **non-normative**; every item carries `[P]`, `[T]`, `[U]` or `[E]`. No appendix item is implemented |
| Phase 1.13 closure | Owner, 2026-11-26 — N-01..N-03 remediated: `CLM-19` now fixes retirement precedence over attempt exhaustion for nonterminal jobs, protects already-committed terminal outcomes, and applies the token/lease/version guard to every Worker write; `CLM-12` and `CLM-13` state the same boundaries; `CLM-18` and Appendix A.12 separate lifecycle abandonment from notification intervention abandonment |
| Phase 1.11 closure | Owner, 2026-11-26 — V-01..V-03 remediated: `CLM-19` makes version retirement a Claim, recovery and publication rule; `OUT-25` separates the delivery outcome from the manual-intervention outcome and records that a manual retry does not reset the automatic budget; Appendix A.4 separates `version == published_version` from `version < published_version`; Appendix A.12 records the dead-notification intervention defaults |
| Phase 1.9 remediation | Owner, 2026-11-26 — F-01..F-10 remediated. F-03 Decision A: a `dead` ordinary notification enters manual intervention (retry, hold, abandon), is retained until that intervention is complete, and only then starts its independent retention period; it stays a separate event type from an alert. New `OUT-26` fixes payload self-containment for every Outbox event |
| Normative source — original-content retention | `docs/architecture.md` (sole authority; referenced here, not restated) |
| Normative source — derived-content retention | This document (not covered by `docs/architecture.md`; see `SPEC-GAP-14`) |
| Status vocabulary | §1.5 — three separate axes: requirement status, specification coverage, implementation status |
| M7.0 implementation status | **Not implemented.** See §5. |
| Scope of this phase | No code, schema, test, config, or workflow change is authorized |

**What this document is.** A governance frame, a proposed chapter outline, and a
register of Owner-confirmed decisions plus unresolved items, for a milestone that
has not been specified in this repository before.

**What this document is not.** It is not an implementation plan, not a schema
design, not an API contract, and not evidence that any M7.0 behaviour exists.

---

## 1. Document governance

### 1.1 Document purpose

This document exists to give the M7.0 milestone a single, explicit starting point
after the loss of the previous specification. It must let a future session:

- see which decisions are already settled and therefore not open for redesign;
- see which questions are still unanswered, without mistaking them for
  requirements;
- see which parts of the described pipeline already exist in code and which do
  not;
- know who may change a status, and how.

### 1.2 Scope and non-goals

**In scope (as specification subject matter, not as work authorized here).** The
AI news processing pipeline: the boundary between the existing collection and
extraction stages and the new LLM processing stages; derived content; primary
classification and supplemental tags; importance scoring; information validity;
article-level and event-level deduplication; Traditional Chinese reading output;
the claim, lease, retry and terminal lifecycle; the outbox and notification
delivery boundary; derived-content retention, together with references to the
original-content retention requirements owned by `docs/architecture.md`; and the
API, CLI, configuration, observability, security and acceptance surfaces that
accompany them.

**Out of scope for this document.**

- Any implementation, refactor, migration, or test.
- Deciding any `OPEN` item, including the ones recorded in §4.
- Defining or restating original-content retention requirements.
  `docs/architecture.md` is their sole authoritative source (Owner decision,
  Option A, 2026-11-26); this document references them. That authority does not
  extend to derived-content retention or to any other M7.0 requirement. This
  document does not modify `docs/architecture.md`.
- Daily briefing generation, the Kou AI application, and multi-user
  authentication. No Owner decision covering these was recorded for M7.0.
- Any claim of secure erasure of data. See `RET-7`.
- Re-litigating decisions that other documents already record as approved, for
  example the LLM provider decisions `D-1`..`D-7` in
  `docs/design/i7-1b-llm-provider.md`.

### 1.3 Normative terminology

| Term | Meaning in this document |
| --- | --- |
| Original content | The body text of a news article, fetched and stored by the extraction stage. |
| Derived content | Content produced by LLM processing from original content: summaries, translations, classifications, scores, tags. |
| First observation | The moment the system first discovers an article. Written once per data lifecycle and never modified, even when the download or the extraction that followed failed. **Not** the retention reference. Normative statement in `docs/architecture.md`. |
| Most recent observation | The moment the system last discovers the article. Updated on every rediscovery, regardless of whether the download or extraction succeeded. **This is the retention reference**: the 168-hour period is measured from it. |
| Processing version | The identity of the code/prompt/model configuration that produced a derived record. Its exact definition is `OPEN` (`SPEC-GAP-05`). |
| Claim | The act of taking exclusive, time-limited ownership of a row for processing, which consumes one attempt. |
| Lease | The time-limited ownership a claim grants, identified by an owner and a token. |
| Terminal row | A row whose `terminal_reason` is not null. Permanently ineligible for automatic claim. |
| Replacement transaction | The single transaction in which a newer processing version persists its derived record and removes prior-version derived rows. |
| Outbox event | A durable record of an intended notification, written in the same store as the business data. |
| Provider acceptance | The messaging provider acknowledged receipt of a message. Not end-user delivery. |
| End-user delivery | The message actually reached the reader. Not established by `sent`. |
| Article-level deduplication | Recognising that two collected items are the same article, by normalised URL. |
| Event-level association | Linking distinct articles that report the same real-world event, without merging or deleting them. |
| Importance | An integer 0–100 score of intrinsic objective significance. Distinct from confidence and from validity. |
| Information validity | A separate assessment of whether information holds up. Not an expiry trigger. |
| Restate | To express an **unchanged** rule again in another place. The rule does not change; the restatement carries no new decision. |
| Supersede | To **replace** an earlier decision with a later Owner decision. The rule changes and the identifier stays; a superseded rule must never be presented as still in force. |
| Article Lifecycle | One retention lifecycle of an article: from its first observation until its original content is deleted under the 168-hour rule. Its identity is the `aggregate_id` the Outbox stores (`OUT-17`). A rediscovery after deletion starts a **new** Article Lifecycle. |
| Initial-success notification | The single notification a lifecycle may emit once AI-derived content has been generated **and** persisted for the first time (`OUT-19`). |
| Correction event | One material change to a core news fact of an already-published article, recorded with its evidence and given its own identity (`OUT-20`, `OUT-21`). |
| Alert event | An Outbox event reporting an operational failure that needs attention, such as exhausted Processing attempts (`CLM-15`). |
| Lease expiry | The moment a Worker's claim lease on one Processing job lapses. It says nothing about the article. |
| Lifecycle expiry | The moment an article's original content reaches its 168-hour retention limit. It says nothing about a claim lease. |
| `GAP-1` | An unresolved outbox alerting concern referenced by Owner decisions. Its definition is not recorded here. |
| `O-8` | An unresolved outbox data-deletion question. Remains open. |
| `O-27` | An unresolved outbox cleanup-command placement question. Remains open. |

This document does not use RFC-2119 keyword force. Bindingness is carried by the
status label in §1.5: only a `CONFIRMED` entry states a requirement.

### 1.4 Owner decision authority

- The Owner is the sole authority for requirement content and for status changes.
- A decision becomes `CONFIRMED` only by an explicit Owner statement, recorded
  with an identifier in §3.
- An implementer, reviewer, or agent may **propose**, but may not confirm.
- Silence is not approval. The absence of a decision is recorded as `OPEN`, never
  as an implied default.
- A conflict between this document and repository evidence must be reported, not
  resolved by editing either side unilaterally.
- **Document authority.** `docs/architecture.md` is the sole authoritative source
  for original-content retention requirements (Owner decision, Option A,
  2026-11-26). This document records the decision identifiers for traceability and
  points at that document; it does not define those requirements. That authority
  does not extend to derived-content retention or to unrelated M7.0 requirements,
  which this document owns (`SPEC-GAP-14`).

### 1.5 Requirement status terminology

| Status | Meaning | May an implementer act on it? |
| --- | --- | --- |
| `CONFIRMED` | Explicitly decided by the Owner. Binding, and not to be reopened as a question. | Yes. |
| `OPEN` | Unresolved. A decision is required before any implementation may depend on it. | No. |
| `PROPOSED` | A draft awaiting Owner ratification. Has no force until it becomes `CONFIRMED`. | No. |
| `DEFERRED` | Deliberately postponed; not rejected, not approved. | No. |

The four statuses above apply to **requirements and Owner decisions only**. They
are never applied to a chapter, a section, or a document as a whole.

#### 1.5.1 Specification coverage (not a requirement status)

Chapters in §2 carry a coverage classification, which describes how much of that
chapter's requirement content has been decided:

| Coverage | Meaning |
| --- | --- |
| `SPECIFIED` | Every requirement in the chapter's subject matter is decided. |
| `PARTIALLY SPECIFIED` | At least one requirement in the chapter's subject matter is decided, and at least one is not. |
| `UNSPECIFIED` | No requirement in the chapter's subject matter is decided. |

Coverage describes the document, not the product. `SPECIFIED` means the chapter
has no unresolved requirement of its own; `PARTIALLY SPECIFIED` means it has at
least one decided and at least one unresolved requirement; `UNSPECIFIED` means it
has no decided requirement. A chapter can therefore be `SPECIFIED` while the
requirements it consolidates are `OPEN`: chapters 24 and 25 are registers, and
being complete is not the same as being decided.

#### 1.5.2 Implementation status (not a requirement status)

Chapters in §2 also carry an implementation classification, grounded in §5:

| Implementation status | Meaning |
| --- | --- |
| `IMPLEMENTED` | §5 establishes that the chapter's subject matter exists and is exercised in this repository. |
| `PARTIALLY IMPLEMENTED` | §5 establishes that part of the chapter's subject matter exists and part does not. |
| `NOT IMPLEMENTED` | §5 establishes that the chapter's subject matter does not exist in this repository. |
| `NOT VERIFIED` | §5 makes no claim about this chapter's subject matter. It is **not** a claim that the behaviour is absent. |

#### 1.5.3 The three axes are independent

- Specification coverage is not requirement status.
- Implementation status is not requirement status.
- A written requirement is not automatically `CONFIRMED`.
- Existing implementation does not automatically make a requirement `CONFIRMED`.
- A `CONFIRMED` requirement may still be unimplemented.

**Current population of `PROPOSED` and `DEFERRED`.** No item in this Phase 1.1
document is recorded as `PROPOSED` or `DEFERRED`. The labels are defined so that
future drafts and postponements are labelled rather than silently absorbed. The
one place a deferral is already recorded elsewhere — API authentication for
future friends and consumers — is inherited from
`docs/design/i7-1b-llm-provider.md` decision `D3` ("API authentication is not
implemented and not authorized") and is not re-decided here.

### 1.6 Rule: `OPEN` items are never silently promoted

> **An `OPEN` item must not be silently converted into an implementation
> requirement.**

Consequences of this rule, all binding on this document:

1. No code, schema, prompt, configuration, or test may depend on an `OPEN` item.
2. An `OPEN` item may only become `CONFIRMED` through an explicit Owner decision,
   recorded with a new identifier and a date in §3 and in the change history
   (§7).
3. An implementation that happens to exist does not make a requirement
   `CONFIRMED`. Observed behaviour is evidence about the repository, not a
   decision by the Owner.
4. A `CONFIRMED` decision may not be narrowed, widened, or "clarified" by an
   implementation choice.
5. Where an implementation and a `CONFIRMED` decision disagree, the divergence is
   reported (§5.4) and left for the Owner.

### 1.7 Evidence standard

- Every statement about current behaviour in this document cites a repository
  path or a document at the baseline commit, or is labelled `NOT VERIFIED`.
- Absence claims ("no such table exists") were produced by search over the
  repository at the baseline commit, and are stated as observed at that commit
  only.
- No claim of runtime behaviour is made from source code alone where the
  behaviour would require executing the application.

---

## 2. Proposed complete table of contents

This is a **proposed** outline. It is a structure for the document to grow into,
not a set of requirements. Two columns describe the chapter and one describes the
product; none of them is a requirement status (§1.5.3).

| # | Chapter | Responsibility | Specification Coverage | Implementation status | Basis |
| --- | --- | --- | --- | --- | --- |
| 1 | Overview and objectives | What the pipeline is for, and what "done" means for M7.0. | `PARTIALLY SPECIFIED` | `NOT VERIFIED` | Purpose decided (`SYS-2`); M7.0 objectives not stated |
| 2 | System scope and boundaries | What the system is and is not; where scheduling, users, and external services sit. | `SPECIFIED` | `NOT VERIFIED` | `SYS-1`..`SYS-4`; boundary statements only |
| 3 | Architecture and component responsibilities | Module decomposition, dependency direction, ownership of state. | `UNSPECIFIED` | `NOT VERIFIED` | No M7.0 component decomposition recorded; pre-existing constraints in `docs/architecture.md` |
| 4 | End-to-end processing pipeline | Stage sequence from stored article to delivered notification. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | Claim/terminal (`CLM-*`) and replacement (`VER-*`) decided; stage graph not. No processing pipeline exists (§5.2) |
| 5 | Data model and entity relationships | Tables, keys, invariants for derived content and outbox. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | Outbox key/constraint facts only (`OUT-1`, `OUT-2`); derived schema `OPEN` (`SPEC-GAP-04`); no such tables exist (§5.2) |
| 6 | Collection and extraction | The existing ingestion and extraction stages the pipeline consumes. | `PARTIALLY SPECIFIED` | `PARTIALLY IMPLEMENTED` | Existing stages implemented (§5.1); `TXN-8` adoption not done (§5.2, §5.4 item 2); `SPEC-GAP-09` open |
| 7 | Original article content lifecycle | Retention clock, expiry, separation from derived records, residual copies. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | `RET-1`..`RET-7`, `EXT-1`..`EXT-3`; observation-timestamp storage and deletion mechanism `OPEN` (`SPEC-GAP-01`, `SPEC-GAP-02`); no retention behaviour (§5.2) |
| 8 | LLM processing and derived content | Generation, persistence, and replacement of derived records. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | `VER-1`..`VER-3`, `RET-3`, `RET-4`, `RET-6`; derived schema and version identity `OPEN`; no derived storage (§5.2) |
| 9 | Classification and supplemental tags | Fixed primary categories plus flexible tags. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | `CLS-1`; category set `OPEN` (`CLS-2`) |
| 10 | Importance scoring | Dimension evaluation, deterministic total, versioning. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | `CLS-3`..`CLS-9`; rubric and anchors `OPEN` (`CLS-10`) |
| 11 | Information validity | Separate validity assessment. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | Only the separation rule is decided (`CLS-11`); fields and categories `OPEN` (`CLS-12`) |
| 12 | Article-level and event-level deduplication | Two distinct deduplication levels. | `PARTIALLY SPECIFIED` | `PARTIALLY IMPLEMENTED` | `DED-1`, `DED-2`; event model `OPEN` (`SPEC-GAP-06`); `DED-1` partial only (§5.3) |
| 13 | Traditional Chinese translation and summaries | What is translated, at which summary levels. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | `SUM-1`, `SUM-3`..`SUM-6`; `SUM-2`, `SUM-7` `OPEN` |
| 14 | Claim, retry, lease and terminal lifecycle | Attempt accounting, lease expiry, terminal exclusion. | `PARTIALLY SPECIFIED` | `PARTIALLY IMPLEMENTED` | `CLM-1`..`CLM-19`; worker/concurrency details `OPEN` (`SPEC-GAP-08`); extraction claim/lease exists, no terminal field (§5.3) |
| 15 | Outbox and notification delivery | Durable event record, delivery semantics, backoff. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | `OUT-1`..`OUT-26`; `OUT-11`..`OUT-16` `OPEN`; no outbox exists (§5.2) |
| 16 | API contracts | Endpoints for processed news and consumers. | `UNSPECIFIED` | `NOT IMPLEMENTED` | No M7.0 endpoint specified (`SPEC-GAP-13`); only health/readiness exist (§5.1) |
| 17 | External scheduling and CLI operations | Who invokes what, when, and with which commands. | `PARTIALLY SPECIFIED` | `PARTIALLY IMPLEMENTED` | `SYS-1`; command inventory `OPEN` (`OUT-15` / `O-27`); `ingest`/`extract` CLIs exist, no processing CLI (§5.1, §5.2) |
| 18 | Retention and cleanup | Enforcement of the retention requirements and outbox cleanup. | `PARTIALLY SPECIFIED` | `NOT IMPLEMENTED` | Rules decided (chapters 7 and 8); enforcement placement `OPEN` (`SPEC-GAP-03`), outbox deletion `OPEN` (`OUT-16` / `O-8`) |
| 19 | Error handling and observability | Error classification, alerting, logs. | `UNSPECIFIED` | `NOT VERIFIED` | Alerting surface for lease exhaustion and `GAP-1` not specified (`SPEC-GAP-10`); §5 makes no claim |
| 20 | Security and data protection | Secrets, exposure, trust boundaries, residual copies. | `PARTIALLY SPECIFIED` | `NOT VERIFIED` | `RET-7` only; no other M7.0 security requirement recorded |
| 21 | Configuration | M7.0 variables, defaults, validation. | `UNSPECIFIED` | `NOT IMPLEMENTED` | None recorded (`SPEC-GAP-11`) |
| 22 | Acceptance criteria | Testable completion criteria. | `UNSPECIFIED` | `NOT VERIFIED` | None recorded (`SPEC-GAP-12`) |
| 23 | Operational procedures | Runbooks for the pipeline, alert response. | `UNSPECIFIED` | `NOT VERIFIED` | Depends on chapters 15, 17, 19, 21 |
| 24 | Open decisions and unresolved questions | The consolidated `OPEN` register. | `SPECIFIED` | `NOT VERIFIED` | Content is §4 of this document |
| 25 | Owner decision register | The consolidated `CONFIRMED` register. | `SPECIFIED` | `NOT VERIFIED` | Content is §3 of this document |
| 26 | Audit and change history | How this document changed, and on what authority. | `SPECIFIED` | `NOT VERIFIED` | Content is §7 of this document |

**Coverage counts, recalculated row by row from the table above:** 4 chapters
`SPECIFIED` (2, 24, 25, 26), 16 `PARTIALLY SPECIFIED` (1, 4, 5, 6, 7, 8, 9, 10,
11, 12, 13, 14, 15, 17, 18, 20), 6 `UNSPECIFIED` (3, 16, 19, 21, 22, 23).
Total 26.

**Implementation-status counts, grounded in §5:** 0 `IMPLEMENTED`,
4 `PARTIALLY IMPLEMENTED` (6, 12, 14, 17), 12 `NOT IMPLEMENTED` (4, 5, 7, 8, 9,
10, 11, 13, 15, 16, 18, 21), 10 `NOT VERIFIED` (1, 2, 3, 19, 20, 22, 23, 24, 25,
26). Total 26.

These two distributions are descriptions of this document and of the repository.
Neither is a count of requirements, and neither changes any requirement's status.

### 2.1 Notes on the outline

- Chapters 3, 16, 19, 21, 22 and 23 are `UNSPECIFIED` because no Owner decision
  recorded for M7.0 addresses their subject matter. They are listed so the
  eventual specification has a place for the decision, not because a shape is
  implied. Chapter 20 is `PARTIALLY SPECIFIED` only because `RET-7` constrains it.
- Chapter 6 is largely a description of existing behaviour, which is why its
  implementation status is `PARTIALLY IMPLEMENTED`. Describing existing behaviour
  is not the same as approving it for M7.0 (§1.6 rule 3); the two places where
  M7.0 touches it are `TXN-8` and `SPEC-GAP-09`.
- A `SPECIFIED` chapter means its requirement content is decided. It does not mean
  the behaviour exists: chapters 24, 25 and 26 are sections of this document, and
  most requirements they consolidate are `NOT IMPLEMENTED` (§5.3).
- No chapter has been expanded into requirements in this phase. Expansion is
  Phase 2 work and is not authorized.

---

## 3. Confirmed Owner decisions

Every entry below is `CONFIRMED` unless its status column says `OPEN`. Identifiers
are stable and are the citation form for the rest of the document.

This register is the **decision history**. It records what the Owner decided, with
stable identifiers, so the trail survives. It is not the normative text for every
entry: where a requirement is owned by another document, the normative statement
lives there and the entry below points to it (§3.1). Everywhere else, the entry's
wording preserves the Owner's exact meaning.

### 3.1 Content retention (`RET`)

**Normative authority.** `docs/architecture.md` §_Original-content retention
(planned)_ is the sole authoritative source for original-content retention
requirements (Owner decision, Option A, 2026-11-26). This section records the
decision identifiers for traceability and states the subject of each decision; it
does not restate the rules that document owns. Derived-content retention is not
covered by `docs/architecture.md` and is stated here (see `SPEC-GAP-14`).

| ID | Status | Subject of the decision (traceability) | Normative source |
| --- | --- | --- | --- |
| `RET-1` | `CONFIRMED` | Expiry of original article content, measured from the **most recent observation** of the article | `docs/architecture.md` → §_Original-content retention (planned)_ → _Retention clock_ |
| `RET-2` | `CONFIRMED` | Rediscovery **extends** the clock by moving the most recent observation forward; the first observation is written once per lifecycle and is **not the retention reference** | `docs/architecture.md` → same section, _Retention clock_ |
| `RET-3` | `CONFIRMED` | Derived LLM content expires exactly 720 hours after successful generation and persistence | This document |
| `RET-4` | `CONFIRMED` | Each derived record **stores its own copy** of the source URL and retains it for the lifetime of that record; it does not depend on the original article row | This document |
| `RET-5` | `CONFIRMED` | Original-content expiry must not cascade-delete unexpired derived content | This document. `docs/architecture.md` records the cascade as a **hard constraint** on any future derived table; it does not prescribe the foreign-key design. |
| `RET-6` | `CONFIRMED` | Derived-content expiry must not delete original article content | This document |
| `RET-7` | `CONFIRMED` | SQL `DELETE` does not establish physical secure erasure; SQLite WAL, freelist and backups are separate concerns | This document. `docs/architecture.md` lists the residual copies that motivate it. |

**`RET-1` and `RET-2` were superseded on 2026-11-26.** Their earlier wording —
"measured from the first successful download" and "Rediscovery or re-extraction
must not reset or extend that clock" — is the inverse of the current rule. The
Batch A Owner decision replaced both, and `docs/architecture.md` was amended in
the same change. The identifiers are unchanged; the decisions they record are
not.

**Why `RET-1` and `RET-2` are pointers, not text.** The Owner decided that
`docs/architecture.md` keeps sole authority over original-content retention. Two
competing normative statements of one rule would be a defect, so this register
records the identifiers and their subjects, and the rule itself is read from the
authoritative document. Decision history is preserved by the identifier;
normative authority is not duplicated.

**Why `RET-3` to `RET-7` remain here.** `docs/architecture.md` does not cover
derived-content retention (`RET-3`, `RET-4`, `RET-6`), and records the cascade
constraint (`RET-5`) and the residual copies (`RET-7`) without prescribing their
design. Those requirements therefore have no other source, and this document
remains their normative home until the Owner decides otherwise
(`SPEC-GAP-14`).

**What a derived record carries (Owner decision, 2026-11-26).** A derived record
stores its own copy of the source URL (`RET-4`), the Traditional Chinese title and
the other AI-derived fields. The **original** article's title is **not** required
to be kept. Because the original article row is deleted at 168 hours while derived
content may live for 720 hours, the URL must not be resolved through that row.
The two retention periods remain independent (`RET-3`, `RET-5`, `RET-6`). Column
names, types and table shape remain `OPEN` (`SPEC-GAP-04`).

### 3.2 Empty extraction (`EXT`)

| ID | Status | Decision |
| --- | --- | --- |
| `EXT-1` | `CONFIRMED` | Empty extraction rows retain extraction metadata for the 168-hour original-content lifecycle. |
| `EXT-2` | `CONFIRMED` | Empty, failed and pending rows follow the same 168-hour original-content retention clock as extracted rows, measured from the most recent observation. |
| `EXT-3` | `CONFIRMED` | No separate metadata expiry policy has been approved. |

**`EXT-2` was superseded on 2026-11-26.** Its earlier wording excluded empty rows
from the 168-hour clock. The Owner decision replaced it: empty, failed and pending
rows are retained on the same clock as extracted rows. The identifier is unchanged,
and the earlier text must not be read as still in force.

`EXT-3` is a confirmed statement of absence: it confirms that a **separate**
metadata policy does not exist, and therefore that none may be implemented. The
underlying question — whether extraction metadata should ever expire — is
answered in direction by `EXT-2` (it expires with the row's lifecycle), while the
remaining technical detail is `OPEN` (`SPEC-GAP-16`).

`docs/architecture.md` now defines that the 168-hour clock applies to the article
record itself, not to the presence of content, and defers the extraction-status
cases to this document. `EXT-1`..`EXT-3` apply that clock to those statuses
without redefining it, and without changing how it is measured.

### 3.3 Version replacement (`VER`)

| ID | Status | Decision |
| --- | --- | --- |
| `VER-1` | `CONFIRMED` | When a newer processing version successfully generates and persists its derived record, prior-version derived rows are deleted immediately as part of the successful replacement transaction. |
| `VER-2` | `CONFIRMED` | A failed newer version must preserve the previous completed derived record. |
| `VER-3` | `CONFIRMED` | Failed attempts leave no row in `article_derived` (`CLM-14`); their records live in the Processing State table, and no time-based retention policy is approved for them. |

`VER-1` and `VER-2` are a pair: the deletion in `VER-1` happens only in the
transaction that succeeds. `VER-2` forbids deleting the previous record when the
new attempt fails. `VER-3` states the consequence: failure records are kept
indefinitely, by absence of policy rather than by design, and they are not derived
content.

### 3.4 Claim and terminal lifecycle (`CLM`)

| ID | Status | Decision |
| --- | --- | --- |
| `CLM-1` | `CONFIRMED` | `terminal_reason IS NOT NULL` is the explicit terminal marker. |
| `CLM-2` | `CONFIRMED` | Terminal rows are permanently excluded from automatic Claim eligibility, regardless of any future change to `MAX_PROCESSING_ATTEMPTS`. |
| `CLM-3` | `CONFIRMED` | Reprocessing a terminal row requires an explicitly defined new-version replacement flow. |
| `CLM-4` | `CONFIRMED` | `failure_code` remains the eight `LlmErrorKind` values plus `PENDING`; `terminal_reason` is a separate lifecycle field. |
| `CLM-5` | `CONFIRMED` | `attempts` counts successful claims, not API calls. |
| `CLM-6` | `CONFIRMED` | A successful claim consumes an attempt immediately, even if the Worker is interrupted before calling the LLM. |
| `CLM-7` | `CONFIRMED` | There is no Release operation and no attempt refund. |
| `CLM-8` | `CONFIRMED` | An expired lease with exhausted attempts transitions to failed **and records a non-NULL `terminal_reason`**, preserves attempts and error information, remains stored, is permanently excluded from automatic Claim (`CLM-1`, `CLM-2`), and requires alerting — unless the job is still nonterminal and its Processing version is below `published_version`, in which case it is retired as `superseded` and no alert is raised (`CLM-19`). |
| `CLM-9` | `CONFIRMED` | `terminal_reason` can record a system lifecycle cause such as `lease_expired`. |
| `CLM-10` | `CONFIRMED` | Each processing version has its own attempt budget of `MAX_PROCESSING_ATTEMPTS = 3` claims. Attempts consumed by an older version do not reduce a new version's budget. Creating a new version must follow the explicitly defined version-creation rules and must not be used to bypass the ceiling. |
| `CLM-11` | `CONFIRMED` | `configuration`, `authentication`, `invalid_request` and `invalid_response` are non-retryable and enter terminal state immediately. `empty_response` remains retryable until the version's attempt ceiling is reached. |
| `CLM-12` | `CONFIRMED` | Every Worker write must validate the claim token it holds. A Worker whose claim is no longer valid must not write results or state. A write that would change job state or publish results must also be refused when the job is still nonterminal and its Processing version is below the lifecycle's published version: that write is rejected and the job follows the `superseded` retirement path (`CLM-19`). |
| `CLM-13` | `CONFIRMED` | At startup the system performs an expired-work recovery check. Work with attempts remaining **and no terminal outcome** is reopened for processing; a job that already has a terminal outcome — including a superseded, expired-unprocessed or cancelled outcome — is never reopened, and neither is a job whose Processing version is below the lifecycle's published version (`CLM-19`). Work with attempts exhausted is marked failed, **with a non-NULL `terminal_reason` recorded**, with attempts and error information preserved, and an alert is raised — **except** that a job which is still nonterminal and whose Processing version is below the lifecycle's published version is retired as `superseded` without an alert instead, because retirement takes precedence (`CLM-19`). |
| `CLM-14` | `CONFIRMED` | `article_derived` stores successfully generated content only. Failed attempts, claim, lease, Worker and terminal state are stored in the independent Processing State table. |
| `CLM-15` | `CONFIRMED` | Recovery and retention are coordinated so that an eligible exhausted job cannot disappear before it is terminalized and its alert event is durably persisted. Before an article's original content is deleted, work that is eligible for terminalization (expired lease, attempts exhausted) is marked failed with a non-NULL `terminal_reason`, its attempts and error information are preserved, and a self-contained alert Outbox event is durably persisted — **except** that a job which is still nonterminal and whose Processing version is below `published_version` is retired as `superseded` instead, so no alert event is required for it (`CLM-19`). The alert event carries enough information to remain valid without the article row. The 168-hour retention period is unchanged and no long-lived lifecycle identity record is created. |
| `CLM-16` | `CONFIRMED` | Alert delivery reuses the existing Outbox retry budget (`OUT-6`..`OUT-8`); that budget is finite and unchanged. When it is exhausted the alert event moves to an explicit manual-intervention state: it is retained and inspectable, never silently discarded, and it does not block deletion of already-expired original content once the required alert event has been durably persisted. |
| `CLM-17` | `CONFIRMED` | Manual intervention may request reprocessing (subject to the retry and version rules of `CLM-3` and `CLM-10`), temporarily hold the item for a later decision, or abandon it. |
| `CLM-18` | `CONFIRMED` | Abandonment stops all subsequent automatic processing for the current Article Lifecycle. Queued work is cancelled, active claims are invalidated, and a stale Worker must not publish results or state; no new correction notification may be generated for the abandoned lifecycle. Already-persisted Outbox events may continue delivery. Abandonment applies to that lifecycle only and must not create a permanent URL-level exclusion; if the same URL is discovered again after lifecycle deletion it may start a new lifecycle and be processed normally. Lifecycle abandonment is not the same operation as abandoning an Outbox notification (`OUT-25`): neither implies the other. |
| `CLM-19` | `CONFIRMED` | Version retirement is not a publication-only rule. Once any Processing version of an Article Lifecycle has published, every unfinished job of that lifecycle whose version is lower than `published_version` is terminalized as `superseded` wherever it is encountered — at Claim, at the startup recovery check, at publication, and at **every Worker write that can change job state or publish results**. **Precedence.** For a job that has not yet reached a terminal outcome, retirement takes precedence over attempt exhaustion: it is terminalized as `superseded`, is never classified as `failed_terminal`, raises no failure alert for that retirement, and consumes no further attempt — including when its attempt budget is already exhausted, provided no terminal outcome has been committed. **Historical protection.** Retirement is never retroactive: a job already committed as `failed_terminal` stays `failed_terminal`, with its recorded failure history and alert handling intact, and a job already committed as `succeeded` stays `succeeded`; neither is converted to `superseded`. **Worker writes.** Every write that can change job state or publish results — a successful publication, a retryable failure, a non-retryable failure, an attempt-exhaustion or other terminal-failure report — must validate the claim token and its ownership, the lease and current state required by `CLM-12`, and whether the version is below `published_version`. A write that fails the version check records neither an old-version success nor an old-version failure, and in particular cannot turn a retired job into `failed_terminal` or raise an alert for it. Such a job is never reopened or claimed again, and its active claim is invalidated. Ordering follows commit order: if the newer publication commits first, an unfinished older job met afterwards is retired; if the older job's terminal outcome committed first, that outcome stands. The concrete transaction mechanism and its atomicity remain `OPEN` (`SPEC-GAP-08`). |

The eight `LlmErrorKind` values in `CLM-4` are defined in
`docs/design/i7-1b-llm-provider.md` §6.1: `configuration`, `authentication`,
`rate_limit`, `timeout`, `unavailable`, `invalid_request`, `empty_response`,
`invalid_response`. `PENDING` is the pre-attempt state value. This document does
not extend that vocabulary.

`CLM-2` is deliberately independent of the retry budget: raising
`MAX_PROCESSING_ATTEMPTS` later cannot re-admit a terminal row.

**What `CLM-10`..`CLM-14` do not decide.** `CLM-10` fixes
`MAX_PROCESSING_ATTEMPTS = 3` per version; the version-creation rules themselves
remain `OPEN` (`SPEC-GAP-05`).
`CLM-11` adds nothing to the `CLM-4` vocabulary and reclassifies no other kind;
the retryability of the remaining kinds is stated in
`docs/design/i7-1b-llm-provider.md` §6.2 and is not restated here. `CLM-12`
requires token validation but fixes neither the token column, the table shape nor
the SQL. `CLM-13` fixes who performs recovery and what it does, not the lease
duration, transaction boundaries or multi-process coordination (`SPEC-GAP-08`).
`CLM-14` separates success records from failure records but does not fix the
Processing State table's columns, keys or cardinality (`SPEC-GAP-15`).

**`terminal_reason` on the exhausted path.** `CLM-8` and `CLM-13` require a
non-NULL `terminal_reason` to be recorded when attempts are exhausted. That is what
makes the terminal exclusion of `CLM-2` apply, and what makes `CLM-8`'s permanent
exclusion from automatic Claim hold independently of the attempt ceiling. The
specific string value is **not decided here**: `CLM-9` fixes only that a system
lifecycle cause may be recorded, not the vocabulary.

**Recovery, alert and intervention (2026-11-26).** `CLM-15` adds one sequencing
requirement to the terminal lifecycle: terminalization and the durable alert event
must happen **before** the original content is deleted, so an eligible job cannot
vanish inside the retention sweep. It does not extend the 168-hour period and it
does not keep the article row alive; the alert event is self-contained (`OUT-18`).
`CLM-16`..`CLM-18` govern what happens after delivery fails. Alert events reuse the
Outbox retry budget (`OUT-6`..`OUT-8`); when it is exhausted the event does not
become silently undeliverable — it enters the manual-intervention state and is
retained for inspection. Whether that state is `OUT-8`'s `dead` status with an
additional marker, or another representation inside `OUT-2`'s four statuses, is
**not decided here**, together with the concrete coordination mechanism (single
sweep, two-phase, lock), the transaction boundaries, the operator interface and
the representation of manual actions (`SPEC-GAP-08`, `SPEC-GAP-10`,
`SPEC-GAP-18`).

**Terminal outcomes and lifecycle close-out (2026-11-26).** Four job outcomes must
not be conflated:

- **failed_terminal** — attempts exhausted, or a non-retryable `LlmErrorKind`
  (`CLM-8`, `CLM-11`, `CLM-13`). This is the only outcome that raises a failure
  alert.
- **superseded** — a newer Processing version has published, so this job may no
  longer publish. It is a terminal outcome, not a failure.
- **expired-unprocessed** — the original content reached 168 hours while
  attempts remained. Terminal, not a failure, and no alert, because no failure
  occurred.
- **cancelled** — the job was cancelled, for example because its Article
  Lifecycle was abandoned (`CLM-18`). Terminal, not a failure, and no alert.

All four are terminal outcomes and must carry a non-NULL terminal marker —
`terminal_reason` or an equivalent terminal marker — so that `CLM-2`'s
exclusion applies; the specific values and schema are **not decided here**.
`superseded`, `expired-unprocessed` and `cancelled` consume no further attempt and
never produce a failure alert.

**Version retirement is not a publication-only rule (`CLM-19`).** Once a version
publishes, every unfinished job of that lifecycle with a lower version is
superseded wherever it is met — at Claim, at the startup recovery check, at
publication, and at every Worker write that can change job state or publish
results — so a stale job cannot be reopened, re-claimed, charged another attempt,
or turned into a `failed_terminal` alert.

**Precedence and history.** For a job with no committed terminal outcome,
retirement beats attempt exhaustion: it becomes `superseded`, not
`failed_terminal`, with no alert and no further attempt, even when its attempt
budget is already spent. Retirement is never retroactive: a job already committed
as `failed_terminal` keeps that outcome and its alert history, and one already
committed as `succeeded` stays `succeeded`.

Recovery therefore reopens only work that has no terminal outcome **and** whose
version is not below the published version. Claim eligibility excludes such jobs,
and excludes a closed or abandoned Lifecycle. An active claim is invalidated when
its job becomes superseded or its lifecycle is abandoned, and the Claim Token
fencing of `CLM-12` still applies, so a stale Worker's late write — success,
retryable failure, non-retryable failure or exhaustion — cannot publish older
content, create a `failed_terminal` alert, or change the current job, publication
or correction state. These semantics are required; the state names, their storage and the
interactions with the Recovery sweep, the Retention sweep and late Worker writes
are **not decided here** — the proposal is Appendix A (`[T]`), and the open detail
stays in `SPEC-GAP-08`, `SPEC-GAP-10` and `SPEC-GAP-15`.

### 3.5 Transaction helper (`TXN`)

| ID | Status | Decision |
| --- | --- | --- |
| `TXN-1` | `CONFIRMED` | A shared Core `immediateTransaction()` helper uses `BEGIN IMMEDIATE`. |
| `TXN-2` | `CONFIRMED` | It accepts a synchronous callback. |
| `TXN-3` | `CONFIRMED` | Nested transactions are rejected. |
| `TXN-4` | `CONFIRMED` | Async/promise callbacks are rejected. |
| `TXN-5` | `CONFIRMED` | Rollback must preserve the original exception. |
| `TXN-6` | `CONFIRMED` | It uses one connection. |
| `TXN-7` | `CONFIRMED` | Existing `transaction()` behavior must remain unchanged. |
| `TXN-8` | `CONFIRMED` | Extraction should use the shared helper. |

`TXN-7` protects the existing helper in `src/core/persistence/sqlite.ts`, whose
contract (synchronous callback, `BEGIN`/`COMMIT`, rollback with the original error
rethrown and rollback failure attached as `rollbackCause`,
`AsyncTransactionCallbackError` for promise-returning callbacks) is already
implemented and tested. `TXN-1` describes a **new** helper; `TXN-7` forbids
changing the old one to build it.

### 3.6 Classification and scoring (`CLS`)

| ID | Status | Decision |
| --- | --- | --- |
| `CLS-1` | `CONFIRMED` | Primary news categories use a fixed category set, with flexible supplemental tags. |
| `CLS-2` | `OPEN` | The exact primary category set is not decided. |
| `CLS-3` | `CONFIRMED` | Importance is an integer score from 0 to 100. |
| `CLS-4` | `CONFIRMED` | Importance measures intrinsic objective AI research, technology and industry significance, not personal relevance. |
| `CLS-5` | `CONFIRMED` | Scoring dimensions and weights: technical breakthrough 35%, industry impact 30%, innovation 20%, timeliness 15%. |
| `CLS-6` | `CONFIRMED` | Formula: `round(0.35*T + 0.30*I + 0.20*N + 0.15*R)`. |
| `CLS-7` | `CONFIRMED` | The LLM evaluates each dimension; code computes the total deterministically. |
| `CLS-8` | `CONFIRMED` | Confidence is separate from importance. |
| `CLS-9` | `CONFIRMED` | Scoring version is stored. |
| `CLS-10` | `OPEN` | The detailed scoring rubric and its anchors are not decided. |
| `CLS-11` | `CONFIRMED` | Information Validity is separate from importance and is not an expiry trigger. |
| `CLS-12` | `OPEN` | The exact Information Validity fields and categories are not decided. |

`CLS-5`..`CLS-7` together mean: the model returns per-dimension judgements, and the
arithmetic is performed in code, so the same dimension values always produce the
same total. `CLS-10` is what would make two humans agree on a dimension value; it
is not decided, so no rubric may be assumed. `CLS-11` forbids using validity as a
reason to expire anything, and also forbids collapsing validity into importance.

### 3.7 Deduplication (`DED`)

| ID | Status | Decision |
| --- | --- | --- |
| `DED-1` | `CONFIRMED` | Normalized URL provides article-level deduplication. |
| `DED-2` | `CONFIRMED` | Event-level association preserves separate articles and does not delete them. |

These are two different levels. `DED-1` collapses the same article seen twice;
`DED-2` relates different articles about one event and explicitly keeps each
article row. `DED-2` does not authorize merging, rewriting, or deleting the
articles it associates.

### 3.8 Summaries and translation (`SUM`)

| ID | Status | Decision |
| --- | --- | --- |
| `SUM-1` | `CONFIRMED` | Two summary levels are intended: a short Telegram/mobile summary and a full summary. |
| `SUM-2` | `OPEN` | The exact length limits are not decided. |
| `SUM-3` | `CONFIRMED` | Translate only information the user actually needs to read into Traditional Chinese. |
| `SUM-4` | `CONFIRMED` | Full-article translation is not the default. |
| `SUM-5` | `CONFIRMED` | Traditional Chinese titles, summaries and selected key information are the primary reading output. |
| `SUM-6` | `CONFIRMED` | Original article content and source URL are retained temporarily for verification. |
| `SUM-7` | `OPEN` | The exact translation-selection rules are not decided. |

`SUM-1` states that two levels are *intended*; it does not fix their lengths
(`SUM-2`). `SUM-3` and `SUM-4` together make selective translation the rule and
whole-article translation the exception. `SUM-6` is why `RET-1` and `RET-4` exist:
the original and the URL stay available for a bounded period so a reader can check
the Traditional Chinese output against the source.

### 3.9 Outbox (`OUT`)

| ID | Status | Decision |
| --- | --- | --- |
| `OUT-1` | `CONFIRMED` | The outbox has 18 columns, primary key `event_id`, and unique constraint `(event_type, aggregate_id, notification_key)`. |
| `OUT-2` | `CONFIRMED` | It has four statuses and six status/field checks. |
| `OUT-3` | `CONFIRMED` | `sent` means the provider accepted the message; it does not mean final end-user delivery. |
| `OUT-4` | `CONFIRMED` | Delivery is at-least-once. |
| `OUT-5` | `CONFIRMED` | A duplicate delivery window exists unless provider idempotency is available. |
| `OUT-6` | `CONFIRMED` | Backoff uses full jitter, exponential base 30 seconds, capped at 6 hours. |
| `OUT-7` | `CONFIRMED` | Maximum attempts: 8. |
| `OUT-8` | `CONFIRMED` | When the eighth claim is exhausted, the event becomes dead. |
| `OUT-9` | `CONFIRMED` | HTTP timeout: 30 seconds. |
| `OUT-10` | `CONFIRMED` | Outbox lease: 60 seconds. |
| `OUT-11` | `OPEN` | The payload definition is not decided. The completeness requirement is confirmed separately (`OUT-26`); the field list, types and schema remain open. |
| `OUT-12` | `OPEN` | The drain cadence is not decided. |
| `OUT-13` | `OPEN` | `GAP-1` alerting is not decided. |
| `OUT-14` | `OPEN` | Retention placement **and duration** are not decided. `OUT-25` fixes only the independence and the cleanup conditions, and the period it names starts only after an event's manual-intervention condition is complete. |
| `OUT-15` | `OPEN` | `O-27` cleanup-command placement is not decided. This document does not decide whether that creates a fifth CLI command. |
| `OUT-16` | `OPEN` | The physical deletion mechanism for Outbox data is not decided. `O-8` remains open. Any cleanup must exclude alert events and `dead` ordinary notifications that are still awaiting manual intervention (`OUT-25`). |
| `OUT-17` | `CONFIRMED` | `aggregate_id` is the identity of the **Article Lifecycle**. All Processing versions of that lifecycle share it, and a Processing version change does not change it. A rediscovery after deletion creates a new Article Lifecycle with a new `aggregate_id`. |
| `OUT-18` | `CONFIRMED` | Outbox events may outlive the article row that produced them and continue delivery. `aggregate_id` is a **soft reference**: the article row need not exist for the event to remain valid. No permanent or long-lived lifecycle identity record is created; the event carries its own `aggregate_id`. |
| `OUT-19` | `CONFIRMED` | Each Article Lifecycle may generate **at most one** initial-success notification. It becomes eligible only after AI-derived content has been generated **and** persisted for the first time. A failed earlier Processing version does not consume the opportunity, so a later version that first succeeds may emit it. Ordinary Processing version upgrades must not create another notification. Its `notification_key` (`OUT-1`) is a lifecycle-scoped constant and must not be derived from `processing_version`, an attempt, or a derived-record identity. |
| `OUT-20` | `CONFIRMED` | A **major correction** may generate a separate correction notification. A major correction is one that changes a core news fact — for example amounts or data, dates, people, organisations, locations, or a core conclusion overturned by new evidence. Cosmetic summary edits, translation improvements, category changes, model upgrades, prompt upgrades and non-material supplementary information do **not** qualify. The AI judges this automatically with no mandatory human pre-approval, and must be strict: if it cannot establish that a core fact materially changed, no correction notification is created. No numeric confidence threshold is approved. |
| `OUT-21` | `CONFIRMED` | Every distinct major core-fact change is an independent correction event, with no fixed per-lifecycle limit. The same correction must not notify twice. A reversal is a new event: 100 → 120, 120 → 100, then 100 → 120 again are three distinct corrections. The previous and corrected values alone are **not** a globally unique key. The notification identity is the persisted correction event's own identity, which distinguishes a reprocessed correction from a genuinely new one in the fact-change sequence. |
| `OUT-22` | `CONFIRMED` | Each correction event preserves the fact item, the previous value, the corrected value, the source URL, and an **AI-generated evidence summary**. Verbatim source text and source excerpts are prohibited: evidence must be generated, not copied. Schema, data types, size limits, taxonomy and normalisation remain technical details (`SPEC-GAP-17`). |
| `OUT-23` | `CONFIRMED` | Correction event records and their required evidence — including the AI-generated evidence summary — follow the AI-derived content retention period of 720 hours (`RET-3`). They must not extend the original article's 168-hour retention, and the two retention periods remain independent. |
| `OUT-24` | `CONFIRMED` | Persistence precedes notification. A correction event and its complete evidence must be persisted before its notification is sent, and initial-success notification requires the derived content to be persisted first. An Outbox event must be durably persisted before a Delivery Worker may send it, and the Worker sends only from persisted Outbox events. Sending first and persisting later is forbidden. |
| `OUT-25` | `CONFIRMED` | Outbox retention is independent of original-content retention. No Outbox event or payload is part of the 168-hour original-article deletion set. An ordinary notification event may be removed only after it has been delivered successfully or, once its automatic retries are exhausted and it is `dead`, only after the manual intervention it requires has been completed — and in either case only after the independently defined Outbox retention period. A `dead` ordinary notification enters manual intervention: it is retained and inspectable until the operator retries, holds or abandons it, and it is never silently discarded. A `dead` notification is not an alert event: the two event types reuse the same action principles and the same retry budget (`OUT-6`..`OUT-8`), but their event types and cleanup conditions stay separate. An alert event may be removed only after the manual intervention it requires has been completed and that same independent period; where an alert requires no manual intervention, its intervention condition is deemed complete, and the successful-delivery and retention conditions still apply. An alert still awaiting manual intervention must never be silently deleted. Delivery outcome and manual-intervention outcome are separate results. `sent` carries only the meaning `OUT-3` gives it; a completed intervention — `abandon` included — is **not** a successful delivery, and an abandoned event is never recorded as `sent`. Retry, hold and abandon keep distinct meanings. Cleanup must test the delivery condition and the intervention condition separately and must never treat a completed intervention as a successful delivery. Not every Outbox event requires manual intervention. Delivery remains at-least-once (`OUT-4`). The retention durations themselves are **not decided here** (`OUT-14`). |
| `OUT-26` | `CONFIRMED` | Every Outbox payload must be self-contained for delivery. A Delivery Worker must not depend on the article row, on the Article Lifecycle row, or on a correction-event row still existing: an event persisted before those rows are removed must still be deliverable afterwards, so the payload must carry the content it sends. A payload must contain no verbatim original text and no verbatim excerpt, and an AI-generated evidence summary remains the only permitted form of correction evidence (`OUT-22`). Self-containment must not extend the 168-hour original-content retention, and it does not authorise keeping original content. |

`OUT-1` fixes the column **count**, the primary key, and one unique constraint; it
does not enumerate the 18 column names, and this document does not invent them
(`SPEC-GAP-07`). Likewise `OUT-2` fixes that there are four statuses and six
status/field checks, while `OUT-3` names only `sent`; the other three statuses are
not named here.

`OUT-3`..`OUT-5` are one statement in three parts: acceptance is not delivery,
delivery is at-least-once, and therefore a duplicate window exists unless the
provider offers idempotency. `OUT-6`..`OUT-8` are the retry budget; `OUT-9` and
`OUT-10` are timeouts on two different clocks (one HTTP call, one claim).

**`OUT-1`'s unique constraint was superseded on 2026-11-26.** It was originally
`(event_type, aggregate_id, processing_version)`, which made every processing
version a distinct notification and therefore contradicted `OUT-19`. The
constraint is now `(event_type, aggregate_id, notification_key)`. The identifier is
unchanged and the earlier key must not be read as still in force.

- `aggregate_id` is the **Article Lifecycle** identity, not the derived record and
  not the Processing run (`OUT-17`).
- `notification_key` is the notification identity **within** the lifecycle.
  `OUT-19`'s initial-success event uses one fixed value per lifecycle, so a second
  initial event is impossible even across versions. `OUT-21`'s correction events
  use the identity of the persisted correction event, so each distinct correction
  notifies once and a reprocessed correction cannot notify twice.
- `processing_version` remains a stored **provenance** column on the event. It is
  not part of the uniqueness identity.
- Alert events use the Processing version that exhausted its attempts, so a
  repeated Recovery or Retention sweep collides instead of duplicating while two
  distinct exhausted versions still produce two alerts. The proposal is Appendix A
  (`[T]`); generation remains `OPEN` (`SPEC-GAP-07`).

One of the 18 columns is `notification_key`; its name, type and the rest of the
column enumeration remain `OPEN` (`SPEC-GAP-07`).

The three duplicate kinds are therefore separated. A **lifecycle** duplicate is a
different `aggregate_id` (`SPEC-GAP-02`) and may notify again. A **version**
duplicate is the same `aggregate_id` with no new `notification_key`, so it cannot
notify. A **delivery** duplicate is the same event row re-sent (`OUT-4`, `OUT-5`).

**Correction identity: rationale and open edges.** A correction is defined against
the **currently published** facts of the lifecycle, not against the whole history:
the newly generated facts are compared with the published baseline, and a
correction record is created only when a core fact differs materially in a way the
AI can establish (`OUT-20`). That is what makes reprocessing idempotent — a later
version that reproduces the already-published values creates no new correction
record and therefore no new event — while a genuine sequence such as 100 → 120 →
100 → 120 still yields three corrections, because each is evaluated against a
different published baseline (`OUT-21`). Still `OPEN`: the fact taxonomy that
decides what counts as "the same fact item", the normalisation rules (formatting,
rounding, unit changes), the representation and size limits of evidence, and how
correction identities are generated (`SPEC-GAP-17`).

### 3.10 System boundary (`SYS`)

| ID | Status | Decision |
| --- | --- | --- |
| `SYS-1` | `CONFIRMED` | Scheduling is external. No internal scheduler is approved. |
| `SYS-2` | `CONFIRMED` | The system is a personal AI news collection, processing and knowledge engine. |
| `SYS-3` | `CONFIRMED` | Future friends or users are API consumers, not Write collaborators. |
| `SYS-4` | `CONFIRMED` | The repository's current implementation does not yet provide the complete scheduled push, LLM processing, processed-news API and Telegram delivery workflow, and these must not be described as implemented. |

`SYS-1` matches the existing architecture: both one-shot CLIs are invoked
externally and `APP_TIMEZONE` is retained for a future scheduler but unused today
(`docs/architecture.md` §_Ingestion execution model_, §_Configuration_).
`SYS-3` matches `D3` in `docs/design/i7-1b-llm-provider.md`; `SYS-4` is the
authority for the implementation-status section (§5) of this document.

### 3.11 Batch A policy decisions (2026-11-26)

These seven policy directions were confirmed by the Owner on 2026-11-26. They are
recorded here because a confirmed policy is a decision, and decisions belong in
this register. They do **not** close their `SPEC-GAP` identifiers: the technical
details in the last column are still unspecified, so each identifier remains
`OPEN` in §4.2. The seven identifiers below are the same seven listed in §4.2 —
they are not additional items, and the unresolved count is 29 (§4.2).

| Gap ID | Confirmed policy | Still open (technical) | Recorded in |
| --- | --- | --- | --- |
| `SPEC-GAP-01` | Two observation timestamps: the **first observation** is written once per data lifecycle and never modified; the **most recent observation** is updated on every rediscovery, whether or not the download or extraction succeeded. The 168-hour period runs from the most recent observation, so rediscovery **extends** retention. A full deletion ends the lifecycle; a later rediscovery starts a new one. | Column names, table placement, types and migration; the article identity and matching rule; when an observation is recorded if discovery fails before a row exists. | §4.2 `SPEC-GAP-01`; `docs/architecture.md` → _Retention clock_ |
| `SPEC-GAP-02` | On expiry the system deletes the original content, the system-managed copies of the original article media, the identifying records and the timestamp records. No tombstone is kept. A later rediscovery of the same article is allowed and starts a new data lifecycle, which may produce a new derived record; the Owner accepts that duplication and it is not an error to be prevented by a tombstone or a permanent identifier. | Whether SQL `DELETE` is sufficient; WAL, freelist and backup handling; external media deletion; deletion timing and verification standard. | §4.2 `SPEC-GAP-02`; `docs/architecture.md` → _Deletion scope_ |
| `SPEC-GAP-04` | AI-derived data is stored separately from original article data, and each derived field is managed separately so that different content is never mixed in one field. Each derived record stores its own copy of the source URL, the Traditional Chinese title and the other derived fields; the original article's title is not required. | Table names, columns, types and constraints; latest-only or version history; the precise field list and the meaning of "managed separately"; how the self-stored URL is validated. | §4.2 `SPEC-GAP-04` |
| `SPEC-GAP-05` | The processing version is an **increasing integer**. A new version replaces the old derived record only after generation **and** persistence both succeed. If generation or persistence fails, the old record stays. | What constitutes a new processing version and where it is stored; publication procedure, including the publication high-water mark and the superseded-job outcome once a newer version publishes; comparison, replacement transaction and concurrency protection; how model, prompt and output-schema changes map to a version bump. | §4.2 `SPEC-GAP-05` |
| `SPEC-GAP-08` | A **single worker** initially. At startup it scans overdue work and performs the necessary recovery: work with attempts remaining is reopened, and work with attempts exhausted is marked failed and terminal, with attempts and error information preserved and an alert raised (`CLM-13`); a still-nonterminal job whose Processing version is below `published_version` is retired as `superseded` instead, with no alert (`CLM-19`). Parallel workers are reconsidered later if needed. | Startup mechanism; lease duration and the overdue test; recovery ordering; protection when two processes start at once; cancellation and claim invalidation; the superseded and expired-unprocessed outcomes; when and where a lower-version job is retired, whether the publishing transaction or a sweep performs it, its atomicity with publication, and the ordering guarantee between a newer publication commit and an older job's terminal-outcome commit; how the Recovery sweep, the Retention sweep and late Worker writes agree. | §4.2 `SPEC-GAP-08` |
| `SPEC-GAP-09` | Claiming consumes an attempt in **both** Extraction and Processing. Cancellation or interruption before the HTTP request or LLM call does not refund it, and no Release may decrement it. | How the existing `releaseSql()` is removed or adjusted; what happens to the `released` counter and the CLI contract; test and external-script compatibility. | §4.2 `SPEC-GAP-09`; §5.4 item 1 |
| `SPEC-GAP-15` | Processing state is stored in its **own table**, separate from original article data and separate from AI-derived content. Its scope covers attempts, worker/run state, lease, terminal reason/state and the failure records of failed attempts; `article_derived` holds successfully generated content only (`CLM-14`). | Table and column structure; relationship to the article, the processing version and derived data; cardinality per article; history retention; state transitions and transaction rules. | §4.2 `SPEC-GAP-15` |

**Boundaries that apply to all seven.** None of them authorises an implementation
change; none specifies a column, type, index, transaction or procedure; and none
permits deleting AI-derived records inside their 720-hour period. Where a policy
above touches `docs/architecture.md`, that document was amended in the same
change and remains the normative source.

**Three cross-decision constraints follow from decisions already confirmed.**

- *Version identity.* The increasing integer in `SPEC-GAP-05` is stored on the
  Outbox event as **provenance** (`OUT-1`), but it is **not** part of the
  notification identity (`OUT-1`, `OUT-19`, `OUT-21`). It must still be stored and
  stable, not recomputed from configuration.
- *Recovery ceiling.* Startup recovery (`SPEC-GAP-08`) may not re-open work that
  has exhausted its attempts or has reached a terminal state (`CLM-2`, `CLM-8`).
  Exhausted work is marked failed **and terminal** (`CLM-13`), not merely failed —
  unless the job is still nonterminal and its Processing version is below
  `published_version`, in which case it is retired as `superseded` instead, with no
  attempt consumed and no alert raised (`CLM-19`).
- *No refund, therefore.* Because a claim is never refunded (`SPEC-GAP-09`),
  recovery can only re-open work that still has attempts remaining **and** whose
  Processing version is not below `published_version` (`CLM-19`).

---

## 4. Open decisions and unresolved questions

Nothing in this section may be implemented. Each entry states what decision is
still required. Two kinds are distinguished, because they have different
provenance.

### 4.1 Owner-recorded `OPEN` items

These are `OPEN` entries from §3, listed together for planning.

| ID | Decision required |
| --- | --- |
| `CLS-2` | The exact primary news category set. |
| `CLS-10` | The detailed importance rubric and per-dimension anchors. |
| `CLS-12` | The exact Information Validity fields and categories. |
| `SUM-2` | Length limits for the short and full summary levels. |
| `SUM-7` | The rules deciding which information is translated into Traditional Chinese. |
| `OUT-11` | The outbox payload definition (completeness is fixed by `OUT-26`; the fields and schema are not). |
| `OUT-12` | The outbox drain cadence. |
| `OUT-13` | `GAP-1` alerting. |
| `OUT-14` | Where outbox retention belongs, and how long it lasts. |
| `OUT-15` | `O-27` cleanup-command placement, including whether it creates a fifth CLI command. |
| `OUT-16` | The physical deletion mechanism for outbox data (`O-8`), excluding events still awaiting manual intervention. |

**Subset relationship, not a duplicate.** `OUT-13` ("`GAP-1` alerting") is a
**subset** of the broader alerting question in `SPEC-GAP-10` ("the alerting
channel and mechanism for lease-exhaustion failures (`CLM-8`) and `GAP-1`"). One
Owner decision on the alerting channel would close both. The two identifiers
remain separate and separately traceable; neither is merged, deleted, or
renumbered.

### 4.2 Specification gaps

These are gaps identified while assembling the outline. Each is `OPEN` because the
technical detail is not specified. Eight of them — `SPEC-GAP-01`, `-02`, `-04`,
`-05`, `-08`, `-09`, `-15` (recorded in §3.11) and `-16` (recorded in §3.2) —
carry a confirmed Owner policy direction; they remain open because a policy
direction does not specify columns, types, transactions or procedures. The other
ten have no Owner decision at all.

| ID | Question requiring a decision |
| --- | --- |
| `SPEC-GAP-01` | Observation timestamps and their storage. **Policy decided (§3.11):** two timestamps — a first observation written once per lifecycle, and a most recent observation updated on every rediscovery regardless of success — with the 168-hour period measured from the most recent observation. **Still open:** column names, table placement, types and migration; the article identity and matching rule; when an observation is recorded if discovery fails before a row exists. `docs/architecture.md` states the behaviour and deliberately does not prescribe the schema. |
| `SPEC-GAP-02` | Original-content deletion. **Policy decided (§3.11):** full deletion of the content, the system-managed copies of the original article media, the identifying records and the timestamp records; no tombstone; a later rediscovery is a new lifecycle, and the duplication that may result is accepted, not an error. **Still open:** whether SQL `DELETE` is sufficient; WAL, freelist and backup handling; external media deletion; timing and verification standard. |
| `SPEC-GAP-03` | Where and how often retention enforcement runs, given `SYS-1` (external scheduling only). |
| `SPEC-GAP-04` | The derived-content schema. **Policy decided (§3.11):** derived data is stored separately from original article data; each derived field is managed separately; each derived record stores its own copy of the source URL, the Traditional Chinese title and the other derived fields, and the original title is not required. **Still open:** table names, columns, types and constraints; latest-only or version history; the precise field list; how the self-stored URL is validated. `VER-3` names `article_derived`; no field list is recorded. |
| `SPEC-GAP-05` | Processing version. **Policy decided (§3.11):** an increasing integer; the old derived record is replaced only after generation and persistence both succeed, and a failed new version leaves it in place. **Still open:** what constitutes a new processing version and where it is stored; publication procedure, including the publication high-water mark and the superseded-job outcome once a newer version publishes; comparison, replacement transaction and concurrency protection; how model, prompt and output-schema changes map to a version bump. `VER-1`, `VER-2`, `CLM-3` and `OUT-1` all depend on it. |
| `SPEC-GAP-06` | The event-level association model: event identity, membership storage, and whether events are derived or authored. `DED-2` states the invariant only. |
| `SPEC-GAP-07` | The outbox column enumeration — including the type and generation of `aggregate_id` (the Article Lifecycle identity) and of `notification_key` for every event type, alert events included — the four status names, and the six status/field checks. `OUT-1` and `OUT-2` fix counts, keys and constraints, not content. |
| `SPEC-GAP-08` | The worker and concurrency model. **Policy decided (§3.11):** one worker initially; at startup the recovery check reopens work with attempts remaining and marks exhausted work failed **and terminal**, preserving attempts and error information and raising an alert (`CLM-13`), except that a still-nonterminal job whose Processing version is below `published_version` is retired as `superseded` with no alert (`CLM-19`); parallel workers deferred. **Still open:** startup mechanism; lease duration and the overdue test; recovery ordering; protection when two processes start at once; cancellation and claim invalidation; the superseded and expired-unprocessed outcomes; when and where a lower-version job is retired, whether the publishing transaction or a sweep performs it, its atomicity with publication, and the ordering guarantee between a newer publication commit and an older job's terminal-outcome commit; how the Recovery sweep, the Retention sweep and late Worker writes agree. `docs/architecture.md` notes `busy_timeout` is a retry window and not a lock. |
| `SPEC-GAP-09` | Refund of a consumed attempt. **Policy decided (§3.11):** claiming consumes an attempt in both Extraction and Processing; cancellation or interruption before the HTTP request or LLM call does not refund it, and no Release may decrement it. **Still open:** how the existing `releaseSql()` is removed or adjusted; what happens to the `released` counter and the CLI contract; test and external-script compatibility. The current implementation is not compliant (§5.4). |
| `SPEC-GAP-10` | The alerting channel and mechanism for lease-exhaustion failures (`CLM-8`, `CLM-15`) and `GAP-1`. `CLM-15` fixes the alert event's durability and self-containment; the delivery channel and mechanism remain open, and the minimum alert payload content is tracked in `OUT-11`. |
| `SPEC-GAP-11` | The M7.0 configuration variables: names, defaults, validation rules. None are recorded. |
| `SPEC-GAP-12` | The M7.0 acceptance criteria. None are recorded. |
| `SPEC-GAP-13` | The processed-news API contract: endpoints, authentication, pagination, and any new error codes beyond `docs/api-conventions.md`. |
| `SPEC-GAP-14` | Placement of derived-content retention requirements. The original authority conflict is **resolved** (Owner decision, Option A, 2026-11-26): `docs/architecture.md` retains sole authority over original-content retention, and this document references it rather than restating it. What remains unresolved is narrower: `RET-3`, `RET-4` and `RET-6` (derived-content retention) are not covered by `docs/architecture.md`, so this document is currently their only normative source. Whether that stays the case, or `docs/architecture.md` is later extended to own them, is undecided. `OUT-25` records that Outbox retention is independent of both original and derived retention, and Appendix A (`[T]`) summarises the four boundaries. |
| `SPEC-GAP-15` | Processing state storage. **Policy decided (§3.11):** a separate table, distinct from original article data and from AI-derived content, covering attempts, worker/run state, lease, terminal reason/state and failure records; `article_derived` holds successful content only. **Still open:** table and column structure; relationship to the article, the processing version and derived data; cardinality per article; history retention; state transitions and transaction rules; lifecycle-row closure and cleanup, how long closed lifecycle rows and their jobs are kept, and how derived, correction and Outbox rows survive removal of the lifecycle row without cascading. `CLM-4` fixes the `failure_code` vocabulary to `LlmErrorKind` + `PENDING`, while the current `article_contents` CHECK constraints require extraction-specific codes (§5.4). |
| `SPEC-GAP-16` | Whether extraction metadata (for empty or any other rows) should ever expire. **Policy decided (§3.2):** empty, failed and pending rows follow the same 168-hour clock, so their metadata expires with the row's lifecycle; no separate metadata-expiry policy exists. **Still open:** whether any metadata must outlive the row (for example for alerting or audit), and the technical details of that. `EXT-3` confirms no separate policy is approved. **This identifier is not closed.** |
| `SPEC-GAP-17` | The correction-event record. `OUT-21` fixes the identity semantics, `OUT-22` the required evidence content (an AI-generated summary only) and `OUT-23` the 720-hour retention. Still open: the core-fact taxonomy; how a fact identity is generated and how the same fact is recognised across Processing versions; value normalisation (formatting, rounding, unit changes); how previous and corrected values are compared; replay detection for a reprocessed correction; preventing distinct facts from being merged and one fact's genuinely distinct changes from being collapsed; preventing concurrent Workers from creating semantically duplicate corrections; the record schema; and the evidence size limits. A reversal stays a new event (`OUT-21`). |
| `SPEC-GAP-18` | The representation of manual-intervention actions (reprocess, hold, abandon) and of the lifecycle states around them, and the operator interface for inspecting and acting on alert events that exhausted their retry budget. `CLM-16`..`CLM-18` fix the policy; the representation and interface remain open, together with the expiry or escalation of an item that stays in manual intervention, the intervention path for a `dead` ordinary notification (retry, hold or abandon), how a manual retry is accounted for against `OUT-6`..`OUT-8` and what state follows a further failure, and how the delivery outcome and the intervention outcome are recorded separately, and the representation of abandonment and of cancelled work. |

**Status of the original authority conflict.** Closed, and not reopened.
`SPEC-GAP-14` is retained only for the residual placement question above; it no
longer represents a competing definition of original-content retention.

**Accounting.**

- **Original baseline count:** 11 Owner `OPEN` identifiers (§3) + 16 `SPEC-GAP`
  identifiers (§4.2) = **27 distinct unresolved identifiers**.
- **Effective unresolved count after this revision: 29.**
  Basis: §3 now holds 80 `CONFIRMED` and 11 `OPEN` entries (91 entries in
  total), and §4.2 now holds 18 `SPEC-GAP` entries, all of them `OPEN` as
  identifiers — eight of them with a confirmed policy direction (§3.11, plus
  `SPEC-GAP-16` in §3.2), and ten with no Owner decision at all. No identifier
  was closed, so 11 + 18 = 29. The 11 identifiers listed in §4.1 are the
  same identifiers as the `OPEN` rows of §3, re-listed for planning; they are not
  additional items and are not counted twice. The eight identifiers with a policy
  direction are likewise the same rows in §4.2, not additions. `SPEC-GAP-17` and
  `SPEC-GAP-18` are new identifiers created by this revision; they are open by
  construction and are counted once.
- **Resolved identifiers: none. This revision closes no identifier.**
  `SPEC-GAP-14` remains `OPEN` and keeps its identifier. Only its original
  authority question is resolved (Owner decision, Option A, 2026-11-26: the
  authority conflict is closed and not reopened). Its residual question — where
  derived-content retention requirements should live — is still undecided, so the
  identifier is not closed and the count is not reduced.
- **Identifier overlap:** `OUT-13` is a subset of `SPEC-GAP-10` (see §4.1). One
  Owner decision could close both, but they remain two identifiers, so the total
  stays 29. **28 is not the number of unresolved identifiers**; it would only be
  reached by collapsing `OUT-13` into `SPEC-GAP-10`, which has not been
  authorized.

### 4.3 Explicitly not decided here

For avoidance of doubt, this document does **not** decide, and no implementation
may assume:

- the deletion mechanism for original content (`SPEC-GAP-02`);
- the physical deletion mechanism for outbox data (`OUT-16`, `O-8`);
- whether outbox cleanup becomes a fifth CLI command (`OUT-15`, `O-27`);
- any category, rubric, validity, length, or selection rule listed in §4.1;
- any schema, API, configuration value, or acceptance criterion.

These are restatements of items already counted in §4.1 and §4.2. They are not
additional unresolved identifiers.

---

## 5. Implementation status at the baseline commit

This section separates **specification** from **implementation**. It reports what
was observed in the repository at
`5ce56d7f070010b102540a10ba6633246544194a`, and nothing else. Observation is not
approval (`SYS-4`, §1.6 rule 3).

**Method.** Read-only inspection: `git rev-parse`, `git status`, `git ls-files`,
`grep` over `src/` and `tests/`, and reading
`src/core/persistence/migrations.ts`, `src/core/persistence/sqlite.ts`,
`src/modules/extraction/repository/sqlite-article-content.repository.ts`,
`package.json`, `docs/architecture.md`, `docs/api-conventions.md`,
`docs/deployment.md`, `docs/security/ci-security-model.md`,
`docs/design/i7-1b-llm-provider.md`, `PROJECT_STATUS.md`, `README.md`. No test,
build, SQL, migration, or application command was run.

### 5.1 Verified present

| Observation | Evidence |
| --- | --- |
| At the observation time — before this document existed — the repository was `Kouichi1229/kou-news-engine`, branch `main`, HEAD `5ce56d7…`, and the working tree was clean. **This row is a historical snapshot, not current status.** | `git remote -v`, `git rev-parse`, `git status --porcelain` |
| Schema migrations v1–v4 exist: `articles`, `article_sources` (rebuilt in v3), `article_contents` (v4). | `src/core/persistence/migrations.ts` |
| `article_contents` has `status` in `extracted`/`empty`/`failed`/`in_progress`, `attempts`, `lease_owner`, `lease_token`, `lease_expires_at`, `extractor_version`, `failure_code`, `http_status`, plus content fields. | v4 migration |
| The current attempt ceiling is enforced by `CHECK (attempts BETWEEN 0 AND 3)`. | v4 migration |
| Extraction claim runs inside a **private** `immediate()` that issues `BEGIN IMMEDIATE`. | `sqlite-article-content.repository.ts` |
| Two one-shot CLIs exist: `ingest`, `extract`, both dry-run by default and requiring `--execute`. | `src/cli/`, `package.json` scripts |
| HTTP surface is `GET /api/health` and `GET /api/ready` only. | `docs/api-conventions.md` |
| A provider-agnostic LLM abstraction with a Gemini adapter and a `fake` provider exists and is not called by any production path. | `docs/architecture.md`, `README.md`, `src/core/llm/` |
| No scheduler exists; `APP_TIMEZONE` is retained but unused. | `docs/architecture.md` |
| `transaction()` in Core is synchronous-only, uses `BEGIN`/`COMMIT`, and rethrows the original error. | `src/core/persistence/sqlite.ts` |

### 5.2 Verified absent

Searches over `src/` and `tests/` returned no matches for any of: `terminal_reason`,
`article_derived`, `outbox`, `immediateTransaction`, `MAX_PROCESSING_ATTEMPTS`,
`processing_version`, `importance`, `validity`. No file or reference matching
`m7` exists in the repository.

Consequently, at the baseline commit:

- no derived-content storage exists (`VER-*`, `RET-3`..`RET-6`, `CLS-*`,
  `SUM-*` are unimplemented);
- no outbox table or delivery path exists, and no alert channel or
  manual-intervention interface exists (`OUT-*`, `CLM-16`..`CLM-18`
  unimplemented);
- no terminal lifecycle field or Processing state table exists for Processing
  (`CLM-1`..`CLM-4`, `CLM-8`, `CLM-9`, `CLM-13`, `CLM-14`, `CLM-19` unimplemented; see §5.3
  for what Extraction already does);
- no shared `immediateTransaction()` helper exists (`TXN-1`..`TXN-6`, `TXN-8`
  unimplemented);
- no retention behaviour exists (`RET-1`..`RET-7`, `EXT-1`, `EXT-2`
  unimplemented);
- no processed-news API, no Telegram delivery, and no scheduled push exist
  (`SYS-4`);
- no startup recovery or overdue-work sweep exists, so an expired lease whose
  attempts are exhausted leaves a row in `in_progress` for ever (`SPEC-GAP-08`);
- no refund-free claim path exists: the extraction repository still decrements
  `attempts` on release, contrary to `CLM-7` as confirmed in §3.11
  (`SPEC-GAP-09`, §5.4).

### 5.3 Status summary against the register

| Register group | Implemented? |
| --- | --- |
| `RET` (7) | No. `RET-1` and `RET-2` are stated in `docs/architecture.md`; `RET-3`..`RET-7` are stated here. No retention behaviour exists. |
| `EXT` (3) | No. Requirement only; `empty` rows are currently stored without any expiry. |
| `VER` (3) | No. No derived table exists. |
| `CLM` (19) | Partly, and **only in Extraction** — see the note below the table. |
| `TXN` (8) | No. A private `BEGIN IMMEDIATE` wrapper exists in one repository; the shared helper does not. |
| `CLS` (12) | No. |
| `DED` (2) | `DED-1` partly: URL canonicalisation and duplicate detection exist at ingestion. `DED-2`: no. |
| `SUM` (7) | No. |
| `OUT` (26) | No. |
| `SYS` (4) | `SYS-1` matches current design (external invocation only). `SYS-2`, `SYS-3`, `SYS-4` are boundary statements, not features. |

**Extraction behaviour is not evidence that the Processing policies are
implemented.** The two lifecycles share vocabulary, not state.

| Rule | Extraction today (`article_contents`) | Processing |
| --- | --- | --- |
| Attempt budget | `claimSql` resets `attempts` to 1 when `extractor_version` changes, and `CHECK (attempts BETWEEN 0 AND 3)` caps the count. In practice a version change therefore starts a fresh budget. | **Not implemented.** `CLM-10`'s `MAX_PROCESSING_ATTEMPTS = 3` per version is a requirement, not a description of existing processing code. |
| Write fencing | Every write (`completeSql`, `emptySql`, `failSql`, `releaseSql`) is guarded by `terminalGuard()`, which requires `status = 'in_progress' AND lease_token = ?`. | **Not implemented.** `CLM-12` requires the same property for Processing; the extraction guard is a local mechanism, not a shared one. |
| Terminal state | No `terminal_reason` column and no terminal exclusion rule exist. | **Not implemented** (`CLM-1`, `CLM-2`, `CLM-8`, `CLM-13`). |
| No refund | **Not compliant.** `releaseSql()` decrements `attempts`, floored at zero (§5.4 item 1). | **Not implemented.** |
| Recovery | No startup sweep exists; an expired lease with exhausted attempts stays `in_progress` indefinitely. | **Not implemented** (`CLM-13`). |
| Version retirement | A single `extractor_version`; a reclaim resets `attempts` and there is no superseded concept. | **Not implemented** (`CLM-19`). |
| Alert durability and manual intervention | No outbox, alert channel or operator interface exists. | **Not implemented** (`CLM-15`..`CLM-18`). |

The extraction `CHECK` constraint governs `article_contents` only and must not be
read as a constraint on the future Processing State table (`SPEC-GAP-15`).

### 5.4 Verified divergences requiring Owner attention

These are reported, not resolved.

1. **`CLM-7` and the existing extraction release path — decided, not implemented.**
   `CLM-7` (§3.4) states there is no Release operation and no attempt refund, and
   the Owner has confirmed (Batch A, 2026-11-26, §3.11) that the rule covers
   Extraction and Processing alike. The current implementation does not comply.
   Nothing else in the extraction lifecycle offsets this: the version-change reset
   and the `lease_token` guard described in §5.3 are local to `article_contents`
   and do not satisfy `CLM-7`.
   The extraction repository contains a release path that decrements `attempts`,
   floored at zero: `releaseSql()` in
   `src/modules/extraction/repository/sqlite-article-content.repository.ts:224–241`
   (decrement at line 234, `attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END`),
   invoked through `release()` at lines 351–353. Its only production caller is
   `src/modules/extraction/extraction.service.ts:148–163`, on the
   pre-HTTP-request cancellation path, and the behaviour is covered by integration
   tests (`tests/integration/extraction/article-content.repository.test.ts:391–430`;
   `tests/integration/extraction/extraction.service.test.ts:358–383`). The
   `released` counter in `ExtractionRunSummary`
   (`src/modules/extraction/extraction.types.ts:76`) reports it.
   **The requirement is confirmed; the code is not compliant; no implementation
   change is authorized.** How `releaseSql()`, the `released` counter and the CLI
   contract are handled remains `OPEN` (`SPEC-GAP-09`).
2. **`TXN-8` versus the existing private helper.** `TXN-8` says extraction should
   use the shared helper; today extraction uses its own private `immediate()`
   because no shared helper exists. Not a contradiction, an unimplemented
   instruction.
3. **`CLM-4` versus existing `failure_code` constraints.** `CLM-4` fixes the
   processing `failure_code` vocabulary to the eight `LlmErrorKind` values plus
   `PENDING`. The current `article_contents` table constrains `failure_code` per
   status, requiring extraction-specific codes such as `NO_CONTENT` and
   `CONTENT_TOO_SHORT` for `empty` rows, and forbidding those two for `failed`
   rows. Whether processing shares this table is `OPEN` (`SPEC-GAP-15`).
4. **Retention documentation authority — resolved for original content.**
   `docs/architecture.md:651–653` claims sole authority for original-content
   retention and instructs other documents to link rather than restate. The Owner
   decided (Option A, 2026-11-26) that this claim stands; §3.1 now references that
   document instead of restating the rules, and `RET-1` and `RET-2` are pointers
   rather than duplicated text. The residual question — where derived-content
   retention requirements (`RET-3`, `RET-4`, `RET-6`) should live — remains `OPEN`
   (`SPEC-GAP-14`).

---

## 6. Traceability to existing documentation

| This document | Existing source | Relationship |
| --- | --- | --- |
| `RET-1`, `RET-2` | `docs/architecture.md` §_Original-content retention (planned)_ → _Retention clock_ | **Normative source.** This document records the decision identifiers and subjects only; it does not restate the rules. Both were **superseded and restated** on 2026-11-26 (Batch A): the clock rule changed, and the entries were rewritten to the new rule. |
| `SPEC-GAP-01`, `SPEC-GAP-02` | `docs/architecture.md` §_Original-content retention (planned)_ → _Retention clock_, _Deletion scope_ | The behaviour is stated there and amended 2026-11-26; this document records only the technical gaps (§3.11, §4.2). |
| `RET-5`, `RET-7` | `docs/architecture.md` §_Original-content retention (planned)_ → _Relationship to cascading deletes_, _Residual copies_ | That section records the cascade constraint and the residual copies; the binding statements are recorded here. |
| `EXT-1`..`EXT-3` | `docs/architecture.md` §_Original-content retention (planned)_ → _Retention clock_ | **Partly covered.** That section states that the clock applies to the article record regardless of content, and defers the extraction-status cases here; the cases themselves are recorded only in this document (`SPEC-GAP-14`). |
| `RET-3`, `RET-4`, `RET-6` | — | Not covered by `docs/architecture.md`; this document is their only source (see `SPEC-GAP-14`). |
| `RET-1`, `RET-2`, `EXT-*` | `PROJECT_STATUS.md` §6 | Records retention as `NOT IMPLEMENTED — requirement recorded only`. |
| `CLM-4` | `docs/design/i7-1b-llm-provider.md` §6.1, §6.2 | Source of the eight `LlmErrorKind` values and their retryability. |
| `TXN-7` | `src/core/persistence/sqlite.ts` | The behaviour that must not change. |
| `SYS-1` | `docs/architecture.md` §_Ingestion execution model_, §_Configuration_ | External scheduling; unused `APP_TIMEZONE`. |
| `SYS-3` | `docs/design/i7-1b-llm-provider.md` `D3` | Friends are API consumers only. |
| `SYS-4` | `README.md` §_Status_, `docs/architecture.md` §_Planned modules_ | The list of capabilities that do not exist. |
| Chapter 16, chapter 20 | `docs/api-conventions.md`, `docs/deployment.md`, `docs/security/ci-security-model.md` | Pre-existing conventions the future API and security chapters must respect. |

---

## 7. Audit and change history

| Date | Change | Authority | Notes |
| --- | --- | --- | --- |
| 2026-11-26 | Document created as a **reconstruction**. Contains document governance, a proposed 26-chapter outline, the confirmed decision register (`RET` 7, `EXT` 3, `VER` 3, `CLM` 9, `TXN` 8, `CLS` 12, `DED` 2, `SUM` 7, `OUT` 16, `SYS` 4), the consolidated open register, and an implementation-status section at baseline HEAD `5ce56d7f070010b102540a10ba6633246544194a`. | Owner, explicit Phase 1 authorization | The previous M7.0 specification was unavailable and was not recovered. No existing file was modified. No code, test, schema, configuration, or workflow was changed. No test, build, SQL, migration, or application command was run. No Git write operation was performed. |
| 2026-11-26 | **Phase 1.1 corrections.** (a) Document authority: `docs/architecture.md` confirmed as sole authority over original-content retention (Owner decision, Option A). §3.1 now records `RET-1` and `RET-2` as pointers to that document instead of restating the rules; the "corroboration" wording is removed; §6 no longer claims equivalence for requirements the source does not cover. (b) `SPEC-GAP-14` re-scoped to the residual derived-content placement question, with the original conflict recorded as resolved. (c) §1.5 now defines three independent axes — requirement status, specification coverage, implementation status — and the `PARTIAL` requirement-status shorthand is removed. (d) The §2 chapter column is split into specification coverage and implementation status, with counts recalculated row by row (4 `SPECIFIED` / 16 `PARTIALLY SPECIFIED` / 6 `UNSPECIFIED`; 0 `IMPLEMENTED` / 4 `PARTIALLY IMPLEMENTED` / 12 `NOT IMPLEMENTED` / 10 `NOT VERIFIED`), replacing the incorrect 5/9/12 summary. (e) §4 records that `OUT-13` is a subset of `SPEC-GAP-10` without merging or renumbering, and states the distinct unresolved identifier count as 27. (f) §5.4 item 1 neutralised: the existing extraction release path is described factually and the scope of `CLM-7` is left `OPEN` under `SPEC-GAP-09`. | Owner, explicit Phase 1.1 authorization | Documentation only. No Owner decision was changed, added, or renumbered. `docs/architecture.md` was not modified. No code, test, schema, configuration, or workflow was changed. No test, build, SQL, migration, or application command was run. No Git write operation was performed. |
| 2026-11-26 | **Phase 1.2 — Batch A Owner decisions recorded.** (a) New §3.11 records seven confirmed policy directions (`SPEC-GAP-01`, `-02`, `-04`, `-05`, `-08`, `-09`, `-15`) with their remaining technical details. (b) `RET-1` and `RET-2` restated: the 168-hour period now runs from the most recent observation, and rediscovery extends it; the supersession of the earlier wording is recorded in §3.1. (c) §4.2 heading and intro adjusted: seven gaps carry a policy direction, nine do not; every identifier remains `OPEN`. (d) `SPEC-GAP-01`, `-02`, `-04`, `-05`, `-08`, `-09`, `-15` rewritten as "policy decided / still open". (e) §5.2 records that no startup recovery exists and that the claim path is not refund-free. (f) §5.4 item 1 rewritten: `CLM-7` now covers Extraction, the code is non-compliant, no implementation is authorized. (g) §6 traceability and §4.2 accounting updated; the unresolved count stays 27 and no identifier was closed. (h) `docs/architecture.md` amended in the same change: _Retention clock_ restated, _No existing timestamp column is a confirmed fit_ rewritten, cascade constraint hardened, _Deletion scope_ added, _Residual copies_ cross-referenced. | Owner, explicit Batch A authorization (documentation only) | No Owner decision was added beyond the seven confirmed directions, and none was renumbered. No technical detail was decided. `docs/architecture.md` was the only other file changed. No code, test, schema, migration, configuration or workflow was changed. No test, build, SQL, migration or application command was run. No Git write operation was performed. |
| 2026-11-26 | **Batch B — post-revision documentation corrections (D1–D15).** Retention terminology moved to first/most recent observation; `EXT-2` superseded; `RET-4` now requires the derived record to store its own source URL; `CLM-10`..`CLM-14` added; §5.3 split Extraction from Processing; §6 traceability rows split; `SPEC-GAP-05`, `-08` and `-16` descriptions updated. | Owner, Batch B authorization (documentation only) | No code, schema, test or configuration change; no implementation claimed. |
| 2026-11-26 | **Task A — post-audit corrections (PR-01..PR-08).** Exhausted-attempt transitions must record a non-NULL `terminal_reason`; §3.2 authority wording corrected; §5.2 and §5.3 separate Extraction from Processing; `SPEC-GAP-08` open list trimmed; retention-reference wording unified; `MAX_PROCESSING_ATTEMPTS = 3` tied to `CLM-10`; `SPEC-GAP-05` version-scope wording corrected. | Owner, Task A authorization (documentation only) | Followed the read-only post-revision audit. No implementation claimed. |
| 2026-11-26 | **Task B — audit follow-up (F-01, F-02).** The §3.4 note now cites `CLM-8`'s permanent exclusion instead of wording `CLM-8` no longer contains; §3.2 states that `EXT-1`..`EXT-3` apply the clock without redefining it. | Owner, Task B authorization (documentation only) | Independent audit of Task B returned PASS. No implementation claimed. |
| 2026-11-26 | **Phase 1.4 — D14, D16 and `aggregate_id` integration.** (a) `OUT-17`..`OUT-24` record Article Lifecycle identity, Outbox survival, the single initial-success notification, AI-judged major corrections with their evidence and 720-hour retention, and persistence-before-notification. (b) `OUT-1`'s unique constraint superseded. (c) `CLM-15`..`CLM-18` record terminalization before deletion, alert durability, manual intervention and abandonment scope. (d) `SPEC-GAP-17` and `SPEC-GAP-18` added. (e) `docs/architecture.md` records the deletion-sequencing cross-reference; `PROJECT_STATUS.md` synchronised. | Owner, this authorization (documentation only) | Documentation only. Nothing is implemented: there is no outbox, correction store or alert channel. |
| 2026-11-26 | **Phase 1.7 — technical design refinement and documentation integration.** (a) `OUT-22`/`OUT-23` record Q1: correction evidence is an AI-generated summary only, verbatim text prohibited, 720-hour retention unchanged. (b) New `OUT-25` records Q2: Outbox retention is independent of the 168-hour deletion set, with cleanup conditions and no silent deletion of an open alert; durations stay `OPEN` (`OUT-14`). (c) `CLM-18` records Q3: abandonment cancels queued work, invalidates claims, blocks late publication and new corrections, and lets already-persisted events finish. (d) New Appendix A (non-normative) records the technical proposal with `[P]`/`[T]`/`[U]`/`[E]` labels. (e) `OUT-19` fixes the initial `notification_key` as a lifecycle constant; the §3.4 note separates exhausted, non-retryable and expired outcomes and defines superseded jobs; `SPEC-GAP-05`, `-07`, `-08`, `-10`, `-14`, `-15`, `-17`, `-18`, `OUT-11`, `OUT-14` and `OUT-16` gain the corresponding open detail. (f) `docs/architecture.md` records the Q2 exclusion and the retention boundaries; `PROJECT_STATUS.md` synchronised. | Owner, this authorization (documentation only) | Documentation only. Nothing is implemented and no identifier is closed: `CONFIRMED` 77→78, `OPEN` unchanged at 11, `SPEC-GAP` unchanged at 18. No code, schema, migration, test, build, SQL or Git write. |
| 2026-11-26 | **Phase 1.9 — Phase 1.8 audit-findings remediation (F-01..F-10).** (a) F-01: the four processing-job outcomes are separated — `failed_terminal`, `superseded`, `expired-unprocessed` and `cancelled` — each terminal, each carrying a non-NULL terminal marker, only the first raising an alert; `CLM-13` now reopens only work with attempts remaining **and no terminal outcome**; claim eligibility excludes closed or abandoned lifecycles; Appendix A.4 closes the superseded job in the no-op path and Appendix A.7 tabulates the four outcomes. (b) F-02: new `OUT-26` requires every Outbox payload to be self-contained for delivery, never depending on the article, lifecycle or correction row, and never carrying verbatim original text; `OUT-11` stays `OPEN`. (c) F-03 (Owner Decision A): `OUT-25` now routes a `dead` ordinary notification into manual intervention (retry, hold, abandon), retains it until that intervention completes, and only then starts the independent retention period, keeping it a separate event type from an alert; `OUT-14` and `OUT-16` updated accordingly. (d) F-04: `CLM-16` states normatively that alert delivery reuses `OUT-6`..`OUT-8`, unchanged. (e) F-05: Appendix A.1 records the SQLite partial-index verification as `[U]`. (f) F-06: Appendix A.9 states that closing a lifecycle does not authorise keeping identifying records and that abandonment neither pauses nor extends the 168-hour period. (g) F-07: new Appendix A.11 lists the minimum payload information as `[T]`. (h) F-08: Appendix A.9 names `docs/architecture.md` as the normative source for the 168-hour row. (i) F-09: §1.3 distinguishes lease expiry from lifecycle expiry. (j) F-10: `OUT-25` treats an alert that needs no intervention as having its intervention condition complete. `docs/architecture.md` and `PROJECT_STATUS.md` synchronised. | Owner, this authorization (documentation only) | Documentation only. `CONFIRMED` 78→79, `OPEN` unchanged at 11, `SPEC-GAP` unchanged at 18; no identifier closed. Nothing implemented: there is still no outbox, processing state store, correction record or alert channel. No code, schema, migration, test, build, SQL or Git write. |
| 2026-11-26 | **Phase 1.11 — final documentation closure (V-01..V-03).** (a) V-01: new `CLM-19` makes version retirement a rule at Claim, at the startup recovery check and at publication — a lower-version job is terminalized as `superseded`, consuming no attempt and raising no `failed_terminal` alert, and is never reopened or claimed; `CLM-13` excludes such jobs from reopening; §3.4 states the rule; Appendix A.4 applies it in the claim and recovery paths; Appendix A.7 states it; `SPEC-GAP-08` gains the open detail of where and how the transition happens. (b) V-02: `OUT-25` now states that the delivery outcome and the manual-intervention outcome are separate, that an abandoned event is never recorded as `sent`, and that cleanup tests them separately; new Appendix A.12 records the technical default that a manual retry neither resets nor extends `OUT-6`..`OUT-8`; `SPEC-GAP-18` retains the open accounting, termination and supervision detail. (c) V-03: Appendix A.4 separates `version == published_version` (already published, idempotent, never rewritten as `superseded`) from `version < published_version` (superseded) and leaves `version > published_version` to normal publication. `PROJECT_STATUS.md` synchronised. | Owner, this authorization (documentation only) | Documentation only. `CONFIRMED` 79→80, `OPEN` unchanged at 11, `SPEC-GAP` unchanged at 18; no identifier closed. Nothing implemented: there is still no outbox, processing state store, recovery sweep, claim path or alert channel. No code, schema, migration, test, build, SQL or Git write. |
| 2026-11-26 | **Phase 1.13 — state-machine consistency closure (N-01..N-03).** (a) N-01: `CLM-19` now states that, for a job with no committed terminal outcome, version retirement takes precedence over attempt exhaustion — it becomes `superseded`, not `failed_terminal`, raises no alert and consumes no further attempt even when the budget is spent — while a `failed_terminal` or `succeeded` already committed is never retroactively rewritten; ordering follows commit order and the mechanism stays `OPEN` in `SPEC-GAP-08`. `CLM-13`'s exhaustion branch carries the same exception. (b) N-02: retirement encounter points now include every Worker write — publication, retryable failure, non-retryable failure and exhaustion — and `CLM-12` requires the version check alongside token and lease validation; Appendix A.4 and A.7 state the same guard. (c) N-03: `CLM-18` and Appendix A.12 state that Article Lifecycle abandonment and Outbox notification abandonment are independent operations, neither implying the other; Q3 is unchanged. `PROJECT_STATUS.md` synchronised. | Owner, this authorization (documentation only) | Documentation only. `CONFIRMED` unchanged at 80, `OPEN` unchanged at 11, `SPEC-GAP` unchanged at 18; no identifier added or closed. Nothing implemented: Worker write fencing, recovery, claim and retirement do not exist. No code, schema, migration, test, build, SQL or Git write. |
| 2026-11-26 | **Phase 1.15 — M-01 cross-section policy consistency correction.** The retirement precedence already stated in `CLM-19` was added where the same policy was still written without it: `CLM-8`, `CLM-15`, the §3.11 *Recovery ceiling* and *No refund, therefore* bullets, and both `SPEC-GAP-08` policy cells. In those places a nonterminal job whose Processing version is below `published_version` is now retired as `superseded` — no attempt consumed and no `failed_terminal` alert — while an ordinary exhausted job keeps its `failed_terminal` outcome and alert, and committed terminal outcomes are never rewritten. Documentation only: `CLM-19` itself, every Owner decision and every `SPEC-GAP` status are unchanged. | Owner, Phase 1.15 authorization (documentation only) | Phase 1.16's independent audit confirmed M-01 **RESOLVED** and recorded L-01 and L-02 as accepted `OPEN` items; that audit's verdict is **PASS WITH FINDINGS**, not an unconditional pass. `CONFIRMED` 80, `OPEN` 11, `SPEC-GAP` 18 unchanged; no identifier added or closed and no `SPEC-GAP` resolved. No runtime behaviour exists or was verified. |

**Change procedure for this document.**

1. A new `CONFIRMED` decision is added to §3 with a new identifier and a date in
   this table, and the corresponding `OPEN` entry is removed from §4 if it exists.
2. An `OPEN` item may not be removed without a recorded Owner decision.
3. Phase 2 (chapter drafting) requires separate authorization.
4. Corrections to factual claims about the repository require re-verification at
   the commit in question; the earlier statement is retained with a note rather
   than silently rewritten, following the practice already used in
   `PROJECT_STATUS.md` §3.

**Known limitations of this document.**

- It is not the original M7.0 specification and cannot be compared against it.
- It records no schema, API, configuration, or acceptance detail, because none
  was decided.
- Its implementation-status section is a point-in-time observation at
  `5ce56d7…`; the clone is shallow, so historical claims beyond that commit were
  not examined.

---

## Appendix A — Technical design proposal (non-normative)

> **Status: proposal only.** Nothing in this appendix is implemented, is a schema
> decision, or is authorized for implementation. It records the technical design
> derived from the Phase 1.6 analysis so that a later authorized phase starts from
> one consistent shape. It cannot override §3 or `docs/architecture.md`; where it
> conflicts with either, they win.
>
> Labels: `[P]` Owner-confirmed policy · `[T]` proposed technical design ·
> `[U]` unresolved technical detail · `[E]` existing implementation evidence.

### A.1 Article Lifecycle identity `[T]`

One row per Article Lifecycle in the Processing State store, with
`lifecycle_id` generated once as a UUIDv4 at lifecycle opening (first claim) and
never derived from the canonical URL. A partial unique index on `(article_id)
WHERE closed_at IS NULL` keeps at most one open lifecycle per article. Every
Processing version of the lifecycle carries the same `lifecycle_id`; the Outbox
stores it as `aggregate_id`.

- `[P]` A rediscovery after deletion opens a new lifecycle with a new
  `aggregate_id`; the Outbox keeps its own copy and survives article deletion;
  no permanent lifecycle identity record is created (`OUT-17`, `OUT-18`).
- `[E]` `articles.id` is `"a1:" + sha256(canonicalUrl)` (`dedupe.ts:241-243`,
  used at `:265`) and is upserted with `ON CONFLICT (id) DO UPDATE`
  (`sqlite-article.repository.ts:35-37`). It is therefore **not** usable as
  `aggregate_id`.
- `[U]` UUID format/version; when a closed lifecycle row and its jobs are
  removed (`SPEC-GAP-15`); the SQLite runtime version and whether it supports
  partial unique indexes. That support must be verified in the executing
  environment before implementation, and no such verification has been performed.

### A.2 Processing job versioning `[T]`

`processing_job` is keyed `(lifecycle_id, processing_version)`; each version has
its own attempt budget (`CLM-10`), its own claim token and lease (`CLM-12`), and
its own terminal state. A retry stays inside one version row; a new version is a
new row with a fresh budget.

### A.3 Published version and revision `[T]`

`processing_lifecycle` keeps `published_version` (high-water mark) and
`published_revision` (monotonic publication counter). A publication is accepted
only when its `processing_version > published_version`. The derived content of
the highest published revision is the *published baseline* used for correction
comparison.

### A.4 Publication transaction protocol `[T]`

```
BEGIN IMMEDIATE
  job := job(lifecycle, version) WHERE lease_token = ? AND state = 'running'
  require lease not expired                                   -- CLM-12
  require lifecycle.closed_at IS NULL AND abandoned_at IS NULL -- Q3
  -- every Worker write, including failure and exhaustion reports, applies this
  -- same token, lease and version guard (CLM-19)
  if version == published_version:      -- this version already published: idempotent replay
     update job state='succeeded', clear token   -- never rewritten as superseded
     return NO-OP
  if version < published_version:       -- a newer version already published
     update job state='superseded', terminal_reason=?, clear token  -- terminal, not a failure
     return NO-OP
  -- version > published_version: normal publication proceeds
  base := derived publication at published_revision
  diff := material core-fact changes vs base
  revision := published_revision + 1
  insert derived publication(revision)
  if base IS NULL: insert outbox('initial_success', lifecycle, 'initial')
  for each change: insert correction event(revision, fact_item) + outbox('correction', correction_id)
  update published_version, published_revision
  update job state = 'succeeded', clear token
COMMIT
```

Uniqueness constraints carry idempotency: `(lifecycle_id, processing_version)`
on jobs, `(lifecycle_id, revision)` on publications, `(lifecycle_id, revision,
fact_item)` on corrections, `(event_type, aggregate_id, notification_key)` on the
Outbox. Claim eligibility and the startup recovery check exclude any job whose
version is below `published_version`, terminalizing it as `superseded` instead
(`CLM-19`) — that transition consumes no attempt and raises no alert. They select
only jobs in an open, non-abandoned lifecycle that have no terminal outcome; a
`superseded`, `expired-unprocessed` or `cancelled` job is never claimable again,
and its token is invalid, so a late write from its Worker fails the guard above.
The version guard is not publication-only: a retryable failure, a non-retryable
failure and an exhaustion report are refused the same way, so a stale Worker
cannot manufacture a `failed_terminal` outcome or its alert. A `failed_terminal`
or `succeeded` committed before the newer publication stays as committed
(`CLM-19`). `[U]` The concrete SQL, indexes and
the `BEGIN IMMEDIATE` helper (`TXN-1`, not implemented) remain open
(`SPEC-GAP-05`, `SPEC-GAP-15`).

### A.5 Correction event identity `[T]`

A correction is the material change of one fact item between the published
baseline and a newly published revision, so its identity is
`(lifecycle_id, revision, fact_item)`; the persisted correction record then
supplies `notification_key` for its Outbox event. A replay of the same result
creates no new revision and therefore no correction. A reversal (100 → 120 →
100 → 120) yields three corrections because each compares against a different
baseline.

- `[U]` Fact taxonomy, fact-identity generation, value normalisation,
  comparison rules, replay detection, and prevention of cross-Worker semantic
  duplicates (`SPEC-GAP-17`).
- `[P]` Evidence is an AI-generated summary only; verbatim text and excerpts are
  prohibited; 720-hour retention, never extending the 168-hour rule (`OUT-22`,
  `OUT-23`).

### A.6 Outbox notification key namespaces `[T]`

| Event type | `notification_key` | Effect |
| --- | --- | --- |
| `initial_success` | one lifecycle constant (e.g. `initial`) | at most one per lifecycle, across all versions (`OUT-19`) |
| `correction` | the persisted correction event's identity | one per distinct correction (`OUT-21`) |
| `alert` | the Processing version that exhausted, e.g. `v<version>` | one per exhausted version; repeated sweeps collide |

`[U]` Literal values, column type and generation (`SPEC-GAP-07`).

### A.7 Terminal job outcomes: superseded, expired-unprocessed, cancelled `[T]`

| Outcome | Cause | Attempts | Alert | Reopened by recovery |
| --- | --- | --- | --- | --- |
| `failed_terminal` | attempts exhausted, or a non-retryable error, where no retirement condition applies | consumed | **yes** | no |
| `superseded` | a newer Processing version published | none additional | no | no |
| `expired-unprocessed` | original content reached 168 hours with attempts left | none additional | no | no |
| `cancelled` | lifecycle abandoned, or an explicit cancellation | none additional | no | no |

All four are terminal and carry a non-NULL terminal marker (`terminal_reason` or
an equivalent marker), so `CLM-2`'s exclusion applies; the marker vocabulary is
`[U]`. `superseded` requires that a stale Worker holding the old claim cannot
publish: its token is invalid and the publication guard rejects it. The published
derived content of the newer version stays.

Retirement happens wherever the job is met: a lower-version job is terminalized as
`superseded` at Claim, at the startup recovery check and at publication, not only
when its Worker attempts to publish; it is never reopened and never charged another
attempt (`CLM-19`). A job whose version equals `published_version` has already
published and is `succeeded`; it is never rewritten as `superseded`.

Precedence follows commit order: for a still-nonterminal job, retirement beats
exhaustion, so an exhausted but stale job becomes `superseded` with no alert,
while a `failed_terminal` committed before the newer publication keeps its outcome
and its alert. A stale Worker's failure or exhaustion report is refused by the
same guard (`CLM-19`).

`[U]` State names, storage, the terminal-marker vocabulary, and how the Recovery,
Retention and Worker paths converge (`SPEC-GAP-05`, `SPEC-GAP-08`, `SPEC-GAP-15`).

### A.8 Expired-unprocessed job `[T]`

When the original content reaches 168 hours while a job still has attempts left,
the job ends as **expired-unprocessed** with a `terminal_reason`, is excluded from
automatic Claim, consumes no further attempt, and raises **no** alert, because no
failure occurred. Exhausted jobs take the `CLM-8`/`CLM-13` path instead: failed,
non-NULL `terminal_reason`, attempts and error preserved, alert persisted, then
the article is deleted (`CLM-15`). `[U]` State name, storage, and the ordering
that makes the three paths agree (`SPEC-GAP-08`, `SPEC-GAP-10`, `SPEC-GAP-15`).

### A.9 Lifecycle closure and retention boundaries `[T]`

| Data | Retention | Removed by |
| --- | --- | --- |
| Original article content, media, identifying and timestamp records | 168 hours `[P]` | article deletion (`docs/architecture.md`) |
| Derived publication | 720 hours from its generation `[P]` | derived retention |
| Correction event + AI evidence summary | 720 hours `[P]` | correction retention |
| Outbox event and payload | independent `[P]`; duration `[U]` | `OUT-14`/`OUT-16` conditions (`OUT-25`), after any manual-intervention condition is complete |

**Normative source for the original-content row: `docs/architecture.md`.** The table
summarises; it does not create a second authority over original-content retention.

Closing a lifecycle (`closed_at`) and deleting the article row happen in one
transaction, after terminalization and alert persistence. Removing the lifecycle
row must not remove derived, correction or Outbox rows; those follow their own
periods. Article deletion is never blocked by a pending Outbox event.

Closing a lifecycle does not authorise keeping identifying records beyond the
168-hour scope, and a lifecycle row is not a licence to retain one: no long-lived
lifecycle identity record is created (`OUT-18`). Abandonment neither pauses nor
extends the 168-hour period. The exact point at which closed lifecycle rows and
their jobs are removed, and the transaction arrangement around it, remain `[U]`
(`SPEC-GAP-15`). Every payload is self-contained, so delivery never depends on
these rows (`OUT-26`).

### A.10 Foreign-key and soft-reference constraints `[T]`

`processing_lifecycle.article_id`, `processing_job.article_id`, derived,
correction and Outbox references are **soft** (plain values, no foreign key to
`articles`). `[E]` `PRAGMA foreign_keys = ON` (`sqlite.ts:337`) and three
cascading relationships already exist (`migrations.ts:96`, `:176`, `:244`), so an
accidental key would really cascade. `[U]` Final column types and index set
(`SPEC-GAP-15`).

### A.11 Minimum payload information `[T]`

This is the minimum information a human needs in order to inspect an event and
act on it. It is not a decided schema: `OUT-11` stays `OPEN` and `OUT-26` fixes
only completeness.

| Class | Information |
| --- | --- |
| Required | `schema_version`; `lifecycle_id`; canonical source URL; event type; Processing version; terminal reason; failure category (alert events); attempts consumed and maximum attempts; the timestamp of the failure or of the event |
| Required when it exists | Traditional Chinese headline, where one has already been generated |
| Optional diagnostic | article id as a soft reference; bounded provider-level error summary (never article text); worker identity; lease expiry timestamp; intervention state |
| Prohibited | any verbatim original text or excerpt; a full prompt or model response; a source page body |

Whether every required field is populated for every event type, and the exact
names, types and size limits, are `[U]` (`OUT-11`, `SPEC-GAP-10`, `SPEC-GAP-18`).
A payload that cannot name the lifecycle, the source URL and the failure it
reports is not sufficient for intervention. An event that entered manual
intervention should also expose its delivery outcome and its intervention outcome;
whether those live in the payload or only in the event row is `[U]`.

### A.12 Manual intervention for a dead notification `[T]`

Two result dimensions are recorded separately and never merged:

| Dimension | Values | Meaning |
| --- | --- | --- |
| Delivery outcome | pending, `sent`, `dead` | whether the provider accepted the message (`OUT-3`, `OUT-8`) |
| Intervention outcome | none, retry, hold, abandoned | what the operator decided or did (`OUT-25`) |

`abandoned` completes the intervention without any delivery, and never sets the
delivery outcome to `sent`. A `hold` changes no delivery outcome. A `retry`
returns the event to delivery attempts without resetting or extending the
automatic budget: the retry draws on the same `OUT-6`..`OUT-8` rules and grants no
unlimited fresh retries. `[U]` How a manual retry is counted, what state it takes
when it fails again, its termination condition, the supervision model, and whether
the two outcomes are stored in the payload or in the event row (`SPEC-GAP-18`).
Cleanup follows `OUT-25` and `OUT-16`. An alert keeps its own completion condition
(`CLM-16`, `CLM-17`) and is not governed by this section.

**Scope.** Abandonment here is an Outbox-level intervention on a single event. It
is not Article Lifecycle abandonment (`CLM-18`) and does not stop processing;
conversely, abandoning a lifecycle does not abandon any notification, and events
already persisted may still be delivered (`CLM-18`, `OUT-25`).

### A.13 What this appendix does not decide `[U]`

Retention durations for the Outbox; the operator interface; the concrete
cancellation mechanism; the fact taxonomy and normalisation; the transaction
helper implementation; the payload field list and schema; the representation,
expiry and escalation of manual intervention; how a manual retry is accounted for
against `OUT-6`..`OUT-8` and what state follows a further failure; when closed
lifecycle rows and their jobs are removed; partial-index and runtime verification;
and every schema name. None of these is authorized for implementation by this document.
