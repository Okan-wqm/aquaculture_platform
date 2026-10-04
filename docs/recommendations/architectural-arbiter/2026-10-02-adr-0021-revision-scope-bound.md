# ADR-0021 — Revision Scope Bound: A Plan Writes Only Inside Its Admitted Surfaces and Closure

**Status:** accepted
**Date:** 2026-10-02
**Resolves:** architectural-arbiter ruling of 2026-10-02 on ARIA-MEDIUM-261 (program review of the
ARIA memory and repository-knowledge plan; the operator accepted the program plan)
**Finding reference:** docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-MEDIUM-261
**Builds on:** ADR-0018 D4 and D5 (`2026-10-02-adr-0018-operator-channel-contract.md`); ADR-0018
stays accepted and is not superseded

## Context

ADR-0018 admits a finding-sourced plan (an aging F finding or a signed operator request) on the
surfaces its grounding names: `finding_grounding.admit_finding` keeps only refs that are tracked
files of the anchor commit and surfaces that are writable, and
`plan_synthesizer.convert_candidate_to_plan_content` writes exactly those surfaces into the seed.
After the seed nothing bounded the write scope:

- `plan_convergence._validate_submitted_plan` held a challenger draft or revision to its origin
  `finding_id` (ADR-0018 D4), not to its surfaces;
- `cross_review_bridge.issue_implementation_envelope` derived `allowed_scope` from the CONVERGED
  body's `affected_surfaces` minus `implementation_safety.READONLY_PATHS`;
- the coverage gate (`plan_coverage`) makes a revision claim the impact closure of its surfaces, so
  widening is required, not incidental.

A request admitted on one file could therefore converge into a write anywhere the readonly list
does not cover. Bounding revisions to the admitted surfaces alone would refuse the tests,
dependents and migrations the coverage gate demands of the same revision.

Options considered and rejected:

- **A — bound to the admitted surfaces only.** Rejected: the coverage gate requires dependents, so
  no plan that honours it could converge.
- **B — bound to the coverage witness's closure.** Rejected as the bound: the witness runs per
  revision over that revision's own surfaces, so a widened revision would widen its own bound.
- **C — let the planners declare the closure.** Rejected: the bound would be planner prose, the
  thing it exists to constrain.

## Decision

1. **The bound is recorded at admission, on the origin record.** `plan_convergence.start_plan`
   runs `plan_origin.compute_admission_scope` for every seed that carries a `finding_id` (F
   finding, operator request, ORPHAN) and stores the result on the `plan_started` payload as
   `admission_scope`: the admitted surfaces (the seed's surfaces, which the converter took from
   the admission), the changed and downstream projects of their
   `impact_graph.plan_downstream_impact` closure and those projects' roots, the subject pins, the
   graph source and the impact-graph ledger hash. `start_plan` has no parameter for a bound: the
   kernel computes it in the workspace the plan starts in, so no caller and no planner can set
   it. A finding-origin plan started without a workspace is refused (`admission_scope_missing`).
2. **The bound is the admitted surfaces united with their project closure.** A path lies inside it
   when it equals, or lies under, an admitted surface, a closure project root or a subject pin.
   Paths are compared in the form `canonical_path.resolve_repo_relpath` gives; a path that has
   none (absolute, backslash, leaving the root) is outside.
3. **Every submitted body is held to it.** `_validate_submitted_plan` refuses a challenger draft or
   revision that names a path outside the bound in `affected_surfaces` or `key_changes[].paths`
   with `revision_scope_exceeds_admission_closure`, listing every offending path. A path outside
   the safe charset is named by its hash, as ADR-0018 D5 names refs.
4. **The implementation scope is held to it.** `implementation_safety.implementation_allowed_scope`
   takes the bound as a required keyword argument (None only for a plan with no finding origin). A
   declared path outside it is not subtracted like a readonly path: the whole scope is refused
   (`plan_origin.AdmissionScopeExceeded`), so the scope it returns never exceeds the bound. The
   implementation mint passes the plan's recorded bound and, on a refusal, mints nothing and
   leaves the plan CONVERGED.
5. **Every refusal is recorded.** Each refusal appends one governance row of kind
   `revision_scope_exceeds_admission_closure` naming the plan, the stage (`plan_submission` or
   `implementation_mint`) and the offending paths.
6. **The record is checked on every fold.** A `plan_started` record whose admitted half differs
   from the seed's surfaces, or whose origin differs from the seed's `finding_id`, is refused.
7. **No record, no write.** A finding-origin plan whose `plan_started` carries no bound (a ledger
   written before this ADR) cannot record a body or mint an implementation
   (`admission_scope_missing`); it is restarted, never left unbounded.
8. **Subject pins are committed policy data.** Paths a subject pins into a bound live in
   `docs/aria/policy/subject-pins.json` (`aria/subject-pins/v1`: `subject_pins[]` of
   `{subject, paths}`, matched against the plan's origin finding id and closure project names),
   and the bound unions them in. `plan_origin.load_subject_pin_policy` reads the file as committed
   at the workspace's main-proven commit through `main_anchor` (scrubbed git, blob re-hashed), never
   from the working tree, and no caller can pass pins in. The admission record names the blob it
   read (`pin_policy`). A missing, malformed or unanchored policy pins nothing, names why on the
   record and is disclosed once as `subject_pin_policy_refused`. It ships empty. Amended
   2026-10-02 (ARIA-LOW-280) per program ruling 15; the first text kept the pins in a kernel tuple.
   A fix's journey pin (`<project>/src/__journeys__/…`) needs no entry: it lies under its own
   project's closure root (decision 2).

## Consequences

- A plan admitted on a surface can revise and implement a fix in that surface's project and in
  every project that depends on it, and nowhere else.
- The coverage gate and the bound can disagree: an event consumer or entity-migration coupling the
  witness finds outside the project closure is reachable only through a coverage waiver the
  completeness critic adjudicates, or through a subject pin.
- The bound is computed once, when the plan starts, against that workspace; a project that starts
  depending on the admitted surfaces later is not in it.
- An ORPHAN plan whose register entry names no evidence is admitted on
  `docs/reviews/orphan-findings.md` alone and can write only there.
- Plans with no finding origin (git-diff, failing-CI, mission) carry no admission record; their
  write scope stays the CONVERGED body minus `READONLY_PATHS`.
- The losing side: a finding-origin plan in flight when this lands has no record and must be
  restarted; a fix that needs an unrelated project needs its own admitted finding.
