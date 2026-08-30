# One thing in flight at a time — and a way out when it dies

Date: 2026-08-04
Branch: `claude/aria-w2-wip-gate`
Scope: `aria_kernel/mission.py`, `aria_kernel/worker_dispatch.py`,
`aria_kernel/promotion_controller.py`, `aria_kernel/cycle.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 2 PR 1.4

## The rule and the gap

Operator rule, 2026-07-28: ARIA must not start a new plan before the current
one is completely finished, and must not leave work half-done. Nothing enforced
it. `promote_converged_plan_to_dispatch` would mint a second worker assignment
while the first was still being worked, and the first one's half-finished
branch would simply be left behind.

## The finding named a data source that could never have fired

ORPHAN-HIGH-487 proposed gating on `plan_convergence.list_active_plans()`,
noting correctly that it is computed, cached, published — and read by nobody
except a cycle summary. Building the gate on it would have been wrong, and the
reason is worth recording because it is the same trap in a new costume.

`list_active_plans()` filters out `TERMINAL_STATES`, and **`CONVERGED` is in
that set**. `promote_converged_plan_to_dispatch` refuses any plan that is not
CONVERGED. So the candidate is structurally never in the active list. Neither
is any previously-promoted plan: promotion writes a dispatch row and **no plan
event at all**, so a promoted plan stays CONVERGED, which is terminal.

A gate reading that source would have been green on every call, forever —
machinery written and unable to fire, the exact defect class this programme
keeps closing, introduced by the fix for one instance of it.

**The live in-flight record is the DISPATCH ASSIGNMENT**, folded by
`_latest_assignment_states` from rows the promotion path actually writes. That
is what the gate reads. The mission-level WIP count reads
`ACTIVE_WIP_STATES`, and it is the record the mission layer is taking over as
PR 1.5 weaves mission ids through plans and dispatches. Both are checked; both
are real today.

## Admission alone would have been worse than nothing

`_derive_assignment_state` has always documented a reaper: _"The reaper writes
`expired` when a lease times out."_ **There was no reaper**, and nothing has
ever produced `expired`. `cancel_dispatch_request` is the only writer of a dead
assignment state, and it is operator-invoked.

So a worker that died left its assignment `picked_up` forever. Harmless while
nothing read the in-flight set — and a permanent freeze the moment this PR's
gate started reading it: one abandoned worker, and ARIA never promotes another
plan. The finding predicted exactly this ("the first without the second would
merely block forever"), which is why both halves land together.

`reap_expired_assignment_claims` is that reaper. Three decisions in it:

**It writes into the vocabulary the fold already understands.** `released`
returns the assignment to `pending`; `human_required` is terminal. It does not
introduce `expired`, which the fold has no claims-row producer for — two dead
states for one death is a vocabulary that has to be kept in agreement with
itself. The stale docstring is corrected rather than left promising a reaper
that now exists somewhere else.

**It does not go through `release_claim_assignment`.** That function
authenticates the caller against the raw lease token, and only the token's
_hash_ is persisted, so the system genuinely cannot present one. The check
exists to stop one worker releasing another's _live_ claim. Here the claim is
expired, and the expiry is the authority — which is why the reaper reads the
deadline the claim itself recorded and **refuses to act without one**. A claim
carrying no `lease_expires_at` is a claim it cannot judge; guessing would kill
live work. Same rule as reconciliation: absence is not damage.

**The requeue budget is borrowed, not invented.** `DEFAULT_MAX_LEASE_REQUEUES`
mirrors `agent_invocations.DEFAULT_MAX_REQUEUES`. The same ladder over the same
failure — a claim whose holder stopped answering — should not have two
different budgets, and the operator's open question in the finding ("how long
may an in-flight plan block?") is answered by policy that already exists rather
than by a new number nobody has reviewed.

## Where the boundaries sit, and why

`ACTIVE_ASSIGNMENT_STATES` is `{pending, prepared, picked_up, submitted}`.

**`verified` is deliberately absent.** Nothing in this state machine moves an
assignment past verification. Whether the PR then merges is the MISSION layer's
question, answered by `mission_reconcile` against GitHub — which is the right
division, and counting `verified` here would hold the slot forever on a machine
that has no event to release it.

`DISCOVERED` missions hold no WIP slot. `mission_ingest` opens every candidate
in that state, so if discovery consumed WIP the first night's adoption would
block every promotion after it. Waiting states hold none either — the reason
`WAITING_STATES` sits outside `ACTIVE_WIP_STATES` in the first place.

`assert_wip_available` **raises**. A function returning `{"available": False}`
reproduces the defect being closed the first time a caller forgets to read the
field. The one caller whose contract is a blocker list rather than a stop —
`promote_converged_plan_to_dispatch` — translates the refusal at its own
boundary, and the governance row names the blocking assignment ids, because a
refusal that does not say what is holding the slot is a refusal an operator
cannot act on.

The WIP checks run **first**, before the per-plan checks. A second promotion
attempted while work is in flight would otherwise report whatever the candidate
plan's own state happens to be and hide the real reason.

## What a test found that a green suite had not

The first version of the ladder fixture re-claimed an assignment with the same
`claimed_at` on every rung, and the suite went green. The stricter version —
asserting the assignment is still in flight _before_ each reap — went red:
`_latest_assignment_states` folds by timestamp, so two claims sharing one
instant are indistinguishable from two live claims, and the fold correctly
called it `multiple_active_claims_corruption`. Production time moves between
claims; the fixture now does too. A fixture unlike production is a suite that
proves less than its names claim.

## Verification

`aria-kernel/tests/test_wip_gate.py` — 27 tests, written before the code.

**Mutation-checked seventeen ways, all killed:**

| Mutation                                           | Result  |
| -------------------------------------------------- | ------- |
| `verified` counts as in flight                     | 2 fail  |
| a claim with no deadline is treated as expired     | 1 fail  |
| an already-terminal claim is released again        | 3 fail  |
| the ladder never escalates                         | 3 fail  |
| the expiry counter never advances                  | 3 fail  |
| a requeue writes `stale` instead of `released`     | 4 fail  |
| a dead assignment is reaped again                  | 1 fail  |
| DISCOVERED missions consume WIP                    | 2 fail  |
| `assert_wip_available` reports instead of refusing | 3 fail  |
| the admitting mission blocks itself                | 1 error |
| the dispatch blocker is dropped                    | 2 fail  |
| the mission blocker is dropped                     | 1 fail  |
| the WIP check runs after the plan-state check      | 1 fail  |
| the refusal stops naming what blocks it            | 1 fail  |
| the reaper phase row is deleted                    | 2 fail  |
| the reaper phase joins burn-in                     | 1 fail  |
| the WIP cap is widened silently                    | 3 fail  |

Kernel suite 3215 OK; `invariants:fast` green; run **sequentially**.

## Findings

- **ORPHAN-HIGH-487** — nothing stops ARIA promoting a second plan while one is
  still in flight. CLOSED by this change: admission at the mutation throat plus
  the lease reaper that keeps admission from becoming a freeze. The finding's
  two open operator decisions are answered rather than left open — a
  closed-unmerged PR counts as **failed, needing rework** (PR 1.3's reconciler
  advances the retry ladder rather than calling it finished), and the
  block-forever timeout is the claim lease that already exists rather than a new
  number.
- **ORPHAN-HIGH-545** (new) — the plan state machine's entire implementation
  phase is unreachable. `request_implementation`, `record_implementation_started`,
  `record_implementation_outcome`, `record_implementation_merged` and
  `record_implementation_rejected` have **no production caller**, so a promoted
  plan never leaves CONVERGED, `_require_coverage_for_implementation` never
  runs, and `IMPLEMENTATION_MERGED`/`IMPLEMENTATION_REJECTED` are unreachable
  terminal states. Found while verifying 487's proposed data source. NOT fixed
  here: wiring five events through five points of the dispatch lifecycle is its
  own change, and doing it inside this one would have shipped an unreviewed
  state-machine rewrite behind a gate fix.
- **ORPHAN-HIGH-544** — #1066's finding; its close ceremony rides whichever PR
  lands after #1066 merges, because `close` refuses a branch-local SHA.
- 487's own close ceremony rides the next PR, for the same reason.

Owner: okan
