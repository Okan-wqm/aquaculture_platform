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

## Re-review corrections (`044a4e65f`)

- **N1, closed: a red baseline was blamed on the implementer.**
  - `validation.py` sets `candidate_validation_not_green` whenever the candidate run is not ok,
    including when the baseline was red too (a red main, a missing toolchain).
  - A blocked gate is now the agent's fault only when a blocker proves it: `validation_regression`
    (worse than the baseline) or `suppression_pattern` (in its own diff).
  - `candidate_validation_not_green` alone is `unclassified`.
- **N2, closed: under `frozen`, the selection raised on its own disclosure.**
  - `next_pending_request` asks once whether the profile admits its records (claims and
    governance).
  - Under a profile that stops writes, an undispatchable request and a stale anchor are still
    skipped, just not recorded. `agent next-pending` and the drain keep answering.
- **N3, closed: re-plans of a subject were unbounded.**
  - One `harness`/`unclassified` implementation ending cools nothing off; it can be the host's.
  - The second consecutive such ending of one subject is evidence about the subject.
    `finding_grounding` then cools the subject off (`SUBJECT_COOL_OFF`,
    `repeated_unverified_failure`), disclosed by the guard's refusal row.
  - A merge or a verified failure in between breaks the streak.
  - Why a cool-off and not a quarantine: the cause is unverified. A cool-off lifts on its own once
    the host is fixed; a quarantine needs an operator's merge.
- **N4, closed: a request on an ended plan stayed in the queue.** `plan_request_closure` ends an
  unheld implementation request whose plan left its implementation phase (rejected, merged,
  abandoned, escalated) with `plan_closed`, which reads as CANCELLED.
  - The settlement closes its plan's queue, and the pre-mint sweep closes it after a reap.
  - CONVERGED is excluded: a request on a still-CONVERGED plan is the mint's crash window, which
    `converged_delivery` recovers.
- **N5, closed: a held plan lock left the plan to the reaper.** The settlement retries a held
  lock three times, one and two seconds apart, before it records the row.
- **Reaper, closed (after #1863): the reap goes through the settlement.**
  - `implementation_settlement.settle_orphaned_plan` is the reaper's writer. It reads the plan's
    newest implementation request and decides the fault domain from its wait.
  - Still waiting on the lane is `harness`: never claimed, or last released for a harness cause
    (an outage, a missing delivery authority, a window). The cause is the wait's, e.g.
    `authority_absent`. Anything else (claimed and lost, answered) is `unclassified`.
  - The reap never judged an answer, so it is never `request` and never cools a finding off.
  - The state is checked under the plan lock. A plan the executor settled first is
    `already_settled`, counted in the reaper summary (`already_settled_count`), never "spared".
    A settlement the store refused is `reap_failed_count`, beside its own failure row.
  - Tests: the reap of a plan waiting on the delivery authority under `standard` (kernel and
    orchestrator level), an answered request (`unclassified`), and an executor that settled first.
- **Submit refused after delivery, tracked.** A result refused after a successful delivery (the PR
  already open) is not settled; settling it needs a decision on the open PR. Tracked as
  ARIA-HIGH-389 (owner claude, deadline 2026-10-15).

## Folded in from the ARIA-HIGH-387 (#1865) re-review

- **L1, closed: an operator approval switched the implementer's identity check off.**
  - `pr_manager._commit_identity_for_proposal` names the implementer's identity only for a machine
    approval. After an operator's `approve_proposal` on a converged proposal, the implementer's
    commits were delivered unchecked.
  - The delivery knows these commits are the implementer's, so it now passes
    `IMPLEMENTER_COMMIT_IDENTITY` to `prepare_pr_open(expected_commit_identity=…)` itself,
    whoever approved.
  - Test: with the approver-keyed lookup returning nothing, a foreign commit is still refused at
    `pre_pr_open`. The same test fails on the code before this change.

## Operator notes

- **L2: a manual `pr open` with human commits on a machine-approved branch is refused.**
  - Since ARIA-HIGH-387, every commit on such a branch must be authored and committed by the
    implementer identity (`commit_identity_is_the_kernels`).
  - An operator hand-fix, or a branch-updater merge from main, is therefore refused
    `commit_identity_foreign`.
  - To ship such a branch, approve the proposal as an operator (`approve_proposal`). A manual
    `pr open` is then no longer held to the implementer identity. The implementation delivery
    still is: it names that identity itself (L1).
