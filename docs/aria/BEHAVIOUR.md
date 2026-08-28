# ARIA — what it does, what it cannot do, and what it only appears to do

**Status:** measured 2026-08-20 against `origin/main` and the live `aria/state` ledgers.
**Authority notice:** This is a dated measurement, not current machine truth. Derive current
capability evidence with `aria-kernel autonomy status --evidence`; use
`docs/aria/CURRENT_STATE.md` for the stamped documentation authority chain.
**Companion to** `SPEC.md` (what ARIA is for), `IDENTITY.md` (what it is), `CONTRACTS.md`
(what it promises). This file is the fourth question those three do not answer: _what does
it actually do tonight?_

## How to read this file

Every claim carries its evidence class. This matters more here than in the other three
documents, because the failure mode this file exists to prevent is a reader believing a
capability is live because a module implementing it exists.

- **[measured]** — reproduced directly against the tree or the live ledgers by the author
  of this file. A `path:line` or a ledger count is given.
- **[reported]** — surfaced by the 2026-08-20 comprehension pass (six independent readers,
  no shared finding list) and **not yet independently refuted**. Treat as a lead, not a
  fact. Each is a candidate finding, not a settled one.

A claim with no marker is a design statement, true by construction.

---

## 1. What ARIA does

**It observes the repository on a schedule and writes what it saw.** A night begins at
`.github/workflows/aria-auto-cycle.yml` on the self-hosted runner, restores the `aria/state`
branch into `.aria-state-store/`, resolves a runtime profile, and runs `aria_kernel autonomy
run`. Everything it learns lands as append-only JSONL on `aria/state` — 87 MB of adapter
runs and 51 MB of raw findings to date **[measured]**.

**It finds defects with adapters, not with a model.** Ten registered adapters scan declared
scopes and emit findings with `file:line` evidence. Two of them — doc-staleness and
test-gap — account for 90.4% of the 24,788 findings ever produced **[measured]**.

**It knows what it cannot see.** `observation_coverage` derives a map from `git ls-files`,
every adapter's `declared_scope`, and an exemption policy that ships empty. Current
reading: **71.8% of tracked files fall inside some declared scope; seventeen roots are
fully unobserved, and `aria-kernel` is 13 of 799 files** **[measured]**. A path counts as
observed only when an adapter both declares it _and_ could parse it.

**It judges a sample of its own findings.** Findings are sampled, dispatched to independent
judge agents, and settled by consensus; a split escalates to an arbiter. Verdicts land in
an append-only feedback ledger.

**It escalates what it cannot settle.** A belief that stands contradicted for three cycles,
a genesis candidate, an adapter promotion, a stale anchor — each becomes a `HUMAN_REQUIRED`
record. Since JJ-3, an independent agent panel adjudicates the kinds it is competent to
settle, and a quorum-refuse hands the item to the operator loudly rather than closing it.

**It plans, and the plan converges or dies naming its reason.** A pressure becomes a plan;
a primary drafter and a challenger write competing plans; a cross-reviewer folds them. Since
CL-1 the convergence advances one step per cycle with no synchronous waiting, and a plan
that cannot converge reaches a terminal state that names why (`convergence_envelope_dead`,
`max_rounds`) instead of wedging forever **[measured — `plan-cyc-20260816T182612Z-auto`
terminated 2026-08-19 05:39 after two days wedged].**

**It gates itself hard on the way to a pull request.** `GATE_PRE_PR_OPEN` runs ten
hard-fail checks at `pr_manager.py:359` **[measured]**. The merge evaluator distinguishes
"unreadable" from "clean" at every input and fails closed on each, and since ORPHAN-717 it
refuses a head SHA carrying zero check runs — the conflicted-PR-reads-as-green hole
**[measured]**.

---

## 2. What ARIA cannot do — by design

These are boundaries, not defects. Each is enforced in code, not by convention.

**It cannot merge its own kernel changes.** M-6.1 forbids self-merge on `aria-kernel/**`;
promotion there is operator-gated. Product-lane (`apps/**`) autonomy is a separate ladder.

**It cannot write its own source outside a granted set.** `READONLY_PATHS` in
`implementation_safety` refuses kernel writes; the constitutional-core list (proposal,
merge authority, evidence validator, the invariant tree, `.github/`, `tools/gates/`) is
refused through three independent layers, and the list lives inside a file that is itself
in the list.

