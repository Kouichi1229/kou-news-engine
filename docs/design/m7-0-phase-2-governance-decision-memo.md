# M7.0 Phase 2 — S0b: Governance Decision Memo for Closing OPEN Specification Items

| Field | Value |
| --- | --- |
| Document | S0b — Governance Decision Memo (M-4) |
| Status | **`PROPOSED — OWNER REVIEW REQUIRED`** |
| Finding | **M-4 — OPEN. This memo does not resolve it.** |
| Phase | Phase 2 — planning |
| Nature | Governance proposal. **No implementation is authorized by this document. No OPEN identifier is closed by it.** |
| Parent specification | `docs/design/m7-0-ai-news-processing-pipeline.md` (M7.0), SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`, HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| Date | 2026-11-26 |
| Related documents | S1 — `m7-0-phase-2-processing-state-data-model.md`; S0a — `m7-0-phase-2-l01-terminal-reason-decision-memo.md` |

**Label legend.** `[OD]` confirmed Owner decision · `[DR]` documented requirement · `[IF]` current implementation fact · `[TO]` technical observation · `[RC]` recommendation (non-binding) · `[ODR]` Owner decision required.

---

## 1. Purpose

Phase 2 design work inevitably decides technical details — a column set, an index, a transaction boundary. Those details are held open today by identifiers such as `SPEC-GAP-15`. The M7.0 document forbids closing an `OPEN` item without a recorded Owner decision (§1.6, L215). Taken literally, that means every column requires an Owner decision; taken loosely, design silently closes gaps and the register loses its meaning.

This memo sets out how to avoid both outcomes. It proposes a governance model and stops there. **M-4 is not resolved by this document.** `[TO]`

## 2. Current documentation governance

`[DR]` M7.0 is a *reconstruction*, not a recovered original (§0, L27–46). Its governance is spread across four places:

| Mechanism | Location | What it says |
| --- | --- | --- |
| Requirement status vocabulary | §1.5 (L158) | `CONFIRMED` / `OPEN` / `SPEC-GAP` are distinct states |
| Owner decision authority | §1.4 (L141) | only the Owner creates or changes confirmed decisions |
| No silent promotion | §1.6 (L215) | an `OPEN` item is never promoted without a recorded Owner decision |
| Change procedure | §0 (L46+) | new `CONFIRMED` decisions get an identifier and a date; an `OPEN` item may not be removed without a recorded Owner decision; Phase 2 chapter drafting requires separate authorization; factual corrections are appended, not silently rewritten |

`[TO]` The procedure already contains the seeds of a solution: it distinguishes *recording a decision* from *removing an `OPEN` entry*, and it treats "Phase 2" as requiring its own authorization. What it does not define is how a **technical** decision becomes an Owner decision.

## 3. Existing rules for Owner decisions

`[DR]` Consolidated from §0, §1.4, §1.6 and §7:

1. A new confirmed decision is added to §3 with a new identifier and a date. (§0)
2. The corresponding `OPEN` entry is removed from §4 only if one exists. (§0)
3. An `OPEN` item may not be removed without a recorded Owner decision. (§0, §1.6)
4. Phase 2 drafting requires separate authorization. (§0)
5. Corrections to factual claims are retained with a note rather than silently rewritten. (§0)
6. Every revision is recorded in §7 with date, change, authority and notes. (practice)

`[TO]` Rule 3 is the crux. It does not say the Owner must personally design the schema; it says removal must be *recorded* as the Owner's decision. A batched approval can satisfy it — if the batch is enumerated precisely enough that no item is closed implicitly.

## 4. Current OPEN specification inventory relevant to Phase 2

`[IF]` At baseline: 80 `CONFIRMED`, 11 Owner `OPEN`, 91 §3 entries, 18 `SPEC-GAP`, 29 unresolved in total (§4.2 accounting, L805).

| Identifier | Subject | Phase 2 relevance | Blocks |
| --- | --- | --- | --- |
| `SPEC-GAP-05` (L782) | processing version creation rules | how a new version is opened | S1, A-U1 |
| `SPEC-GAP-07` (L784) | outbox column enumeration, `aggregate_id` type | publication inserts | A-U4, C |
| `SPEC-GAP-15` (L792) | processing state storage: columns, types, indexes, removal | the whole data model | S1 |
| `SPEC-GAP-08` (L785) | transaction mechanism, lease duration, ordering | transaction design | A-U2..U6 |
| `SPEC-GAP-17` (L794) | correction-event record | correction writes | A-U4 |
| `SPEC-GAP-01` (L778) | observation timestamp storage | `expired-unprocessed`, retention clock | R-11 |
| `SPEC-GAP-04` (L781) | derived-content schema | publication storage | A-U4 |
| `SPEC-GAP-18` (L795) | manual retry accounting and intervention representation | operator surface | C |
| `OUT-11`–`OUT-16` (§4.1, L753–758) | payload, cadence, `GAP-1`, retention duration, cleanup placement, deletion mechanism | outbox implementation | C |
| `CLS-2`, `CLS-10`, `CLS-12`, `SUM-2`, `SUM-7` (§4.1, L748–752) | classification and summary policy | outside the processing pipeline | — |

`[TO]` Eight of the eighteen gaps carry a confirmed policy direction (§4.2, L769–773); the remainder have no Owner decision at all. A governance model must handle both kinds.

## 5. The problem M-4 intends to resolve

`[TO]` Four failure modes are possible today:

1. **Stall.** Every column-level decision is escalated, so design never converges and Phase 2 planning becomes an Owner bottleneck.
2. **Silent closure.** Design decides a detail and quietly treats the gap as gone. The register then understates what is undecided, and a later reader cannot tell a decided question from a forgotten one.
3. **Closure by implementation.** Code lands first and the gap is closed afterwards "because it now exists". This inverts the rule that a decision precedes the change.
4. **Closure conflated with authorization.** An identifier is closed, and implementation is assumed to be permitted. Nothing in the current text licenses that inference, but nothing prevents the confusion either.

`[ODR]` M-4 must choose a mechanism that makes 2 and 3 impossible while removing 1, and that keeps 4 explicit.

## 6. Candidate governance models

| Model | Mechanism | Strength | Cost |
| --- | --- | --- | --- |
| **G-1** | each `OPEN` identifier requires its own explicit Owner decision, one at a time | maximum fidelity; nothing closes implicitly | slowest; scales badly across ~18 identifiers and dozens of fields |
| **G-2** | Owner approves a **design package**; the approval record enumerates the identifiers it closes | batched; still explicit; one review pass per package | requires the package to be precisely enumerated; a vague package reintroduces silent closure |
| **G-3** | two independent gates: **design approval** (may close identifiers) and **implementation authorization** (separate, later, explicit) | cleanly separates "we know what to build" from "go build it" | adds a state to track; requires status fields that do not exist yet |
| G-4 (variant) | partial closure: a gap may be split into closed and still-open sub-parts | matches reality — `SPEC-GAP-15` contains several separable questions | needs sub-identifier convention; risks identifier sprawl |

`[TO]` G-2 and G-3 are compatible and are usually combined. G-4 is orthogonal: it can be adopted under any of the three.

`[TO]` None of these models changes an existing rule; each is a *procedure for producing* the recorded Owner decision that §1.6 already requires.

### 6.1 Partial closure — the unresolved convention

`[TO]` G-4 raises a question no current rule answers: when a gap holds several separable questions and only some are decided, what should the register say?

| Option | Representation | Identifier counting | OPEN / closed reporting | Traceability | Audit history |
| --- | --- | --- | --- | --- | --- |
| PC-1 | parent stays `OPEN`; child identifiers carry the decided parts | counts do not move | "OPEN" stays literally true; progress is visible only in the children | each child maps to a decision record; the parent maps to the residual question | the parent shows no closure — accurate, but reads as no progress |
| PC-2 | parent becomes `PARTIALLY RESOLVED` with an explicit residual scope | adds a third state, so every count must say whether it includes partials | three states must be reported wherever two are printed today | the residual scope must be written down, or the partial state hides an undecided question | the transition is visible and the residual stays in the same entry |

`[TO]` Each option has a failure mode. PC-1 can make a mostly-decided gap look untouched. PC-2 can make a half-decided gap look finished, which is exactly the silent-closure risk G-R5 names.

`[TO]` One constraint is not a convention choice: a parent identifier **may not** be marked closed while residual requirements remain. Closing means "the question this identifier holds is answered", and a residual question is unanswered by definition.

`[ODR]` **Not chosen.** The convention is an Owner decision (Q-M4-9). This document adopts neither PC-1 nor PC-2 and introduces no `PARTIALLY RESOLVED` state into M7.0.

## 7. Decision lifecycle

`[RC]` Six states, in this order, each with a distinct owner and a distinct record:

| # | State | Meaning | Who moves it | Evidence required |
| --- | --- | --- | --- | --- |
| 1 | **Design proposal drafted** | a candidate design exists | author | the document, status `PROPOSED — OWNER REVIEW REQUIRED` |
| 2 | **Design reviewed** | findings recorded, open questions listed | reviewer | review notes; unresolved items enumerated |
| 3 | **Design approved by Owner** | the Owner accepts the design as the intended direction | Owner | approval record with date and scope |
| 4 | **Specification identifier closed** | the named `OPEN`/`SPEC-GAP` entries are marked closed in M7.0 | Owner (per G-1/G-2) | explicit enumeration of closed identifiers |
| 5 | **Implementation authorized** | work may begin | Owner | separate authorization record |
| 6 | **Implementation completed and verified** | code exists and evidence is recorded | implementer, accepted by Owner | tests/evidence bundle; `PROJECT_STATUS` update |

`[TO]` The mandatory distinction the assessment asked for is exactly the separation of 3, 4 and 5. Today the documents only express 1 and 6.

**No transition may be skipped.** In particular, 4 does not follow from 3 unless the approval record names the identifiers, and 5 never follows from 4.

### 7.1 Approval and closure in one record, or two

`[TO]` States 3 and 4 are distinct, but they need not be separate documents. The difference matters:

| Reading | What it means | Risk |
| --- | --- | --- |
| Two records | design approval is one Owner action; identifier closure is a later, separate action | accurate but slow, and invites the assumption that approval alone closed the gap |
| One record, two explicit statements | a single Owner decision record states the approval *and* enumerates the identifiers it closes | efficient, but only if the enumeration is mandatory — otherwise approval becomes blanket closure |

`[RC]` The second reading is permissible and is the one this memo would use, under four constraints:

1. A single Owner decision record **may** document both the design approval and the closure of specifically enumerated identifiers.
2. Design approval **must not** implicitly close every identifier the design touches. Only identifiers explicitly enumerated as closed may transition to closed.
3. Implementation authorization remains a separate gate and is never inferred from design approval or from specification closure.
4. Verification remains a later, separate gate.
5. Identifier closure remains a **distinct status transition** even when it is recorded in the same decision record; the record must state the approval and the closure as two separate facts, not one.

`[TO]` Constraint 2 is the whole point. Without it, "approve the design" and "close everything it mentions" become the same act, and §8's separation of *affected* from *closed* loses its meaning.

`[TO]` No stage may be inferred from an earlier one: approval is not closure, closure is not authorization, and authorization is not verification. Each transition needs its own recorded statement, even when several share one document.

`[ODR]` Whether one record may carry both statements is Q-M4-8. The four constraints are a recommendation, not an approved rule.

## 8. Traceability requirements

`[RC]` Every decision record must carry:

1. A decision ID and date.
2. The exact question answered, in the Owner's terms.
3. The chosen option, and the rejected options with reasons.
4. The **identifiers affected** and, separately, the **identifiers closed by this approval**.
5. The M7.0 sections that must change as a consequence.
6. The consequences accepted (including metrics or audit effects).
7. An explicit statement of whether implementation is authorized (normally: no).

`[TO]` Separating "affected" from "closed" is the single most important control: it prevents a design that merely *touches* a gap from closing it.

## 9. Change-history requirements

`[DR]` Existing practice: every revision adds a §7 row with date, change, authority and notes, and factual corrections are appended rather than rewritten (§0).

`[RC]` Additions for Phase 2:

- One §7 row per approved decision, naming the decision ID.
- §7 rows are append-only; a superseded decision gets a new row that references the old one.
- A decision that closes identifiers must say so in the §7 row, not only in the decision record.

## 10. Version and status synchronization

`[TO]` The Phase 1.15/1.17 episodes showed the concrete failure: M7.0 §0, §7 and `PROJECT_STATUS.md` drifted apart until a separate task reconciled them (findings T-01, T-02). Any governance model should make that drift impossible.

`[RC]` A decision that changes status must update, in one change: M7.0 §3 (if a decision is added), §4 (if an `OPEN` entry is removed), §7 (history row), §0 `Phase` row, and the `PROJECT_STATUS.md` header. The rule is "one status change, one change set".

## 11. Auditability and historical decision preservation

`[RC]` Principles:

1. Decision records are immutable once approved; corrections are new records.
2. Rejected options remain visible — a future reader must be able to see what was considered.
3. A closed identifier keeps its history: the closure record names the decision that closed it.
4. Design documents keep their `PROPOSED` status in the record even after approval, so the sequence remains reconstructable.

`[TO]` This mirrors the practice already used for `RET-1`/`RET-2`, whose superseded wording is retained with a note rather than deleted (§3.1, L341+).

## 12. Risks of premature closure

| Risk | Description | Consequence | Control |
| --- | --- | --- | --- |
| G-R1 | closing an identifier whose question was never actually answered | register says "decided" while design is still guessing | require the record to restate the question and the answer |
| G-R2 | closure by schedule pressure | gaps close at a deadline | closure requires an explicit enumeration; no batch closure "because time" |
| G-R3 | closure by narrowing scope | the question is redefined to something easier | the original question text must be quoted verbatim in the record |
| G-R4 | closure read as implementation permission | work starts because "the gap is closed" | G-3's separate gate, stated in every record |
| G-R5 | silent partial closure | half a gap is decided and the whole is marked closed | G-4 sub-identifiers or explicit "partially decided" status |
| G-R6 | approval fatigue leading to blanket approvals | one approval closes everything | cap each package to enumerated identifiers; require per-identifier acknowledgement |

## 13. Recommendation, clearly labelled as non-binding

`[RC]` **Non-binding.** Adopt **G-2 + G-3**, with G-4 available for gaps that genuinely contain separable questions:

- Owner approves a design package that **enumerates** the identifiers it closes (G-2).
- Approval closes identifiers; it never authorizes implementation (G-3).
- `SPEC-GAP-15` and `SPEC-GAP-08` are natural candidates for G-4 sub-identifiers, because each bundles several separable questions.
- Every approval record states implementation authorization explicitly, defaulting to **not granted**.

`[RC]` Under this model the first Phase 2 package would close nothing until the S1 design is reviewed, which is the correct sequence: proposal → review → approval → closure → authorization.

`[RC]` Approval and closure may share one decision record (§7.1), provided the closed identifiers are enumerated. Implementation authorization stays separate either way.

**This memo does not adopt any model. M-4 remains OPEN.**

## 14. Exact Owner approval questions

1. **Q-M4-1.** Which model applies — G-1, G-2, G-3, or G-2+G-3 (recommended), and is G-4 (partial/sub-identifier closure) permitted?
2. **Q-M4-2.** Who may *review* a design package (the Owner only, or a named reviewer acting for the Owner), and who may *approve* it?
3. **Q-M4-3.** Must an approved design be implementation-ready before identifiers close, or is "the question is answered" sufficient?
4. **Q-M4-4.** Where are decision records stored — a new file per decision, a register inside M7.0, or the existing §7 history? (Creating a new file requires its own authorization.)
5. **Q-M4-5.** Is partial closure allowed, and if so what identifier convention applies (e.g. `SPEC-GAP-15a`)?
6. **Q-M4-6.** What is the mechanism for reopening an identifier whose approved design later proves wrong?
7. **Q-M4-7.** Does closing an identifier ever imply implementation authorization? (Recommendation: never, explicitly.)
8. **Q-M4-8.** May a single Owner decision record document both design approval and the closure of enumerated identifiers, or must the two always be separate records?
9. **Q-M4-9.** For partial closure, which convention applies — PC-1 (parent stays `OPEN`, child identifiers) or PC-2 (parent becomes `PARTIALLY RESOLVED` with explicit residual scope) — and if PC-2, how are the counts and reports restated?

## 15. Proposed governance decision-record template

Not pre-filled; to be used only if a model is approved.

| Field | Value |
| --- | --- |
| Decision ID | *(to be assigned)* |
| Date | *(to be set)* |
| Package / document | *(e.g. S1 data model)* |
| Question(s) answered | *(verbatim)* |
| Chosen option | *(to be set)* |
| Options rejected and why | *(to be set)* |
| Design approved (state 3) | *(yes / no — distinct from closure)* |
| Identifiers **affected** | *(list)* |
| Identifiers **closed by this approval** | *(explicit list, or "none")* |
| Identifiers **partially closed** | *(list with the remaining question; convention undecided — §6.1)* |
| M7.0 sections to update | §3 / §4 / §7 / §0 |
| `PROJECT_STATUS.md` update required | yes / no |
| Consequences accepted | *(to be set)* |
| Implementation authorized | **No** (default) / yes, with a separate authorization ID |
| Verification completed (state 6) | *(to be set — later gate)* |
| Owner approval | *(name, date)* |

**No implementation is authorized by this document. No identifier is closed by it. M-4 remains OPEN.**
