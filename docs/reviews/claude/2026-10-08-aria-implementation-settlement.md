# An implementation outcome never reached the plan ledger (2026-10-08)

Owner: claude (implementation), okan (review). Deadline 2026-10-15.

## ARIA-HIGH-388

Every learning consumer reads the plan ledger (`plans/events.jsonl`):

- the scorecard (`agent_eval._performance_episodes`);
- the loop guard's cool-off (`finding_grounding._fold_plans`);
- finding closure and convention promotion (`implementation_reconciler`);
- the lessons in the next envelope (`planner_lessons`, `cross_review_bridge`).

The executor wrote an implementation request's terminal outcome only to governance and to a
HUMAN_REQUIRED row:

- an agent refusal (`ci_executor.py`, the `agent_refused:<class>` release);
- a delivery the kernel refused at a request-class stage (the apply gate, the PR perimeter, the
  push).

The ledger's only `implementation_rejected` writer was the orphan reaper. It relabels a plan
`orchestrator_restart_reaped_orphan` (unattributable) a day later.

Measured on the live store (2026-10-08):

- `AIR-aria-implementer-e056f97fe09b` was refused `agent_refused:safety` at 06:31Z. Its plan
  `plan-cyc-20261007T225133Z-auto` still ends at `implementation_requested` on the ledger.
- `memory/procedural` holds 24 episodes, 0 of them implementer.
- `knowledge-graph/conventions.jsonl` holds 1 row: no plan ever merged.

Second, the store's profile fell from `strict` to `standard` at 04:38Z (the unlock ladder's 72 h
window). A request minted under strict and claimed after that drop spends a whole spawn, then the
apply gate refuses it as the request's fault.

Rule: the job that ends an implementation request settles its plan in one terminal event. A host
precondition is refused before the spawn, never billed to the request.

Fix:

- **One settlement writer.** `aria_kernel/implementation_settlement.py` settles an agent refusal
  (`implementer_refused`) and a delivery refusal into `implementation_rejected`. The payload
  carries the class, the stage, the fault domain and the request. The executor calls it after
  the release, at its two terminal paths.
  - Idempotent through the state machine: a second settle is reported `already_settled`.
  - A store fault is an `implementation_settlement_failed` row, never an exception.
- **One table owns the class.** `implementation_rejections.DELIVERY_STAGE_SETTLEMENT` maps every
  request-class stage of `DELIVERY_STAGES` to its class and fault domain. Host stages are absent
  on purpose: they are released and retried. A test pins that the table covers exactly
  `DELIVERY_STAGES - HOST_STAGES`.
- **Attribution keeps its one owner.** `failure_attribution.APPLY_GATE_REJECTION_CLASSES` gains
  `implementation_result_inadmissible` and `pr_perimeter_refused`, the implementer's own output.
  These are not attributed: `implementer_refused`, `implementation_unpublished` (an unadvanced
  branch is as often the host's missing identity) and the harness-class settlements.
- **Lane faults stay out of the cool-off.** `outage_attribution.failure_is_lane_fault` reads the
  settled `fault_domain`. A refused push or PR (`harness`) never cools the finding's subject off.
- **Authority is admitted before the spawn.** `implementation_delivery.delivery_admission_refusal`
  refuses `authority_absent:profile=…:missing=…` when the profile lacks `DELIVERY_ACTIONS`
  (`apply_gate`, `pr_open`). This is a harness-class release, retried once the authority is back.

Not in this change: the orphan reaper still writes its own class. Its call site is in
`autonomy_orchestrator.py`, which #1863 owns until it merges. This branch rebases onto #1863 and
routes the reaper through the same settlement before it is opened for review.

Tests:

- `aria-kernel/tests/test_implementation_settlement.py` (8): table completeness, settling once,
  scorecard attribution, lane fault, wrong role, store fault.
- `aria-kernel/tests/test_delivery_authority_admission.py` (2).

## Review corrections (adversarial review of `cd2166bb4`)

The review said **do not merge**. Each item below is either closed on this branch or disclosed
with its reason.

1. **HIGH, closed: an agent refusal was billed to the request.**
   - Every `agent_refused:<class>` settled `implementer_refused` / `request`, so the finding cooled
     off for 7 days. Today's case, `safety` for a missing git identity, was the host's fault.
   - An agent's refusal is the agent's word, which the kernel cannot verify. It now settles
     `unclassified`. `outage_attribution.failure_is_lane_fault` cools off on a verified `request`
     fault only.
   - Executor test: a host-caused refusal ends the plan `unclassified`, cools nothing off and
     blames no one.
2. **HIGH, closed except the reaper interaction: the `authority_absent` loop.**
   - `implementation_dispatch.implementation_dispatch_refusal` is the one dispatchability check:
     the delivery authority, plus whether the plan still awaits an implementation.
   - The queue's selection (`next_pending_request`) asks it before any claim. The executor asks it
     again before the identity mint and the credential lease. A skip is disclosed once per
     (request, cause). Nothing is minted, leased or spent.
   - A request whose plan already ended is never handed out, so no implementer runs on a dead
     plan.
   - Executor test: under `standard` the request is released harness-class with no turn, no key
     and no lease.
   - Disclosed: a request that waits more than 24 h for authority is still reaped by the orphan
     reaper, because the reaper ages it by wall time. The reaper's call site is in
     `autonomy_orchestrator.py`, owned by #1863. After #1863 lands this branch rebases and routes
     the reaper through the settlement, with the waiting cause as its fault domain.
3. **MEDIUM, closed: a stage was taken as a verified cause.** `settlement_for_delivery` now
   classifies by the refusal's own reason.
   - Only these are `request`: a scope drift, a secret-shaped diff, a result rejected for
     agent-only codes, and a gate blocked only by the agent's change.
   - A push or PR the remote refused is `harness`.
   - Anything else is `unclassified` (`implementation_delivery_unclassified`), which blames no one
     and cools nothing off.
4. **MEDIUM, disclosed: a harness fault after publication ends the plan.** Once the branch is
   published, a retry in place collides with it (`implementation_branch_collision`). So the plan
   ends `harness`, which never cools the finding off, and the next cycle re-plans the finding.
   Host faults before publication (window, sandbox, credential, authority) are still released and
   retried in place.
5. **MEDIUM, partly closed.**
   - The branch-collision and invalid-request pre-spawn exits now settle
     (`PRE_SPAWN_SETTLEMENT`).
   - The state check runs inside the plan lock (`plan_convergence.settle_implementation_rejected`),
     so a reaper that settled first is reported `already_settled`, not `failed`.
   - Disclosed: the reaper routing (see 2). An implementation result that the submit rejects after
     a successful delivery is outside the settlement.
6. **LOW, closed.**
   - Only `PlanLedgerLocked`, `LedgerIntegrityError` and `OSError` are caught; a programming error
     raises.
   - The executor settles after `_refuse_dispatch`, so a raise can no longer skip it.
   - The payload is a typed `ImplementationSettlement` written through
     `settle_implementation_rejected`. `record_implementation_rejected` is unchanged.
7. **Tests, closed except the reaper × authority interaction.**
   - The six executor tests assert the class and the `fault_domain`.
   - New executor tests cover the agent-refusal settlement and the pre-identity `authority_absent`
     release.
   - New unit tests cover reason classification, cool-off by domain, the lock race, a held lock, a
     programming error, and the queue's dispatchability.
   - The reaper × authority test lands with the reaper routing (see 2).
