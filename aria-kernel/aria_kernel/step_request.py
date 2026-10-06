"""One rule for a planning step's requests: wait, mint, mint a successor, or stop.

WHY this module exists (ARIA-HIGH-355, measured 2026-10-05). A plan's
convergence advances one (plan, role, round) step at a time, and two
producers mint those steps' envelopes: the convergence drainer (every
autonomy cycle) and the CLI round controller. They disagreed about a step
whose request is no longer deliverable:

* The round controller (Y3, ORPHAN-703) minted a successor with
  ``remint_of`` lineage when every prior request had died of queue mechanics
  (anchor age, expired lease budget, cancellation), bounded by a budget.
* The drainer raised ``_EnvelopeDead`` on ANY prior request that was not
  live, and the plan went HUMAN_REQUIRED. That included a request whose
  answer the drainer still had to read. The F-007 plan's completeness critic
  was answered and refused; the next cycle closed the plan
  (``convergence_envelope_dead:completeness_critique``) instead of folding
  the refusal into the coverage verdict.

A refused answer from a planning-round agent is a fact about the answer (a
citation the evidence law refuses, a malformed matrix), not about the plan.
The successor envelope names its predecessor, and the mint carries the
refusal's reasons into it (``agent_invocations.predecessor_rejection``), so
the next attempt is told what to correct.

The budget is per step and shared by both causes: ``MAX_STEP_REQUEST_REMINTS``
successors, then the step is ``exhausted`` and its producer decides what an
exhausted step means (the drainer escalates a planner step, and fails a
critic step closed to ``gaps``).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .agent_surface import REMINT_ELIGIBLE_DEAD_STATES
from .plan_round_scope import PLANNING_ROUND_ROLES

# A step's request in one of these states is still the executor's to deliver.
# STALE is a lease expiry the reaper requeues (ARIA-HIGH-086);
# ACCEPTED_PENDING_BRIDGE is answered and waiting for its bridge;
# EXTERNAL_OUTAGE is transient and reaped back to the queue.
LIVE_STEP_STATES: frozenset[str] = frozenset({
    "PENDING",
    "CLAIMED",
    "RUNNING",
    "SUBMITTED",
    "REQUEUED",
    "STALE",
    "ACCEPTED_PENDING_BRIDGE",
    "EXTERNAL_OUTAGE",
})

# Successors one step may mint, across queue deaths and refused answers.
MAX_STEP_REQUEST_REMINTS = 2


@dataclass(frozen=True)
class StepRequestDisposition:
    """What a producer does next for one (plan, role, round) step.

    ``kind``:
      * ``absent``    — no request yet: mint one.
      * ``live``      — ``request_id`` is still deliverable: wait for it.
      * ``remint``    — ``request_id`` (the newest) died or was refused and the
        budget allows a successor: mint one with ``remint_of=request_id``.
      * ``outcome``   — ``request_id`` reached a verdict the step consumes
        (ACCEPTED), or one no successor can change.
      * ``exhausted`` — the newest request died or was refused and the budget
        is spent.
    """

    kind: str
    request_id: str | None = None
    state: str | None = None
    remints_so_far: int = 0
    states: Mapping[str, str] = field(default_factory=dict)


def successor_eligible_states(role: str) -> frozenset[str]:
    """The newest-request states after which ``role``'s step mints a successor."""
    if role in PLANNING_ROUND_ROLES:
        return frozenset({*REMINT_ELIGIBLE_DEAD_STATES, "REJECTED"})
    return frozenset(REMINT_ELIGIBLE_DEAD_STATES)


def step_request_disposition(
    rows: list[dict[str, Any]], *, role: str, base_dir: str | Path,
) -> StepRequestDisposition:
    """Decide the next move for one step from its minted requests, oldest first."""
    from .agent_invocations import derive_request_state

    if not rows:
        return StepRequestDisposition("absent")
    states: dict[str, str] = {}
    for row in rows:
        request_id = str(row.get("request_id") or "")
        if request_id:
            states[request_id] = derive_request_state(request_id=request_id, base_dir=base_dir)
    for request_id, state in states.items():
        if state in LIVE_STEP_STATES:
            return StepRequestDisposition("live", request_id, state, states=states)
    newest = str(rows[-1].get("request_id") or "")
    newest_state = states.get(newest, "")
    remints_so_far = sum(1 for row in rows if row.get("remint_of"))
    if newest_state not in successor_eligible_states(role):
        return StepRequestDisposition("outcome", newest, newest_state, remints_so_far, states)
    kind = "remint" if remints_so_far < MAX_STEP_REQUEST_REMINTS else "exhausted"
    return StepRequestDisposition(kind, newest, newest_state, remints_so_far, states)
