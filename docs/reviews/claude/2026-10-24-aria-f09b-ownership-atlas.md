# ARIA F0.9b ownership atlas: copy families without a finding

**Owner agent:** claude · **Cycle:** 2026-10-21-aria-quality-learning-program-v2 · **Branch:**
`feat/aria-f09b-atlas-generator`

PLAN-v2 F0.9b generates the ownership atlas from code (`aria_kernel.ownership_atlas`, rendered
at `docs/aria/generated/OWNERSHIP-ATLAS.md`). A concept family with copies is not folded in
F0.9b: it names the plan package that folds it and a registered finding. Seven of the nine copy
families already had one (ARIA-HIGH-737, ARIA-MEDIUM-744, ARIA-HIGH-745, ARIA-MEDIUM-746,
ARIA-LOW-738, ARIA-LOW-743, ARIA-LOW-732). The two below had none.

## ARIA-MEDIUM-903

Impact analysis has four computers: `impact_graph.plan_downstream_impact` (the owner),
`impact.plan_impact` (no production importer), `recursive_impact.compute_recursive_impact`
(reached only from the CLI) and `pr_tracking.plan_new_merge_impact` (a glob map of merges onto
findings, live in the change_intelligence phase).

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-27.
- Raised by: the F0.9b implementer from the generated atlas (hand atlas F0.9 item 8; skeptic
  item "impact engines").
- Plan item(s): SE-4, PLAN-v2 §2 "Etki analizi".
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:45` (plan_downstream_impact, the owner)
  - `aria-kernel/aria_kernel/impact.py:11` (plan_impact wraps the owner with its own risk,
    validation and project-hint rules; no production importer)
  - `aria-kernel/aria_kernel/recursive_impact.py:909` (compute_recursive_impact, a third engine
    with its own path-to-project mapper and nx graph reader)
  - `aria-kernel/aria_kernel/cli.py:6184-6188` (its only production caller)
  - `aria-kernel/aria_kernel/pr_tracking.py:205` (plan_new_merge_impact)
  - `aria-kernel/aria_kernel/cycle.py:1907-1916` (`_phase_change_intelligence` calls it)
- Rule: the planner envelope's impact_graph_refs over impact_graph are the one impact answer and
  no third engine exists; one owner per concept family.
- Failure scenario: an operator asks for a change's impact through the CLI and gets the
  recursive engine's answer, the planner gets impact_graph's, and a merge's revalidation set
  comes from pr_tracking's globs; the three can name different projects for the same paths.
- Close condition: the atlas's impact_analysis row lists `impact_graph.py` alone as writer
  module, the row drops its finding, and the family joins the one-owner invariant
  (`aria-kernel/tests/invariants/test_atlas_one_owner.py`). SE-4 (branch
  `feat/aria-se4-one-closure`) moves the entry points onto one closure; ARIA-MEDIUM-791 and
  ARIA-MEDIUM-794 name recursive_impact's own path and event readers.

## ARIA-MEDIUM-904

The seat law has two more computers beside `feedback_store.distinct_judge_seats`:
`independence_check.verify_route_distinctness` gates a human_required RESOLVE quorum on
DEFAULT_QUORUM = 2 distinct (provider, model) routes, and
`skill_genesis_drainer.check_pattern_signature_stability` gates skill genesis on two distinct
cross-reviewers.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b implementer from the generated atlas (hand atlas F0.9 item 6; the skeptic
  added the skill genesis count).
- Plan item(s): F0.8, PLAN-v2 §2 "Çeşitlilik yasası".
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:386-406` (distinct_judge_seats, the one seat
    function)
  - `aria-kernel/aria_kernel/independence_check.py:509-531` (verify_route_distinctness counts
    distinct (provider, model) routes)
  - `aria-kernel/aria_kernel/human_required_adjudication.py:107` (DEFAULT_QUORUM = 2) and
    `:704-712` (the RESOLVE quorum asks verify_route_distinctness)
  - `aria-kernel/aria_kernel/skill_genesis_drainer.py:482-483` and `:571` (two distinct
    reviewers, counted on its own)
- Rule: one seat function and every consumer asks it (F0.8); one owner per concept family.
- Failure scenario: under one provider running one model, two judges count as two seats for the
  consensus, while the same two can never clear a human_required item: the route law refuses
  them as `distinct_routes:1<2`.
- Close condition: human_required adjudication and skill genesis ask the seat function (or
  PLAN-v2 names route distinctness a different property and the atlas row says so), the atlas's
  seat_law row lists `feedback_store.py` alone as writer module, the row drops its finding, and
  the family joins the one-owner invariant. ARIA-MEDIUM-832 and ARIA-MEDIUM-834 cover the inline
  restatements inside feedback_store.
