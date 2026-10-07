"""ARIA-HIGH-368 — the executor advances a plan the moment a step's answer lands.

THE MEASURED DEFECT. A plan round took about 18 hours. Convergence is a
resumable step function (``convergence_drainer.run_convergence_drainer``,
CL-1): each call advances ONE derived step and mints the next envelope. Its
only caller was the nightly cycle, so every step paid a full cycle →
executor → cycle turn: the cycle minted the challenger, the executor answered
it, the NEXT cycle minted the cross review, the next executor answered it,
and so on through primary revision, completeness critique, convergence and
the implementation request. The executor already held every answer the next
step needed; it just was not allowed to take the step.

THE FIX. After a planning-step result is accepted in ``drain_pending``, the
executor calls the SAME step function the cycle calls, with the same round
cap (``AUTONOMY_CYCLE_MAX_ROUNDS``). The next envelope is minted in this run
and the drain's planning turn (plan progress before backlog) claims it in
this run. One function advances plans; it now has two callers, both of which
hold the store.

WHAT BOUNDS IT.
  * The aria/state writer lease (ARIA-HIGH-342). Only the job holding it may
    write the store; the executor workflow hands the restore's verdict to
    the drain step as ``ARIA_STATE_WRITER_LEASE`` and anything but ``held``
    advances nothing. A local drain therefore leaves the advance to the
    cycle, exactly as before.
  * ``ARIA_JOB_DEADLINE_EPOCH`` — the job's own absolute deadline, the one
    every spawn and delivery in the job already runs under.
  * ``MAX_CONVERGENCE_ADVANCES_PER_RUN`` — a whole debate at the cycle's
    round cap, and no more, so one plan cannot turn a run into a loop.
  * Idempotency per (plan, role, round) is the step function's own
    (``step_request``): a second advance on an unchanged state finds the
    live envelope and mints nothing.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .agent_surface import PLANNER_BRIDGE_ROLES
from .convergence_drainer import AUTONOMY_CYCLE_MAX_ROUNDS
from .cross_review_bridge import COMPLETENESS_CRITIC_ROLE, IMPLEMENTATION_ROLE

# The roles whose accepted answer moves a plan's CONVERGENCE (never its
# implementation, which the V9 runner and the merge lane own). Derived from
# the bridge constants the drain's planning lane is derived from.
PLANNING_STEP_ROLES: frozenset[str] = (
    frozenset(PLANNER_BRIDGE_ROLES) - {IMPLEMENTATION_ROLE[1]}
) | {COMPLETENESS_CRITIC_ROLE[1]}

# A round is at most four answered steps: the primary revision (rounds 2+),
# the challenger, the cross review and the completeness critique. A whole
# debate at the cycle's round cap is therefore this many advances; a run that
# reaches it has advanced one plan as far as the cap lets any plan go.
ADVANCES_PER_ROUND: int = 4
MAX_CONVERGENCE_ADVANCES_PER_RUN: int = AUTONOMY_CYCLE_MAX_ROUNDS * ADVANCES_PER_ROUND

# The restore action's verdict (`.github/actions/restore-aria-state`, output
# `writer-lease`), handed to the executor step by the workflow.
WRITER_LEASE_ENV: str = "ARIA_STATE_WRITER_LEASE"
WRITER_LEASE_HELD: str = "held"
JOB_DEADLINE_ENV: str = "ARIA_JOB_DEADLINE_EPOCH"
# The convergence drainer's `cycle_id` names who advanced; an executor run
# is not a cycle and must never be mistaken for one.
EXECUTOR_ADVANCE_PREFIX: str = "executor-"
ADVANCE_GOVERNANCE_KIND: str = "executor_convergence_advanced"

SKIP_NOT_PLANNING_STEP = "not_a_planning_step"
SKIP_NO_PLAN = "request_names_no_plan"
SKIP_LEASE_NOT_HELD = "writer_lease_not_held"
SKIP_JOB_DEADLINE = "job_deadline_reached"
SKIP_ADVANCE_CAP = "advance_cap_reached"
SKIP_PLAN_NOT_CONVERGING = "plan_not_converging"
ADVANCE_FAILED = "advance_failed"


@dataclass
class AdvanceBudget:
    """One drain run's advances: the cap's counter and the audit trail."""

    advances: int = 0
    outcomes: list[dict[str, Any]] = field(default_factory=list)


def writer_lease_held(environ: Mapping[str, str]) -> bool:
    return environ.get(WRITER_LEASE_ENV, "").strip() == WRITER_LEASE_HELD


def job_deadline_epoch(environ: Mapping[str, str]) -> float | None:
    """The job's absolute deadline, or None (a local run binds nothing —
    the spawn clamp's contract, ORPHAN-661). Garbage is the spawn clamp's
    to refuse loudly; here it binds nothing."""
    raw = environ.get(JOB_DEADLINE_ENV)
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def executor_cycle_id(run_id: str) -> str:
    return f"{EXECUTOR_ADVANCE_PREFIX}{run_id}"


def _skip(reason: str, request: Mapping[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "status": "skipped",
        "reason": reason,
        "trigger_request_id": request.get("request_id"),
        "trigger_role": request.get("role"),
        **extra,
    }


def advance_after_accepted_step(
    *,
    request: Mapping[str, Any],
    tools_dir: Path,
    workspace_root: Path,
    run_id: str,
    budget: AdvanceBudget,
    drain_remaining_seconds: float | None,
    environ: Mapping[str, str] | None = None,
    now: Callable[[], float] = time.time,
    converged_seam: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Take the next convergence step for the plan ``request`` answered.

    Returns the outcome: ``skipped`` with the gate that refused, ``failed``
    with the store fault, or ``advanced`` with the step's verdict, the
    envelopes it minted and — when the plan converged — what the converged
    seam did with it (``executor_converged_seam``).
    """
    from .bridge_exceptions import BridgeContractViolation
    from .convergence_drainer import run_convergence_drainer
    from .ledger import LedgerIntegrityError
    from .plan_convergence import TERMINAL_STATES, fold_plan_state
    from .tool_registry import GovernanceError, append_tools_governance

    env = os.environ if environ is None else environ
    role = str(request.get("role") or "")
    plan_id = str(request.get("convergence_id") or "")
    if role not in PLANNING_STEP_ROLES:
        return _skip(SKIP_NOT_PLANNING_STEP, request)
    if not plan_id:
        return _skip(SKIP_NO_PLAN, request)
    if not writer_lease_held(env):
        return _skip(SKIP_LEASE_NOT_HELD, request, plan_id=plan_id)
    deadline = job_deadline_epoch(env)
    if deadline is not None and now() >= deadline:
        return _skip(SKIP_JOB_DEADLINE, request, plan_id=plan_id)
    if budget.advances >= MAX_CONVERGENCE_ADVANCES_PER_RUN:
        return _skip(SKIP_ADVANCE_CAP, request, plan_id=plan_id, advances=budget.advances)
    # The step function STARTS a plan it cannot find (from `plan_seed`); the
    # executor has no seed and must never start one. A plan already terminal
    # or in its implementation phase has no convergence step left to take.
    plan_state = fold_plan_state(plan_id=plan_id, base_dir=tools_dir).get("state")
    if plan_state is None or plan_state in TERMINAL_STATES or plan_state.startswith("IMPLEMENTATION_"):
        return _skip(SKIP_PLAN_NOT_CONVERGING, request, plan_id=plan_id, plan_state=plan_state)

    budget.advances += 1
    cycle_id = executor_cycle_id(run_id)
    outcome: dict[str, Any] = {
        "status": "advanced",
        "trigger_request_id": request.get("request_id"),
        "trigger_role": role,
        "plan_id": plan_id,
        "from_state": plan_state,
        "advance_number": budget.advances,
    }
    try:
        result = run_convergence_drainer(
            cycle_id=cycle_id,
            base_dir=tools_dir,
            workspace_root=workspace_root,
            plan_id=plan_id,
            plan_seed={},
            max_rounds=AUTONOMY_CYCLE_MAX_ROUNDS,
        )
    except (GovernanceError, BridgeContractViolation, LedgerIntegrityError, OSError) as exc:
        # A store or contract fault of THIS plan's step, not the drain's: the
        # cycle meets the same state next and handles it as it always has
        # (`convergence_invalid_plan`). Programming errors raise.
        outcome.update(status=ADVANCE_FAILED, error_class=type(exc).__name__, error_message=str(exc)[:500])
        append_tools_governance(tools_dir, ADVANCE_GOVERNANCE_KIND, {"cycle_id": cycle_id, **outcome})
        budget.outcomes.append(outcome)
        return outcome
    outcome.update(
        verdict=result["arbiter_verdict"],
        minted_request_ids=list(result.get("request_ids") or []),
        to_state=fold_plan_state(plan_id=plan_id, base_dir=tools_dir).get("state"),
    )
    if result["arbiter_verdict"] == "converged":
        if converged_seam is None:
            from .executor_converged_seam import run_executor_converged_seam as converged_seam
        outcome["converged_seam"] = converged_seam(
            plan_id=plan_id,
            cycle_id=cycle_id,
            convergence_result=result,
            tools_dir=tools_dir,
            workspace_root=workspace_root,
            drain_remaining_seconds=drain_remaining_seconds,
            deadline_epoch=deadline,
            now=now,
        )
    append_tools_governance(tools_dir, ADVANCE_GOVERNANCE_KIND, {"cycle_id": cycle_id, **outcome})
    budget.outcomes.append(outcome)
    return outcome


__all__ = [
    "ADVANCES_PER_ROUND",
    "ADVANCE_GOVERNANCE_KIND",
    "AdvanceBudget",
    "MAX_CONVERGENCE_ADVANCES_PER_RUN",
    "PLANNING_STEP_ROLES",
    "WRITER_LEASE_ENV",
    "WRITER_LEASE_HELD",
    "advance_after_accepted_step",
    "executor_cycle_id",
    "job_deadline_epoch",
    "writer_lease_held",
]
