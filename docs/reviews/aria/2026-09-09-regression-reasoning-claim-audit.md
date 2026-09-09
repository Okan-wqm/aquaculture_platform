# ARIA review — 2026-09-09: adjudicating an external claim set about ARIA's regression reasoning

- Date: 2026-09-09
- Owner: `okan`
- Subject: an LLM-authored analysis of how ARIA should reason about regressions
  ("Repair vs Adapt vs Revert"), and what ARIA's code does today
- Method: every claim executed or read against the code. No claim graded from
  the analysis text alone.

The operator supplied an external analysis arguing that ARIA, on finding a
regression after its own fix, must not reflexively revert; it must first
classify WHY the regression happened and choose between forward-fix, patch
refinement, revert, and human escalation. The analysis also made concrete
factual claims about ARIA's current code.

This document grades those claims. The verdict is mixed in a specific and
useful way: **the analysis is right about the engineering, wrong about one
absence, and its central insight is provable inside ARIA's own gate.**

## Scope honesty — what was and was not read

ARIA is 302 kernel modules / ~145k lines, 625 kernel test files, and 64 files
across `tools/aria-{poc,adapters,acceptance}`. This audit read the modules the
claims name and their call sites. It is **not** the full-codebase read the
operator asked for; that is a larger piece of work and is scoped at the end of
this document rather than simulated here.

## Claim-by-claim adjudication

### 1. "`impact_graph.py` derives downstream dependents into `downstream_projects` / `validation_scope`" — DOĞRU

`aria-kernel/aria_kernel/impact_graph.py:76` emits `downstream_projects`;
`:80` computes `validation_scope` via `_validation_scope(changed, downstream,
unknown_files)`. `impact.py:104-105` widens validation to
`direct_projects + downstream_projects` when the scope resolves to
`downstream`, and `impact.py:49` fails closed to `blocked_unknown_graph` when
the graph cannot be trusted.

### 2. "The code examines upstream foundational layers first" — DOĞRU, near-verbatim

`impact_graph.py:97-105`: *"Order projects so each is examined AFTER its
dependencies (upstream foundational layers first) … `layer` is the topological
depth."* The order is cached by graph fingerprint (`:216`) and the ripple is
presented in dependency order so examination walks upstream-before-downstream
(`:259-262`, `:286`).

### 3. "`rollback_bundle.py` gates merge on a bundle plus a passed simulation" — DOĞRU

`merge_authority.py:25` imports `verify_rollback_bundle`; `:105` calls it and
`:310` records the result in the decision row.

### 4. "We cannot prove every failed validation is wired to a semantically correct automatic revert" — DOĞRU

The analysis hedged here, and the hedge was accurate. No such wiring exists.

### 5. "ARIA needs baseline capture" (implying it has none) — KISMEN YANLIŞ

A baseline→postcheck comparator **does** exist and the analysis did not know
about it. `architecture_spine_gate.py` measures five invariant kinds
(`tenant_scoping`, `event_contracts`, `schema_entity`, `auth_security`,
harness security), compares baseline against postcheck via `detect_drift`
(`:495`), labels each field `regression` / `improvement` / `unchanged`, and
escalates to HUMAN_REQUIRED after five consecutive regressions for one
`plan_id` (`:86`).

So the shape the analysis asked for is partly built. Which makes the next
finding the important one.

### 6. "Failure identity matters; comparing failure COUNTS is not enough" — DOĞRU, and provable inside ARIA

This is the analysis's central engineering insight, and ARIA's own baseline
comparator is an instance of the defect it names.

`InvariantMeasurement.measurements` carries **counts only** — e.g.
`{"get_repository_callsite_count": 3}` (`:160`), `{"declared_event_count":
N, "missing_schema_count": M}` (`:196`). No file, no identity, no which-one.
`detect_drift` then compares those numbers: `p_val > b_val` → regression,
`<` → improvement, `==` → skipped entirely.

Executed against the real function:

```
identity swapped, count equal (3 -> 3) -> NO DRIFT REPORTED
fixed 2 / broke 1        (3 -> 2) -> [('get_repository_callsite_count', 'improvement')]
```

Both readings are wrong in the direction that matters:

- A change that removes one `getRepository()` tenant-isolation violation and
  introduces a different one nets to zero. The gate reports no drift and the
  plan advances carrying a brand-new isolation bug.
- A change that fixes two violations and introduces one reads as an
  **improvement** — the new violation is absorbed into a favourable number.

This is exactly the `before: 3 failures / after: 3 failures` trap the analysis
described, sitting in the gate that controls plan advancement. Raised as
`ARIA-HIGH-045`.

### 7. "No central state machine decides required-migration vs patch-regression" — DOĞRU

