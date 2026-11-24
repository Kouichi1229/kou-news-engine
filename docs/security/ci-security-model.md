# CI Security Model

Status: **M5.0 — specification only.** No part of this document is implemented by
itself. The M5.1 workflow is a separate deliverable; the hardening directions in
Section 6 are **unimplemented and unauthorized**.

Audience: the repository Owner, anyone reviewing a pull request, and anyone
planning the next security milestone.

---

## 1. Scope, and what this document is not

This document defines the security model for **continuous integration** in this
repository. It answers one question: _what may a pull request from an untrusted
person do to this repository and its infrastructure?_

It is deliberately narrow.

- It is **not** a claim of process-level network isolation. No such isolation
  exists here, and none is claimed. See Section 5.
- It is **not** a replacement for the LLM-layer normative specification in
  `docs/design/i7-1b-llm-provider.md`. Where the two touch, that document is
  authoritative and this one defers to it.
- It is **not** an assertion that CI evidence is independent of the pull
  request. Code-level evidence runs inside code the pull request controls. See
  Section 4.

The project is a **personal, small-scale collaborative** effort. The security
model is proportionate to that, and it says so plainly rather than borrowing
enterprise assumptions it does not implement.

---

## 2. Contributor trust boundaries

There are three distinct populations. Conflating them is the most common
mistake this document exists to prevent.

### Class A — External fork contributors (UNTRUSTED)

Anyone who opens a pull request from a fork. Assumed hostile until reviewed.

| Property        | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Trust           | **Untrusted**                                                            |
| Event           | `pull_request`                                                           |
| Secrets         | None. Repository, organization and environment secrets are not provided. |
| `GITHUB_TOKEN`  | Read-only. `contents: read` is the ceiling.                              |
| OIDC            | Not permitted. No `id-token: write`.                                     |
| Runner          | GitHub-hosted `ubuntu-24.04` (VM-backed)                                 |
| Self-hosted     | Prohibited                                                               |
| Manual approval | Required for **first-time external fork contributors** before their workflows run (D2 Option B). Not required for same-repository pull requests. |

### Class B — Repository write collaborators (TRUSTED)

People with write access to this repository.

This class is **not** equivalent to Class A, and the difference is not a
formality:

- Write access permits **modifying workflow files**.
- Write access **may affect workflow permissions**, because the token begins at
  the repository default and the fork-specific downgrade does not apply.
- A compromised write collaborator is indistinguishable from a legitimate one.

No technical control in this document mitigates a compromised administrator.
That is residual risk **R8** (Section 4), accepted by the Owner.

### Class C — API consumers (NO REPOSITORY ACCESS)

Friends of the project who consume processed news through the HTTP API.

They receive **no repository access of any kind**: not read, not write, not
triage. Their relationship to this repository is "consumer of a service", not
"collaborator". API authentication is **not implemented** and is **not
authorized** by M5.0 or M5.1.

---

## 3. Current CI security controls

### 3.1 Platform-enforced controls

These are provided by GitHub and cannot be weakened by repository code:

| Control                  | Behaviour                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Fork PR secret exclusion | Secrets are not passed to the runner for fork-triggered workflows                                           |
| Fork PR token downgrade  | Write permissions are reduced to read-only for fork PRs                                                     |
| Runner ephemerality      | Each GitHub-hosted job gets a fresh VM                                                                      |
| PR cache scoping         | A `pull_request` run's cache is scoped to the merge ref and cannot be written to the default branch's scope |

**Critical caveat:** the token downgrade and secret exclusion are
platform behaviours that depend on **correct repository settings**. Repository
code cannot prove them. See Section 7.

### 3.2 Workflow-declared controls

Declared in `.github/workflows/ci.yml` and verified by
`tests/unit/ci/workflow-policy.test.ts`:

| Control     | Declaration                                                           |
| ----------- | --------------------------------------------------------------------- |
| Runner      | `runs-on: ubuntu-24.04`                                               |
| Permissions | `permissions: contents: read` only                                    |
| OIDC        | No `id-token` permission anywhere                                     |
| Secrets     | No `secrets.*` reference anywhere                                     |
| Caching     | `package-manager-cache: false`, no `cache:` input, no `actions/cache` |
| Actions     | Official GitHub Actions only, pinned to full commit SHAs              |
| Artifacts   | No artifact upload/download between jobs                              |

