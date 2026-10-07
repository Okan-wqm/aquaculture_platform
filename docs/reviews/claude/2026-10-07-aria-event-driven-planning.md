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