Searched `forward_fix`, `patch_refinement`, `consumer_migration`,
`required_migration` across `aria-kernel/` and `tools/aria-poc/`. Two hits,
both incidental: a plan note in a `runtime_profile.py` comment and a
`tools_root_bind_required_migration` binding constant. No decision machine.

The nearest existing organ is `change_outcome.py`, and the difference is worth
stating precisely because it is easy to mistake one for the other: it grades a
merged change N nights **after** the fact into `gain_confirmed` / `no_gain` /
`regression` / `unknown`. It is an outcome grader, not a pre-merge chooser
between forward-fix, refinement and revert. It also explicitly adds no second
detector — its `regression` verdict is CONSUMED from the existing
`experiment_regression_detected` event ("one detector, one event, two
readers").

### 8. Operator's own principle: "ARIA's learning must come from events" — ALREADY THE RULE, and well-built

`change_outcome.py` states it directly: the verdict is RECOMPUTED FROM THE
LEDGERS, and `emit_change_outcome` **refuses** any reading whose sources are
not in `LEDGER_EVIDENCE_SOURCES` — the surfaces that record an execution or an
event after the fact. `proposals` is a declared ledger and is deliberately
inadmissible, because *"a system that graded its own homework from its own
claim would produce a ledger of confirmations and learn nothing."*

That is the correct principle, already enforced in code. The gap is not the
rule; it is that the organ reports having fired zero times — the module's own
docstring records "the regression strip E21-d built has fired zero times in
production (zero `finding_reproduced` rows)". An event-sourced learner with no
events has the right architecture and no data.

## Where the analysis is strongest

Its three proposed invariants survive scrutiny and are not currently encoded
anywhere in ARIA:

1. A regression is not automatically a reason to revert; classify first whether
   it is the necessary consequence of removing the defect or a side effect of
   the patch.
2. ARIA may not merge a change that breaks behaviour which worked at baseline
   and is unrelated to the defect being fixed.
3. ARIA may not revert a proven security fix to preserve a consumer that
   depended on the insecure behaviour; it migrates the consumer, or escalates
   when safe migration cannot be determined.

The "minimum necessary behavioral change" principle is likewise absent as an
encoded constraint. The analysis's `X-Auth-Token` example — where migrating 50
consumers is the wrong answer and narrowing the patch is the right one — is a
real failure mode that nothing in ARIA currently prevents.

## Where the analysis overreached

Only in claim 5: it argued from an assumed absence. The baseline/postcheck
organ exists, is wired into plan advancement, and already escalates to
HUMAN_REQUIRED on repeated regressions. An audit that had read
`architecture_spine_gate.py` would have made a sharper argument — the one this
document makes in claim 6 — instead of asking for a mechanism that is there.

The practical lesson generalises: a recommendation derived from a description
of a system rather than from its code will misplace the gap even when it
correctly identifies the principle.

## ARIA-HIGH-045 — the baseline comparator compares counts, so a swapped violation is invisible (OPEN)

- Owner: `okan`
- Deadline: 2026-11-15

**Problem.** `InvariantMeasurement.measurements` carries aggregate counts with
no identity, so `detect_drift` cannot distinguish "the same three violations"
from "three different violations". Equal counts report no drift; a net
improvement hides a newly introduced violation.

**Test that proves it.** See claim 6 above — both readings produced by calling
`detect_drift` directly.

**Architectural fix (Tier 1, not applied here).** Measurements must carry the
violation SET, not its cardinality — a sorted, stable identity per violation
(file path plus symbol or rule id). `detect_drift` then compares sets and
reports `introduced` / `removed` as distinct facts, so a swap surfaces as one
introduction plus one removal rather than silence, and "improvement" can no
longer absorb a new defect. This changes the measurement payload written to
the spine ledger and every reader of it, so it needs its own review and
migration of existing baseline rows.

## What full ARIA documentation would require, honestly

The operator's request is that ARIA's whole codebase be read and recorded so
an LLM can understand it. At 302 modules and ~145k lines that is not a single
pass, and a document produced by skimming would be the same defect class this
review exists to catch — a claim shaped like a measurement.

The shape that would actually work, and is proposed rather than started:

1. **Mechanical inventory first.** Every module, its public surface, its
   ledger writes and reads, its callers. Generated from the code, not written
   by hand, so it cannot drift silently.
2. **Layer the narrative on the inventory.** `docs/aria/` already carries
   SPEC/CONTRACTS/CURRENT_STATE; the missing artifact is the module-level map
   between them and the code.
3. **Bind it with a gate.** A generated inventory that nothing regenerates in
   CI becomes stale documentation within one sprint — the same failure as an
   acceptance lane nothing runs.

Ordering note: this documentation effort and the regression-classification
machine compete for the same attention. The classification machine is the one
that changes ARIA's behaviour; the map changes what a reader can see. On the
evidence in this document — a gate that cannot see a swapped violation — the
behaviour is the more urgent of the two.