### 3.3 Code-level controls

The Fake-transport path is enforced in source, not merely in CI configuration:

- `src/config/env.ts` defaults `LLM_PROVIDER` to `fake`.
- `src/core/llm/provider.factory.ts` returns a `FakeProvider` **before** the
  transport seam is reached, and throws on an unknown provider rather than
  falling back.
- `tests/unit/core/llm/no-real-transport.test.ts` asserts the seam is never
  invoked on the Fake path.
- `tests/helpers/architecture-scan.ts` provides a static egress scan of the
  adapter closure.

---

## 4. Assertions 4-A and 4-B

The original **Assertion 4** required that _no external socket is opened_ during
T-10a. That requirement remains **BLOCKED** and is not satisfied by anything
below. See Section 5.

M5 introduces two narrower assertions with different evidence standards.

### Assertion 4-A — Credential and test-transport isolation

**Guarantees:**

1. Fork PR test execution receives **no valid Gemini API credential** and no
   valid internal service credential.
2. The **Fake/Mock Gemini transport is explicitly selected**.
3. Fake transport injection is **verified** by test.
4. There is **no silent fallback** to the real Gemini transport.
5. The Fork PR test path **does not construct** the real Gemini transport.

**Explicitly NOT established by 4-A:**

- That no external HTTP request occurs.
- That no outbound network access occurs.
- That no external data disclosure occurs.
- That an unauthenticated network request is impossible.

Credential absence and transport non-construction are **different properties**
from network isolation. A process with no credential can still open a socket.
4-A must never be cited as network-isolation evidence.

### Assertion 4-B — CI execution and permission boundary

**Scope of the workload.** 4-B covers two distinct workloads that share one
workflow, exactly as §9.5.3.7 of the design records. It must not be read as a
fork-only statement:

| Workload | Trigger | Contributor class | Trust |
| --- | --- | --- | --- |
| **Untrusted PR validation** | `pull_request` | Class A — external fork contributors | **Untrusted** |
| **Trusted main validation** | `push` to `main` | Class B — repository write collaborators | **Trusted** |

Both workloads use the same documented runner configuration: GitHub-hosted
`ubuntu-24.04`, never `ubuntu-latest`, `ubuntu-slim`, self-hosted or persistent.
The trusted `push` workload does **not** carry the same trust classification as
an external Fork PR — it runs a post-merge commit authored by a write
collaborator — so a guarantee stated for Class A must not be read as a
concession to Class B, nor vice versa.

**Guarantees (untrusted `pull_request` workload):**

1. GitHub-hosted `ubuntu-24.04`; no self-hosted or persistent runner.
2. Read-only `GITHUB_TOKEN`.
3. No `contents: write`, `pull-requests: write`, or `id-token: write`.
4. No fork PR write-token exception enabled.
5. No secrets or valid internal credentials injected into fork PR jobs.
6. External network access **is accepted** — this is a stated property, not a
   defect to be argued away.
7. Workflows from **first-time external fork contributors** require manual
   approval before they run (D2 Option B). The gate covers first-time external
   contributors only; it is not a blanket requirement on all external
   contributors and does not apply to same-repository pull requests. Approval
   authorizes workflow execution only, not acceptance or merge.

**This is not N-1 or N-2 network isolation.** It is a privilege and credential
boundary, not a network boundary. Neither workload establishes N-1 or N-2: a
post-merge run is not evidence of egress denial either.

### 4.1 The evidence boundary

Two kinds of evidence exist, and they are **not interchangeable**:

| Evidence kind     | Source                                         | Independent of the PR author?                                                                         |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Code-level        | Tests, scans, transport assertions             | **No** — runs inside PR-controlled code                                                               |
| Platform/settings | Runner labels, event type, repository settings | **Partially** — metadata is platform-side; effective token permissions are not observable via any API |

**A malicious PR author can modify** the tests, the static scanners, the
transport-injection code, the workflow declarations, and the fixtures — all in
the same pull request. Therefore:

- 4-A's tests are **self-reported**, not tamper-resistant.
- A workflow declaration on the base branch is **not proof** of the workflow
  that actually executed for a given PR.
- No external verifier exists in this project. This is recorded as a
  **limitation**, not a risk to be mitigated later.

The only genuine independent control is **human review before merge**, and even
that does not protect a PR execution that has already occurred. Human review is
**independent only when the reviewer is not the PR author**. For an
**Owner-authored PR** the Owner is both author and reviewer, so that review is
**self-review, not independent review** (Section 6.3). Self-review improves
**traceability** — it records what was examined — but it does **not restore
reviewer separation**, and no amount of local evidence or CI output substitutes
for that separation.

---

## 5. Historical M4.6 status: why M5 does not resolve it

M5 is a **scope revision**, not a **finding revision**. The following remain
exactly as they were:

| Item                                                           | Status              | Meaning                                      |
| -------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| **Assertion 4** (original: no external socket opened)          | **BLOCKED**         | Not satisfied, not superseded, not retracted |
| **B-6** (N-1 available, or N-2 with a complete coverage table) | **BLOCKED**         | Neither N-1 nor complete N-2 exists          |
| **O-3** (whether N-1 egress denial is available)               | **BLOCKED**         | Unresolved                                   |
| **T-10a**                                                      | **BLOCKED**         | Cannot pass while Assertion 4 is blocked     |
| **N-1** evidence                                               | **Not established** | Never demonstrated in this environment       |
| **N-2** evidence                                               | **Not established** | No complete coverage table                   |

**Why M5 does not resolve them:** M5 lowers the _objective_ for ordinary PR CI.
It does not produce the _evidence_ the original objective demanded. Those are
independent things. A revised requirement that no longer asks for process-level
egress denial does not make egress denial exist.

B-6 is retained in the design specification as a **historical-only**
requirement. It remains the correct gate for any future work that genuinely
needs process-level network isolation — for example, a real-API integration
path.

**No historical BLOCKED result is converted to PASS anywhere in this
repository.**

---

## 6. Accepted residual risks R1–R8

All are **accepted by the Owner** for the current personal/small collaborative
project stage. Acceptance is scoped to that stage; the reassessment triggers in
Section 9 exist precisely because the acceptance does not automatically carry
forward.

| ID     | Risk                                                | Consequence if realized                                                       | Mitigation in place                                              | Residual after mitigation                                                      |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **R1** | Cache/artifact disclosure to fork PRs               | Base-branch cache contents readable by PR code                                | No cache restore or save in PR jobs                              | Minimal while caching stays off; returns if caching is re-enabled              |
| **R2** | Dependency lifecycle scripts execute arbitrary code | Arbitrary code on the runner, no secrets present                              | Lockfile + `npm ci`; disposable runner; no credentials           | Accepted — code execution in a credential-free, disposable runner              |
| **R3** | PR may modify its own tests and workflow            | False-green CI; weakened assertions                                           | **Owner self-review before merge plus required CI.** Two cases differ: **Case A (external contributor PR)** — the Owner is a different person from the author and *can* review independently, but Code Owner approval is **not enabled** under single-maintainer governance, so independent review is an **operating procedure, not a configured guarantee**. **Case B (Owner-authored PR)** — the Owner is author and reviewer; the review is **self-review, not independent review**                                              | **Not independently verified.** Self-review and CI do **not** eliminate false-green CI when the same Owner modifies both workflow logic and the tests that validate it. Merge integrity is **not** guaranteed by an independent party                                                                 |
| **R4** | Fake transport not provably exclusive               | Unintended real call **only if** a credential were present, which 4-A forbids | 4-A assertions; no credential in job                             | Low, but not network isolation                                                 |
| **R5** | Outbound network not blocked in PR CI               | Data exfiltration from the runner; runner egress abuse                        | No secrets; no self-hosted runners; no persistent infrastructure | **Accepted** — the core accepted risk of M5                                    |
| **R6** | Shared-VM co-tenancy                                | Cross-tenant influence outside project control                                | `ubuntu-24.04` only; never `ubuntu-slim`, never self-hosted      | Reduced to GitHub's own boundary — accepted                                    |
| **R7** | CI resource exhaustion within plan limits           | Queue and cost impact                                                         | Concurrency limits (implemented); path filters (not implemented — a possible future control) | Accepted                                                                       |
| **R8** | Compromised write collaborator or administrator     | Full repository compromise, including workflow and protection edits           | 2FA, least privilege, admin restrictions, audit logging          | **Cannot be guaranteed.** Reduced likelihood, improved detection, no guarantee |

