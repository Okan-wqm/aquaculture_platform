# A CONVERGED plan got exactly one chance to be implemented (2026-10-06)

Owner: claude (implementation), okan (review). Deadline 2026-10-13.

## ARIA-HIGH-362

`CONVERGED` is in `plan_convergence.TERMINAL_STATES`, so `list_active_plans` and
`resume_candidate_plan_id` never look at a converged plan again. The V9 implementation runner was
called in one place only: the cycle whose drainer returned `converged`
(`autonomy_orchestrator.py`, the `v9_implementation_runner.run(` call between the memory hook and
specialist review). Whatever that call produced was final:

| What the converging cycle hit                                                                                     | Result row                                                       | What happened to the plan |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- |
| profile `standard` (NoOp runner)                                                                                  | `IMPLEMENTATION_REQUEST_REFUSED`, `no_op_v9_runner`              | CONVERGED forever         |
| staging raises (dirty workspace `validation.py:205`, no `architectural_tier`, unregistered recipe `apply_engine`) | `implementation_staging_governance_error` governance row         | CONVERGED forever         |
| any runner fault                                                                                                  | `runner_exception:<class>`, `v9_implementation_phase_failed` row | CONVERGED forever         |

No reader consumed any of those rows. A plan the whole primary/challenger/cross-review debate had
agreed on was implemented only if the night it converged could also deliver it.

Rule: a CONVERGED plan is offered to the implementation runner until it leaves CONVERGED, a bounded
number of times, and a plan that exhausts the bound reaches a named terminal state an operator sees.

Fix:

- **One delivery path.** `aria_kernel/converged_delivery.py` `deliver_converged_plan` is the only
  `runner.run(` call site. The converging cycle calls it (origin `converged_this_cycle`). A sweep at
  the start of every cycle, before plan adoption, calls it for plans an earlier cycle left
  CONVERGED (`redeliver_stranded_converged_plans`, origin `stranded_redelivery`).
- **Durable, idempotent attempts.** Under a profile holding `pr_create` (the cell
  `select_v9_implementation_runner` reads), each offer first appends
  `implementation_delivery_attempted` to the plan's own ledger. This is an annotation event that is
  legal only in CONVERGED. Its idempotency key is (plan, attempt), so a racing offer for the same
  number appends nothing and does not run. The count survives a process killed inside the runner.
- **What is not counted.** A NoOp refusal under `standard` says the night could not deliver. It
  says nothing about the plan, so it spends no attempt and causes no escalation. The first night
  that can deliver gets the full bound.
- **No double mint.** A plan is withheld while an `implementation` request for it is live. The mint
  appends the request row before it writes the plan transition, so a crash between the two leaves a
  live request on a plan that still folds to CONVERGED. A plan is also withheld once it has left
  CONVERGED, and after it was offered once in the current cycle.
- **Bound and terminal.** After 3 counted offers that left the plan CONVERGED, the operator record
  `human-required/converged-delivery-exhausted-<plan>.json` (context kind
  `converged_plan_delivery`, the attempts, the last rejection class) is written first. Then the plan
  moves to `HUMAN_REQUIRED` with reason code `implementation_delivery_exhausted`. Both writes are
  idempotent, and a sweep that finds a spent plan escalates it without offering a fourth time.
- **Per-cycle cost.** Staging runs the plan's validation suite as its baseline, so the sweep
  re-offers at most one plan per cycle, oldest convergence first. Escalations are not bounded.

Tests (`aria-kernel/tests/test_converged_delivery.py`, 9):

- (a) Refused by the NoOp under `standard` in cycle N, then implemented by the `strict` sweep in
  cycle N+1. This is tested at the unit level and through `run_autonomy_orchestrator`.
- (b) A staging `GovernanceError` under the real `AutonomousV9ImplementationRunner` is re-offered,
  and the second offer mints. A runner exception is counted and re-offered.
- (c) Three failing offers lead to `HUMAN_REQUIRED` with `implementation_delivery_exhausted` and
  the operator record. A spent plan found by the sweep is escalated without a fourth offer. Attempts
  are idempotent and dense.
- (d) A live request left by a mint that died between its two writes withholds the plan. There is
  no runner call and no attempt is spent.
- The sweep offers one plan per cycle, oldest convergence first.

The wiring pin `tests/invariants/v10/test_phase_v10_5_phase_7_v9_runner_wired.py` now pins the
seam: one `runner.run(` in `converged_delivery`, the converging offer between the memory hook and
specialist review, and the sweep before plan adoption.
