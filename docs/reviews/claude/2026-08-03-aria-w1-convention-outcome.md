# ARIA Wave 1 — a plan that converged is not a plan that worked

Date: 2026-08-03
Branch: `claude/aria-w1-convention-outcome`
Scope: `cycle_phases/memory.py`, `knowledge_graph.py::Pattern`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1 (gap 7)

## The defect

When the convergent gate resolves, the memory phase records the result as
a `convention` pattern at a hard-coded confidence of **0.9**. That row is
written _before_ the change is merged, _before_ CI has run against it,
_before_ any outcome exists at all.

`MIN_PATTERN_CONFIDENCE` is **0.7**, and that is the floor
`lookup_pattern` serves from. So the row was immediately available to
later planners as established knowledge.

The result is a system compounding its own predictions into its own
priors: ARIA proposes a plan, three of its own roles agree the plan is
sound, and it files that agreement as a fact about the repository — then
reads it back as evidence when planning the next change.

## What convergence actually is

Real evidence, and worth keeping. A primary planner, an independent
challenger and a cross-review all agreed. That is a meaningful signal
about the _plan_.

It is evidence about **agreement**, not about **outcome**. Nothing in the
convergent gate observes whether the change merged, whether CI stayed
green, or whether anything was reverted a day later.

So the row stays — it is recorded at `CONVENTION_HYPOTHESIS_CONFIDENCE =
0.5`, deliberately below the serving floor. Stored, because the
observation is worth having. Not served, because it is not yet knowledge.

## `outcome_status` defaults to `unknown`, not `verified`

`Pattern` gains an `outcome_status` field. The default matters more than
it looks: every convention recorded before this field existed was _also_
written pre-outcome. Defaulting old rows to `verified` would assert
something the ledger never observed — inventing a history to make the
schema tidy. `unknown` says exactly what is known about them.

Promotion to `verified` on a VERIFIED mission, and demotion (plus
anti-pattern candidacy) on a rolled-back one, is Wave 10's half. This PR
is the half that stops the false claim; the shape is here so Wave 10 has
somewhere to write.

## Verification

`aria-kernel/tests/test_convention_outcome_status.py` — 4 tests written
before the fix:

- a pre-outcome convention is below the serving floor, asserted both as a
  property of the constant and by `lookup_pattern` returning `None`;
- the row is still recorded and readable at `min_confidence=0.0` — not
  served is not the same as not kept;
- `outcome_status` defaults to `unknown` for rows predating the field;
- an outcome-verified convention IS served, so Wave 10's promotion has a
  working target rather than a shape that would need changing again.

Mutation-checked both halves: restoring `0.9` fails 1 test; defaulting
`outcome_status` to `verified` fails 1.

Kernel suite 3093 green.

## Finding

- **ORPHAN-HIGH-536** — pre-outcome conventions served as knowledge.
  CLOSED here.

Owner: okan
