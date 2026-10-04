# ARIA planners — the lessons procedural memory derives reach only the implementer (2026-10-03)

Context: decision R3-D4 of the memory and repository-knowledge program, rev3.1 ("the learning loop
does not wait for the refutation protocol": K10 merges in the chain wave, and the planner/drafter
lesson reader follows the `observed_failure_obligation` pattern; lesson text comes only from a
kernel template, agent strings ride as ids or hashes, attack report R9; no `node_ids` in memory
before K17, ADR-0022). Read on `fix/aria-agent-eval-real-mode @ 4c7309a87` (PR #1738, K10).

Owner: claude (implementation), okan (review). Deadline 2026-10-24, the program's "learning loop in
code" P80.

## ARIA-HIGH-309

K10 records every finished drafter and implementer episode on `memory/procedural.jsonl` and derives
a lesson once one attributable failure mode recurs `LESSON_EPISODE_THRESHOLD` (3) times
(`agent_eval.recurring_failure_modes`). Its only reader is the implementer envelope
(`cross_review_bridge._observed_failure_obligations`). No planner envelope reads it:

- the drainer's challenger envelope carries exactly the obligations its caller passed
  (`convergent_planning_bridge.issue_challenger_envelope`);
- the round-2+ primary revision envelope carries the cycle's obligations and the measured carries
  (coverage, spine, plan contract), nothing from procedural memory
  (`cross_review_bridge.issue_primary_envelope`);
- the round controller's planner request carries one static obligation
  (`plan_round_controller._ensure_planner_request`).

`recurring_failure_modes` also cannot answer the planner's question: it counts one `subject`
across every plan, while a plan's outcome belongs to the plan whoever drafted it (the seed is
`kernel:plan_synthesizer`, a revision `aria-primary-planner`), and a lesson for this plan is about
plans like it.

So a plan repeats a failure mode the system has already recorded three times on plans of the same
kind, and the challenger, whose job is to find where the primary is wrong, is not told where
primaries have been wrong before.

Evidence:

- `aria-kernel/aria_kernel/cross_review_bridge.py:705` (`_observed_failure_obligations`, the one
  reader of `recurring_failure_modes`, implementer envelope only)
- `aria-kernel/aria_kernel/convergent_planning_bridge.py:106` (challenger envelope: the caller's
  `must_satisfy` only)
- `aria-kernel/aria_kernel/cross_review_bridge.py:346` (primary revision envelope: the caller's
  `must_satisfy` only)
- `aria-kernel/aria_kernel/plan_round_controller.py:156` (round controller planner request: one
  static obligation)
- `aria-kernel/aria_kernel/agent_eval.py:1007` (`recurring_failure_modes`: one subject, no plan
  scope)

Rule: every envelope that authors a plan (primary and challenger, at every mint site) carries one
binding obligation per drafter failure mode that recorded plans of the same origin class on
overlapping affected surfaces repeat at least `LESSON_EPISODE_THRESHOLD` times, at most five per
envelope, chosen deterministically. The obligation text is the kernel's template; a recorded mode
that is not a kernel token rides as its hash only.

Not a lesson input: the skill drafters (`primary_authoring`, `challenger_authoring`) record no
episode, so no lesson exists for them to read.
