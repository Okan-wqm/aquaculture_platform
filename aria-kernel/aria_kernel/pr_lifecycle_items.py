"""Which approved proposals the cycle's pr_lifecycle phase previews — read from their owners.

WHY. The phase previews ``open_pr_for_action(dry_run=True)`` for every
approved proposal it calls a candidate, and one refused preview fails the
phase, the cycle, and (fail-closed) the rest of the night: planner, bridge,
convergence, worker and reflection never run. Every way that has happened so
far was the phase asking the wrong record who owns a proposal's work:

* ORPHAN-CRITICAL-728 — an action still ``staged_for_implementation`` was
  previewed and refused, every cycle, forever.
* ARIA-HIGH-408 — an action whose PR the executor had already opened stayed
  ``ready_for_pr`` (the gate's verdict, which nothing advances) and was
  previewed again on a runner that does not have the executor's branch.
* ARIA-HIGH-412 — still open after both: an action whose plan the kernel had
  already settled (HUMAN_REQUIRED after three refused deliveries, REJECTED by
  the orphan reaper) sat in ``staged_for_implementation`` forever, eight of
  them on aria/state 2026-10-10; and a ``blocked`` action, an approved
  proposal with no apply action yet, an approval whose source is unknown, and
  a ``ready_for_pr`` action whose executor delivery was refused at a host
  stage were all still previewed and would each fail the night the same way.

WHAT. Each fact already has exactly one owner, and this module only reads
them; it appends no ledger row, so it adds no second copy of any status:

1. ``pr-lifecycle`` (``merge_record``) owns "does this change have a PR" —
   ``delivered``. Read first: a REJECTED plan whose orphan-reaped delivery is
   still mergeable, and a HUMAN_REQUIRED plan whose PR a person merged, are
   both answered here.
2. The proposal owns who approved it (``proposal.approval_source_of``, the one
   reader of that question). A MACHINE approval is a converged plan's
   staging, and the plan fold (``plan_convergence``) owns its work. The cycle
   never opens that PR — the executor does (``implementation_delivery``) and
   writes its own refusals back onto the plan (``settle_delivery_refusal``).
   So a machine-approved proposal is never a candidate: its plan is either
   still the executor's (``in_flight``) or finished (``settled``).
3. Only an OPERATOR approval is previewed here, and only once the apply gate
   has said ``ready_for_pr``: no action yet is ``awaiting_apply``, an action
   still being built is ``in_flight``, a gate refusal is ``gate_blocked``.

Anything outside those shapes — an approval with no known source, a machine
approval whose staging names no plan, a plan in a state no staging can
produce, an action status this module does not know — is ``unowned``:
reported, never previewed. Previewing it could only be refused by
``open_pr_for_action`` and fail the night.

The two plan-state sets are DERIVED from ``plan_convergence``'s own
constants, not restated: every terminal state except CONVERGED (which V9
re-opens into the implementation phase) ends the plan's delivery, and
CONVERGED plus the implementation phase is the executor's.
``tests/test_pr_lifecycle_plan_ownership.py`` pins that they cover every
post-convergence state the reducer assigns, with no overlap.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .plan_convergence import IMPLEMENTATION_PHASE_STATES, TERMINAL_STATES

SETTLED_PLAN_STATES: frozenset[str] = frozenset(TERMINAL_STATES - {"CONVERGED"})
EXECUTOR_OWNED_PLAN_STATES: frozenset[str] = frozenset({"CONVERGED"} | IMPLEMENTATION_PHASE_STATES)


@dataclass
class PrLifecycleItems:
    """Every approved proposal, in exactly one bucket. Only ``candidates`` are previewed."""

    candidates: list[dict[str, Any]] = field(default_factory=list)
    delivered: list[dict[str, Any]] = field(default_factory=list)
    settled: list[dict[str, Any]] = field(default_factory=list)
    in_flight: list[dict[str, Any]] = field(default_factory=list)
    gate_blocked: list[dict[str, Any]] = field(default_factory=list)
    awaiting_apply: list[dict[str, Any]] = field(default_factory=list)
    unowned: list[dict[str, Any]] = field(default_factory=list)


def classify_pr_lifecycle_items(*, base_dir: str | Path | None) -> PrLifecycleItems:
    """Sort the approved proposals by who owns their next step.

    The owners are imported here, at call time, for the same reason
    ``cycle._run_pr_lifecycle_phase`` always did: tests substitute them where
    they are looked up. A ledger-integrity error from the plan fold is not
    caught — an untrustworthy plan ledger is a loud phase failure, not a
    proposal to skip.

    ``list_proposals`` returns raw rows and an approval may be written more
    than once; a proposal is classified once, at its first approved row.
    """
    from .apply_engine import IN_FLIGHT_APPLY_STATUSES, latest_apply_action
    from .merge_record import lifecycle_rows, pull_requests_for_change
    from .plan_convergence import fold_plan_state
    from .proposal import approval_source_of, list_proposals

    lifecycle = lifecycle_rows(base_dir)
    items = PrLifecycleItems()
    seen: set[str] = set()
    for prop in list_proposals(base_dir=base_dir):
        if prop.get("status") != "approved_for_apply":
            continue
        proposal_id = str(prop.get("proposal_id") or "")
        if proposal_id in seen:
            continue
        seen.add(proposal_id)
        action = latest_apply_action(proposal_id=proposal_id, base_dir=base_dir)
        if action is None:
            items.awaiting_apply.append({"proposal_id": proposal_id})
            continue
        status = action.get("status")
        change_id = action.get("change_id")
        pull_requests = pull_requests_for_change(
            lifecycle, proposal_id=proposal_id, change_id=change_id,
        )
        if pull_requests:
            items.delivered.append({
                "proposal_id": proposal_id,
                "change_id": change_id,
                "pull_requests": pull_requests,
            })
            continue
        source = approval_source_of(prop)
        row = {"proposal_id": proposal_id, "approval_source": source, "apply_action_status": status}
        if source == "machine":
            plan_id = action.get("plan_id")
            plan_state = (
                fold_plan_state(plan_id=str(plan_id), base_dir=base_dir).get("state")
                if plan_id else None
            )
            row = {**row, "plan_id": plan_id, "plan_state": plan_state}
            if plan_state in SETTLED_PLAN_STATES:
                items.settled.append(row)
            elif plan_state in EXECUTOR_OWNED_PLAN_STATES:
                items.in_flight.append(row)
            else:
                items.unowned.append(row)
        elif source == "operator":
            if status in IN_FLIGHT_APPLY_STATUSES:
                items.in_flight.append(row)
            elif status == "blocked":
                items.gate_blocked.append(row)
            elif status == "ready_for_pr":
                items.candidates.append(prop)
            else:
                items.unowned.append(row)
        else:
            items.unowned.append(row)
    return items
