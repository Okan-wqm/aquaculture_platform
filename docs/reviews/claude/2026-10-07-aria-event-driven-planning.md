# A plan advanced one step per cycle (2026-10-07)

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

## ARIA-HIGH-368

Convergence is a resumable step function: `convergence_drainer.run_convergence_drainer` advances
one derived step and mints the next envelope. Its only caller was the nightly cycle
(`autonomy_orchestrator.py`, `convergence_result = convergence_runner(`). The executor answered an
envelope, and the next envelope waited for the next cycle. Every step therefore cost a full cycle
plus executor turn.

Measured on the live store (`.aria-state-store/tools/plans/events.jsonl`):

| Plan                             | Event                        | At (UTC)    | Gap    |
| -------------------------------- | ---------------------------- | ----------- | ------ |
| `plan-cyc-20261004T073028Z-auto` | `plan_started`               | 10-04 08:47 |        |
|                                  | `challenger_plan_drafted`    | 10-04 13:55 | 5.1 h  |
|                                  | `cross_review_recorded` (x2) | 10-04 18:06 | 4.2 h  |
|                                  | `plan_evaluated` round 1     | 10-05 08:54 | 14.8 h |
| `plan-cyc-20261005T140553Z-auto` | `plan_started`               | 10-05 15:39 |        |
|                                  | `challenger_plan_drafted`    | 10-06 00:54 | 9.3 h  |
|                                  | `cross_review_recorded` (x2) | 10-06 02:34 | 1.7 h  |
|                                  | `coverage_computed`          | 10-06 05:24 | 2.8 h  |
|                                  | `revision_recorded` (r2)     | 10-06 09:48 | 4.4 h  |
|                                  | `challenger_plan_drafted` r2 | 10-06 23:08 | 13.3 h |
|                                  | `plan_evaluated` round 2     | 10-07 08:05 | 9.0 h  |

One round took 24.1 h on the first plan. Two rounds took 40.4 h on the second. Each evaluation
waited for a cycle after its last answer had already landed.

Rule: when the executor has accepted the answer a plan step waited for, the job that holds the store
takes the next step in the same run.

Fix:

- **Same step function, second caller.** `tools/aria-poc/ci_executor_drain.py` `_advance_plan`
  runs after every succeeded planning-step child. It calls
  `aria_kernel/executor_convergence.py` `advance_after_accepted_step`, which calls
  `run_convergence_drainer` with the cycle's round cap. The minted envelope is claimed by the
  drain's existing planning turn in the same run.
- **One round cap.** `convergence_drainer.AUTONOMY_CYCLE_MAX_ROUNDS` (2) is the default of
  `autonomy run --max-rounds` and the executor's cap. Two caps would give one plan two terminal
  rules.
- **Lease-gated.** The executor step receives the restore's public verdict as
  `ARIA_STATE_WRITER_LEASE`. Anything other than `held` advances nothing, so a local drain leaves
  the step to the cycle.
- **Bounded.** The advance stops at `ARIA_JOB_DEADLINE_EPOCH` and at
  `MAX_CONVERGENCE_ADVANCES_PER_RUN`, which is 2 rounds x 4 steps, a whole debate at the cap.
  Minting stays idempotent per (plan, role, round) through `step_request`. The executor never
  starts a plan: no seed, no start.
- **What a converged plan gets.** `aria_kernel/executor_converged_seam.py` runs the cycle's
  plan-scoped post-CONVERGED parts, in the cycle's order, while the plan is still CONVERGED:
  1. The funnel's `converged` count. It is credited to the source on the plan's first
     `cycle_runner_synthesized_plan` row; the orchestrator now records that source as
     `PLAN_PRESSURE_SOURCE_DETAIL`. If no source was recorded, a governance row names that
     instead of a guess.
  2. The memory hook, under the cycle knowledge signer.
  3. `converged_delivery.deliver_converged_plan` with origin `converged_in_executor_run`.
- **Delivery conditions.** The offer is made only when the persisted profile's runner can deliver
  (`pr_create`). Staging runs the baseline suite in-process, so the offer is also made only when
  the suite's worst case fits both the drain window and the job deadline. Otherwise the plan stays
  CONVERGED for the cycle's sweep, uncounted. The specialist review is not run here. In the cycle it
  runs after delivery and gates only that cycle's worker drain and auto-merge evaluation.

