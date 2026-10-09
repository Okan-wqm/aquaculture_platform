# ARIA cross-review scope from the plan (2026-10-04)

Context: the first live plan, `plan-cyc-20261004T073028Z-auto`, was started from the signed
operator request OP-F007-20261004-1 to remediate F-007, an hr leave-status filter drift. Its
surfaces are `web/modules/hr-module/src/pages/leaves/LeavesPage.tsx` and
`apps/hr-service/src/leave/entities/leave-request.entity.ts`. Cycle `cyc-20261004T151152Z-auto`
(run 37210517145) minted its round-1 cross_review `AIR-aria-cross-reviewer-d231ca154c99` at 16:42Z
with `allowed_scope: ['.github/workflows/ci-affected.yml']` and a `key-change-0` obligation naming
`ci-run-37215065518-key-change-001`. That scope and obligation belong to the FAILING_CI candidate
the same cycle synthesized. The reviewer returned `material_risks_present` with the blocking risk
CR-001 (scope drift): the obligation forbade every file both plans touch.

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-345

Evidence (at `main@690470509`):

- `aria-kernel/aria_kernel/autonomy_orchestrator.py:1769`: a cycle adopts the newest
  mid-convergence plan (`resume_candidate_plan_id`). It still synthesizes a fresh candidate in the
  same cycle (`plan_content_provider` / `plan_synthesizer`).
- `aria-kernel/aria_kernel/autonomy_orchestrator.py:2017`, `:2034`, `:2037`: `must_satisfy`,
  `evidence_refs` and `allowed_scope` were computed from that FRESH candidate's key changes,
  evidence and surfaces. `:2055`-`:2057` passed them to the drainer for the ADOPTED plan id.
- `aria-kernel/aria_kernel/convergence_drainer.py:603`-`:604`: the drainer's "adopted plans use
  what the plan STARTED with" branch read `plan_started.must_satisfy`. The `plan_started` payload
  (`aria-kernel/aria_kernel/plan_convergence.py:171`-`:176`) records `plan_content`,
  `content_hash`, `initial_revision_id` and `admission_scope`, never `must_satisfy`, so every
  adopted plan fell through to the caller's value.
- `aria-kernel/aria_kernel/convergence_drainer.py:1041`, `:1063`, `:1084`, `:1119`, `:1220`,
  `:873`: the challenger, cross_review, primary-revision and completeness-critic mints all took
  the caller's `allowed_scope` unchanged. The planner and reviewer mints re-derived evidence
  refs from the plan body (`_planning_source_context`), which is why the bad envelope carried the
  right F-007 refs. The completeness-critic mint (`:872`) appended the caller's `evidence_refs`
  instead, so it would have carried the other candidate's refs as well.
- `aria-kernel/aria_kernel/plan_round_controller.py:164`, `:227`: the CLI round controller
  hard-coded `["aria-kernel/**", "aria-tools/**", ".claude/**"]` for every plan.
- `aria-kernel/tests/test_autonomy_orchestrator.py:704`
  (`test_outer_adopted_plan_uses_recorded_body_with_unchanged_caller_scope`) pinned the defect:
  it asserted that an adopted plan's envelope carries the fresh candidate's `allowed_scope`.

Live data path (read-only, runner store): `plans/events.jsonl` holds `plan_started` 08:47Z (the
F-007 body plus its admission bound: admitted surfaces above, closure roots `apps/hr-service`
and `web/modules/hr-module`), `challenger_plan_drafted` 13:55Z, `cross_review_tasks_requested`
18:06Z and two `cross_review_recorded` 18:06Z. The plan is CROSS_REVIEWED, round 1. The
`requests/2026-10.jsonl` row of the round-1 challenger (minted by `cyc-20261004T073028Z-auto`,
the cycle that STARTED the plan from its own seed) carries the F-007 scope. The cross_review row
(`cyc-20261004T151152Z-auto`) carries the ci-affected scope. The cycle's `autonomy_state` rows
show `cycle_runner_synthesized_plan` with `plan_id` = the adopted F-007 plan and one key change.
The cycle synthesized the failing_ci candidate and adopted the F-007 plan.

Rule: every envelope of a plan's round (challenger, cross_review, primary revision, completeness
critique) derives its scope, key-change obligations and evidence from that plan's own
`plan_started` record and admission bound. No cycle-level value of another candidate reaches it.
The request mint refuses a planning-round envelope whose scope or key-change obligations do not
reach the plan it names.

Fix (branch `fix/aria-cross-review-scope-from-plan`):

- New `aria-kernel/aria_kernel/plan_round_scope.py`. `plan_round_contract(state)` derives the
  scope from the started body and its bound. For a finding-origin plan, that is the admitted
  surfaces, `<root>/**` per closure root and the policy pins: the bound every revision is already
  held to (`plan_origin.require_within_admission_scope`). For a plan with no origin, it is the
  body's own paths. The function also derives one key-change obligation per started key change
  and the started evidence refs.
- Tier 1, impossible by construction: `run_convergence_drainer` and the `ConvergenceRunner`
  Protocol no longer take `must_satisfy`, `allowed_scope` or `evidence_refs`. The orchestrator no
  longer computes them. Every drainer mint derives them from the plan it advances, and a fresh
  plan derives them from the record its own start writes.
- Tier 3, detectable at mint for every other producer: `create_agent_invocation_request` runs
  `require_plan_round_envelope` for `primary_plan`, `challenger_plan`, `cross_review` and
  `completeness_critique` rows that name a `convergence_id`. It refuses
  `plan_round_scope_foreign` when a scope entry does not reach the plan's bound or surfaces. It
  refuses `plan_round_obligation_foreign` when a `plan_key_change` obligation names a key change
  or path that is not the plan's. It refuses `plan_round_plan_not_started` when the plan has no
  start record.
- `plan_round_controller` mints with the plan's scope and key-change obligations.
- Replayed against a read-only copy of the live `plans/events.jsonl`, the derivation gives
  `[leave-request.entity.ts, LeavesPage.tsx, apps/hr-service/**, web/modules/hr-module/**]` and
  `key-change-0 = OP-F007-20261004-1-key-change-001`. The guard accepts the live round-1
  challenger row and refuses the live cross_review row with `plan_round_scope_foreign`.

Round 2 under the fix:

- No re-mint of round 1 is possible or needed. Its cross_review is answered and recorded, and the
  plan is CROSS_REVIEWED. The drainer never re-mints a round it has passed.
- The next cycle's drainer computes round-1 coverage. If the challenger's waivers yield
  `covered_with_waivers`, it mints the completeness critic with the derived scope. It then
  evaluates round 1. CR-001..CR-005 and the tierless primary body give NEXT_ROUND_REQUIRED, and
  it mints the round-2 primary revision with the F-007 scope and obligation. The round-2
  challenger and cross_review follow with the same derivation.
- The defect consumed round 1's review. With a two-round budget, round 2 is the plan's last
  chance: any material round-2 risk ends HUMAN_REQUIRED (`max_rounds_reached`). If the operator
  wants two clean rounds, the plan has to be withdrawn and restarted from the same signed request.
  That is optional and not required by the fix.
- The fix only acts once it is on the runner's checkout. A cycle that runs before that repeats
  the leak into the round-2 envelopes.

Observed separately (not part of ARIA-HIGH-345, not changed here):

- When the cycle synthesizes no fresh candidate (`cycle_runner_no_pressure`), the orchestrator
  skips convergence entirely, so an adopted plan does not advance on a quiet night.
- The cycle still records `cycle_runner_synthesized_plan` and a funnel `minted=1` against the
  adopted plan's id for a candidate it never opened.