### 6.1 Why R1 is disclosure, not poisoning

These are different properties and were previously conflated:

- A fork PR **can read** base-branch caches. That is **disclosure**.
- A fork PR **cannot write** to the default branch's cache scope. Under
  `pull_request`, the platform prevents it: the cache is scoped to
  `refs/pull/.../merge` and cannot be restored by the base branch or by other
  pull requests.

Therefore "a fork PR can read base caches" is **not** evidence that a fork PR
can poison them. The policy response is to cache nothing sensitive and to
disable caching in PR jobs — not to treat the cache as compromised by default.

### 6.2 Why R2 is not eliminated by the lockfile

`package-lock.json` and `npm ci` improve **reproducibility**. They fix _which_
code runs. They do not establish that the code is **benign**.

Concretely, in this repository:

- `ignore-scripts` defaults to `false`, so `npm ci` runs install scripts.
- The lockfile records packages declaring install scripts. `esbuild` has no
  `os` restriction and declares a `postinstall`, so it is expected to execute
  on Linux. `fsevents` declares `os: ["darwin"]` and is optional, so it is not
  installed on Ubuntu.

The risk is therefore real but narrower than "every declaring package runs
here". The exposure class is unchanged: third-party code executes on the
runner, without credentials, with network egress.

### 6.3 Why R3 is not restored by self-review

R3 is that a pull request may modify **its own tests and workflow**, producing
false-green CI. The original mitigation was Code Owner review before merge.
Under single-maintainer governance that mitigation changes character, and the
two cases must not be conflated.

**Case A — external contributor PR.** The Owner is a different person from the
author and *can* review independently. But Code Owner approval is **not enabled**
while the project has one maintainer, so independent review is available as an
**operating procedure only**. It is **not** guaranteed by the configured merge
controls, and this document does not claim that every external PR necessarily
receives independent review.

**Case B — Owner-authored PR.** The Owner is both author and reviewer. The Owner
can perform self-review and observe CI, but that is **not independent review**.
The same Owner can modify both the workflow logic and the tests intended to
validate it, so a deliberately weakened test alongside a weakened workflow can
produce **false-green CI without independent detection**.

Self-review and CI therefore **do not eliminate** this possibility. What they
provide is a recorded, auditable statement of what was and was not checked —
not an independent check.

**Repository-local evidence is not a substitute for independence.** Tests,
allowlists, recorded hashes and retained CI logs may improve **traceability or
detection**. They do **not restore reviewer independence**, and must not be
described as if they did. Independence is a property of *who reviews*, not of
how much evidence is retained.

The risk remains **acknowledged and accepted at its existing rating**; only the
mitigation and residual descriptions above have been corrected.

---

## 7. Manual GitHub settings checklist

These controls **cannot** be established by repository files. They are
configuration, and they are recorded here so that an auditor can verify them
against the live repository rather than trusting a workflow declaration.

| #   | Setting                                             | Required value                        | Why                                                                   |
| --- | --------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| S1  | Actions → Workflow permissions                      | **Read repository contents**          | Workflow `permissions:` can only reduce; it cannot prove the default  |
| S2  | "Send write tokens to workflows from pull requests" | **Unchecked**                         | This is the documented escape hatch that re-enables fork write tokens |
| S3  | Branch protection / ruleset on `main`               | Require PR; **required approving reviews = 0**; require status check **`verify`**; **Code Owner approval OFF** while single-maintainer governance applies | CODEOWNERS alone enforces nothing; with one maintainer a mandatory approval cannot be satisfied |
| S4  | Administrator restrictions                          | Per Owner policy (D8): **no routine administrator bypass**; **empty bypass list** is the intended configuration | A personal-repository Owner can edit or delete rulesets. This remains a **behavioural commitment, not an enforceable guarantee** against the Owner |
| S5  | Repository / organization / environment secrets     | **None**                              | 4-A depends on absence                                                |
| S6  | Environments with secrets                           | **None**                              | Same                                                                  |
| S7  | Self-hosted runners                                 | **None registered**                   | 4-B depends on absence                                                |
| S8  | Fork PR workflow approval                           | **Manual approval required for first-time external fork contributors** (D2 Option B); not required for same-repository PRs | Stated property of Class A, scoped to first-time external contributors |