Tests (`aria-kernel/tests/test_executor_event_driven_planning.py`, 12):

- One `drain_pending` run with a scripted agent dispatches `challenger_plan`, `cross_review` and
  `implementation`. The plan ends `IMPLEMENTATION_REQUESTED` with one cross-review and one
  implementation request. On origin/main's drain the same test dispatches `['challenger_plan']`
  only and fails.
- Also covered: no double mint, no advance without the lease, a deadline stop and the cap stop. An
  unknown plan is never started, and judge or implementation answers do not advance.
- The seam: no authority leaves the plan to the sweep with no uncounted row. A window too small for
  staging does not start the runner. The funnel credits the plan's minting source.

Observed while tracing, reported to the operator: a round whose independence check fails
(`cross_review_self_agreement`) leaves the plan state CONVERGED. The cycle withholds delivery that
cycle, but the next cycle's `redeliver_stranded_converged_plans` offers it by plan state alone. The
executor seam offers only on the `converged` verdict.

## ARIA-HIGH-375

The cross-review independence check (ORPHAN-HIGH-421) ran after `evaluate_plan` had already
written CONVERGED (origin/main `convergence_drainer.py:991`). On failure the converging cycle
downgraded only its own verdict to `cross_review_self_agreement` (`:998`) and withheld delivery.
The plan stayed CONVERGED, and every delivery path selects plans by that state:
`converged_delivery._plan_ledger_scan` (`:127`) feeds `redeliver_stranded_converged_plans` (`:526`),
so the next cycle's sweep offered the echo-chamber plan to the implementer. The independence gate
was bypassed one cycle later. Live store, 2026-10-07: no plan is in this state today (zero
`convergence_invalid_self_agreement` rows), so no repair of existing plans is needed.

Rule: a round whose cross review is not independent never reaches CONVERGED, so no path can
deliver it.

Fix (as corrected after review, see **Review corrections** below):

- **Independence is a gate of the evaluation.** `plan_convergence.evaluate_plan` derives the
  round's verdict itself (`round_independence.round_independence_verdict`) whenever its decision
  would be CONVERGED, and records `cross_review_independence` in `gate_decisions`, next to the
  spine and contract gates. A round that fails is written HUMAN_REQUIRED with reason
  `cross_review_self_agreement`, in the same single `plan_evaluated` event. No caller can omit it:
  the drainer, `plan evaluate` and `plan advance-rounds` all go through the same function.
  The gate judges every round that had a cross review. A legacy critique-only round (V8
  `request_critics`) has no cross reviewer to be independent of, and is not judged.
  `_derive_arbiter_verdict` maps the reason to the `cross_review_self_agreement` verdict.
- **Plans CONVERGED before the gate.** Their converging evaluation carries no independence
  decision. `converged_delivery.withhold_ungated_self_agreement` judges such a plan. It runs in the
  per-cycle sweep before anything is offered or escalated, under every lane including one
  without authority, and again at the delivery door (`_claim_attempt`). A failure moves the plan
  CONVERGED → HUMAN_REQUIRED under the plan lock and writes one operator item. That move is the
  migration's own record, so each plan is moved at most once.

Tests: `aria-kernel/tests/test_converged_independence_gate.py`. The first five tests failed on
the pre-fix kernel, 5/5 red at `46d2e6a0c`. `test_convergence_resumable_step` used to accept
CONVERGED with a self-agreement verdict, which was exactly this defect; it now answers the gate.

## Review corrections

The independent review of PR #1831 found no blocker. It raised one HIGH and three MEDIUM issues,
plus three LOW items. Each is fixed on this branch.

- **HIGH-1 (375): self-agreement scored as the drafter's failure.** `agent_eval` turns every
  HUMAN_REQUIRED evaluation into a drafter `escalated` episode. `cross_review_self_agreement`
  was attributable, so `recurring_failure_modes` would have handed the primary planner a
  must-check for a reviewer-independence fault it cannot fix. It is now in
  `UNATTRIBUTABLE_FAILURE_MODES`. One constant names it, in `independence_check`.
- **MEDIUM-1 (375): the lazy migration never ran, and the operator paths bypassed the gate.**
  The first version took the round's verdict as an optional parameter, so `plan evaluate` and
  `advance-rounds` converged without it. It also repaired legacy plans only in `_terminal_result`,
  which nothing calls on a terminal plan. `evaluate_plan` now derives the verdict itself (no
  parameter), and the sweep plus the delivery door run the one-time migration. The earlier claim
  that a self-agreeing CONVERGED state "cannot be reached" was false for those paths.