**It cannot label its own ground truth as human.** `resolve_human_required` refuses a
`verdict=` from a non-operator resolver, and the panel executor has no `source_type`
parameter at all — the value is a module constant. A panel row is ground truth only when
unanimous, and since ORPHAN-755 it is bounded to the belief it settled: it can never buy an
adapter the anchor volume that promotes it.

**It cannot raise its own confidence in a belief.** A panel may affirm a contradiction
(lowering confidence); the inverse is unreachable by construction, because ARIA reading its
own agreement as evidence is the exact ratchet the belief recorder had to be fixed for.

**It cannot see the Rust edge, the IaC, the SQL, the shell, or the test suites.** No
adapter parses `.rs`, `.tf`, `.sql` or `.sh`; 627 files are written in languages no tool
can read **[measured]**. This is a known gap with a plan (H-5, H-6), not a claim of
coverage.

---

## 3. What ARIA appears to do, and does not

This section is the reason this file exists. Everything below is a module that exists, is
tested, is referenced in prose — and is not connected to a path that runs.

**Autonomous merge is structurally unreachable — and not only because policy forbids it.**
The merge-candidate enumerator reads `enterprise/readiness-claims.jsonl`. The only producer
of that ledger, `produce_readiness_claim` (`readiness_proofs.py:1021`), has **zero
production callers** **[measured]**. A missing ledger reads as `[]`, so the candidate list
is always empty. The policy gate and the empty-input gate would each stop a merge; only one
of them is on purpose.

**The pre-merge hard-fail perimeter is defined and never invoked.** Its checks are
registered against `GATE_PRE_MERGE`, and the only production call of `run_hard_fail_checks`
passes `GATE_PRE_PR_OPEN` **[measured]**. What guards ARIA's PRs is the pre-PR-open
perimeter; the pre-merge one is a declared surface with no caller.

**132 of 205 declared durable state surfaces have never been written once** — and the
missing set is almost exactly the action-taking half: every `pr-lifecycle` ledger, the whole
`change-ledger` triple, all twenty `enterprise/*` proof ledgers, the whole `dispatch/*`
family **[reported]**. What did materialise is overwhelmingly observational.

**No adapter has ever reached ACTIVE**, and the calibration report that would earn the
promotion skips the cohort that needs it **[reported]**. Every adapter is still SHADOW.

**Judge weights are `None` in production** — a calibration row is appended after the
computation that would have filled it **[reported]** — and calibration against anchor
ground truth is tautological where a judge took part in producing the anchor **[reported]**.
JJ-1 tightened the anchor rule; the corollary is that the only ground-truth row ARIA ever
produced was retroactively demoted and nothing backfilled it **[reported]**.

**A vocabulary member emitted but never declared was invisible to the gate built to catch
exactly that.** The reachability gate asked only "is a declared member reachable?" for its
whole life; `written_members` resolved the inverse answer and discarded it one line early.
Turning the direction on found two live instances immediately **[measured — ORPHAN-758]**.

**The dispatch role vocabulary is decorative.** `DISPATCHABLE_ROLES` is enforced only inside
`claim_and_dispatch_one`, which has no production caller; the live drain path checks that a
role is truthy and nothing more **[reported]**.

**`validate_request` is documented as the enqueue-time fail-closed gate and has no
production caller** **[reported]** — while `validate_response` genuinely is wired.

**69% of every agent envelope ARIA has ever minted died of anchor expiry**, because the mint
rate exceeds the drain rate **[reported]**. Minting is not dispatching.

---

## 4. The pattern under all of it

Six independent readers, given no finding list, converged on one defect class: **a mechanism
that exists, is tested, is cited in prose, and has no caller.** It outnumbers every other
class in this repository's ARIA surface, and it is invisible to the kind of review that asks
"is this code correct?" — because the code usually is. The question that finds it is _what
calls this, on the path that actually runs?_

The second pattern is narrower and worse: **a gate that returns PASS without being able to
examine its subject.** A test whose name promises set equality and whose body checks two
literals; an attestation whose unmeasurable facts default to `true`; a validation battery
satisfiable by runs at the parent commit. These do not fail loudly, and a green result from
one is indistinguishable from a green result from a real check.

Both patterns are why this file marks its evidence class on every line.