**Verification of S1–S8 requires repository settings access and is not
performed by CI.** No API call in this project asserts them.

**GOV-1 status of these settings.** The single-maintainer governance decision
(GOV-1) specifies the _intended_ values for S3 and S4 above. It does **not**
configure them. As of this document revision the `main` ruleset has **not** been
created, **no** required status check is active, and **no** bypass configuration
has been applied. Configuring them requires repository settings access under a
separate authorization, and until that happens S3 and S4 remain **unverified**.

---

## 8. Future hardening directions

**Everything in this section is unimplemented and unauthorized.** It is a
roadmap, not a description of the current system. Reading it as a claim about
what exists today would be a misreading.

### 8.1 N-1 — process-level egress isolation

The original objective. Would require running the test process in a network
namespace with no route, so that `connect()` fails at the kernel rather than
being observed to fail at the application layer.

This remains the **preferred** mechanism if it ever becomes available. It is
blocked by environment constraints documented in the design specification
(§11.2.2), not by a change of mind.

### 8.2 N-2 — interception evidence

A fallback only. N-2 requires a **complete coverage table** in which every
egress path is either intercepted-and-verified or explicitly accounted for with
a compensating control. Partial interception is **not** N-2 and may not be cited
as assertion-4 evidence.

If N-2 is attempted, the existing normative completeness requirements apply
unchanged. Lower effort does not reduce the required table.

### 8.3 Trusted dispatcher and independent evidence collection

The structural fix for the Section 4.1 limitation. A workflow running on a
protected base ref, triggered by a trusted event, would collect evidence about
the PR rather than letting the PR report on itself. This is the only direction
that produces genuinely independent evidence.

Design constraints if pursued: the dispatcher must not execute PR code with
privileges, and its output must not be writable by the PR.

### 8.4 Stronger execution isolation

Beyond VM-per-job: ephemeral isolated environments, restricted egress at the
infrastructure layer, or a dedicated runner pool that is destroyed after each
job. Each raises cost and operational complexity.

### 8.5 Supply-chain security improvements

- Dependency review on pull requests.
- Automated update tooling with pinned versions.
- Provenance attestations for build outputs.
- Lockfile-diff review requirements.

Note that `npm ci` retaining lifecycle scripts (D9) is a deliberate accepted
trade-off; tightening it would break packages that require build steps and is
not a free improvement.

---

## 9. Reassessment triggers

The accepted risks are proportionate to the current stage. Reassessment is
**required**, not optional, when any of the following becomes true:

1. **More users or collaborators.** Additional write collaborators enlarge
   Class B and make R8 more consequential.
2. **Increased external contributions.** More untrusted PRs raise the value of
   independent evidence (8.3) and of egress control (8.1).
3. **Public deployment or additional services.** A deployed service with real
   credentials changes R5 from "accepted" to "material".
4. **New threat evidence.** A observed attempt, a disclosed vulnerability in a
   dependency, or a platform behaviour change.
5. **Improved tools or model capabilities** that materially reduce the cost of
   N-1, N-2, or a trusted dispatcher.

---

## 10. The governing rule

> **Lower implementation cost never lowers the required security evidence
> standard.**

If N-1 becomes cheap to implement, it becomes _available_, not _optional to
verify_. If a tool makes N-2 easier to attempt, the completeness table is still
required in full. Convenience is not evidence.

Correspondingly, and equally binding:

> **A revised requirement does not retroactively satisfy the original one.**

Assertion 4, B-6, O-3 and T-10a remain BLOCKED. M5 changed what ordinary PR CI
must prove. It did not produce the proof the original requirement demanded.