- **MEDIUM-2 (368): a fault in the converged seam stopped the drain.** The seam is now called
  inside the same store-fault tuple as the step (`GovernanceError`, `BridgeContractViolation`,
  `LedgerIntegrityError`, `OSError`). A fault becomes `converged_seam.status = failed` on the
  advance row, and the drain goes on. The plan stays CONVERGED for the cycle's sweep.
- **MEDIUM-3 (368): plans the executor ended dropped out of the cycle's reporting.**
  `convergence_outcome.report_executor_terminal` writes the cycle's own rows for any plan the
  executor's step made terminal: `convergence_resolved` always, and for other verdicts also
  `convergence_blocked`, the funnel's `rejected` count and the operator item. The job that ends a
  plan reports it; the cycle never sees a terminal plan, so nothing is counted twice.
  - `record_parked_plan` gives every HUMAN_REQUIRED plan exactly one operator item, keyed
    `plan-human-required-<plan_id>`. The cycle's blocked branch, the executor and the legacy
    migration all write the same key.
  - The seam now also writes the `memory_hook_recorded` transition and runs
    `complete_pending_observations` under its signer, as the cycle's converged branch does.
  - Reflection and the daily report are cycle-scoped; they read the state rows above.
- **LOW items:**
  - `drain_remaining` is a callable read at the staging check.
  - The executor id is `executor-<run_id>-<attempt>`.
  - `round_dispatch_record_refused` is written once per (plan, round, role, reason), through
    `append_tools_governance_once`.

## Second review corrections

The second review of PR #1831 found two MEDIUM and two LOW items. All are fixed here
(ARIA-HIGH-375); one LOW is not, with its reason below.

- **MEDIUM-A: the migration could end the cycle, and a parked plan could lose its item.**
  - The sweep's `withhold_ungated_self_agreement` call is now guarded like the other sweep steps.
    A `GovernanceError`, `LedgerIntegrityError` or `OSError` becomes a
    `converged_independence_migration_failed` row. The plan is withheld as
    `independence_unjudged`, because its independence is what is unknown, and the cycle goes on.
    This is the class #1813 closed for the uncounted note. The migration's governance row now
    passes `bypass_profile_gate=True`, as the other kernel bookkeeping does.
  - The transition and the item are separate writes: in the cycle, in the executor
    (`executor_convergence`) and in the migration. A fault between them used to leave a
    HUMAN_REQUIRED plan that no scan would look at again.
    `convergence_outcome.reconcile_parked_plans` is now the single place the invariant holds. It
    runs at the end of every sweep, plan by plan, with faults as rows. Every HUMAN_REQUIRED plan
    gets its item, idempotently and keyed by the plan.
- **MEDIUM-B: a parked item was never resolved.** The same reconcile resolves, through
  `write_kernel_disposition`, every item of a plan that left HUMAN_REQUIRED (abandoned, or moved
  on by an operator). The disposition is `plan_left_human_required`, and resolution happens no
  later than the next cycle.
  - A re-parked plan gets a fresh item: `plan-human-required-<id>-2` for its second parking,
    following the #1828 suffix pattern. The item counts the plan's HUMAN_REQUIRED evaluations, so
    `record_human_required` never hands back an earlier, resolved record as the open one.
  - A plan the operator parked himself (reason codes `operator_*`, e.g. `operator_withdrawn`) is
    recorded already resolved (`parked_by_operator`), not handed back to the person who decided.
- **LOW, done: credit for a withdrawn convergence.** `agent_eval` no longer credits the drafter
  with a converged success that the migration withdrew. The self-agreement escalation supersedes
  that episode.
- **LOW, not done: a pass marker per plan and gate epoch.** A legacy plan that passes is still
  re-judged each sweep. The judgment is read-only and idempotent. The live store holds zero
  CONVERGED plans without the gate (2026-10-07). A marker would need a new declared state
  surface.

Tests: 5 new tests in `test_converged_independence_gate.py` covering the guard, the
repair/resolve cycle, operator parking, re-parking and the superseded credit. All 5 fail on the
pre-fix head.
