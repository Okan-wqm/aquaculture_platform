"""ARIA-HIGH-362 — a CONVERGED plan is offered to the V9 runner until it leaves CONVERGED.

WHY. ``CONVERGED`` is terminal for convergence (``plan_convergence.TERMINAL_STATES``),
so neither ``list_active_plans`` nor ``resume_candidate_plan_id`` ever looks at a
converged plan again. The V9 implementation runner was called in exactly one
place: the cycle whose drainer returned ``converged``. Whatever that one call
produced was final. Under ``standard`` it is the NoOp's refusal; under
``strict`` a dirty workspace, a plan without an architectural tier or an
unregistered recipe makes staging raise (``implementation_staging_governance_
error``), and any other fault becomes ``runner_exception:<class>``. Each of
those left the plan CONVERGED for good, with one governance row that nothing
reads. A plan the whole P+C+CR debate agreed on was delivered at most once,
and only if the night it converged happened to be a night that could deliver.

WHAT. One function offers a converged plan to the runner,
:func:`deliver_converged_plan`, and both callers use it: the converging cycle
(origin ``converged_this_cycle``) and a sweep at the start of every later
cycle (:func:`redeliver_stranded_converged_plans`, origin
``stranded_redelivery``).

* **What counts.** An offer is a counted attempt only when the runner that runs
  declares it can deliver (``delivers_implementation``, review M5 — the
  runner's own class, never the cycle's profile string). The attempt is
  recorded as ``implementation_delivery_attempted`` on the plan's own ledger
  BEFORE the call, so the count survives a process killed inside the runner,
  idempotent per (plan, attempt). A staging step the PROFILE refused (a
  mid-cycle demotion, ``STAGING_PROFILE_REFUSED``) voids the attempt: weather,
  not the plan.
* **What is withheld, uncounted.** A plan that left CONVERGED; one with a live
  implementation request (the mint appends the request before the plan
  transition); one offered once this cycle; and an offer into a DIRTY tree
  (review M6): the sweep's baseline can leave an untracked artefact behind,
  and staging refuses a dirty tree for every plan alike, so the dirt is the
  lane's state and must not spend the converging plan's attempt.
* **The bound.** After ``MAX_DELIVERY_ATTEMPTS`` counted attempts the plan
  moves, under the plan lock and only from CONVERGED with no live request
  (review M3), to ``HUMAN_REQUIRED`` with reason code
  ``implementation_delivery_exhausted``, and the operator record
  ``human-required/converged-delivery-exhausted-<plan>.json`` is written. A
  plan whose transition landed but whose record did not is repaired by the
  next sweep.
* **No authority, for long.** A lane whose runner cannot deliver (a permanent
  ``standard`` ceiling) never spends a plan's attempts, so on its own it would
  never surface the plan. After ``AUTHORITY_ABSENT_CYCLES`` such cycles since
  the plan's last counted attempt, the operator record
  ``converged-delivery-no-authority-<plan>.json`` (reason
  ``implementation_authority_absent``) is written. The plan is NOT
  transitioned: the authority may come back.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import load_jsonl

# Three offers by a lane that could deliver. One refusal can be the weather
# (a red baseline); three in a row on three cycles is the plan, and a person
# has to look at it.
MAX_DELIVERY_ATTEMPTS: int = 3
# Staging runs the plan's validation suite as its baseline, so one re-offer
# per cycle keeps a backlog of stranded plans from turning one cycle into N
# baseline runs. Escalations are not bounded: they run no suite.
REDELIVERIES_PER_CYCLE: int = 1
# A week of nightly cycles in which no runner could deliver the plan.
AUTHORITY_ABSENT_CYCLES: int = 7
DELIVERY_EXHAUSTED_REASON: str = "implementation_delivery_exhausted"
AUTHORITY_ABSENT_REASON: str = "implementation_authority_absent"
# The same surfacing when the uncounted cycles were not all for missing
# authority (a lane that keeps leaving its tree dirty, review of #1813).
DELIVERY_WITHHELD_REASON: str = "implementation_delivery_withheld"
HUMAN_REQUIRED_CONTEXT_KIND: str = "converged_plan_delivery"
UNCOUNTED_GOVERNANCE_KIND: str = "converged_delivery_uncounted"
ORIGIN_CONVERGED: str = "converged_this_cycle"
ORIGIN_REDELIVERY: str = "stranded_redelivery"
# ARIA-HIGH-368 — the executor run whose in-run advance converged the plan
# (`executor_converged_seam`); counted like the converging cycle's offer.
ORIGIN_EXECUTOR: str = "converged_in_executor_run"
VOID_PROFILE_REFUSED: str = "profile_refused_at_staging"

# Why an offer was not made. Named so the cycle summary and the tests read the
# same strings.
WITHHELD_NOT_CONVERGED: str = "not_converged"
WITHHELD_REQUEST_LIVE: str = "implementation_request_live"
WITHHELD_OFFERED_THIS_CYCLE: str = "offered_this_cycle"
WITHHELD_EXHAUSTED: str = "attempts_exhausted"
WITHHELD_ATTEMPT_TAKEN: str = "attempt_claimed_elsewhere"
WITHHELD_ATTEMPT_UNRECORDED: str = "attempt_unrecorded"
WITHHELD_NO_AUTHORITY: str = "no_implementation_authority"
WITHHELD_CYCLE_BOUND: str = "per_cycle_bound"
WITHHELD_WORKSPACE_DIRTY: str = "workspace_dirty"
# ARIA-HIGH-375 — a CONVERGED plan whose converging evaluation predates the
# independence gate, judged now and found self-agreeing: moved to
# HUMAN_REQUIRED, never offered.
WITHHELD_NOT_INDEPENDENT: str = "convergence_not_independent"
INDEPENDENCE_MIGRATED_KIND: str = "converged_independence_migrated"
INDEPENDENCE_MIGRATION_FAILED_KIND: str = "converged_independence_migration_failed"
WITHHELD_INDEPENDENCE_UNJUDGED: str = "independence_unjudged"


def human_required_request_id(plan_id: str) -> str:
    return f"converged-delivery-exhausted-{plan_id}"


def authority_absent_request_id(plan_id: str) -> str:
    return f"converged-delivery-no-authority-{plan_id}"


def _record_exists(base_dir: Path, request_id: str) -> bool:
    return (base_dir / "human-required" / f"{request_id}.json").exists()


def live_implementation_request_ids(plan_id: str, *, base_dir: Path) -> list[str]:
    """Implementation requests for ``plan_id`` whose derived state is not terminal.

    The envelope mint appends the request row BEFORE it writes the plan's
    ``implementation_requested`` event, so a process that dies between the
    two leaves a live request on a plan that still folds to CONVERGED. Offering
    that plan again would mint a second envelope for work already queued.
    """
    from .agent_invocations import derive_request_state, list_agent_invocation_requests
    from .agent_surface import TERMINAL_REQUEST_STATES
    from .cross_review_bridge import IMPLEMENTATION_ROLE

    live: list[str] = []
    for row in list_agent_invocation_requests(
        base_dir=base_dir, convergence_id=plan_id, role=IMPLEMENTATION_ROLE[1],
    ):
        request_id = str(row.get("request_id") or "")
        if request_id and derive_request_state(
            request_id=request_id, base_dir=base_dir,
        ) not in TERMINAL_REQUEST_STATES:
            live.append(request_id)
    return live


def _plan_ledger_scan(base_dir: Path) -> tuple[list[str], list[str]]:
    """(CONVERGED plans oldest convergence first, plans ended by exhaustion) — one ledger pass."""
    from .ledger import load_declared_jsonl
    from .plan_convergence import events_path, fold_plan_state

    path = events_path(base_dir)
    if not path.exists():
        return [], []
    converged_at: dict[str, str] = {}
    exhausted: set[str] = set()
    for event in load_declared_jsonl(path, expected_surface="plan_convergence_events"):
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event.get("event_type") != "plan_evaluated":
            continue
        plan_id = str(event.get("plan_id"))
        if payload.get("terminal_state") == "CONVERGED":
            converged_at[plan_id] = str(event.get("recorded_at") or "")
        elif DELIVERY_EXHAUSTED_REASON in (payload.get("reason_codes") or []):
            exhausted.add(plan_id)
    ordered = sorted(converged_at, key=lambda plan_id: (converged_at[plan_id], plan_id))
    converged = [
        plan_id for plan_id in ordered
        if fold_plan_state(plan_id=plan_id, base_dir=base_dir).get("state") == "CONVERGED"
    ]
    return converged, sorted(exhausted)


def converged_plan_ids(*, base_dir: Path) -> list[str]:
    """Plans that fold to CONVERGED, oldest convergence first (one ledger pass)."""
    return _plan_ledger_scan(base_dir)[0]


def withhold_ungated_self_agreement(plan_id: str, *, base_dir: Path) -> bool:
    """True when ``plan_id`` must not be offered because its convergence was
    never independence-gated and fails the gate now (ARIA-HIGH-375).

    Every evaluation since ARIA-HIGH-375 carries the gate, so this judges
    only plans CONVERGED before it (or by a ledger written by hand). A plan
    that fails is moved CONVERGED → HUMAN_REQUIRED under the plan lock, with
    one operator item; the move is the migration's record, so a plan is
    judged and moved at most once. A plan that passes stays CONVERGED.
    """
    from .convergence_outcome import record_parked_plan
    from .plan_convergence import (
        CROSS_REVIEW_SELF_AGREEMENT_REASON,
        PlanStateRefused,
        cross_reviewed_round,
        fold_plan_state,
        force_plan_human_required,
        independence_gated,
    )
    from .round_independence import round_independence_verdict
    from .tool_registry import append_tools_governance

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "CONVERGED":
        return False
    converging = next(
        (event.get("payload") or {} for event in reversed(state.get("events") or [])
         if event.get("event_type") == "plan_evaluated"
         and (event.get("payload") or {}).get("terminal_state") == "CONVERGED"),
        None,
    )
    if converging is None or independence_gated(converging):
        return False
    round_number = int(converging.get("round_number") or state.get("current_round") or 1)
    if not cross_reviewed_round(state, round_number):
        # A legacy critique-only round: no cross reviewer, nothing to judge.
        return False
    passed, violations = round_independence_verdict(
        plan_id=plan_id, round_number=round_number, state=state, base_dir=base_dir,
    )
    if passed:
        return False
    try:
        force_plan_human_required(
            plan_id=plan_id, round_number=round_number,
            reason_codes=[CROSS_REVIEW_SELF_AGREEMENT_REASON],
            from_states=frozenset({"CONVERGED"}), base_dir=base_dir,
        )
    except PlanStateRefused:
        # Left CONVERGED under the lock (a mint got there first): what it is
        # now is not an offer this path may make either.
        return True
    append_tools_governance(
        base_dir, INDEPENDENCE_MIGRATED_KIND,
        {"plan_id": plan_id, "round_number": round_number, "violation_reasons": violations},
        bypass_profile_gate=True,
    )
    record_parked_plan(plan_id=plan_id, base_dir=base_dir, verdict="cross_review_self_agreement",
                       origin="converged_delivery")
    return True


def _withheld(plan_id: str, origin: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "terminal_state": "IMPLEMENTATION_REQUEST_REFUSED",
        "pr_url": None,
        "rejection_class": f"delivery_withheld:{reason}",
        "specialist_review_signal": "review_converged_plan",
        "delivery": {"plan_id": plan_id, "origin": origin, "attempt": None,
                     "withheld": reason, **extra},
    }


def _claim_attempt(
    *, plan_id: str, cycle_id: str, profile: str, runner_class: str,
    workspace_root: Path, base_dir: Path,
) -> tuple[int | None, str | None]:
    """(attempt number, None) when this offer may run, else (None, reason)."""
    from .plan_convergence import (
        counted_delivery_attempts,
        fold_plan_state,
        record_implementation_delivery_attempt,
    )
    from .validation import worktree_is_dirty

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "CONVERGED":
        return None, WITHHELD_NOT_CONVERGED
    if withhold_ungated_self_agreement(plan_id, base_dir=base_dir):
        # ARIA-HIGH-375 — the one door: no caller offers a self-agreeing plan.
        return None, WITHHELD_NOT_INDEPENDENT
    attempts = state.get("implementation_delivery_attempts") or []
    if any(row.get("cycle_id") == cycle_id for row in attempts):
        return None, WITHHELD_OFFERED_THIS_CYCLE
    if len(counted_delivery_attempts(state)) >= MAX_DELIVERY_ATTEMPTS:
        return None, WITHHELD_EXHAUSTED
    if live_implementation_request_ids(plan_id, base_dir=base_dir):
        return None, WITHHELD_REQUEST_LIVE
    if worktree_is_dirty(workspace_root):
        return None, WITHHELD_WORKSPACE_DIRTY
    attempt = len(attempts) + 1
    claimed = record_implementation_delivery_attempt(
        plan_id=plan_id, attempt=attempt, cycle_id=cycle_id,
        profile=profile, runner_class=runner_class, base_dir=base_dir,
    )
    if claimed["idempotent"]:
        return None, WITHHELD_ATTEMPT_TAKEN
    return attempt, None


def _attempt_summaries(state: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {key: row.get(key) for key in ("attempt", "cycle_id", "profile", "runner_class", "recorded_at", "voided")}
        for row in state.get("implementation_delivery_attempts") or []
    ]


def _record_exhaustion(plan_id: str, *, base_dir: Path, last_rejection_class: str | None) -> str:
    from .human_required import record_human_required
    from .plan_convergence import fold_plan_state

    request_id = human_required_request_id(plan_id)
    attempts = _attempt_summaries(fold_plan_state(plan_id=plan_id, base_dir=base_dir))
    record_human_required(
        request_id=request_id,
        severity="HIGH",
        reason=(
            f"{DELIVERY_EXHAUSTED_REASON}: CONVERGED plan {plan_id} was offered to an "
            f"implementation runner that could deliver it {MAX_DELIVERY_ATTEMPTS} times and "
            f"stayed CONVERGED; it is now HUMAN_REQUIRED. Re-stage it or abandon it"
        ),
        context={
            "kind": HUMAN_REQUIRED_CONTEXT_KIND,
            "plan_id": plan_id,
            "reason_code": DELIVERY_EXHAUSTED_REASON,
            "attempts": attempts,
            "last_rejection_class": last_rejection_class,
            "finding_id": "ARIA-HIGH-362",
        },
        base_dir=base_dir,
    )
    return request_id


def escalate_exhausted_plan(
    plan_id: str, *, base_dir: Path, last_rejection_class: str | None = None,
) -> dict[str, Any]:
    """End a plan whose counted attempts are spent, then tell the operator.

    Not while an implementation request for it is live (review M3): that
    request is still the plan's delivery. The CONVERGED check and the
    HUMAN_REQUIRED write are one step under the plan lock
    (``force_plan_human_required(from_states={"CONVERGED"})``), so a mint
    that lands between this function's read and its write is never
    overwritten. The operator record follows the transition; a record the
    process did not live to write is written by the next sweep
    (:func:`redeliver_stranded_converged_plans`).
    """
    from .plan_convergence import (
        PlanStateRefused,
        counted_delivery_attempts,
        fold_plan_state,
        force_plan_human_required,
    )

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "CONVERGED":
        return {"plan_id": plan_id, "status": WITHHELD_NOT_CONVERGED, "state": state.get("state")}
    if len(counted_delivery_attempts(state)) < MAX_DELIVERY_ATTEMPTS:
        return {"plan_id": plan_id, "status": "attempts_remaining"}
    if live_implementation_request_ids(plan_id, base_dir=base_dir):
        return {"plan_id": plan_id, "status": WITHHELD_REQUEST_LIVE}
    try:
        force_plan_human_required(
            plan_id=plan_id,
            round_number=max(1, int(state.get("current_round") or 1)),
            reason_codes=[DELIVERY_EXHAUSTED_REASON],
            from_states=frozenset({"CONVERGED"}),
            base_dir=base_dir,
        )
    except PlanStateRefused:
        latest = fold_plan_state(plan_id=plan_id, base_dir=base_dir).get("state")
        return {"plan_id": plan_id, "status": WITHHELD_NOT_CONVERGED, "state": latest}
    request_id = _record_exhaustion(plan_id, base_dir=base_dir, last_rejection_class=last_rejection_class)
    return {"plan_id": plan_id, "status": "escalated", "request_id": request_id,
            "attempts": len(counted_delivery_attempts(state))}


def _record_escalation_failure(base_dir: Path, plan_id: str, exc: Exception) -> dict[str, Any]:
    from .tool_registry import append_tools_governance

    append_tools_governance(
        base_dir, "converged_delivery_escalation_failed",
        {"plan_id": plan_id, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
        bypass_profile_gate=True,
    )
    return {"plan_id": plan_id, "status": "escalation_failed", "error_class": type(exc).__name__}


def _uncounted_rows(governance: list[dict[str, Any]], plan_id: str) -> list[dict[str, Any]]:
    return [
        row["details"] for row in governance
        if row.get("kind") == UNCOUNTED_GOVERNANCE_KIND
        and isinstance(row.get("details"), dict) and row["details"].get("plan_id") == plan_id
    ]


def note_uncounted_cycle(
    plan_id: str, *, cycle_id: str, base_dir: Path, governance: list[dict[str, Any]] | None = None,
    reason: str = WITHHELD_NO_AUTHORITY,
) -> dict[str, Any]:
    """Record one cycle whose runner could not deliver ``plan_id``; surface a long run of them.

    The row carries the plan's counted-attempt total at the time, so "since
    the last counted attempt" is the rows with the current total — no clock
    comparison. Once per (plan, cycle). Surfacing is an operator record
    only; the plan stays CONVERGED.
    """
    from .human_required import record_human_required
    from .plan_convergence import counted_delivery_attempts, fold_plan_state
    from .tool_registry import append_tools_governance

    request_id = authority_absent_request_id(plan_id)
    if _record_exists(base_dir, request_id):
        # Surfaced once; the record is the operator's from here.
        return {"plan_id": plan_id, "uncounted_cycles": None, "surfaced": True}
    rows = _uncounted_rows(
        governance if governance is not None else load_jsonl(base_dir / "governance.jsonl"), plan_id,
    )
    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    counted = len(counted_delivery_attempts(state))
    if not any(row.get("cycle_id") == cycle_id for row in rows):
        append_tools_governance(
            base_dir, UNCOUNTED_GOVERNANCE_KIND,
            {"plan_id": plan_id, "cycle_id": cycle_id, "reason": reason,
             "counted_attempts": counted},
        )
        rows.append({"plan_id": plan_id, "cycle_id": cycle_id, "reason": reason, "counted_attempts": counted})
    current = [row for row in rows if row.get("counted_attempts") == counted]
    run = sorted({row.get("cycle_id") for row in current})
    if len(run) < AUTHORITY_ABSENT_CYCLES:
        return {"plan_id": plan_id, "uncounted_cycles": len(run), "surfaced": False}
    # Rows written before reasons were recorded are the no-authority case,
    # the only one that wrote rows then.
    reasons = sorted({str(row.get("reason") or WITHHELD_NO_AUTHORITY) for row in current})
    reason_code = AUTHORITY_ABSENT_REASON if reasons == [WITHHELD_NO_AUTHORITY] else DELIVERY_WITHHELD_REASON
    record_human_required(
        request_id=request_id,
        severity="MEDIUM",
        reason=(
            f"{reason_code}: CONVERGED plan {plan_id} could not be offered to an "
            f"implementation runner in {len(run)} cycles ({', '.join(reasons)}). "
            f"The plan stays CONVERGED and is offered again once the cause clears"
        ),
        context={
            "kind": HUMAN_REQUIRED_CONTEXT_KIND,
            "plan_id": plan_id,
            "reason_code": reason_code,
            "withheld_reasons": reasons,
            "uncounted_cycles": run,
            "finding_id": "ARIA-HIGH-362",
        },
        base_dir=base_dir,
    )
    return {"plan_id": plan_id, "uncounted_cycles": len(run), "surfaced": True}


def _note_uncounted_guarded(
    plan_id: str, *, cycle_id: str, base_dir: Path, reason: str,
    governance: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """``note_uncounted_cycle`` for the cycle's own call sites: bookkeeping
    that must not end the cycle. A lock timeout or ledger fault here used to
    escape the sweep (run before plan adoption) and the converging call alike,
    and with the run of uncounted cycles persisted, the same fault recurred
    every night. The fault is a governance row instead (review of #1813)."""
    from .ledger import LedgerIntegrityError
    from .tool_registry import GovernanceError, append_tools_governance

    try:
        return note_uncounted_cycle(plan_id, cycle_id=cycle_id, base_dir=base_dir,
                                    governance=governance, reason=reason)
    except (GovernanceError, LedgerIntegrityError, OSError) as exc:
        append_tools_governance(
            base_dir, "converged_delivery_uncounted_unrecorded",
            {"cycle_id": cycle_id, "plan_id": plan_id, "reason": reason,
             "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
            bypass_profile_gate=True,
        )
        return {"plan_id": plan_id, "status": "unrecorded", "surfaced": False,
                "error_class": type(exc).__name__}


def deliver_converged_plan(
    *,
    runner: Any,
    cycle_id: str,
    plan_id: str,
    workspace_root: Path,
    base_dir: Path,
    cross_review_summary: dict[str, Any],
    profile: str,
    origin: str,
) -> dict[str, Any]:
    """Offer ONE converged plan to the V9 runner — the only call site of ``runner.run``.

    Returns the cycle summary's ``v9_implementation`` shape (terminal_state,
    pr_url, rejection_class, specialist_review_signal) plus ``delivery``: the
    origin, the attempt number this offer counted as (None when uncounted)
    and, when no offer was made, why. A runner fault is caught here, as it
    was at the converging call site, so a V9 failure never blocks specialist
    review; the fault is a governance row and the attempt stays counted.
    """
    from .autonomy_state import AutonomyStateReducer
    from .cycle_phases.implementer import STAGING_PROFILE_REFUSED
    from .ledger import LedgerIntegrityError
    from .plan_convergence import void_implementation_delivery_attempt
    from .tool_registry import GovernanceError, append_tools_governance

    runner_class = type(runner).__name__
    attempt: int | None = None
    if runner.delivers_implementation:
        try:
            attempt, withheld = _claim_attempt(
                plan_id=plan_id, cycle_id=cycle_id, profile=profile, runner_class=runner_class,
                workspace_root=workspace_root, base_dir=base_dir,
            )
        except (GovernanceError, LedgerIntegrityError, OSError) as exc:
            # The attempt could not be recorded, so no offer is made: an
            # uncounted offer is exactly what the bound exists to prevent.
            # Like a runner fault, it must not block specialist review.
            append_tools_governance(
                base_dir, "converged_delivery_attempt_unrecorded",
                {"cycle_id": cycle_id, "plan_id": plan_id, "delivery_origin": origin,
                 "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
                bypass_profile_gate=True,
            )
            return _withheld(plan_id, origin, WITHHELD_ATTEMPT_UNRECORDED,
                             error_class=type(exc).__name__)
        if withheld is not None:
            summary = _withheld(plan_id, origin, withheld)
            if withheld == WITHHELD_WORKSPACE_DIRTY:
                # Uncounted, because the tree is the lane's state rather than the
                # plan's. It is still not silent: a lane that keeps leaving its tree
                # dirty surfaces like one without authority.
                summary["delivery"]["uncounted"] = _note_uncounted_guarded(
                    plan_id, cycle_id=cycle_id, base_dir=base_dir, reason=WITHHELD_WORKSPACE_DIRTY,
                )
            return summary
    delivery: dict[str, Any] = {"plan_id": plan_id, "origin": origin, "attempt": attempt, "withheld": None}
    AutonomyStateReducer.transition(
        base_dir, cycle_id=cycle_id, phase="v9_implementation_phase_started",
        status="ok", profile=profile,
        details={"plan_id": plan_id, "runner_class": runner_class,
                 "delivery_origin": origin, "delivery_attempt": attempt},
    )
    try:
        result = runner.run(
            cycle_id=cycle_id,
            plan_id=plan_id,
            workspace_root=workspace_root,
            base_dir=base_dir,
            cross_review_summary=cross_review_summary,
            profile=profile,
        )
        summary: dict[str, Any] = {
            "terminal_state": result.terminal_state,
            "pr_url": result.pr_url,
            "rejection_class": result.rejection_class,
            "specialist_review_signal": result.specialist_review_signal,
        }
        AutonomyStateReducer.transition(
            base_dir, cycle_id=cycle_id, phase="v9_implementation_phase_resolved",
            status=str(result.terminal_state), profile=profile,
            details={"specialist_review_signal": result.specialist_review_signal,
                     "pr_url": result.pr_url, "rejection_class": result.rejection_class,
                     "plan_id": plan_id, "delivery_origin": origin, "delivery_attempt": attempt},
        )
    except Exception as exc:
        # A V9 phase failure must not block specialist_review + worker_drainer.
        # The plan falls back to review_converged_plan (the V8 default) and the
        # counted attempt stands: the next cycle's sweep re-offers it.
        summary = {
            "terminal_state": "IMPLEMENTATION_REQUEST_REFUSED",
            "pr_url": None,
            "rejection_class": f"runner_exception:{type(exc).__name__}",
            "specialist_review_signal": "review_converged_plan",
        }
        try:
            append_tools_governance(
                base_dir, "v9_implementation_phase_failed",
                {"cycle_id": cycle_id, "plan_id": plan_id, "error_class": type(exc).__name__,
                 "delivery_origin": origin, "delivery_attempt": attempt},
                bypass_profile_gate=True,
            )
        except Exception as audit_exc:
            summary["audit_error_class"] = type(audit_exc).__name__
    summary["delivery"] = delivery
    if attempt is None:
        # Bookkeeping for the M4 surfacing; like the attempt record, a ledger
        # fault here must not block specialist review of this cycle's plan.
        delivery["uncounted"] = _note_uncounted_guarded(
            plan_id, cycle_id=cycle_id, base_dir=base_dir, reason=WITHHELD_NO_AUTHORITY,
        )
        return summary
    if summary["rejection_class"] == STAGING_PROFILE_REFUSED:
        try:
            void_implementation_delivery_attempt(
                plan_id=plan_id, attempt=attempt, reason=VOID_PROFILE_REFUSED, base_dir=base_dir,
            )
            delivery["voided"] = VOID_PROFILE_REFUSED
        except (GovernanceError, LedgerIntegrityError, OSError) as exc:
            # The attempt stays counted: the conservative side of the bound.
            # A fault (or a plan that moved under the void) must not skip this
            # cycle's specialist review.
            append_tools_governance(
                base_dir, "converged_delivery_void_unrecorded",
                {"cycle_id": cycle_id, "plan_id": plan_id, "attempt": attempt,
                 "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
                bypass_profile_gate=True,
            )
            delivery["void_error_class"] = type(exc).__name__
        return summary
    try:
        delivery["escalation"] = escalate_exhausted_plan(
            plan_id, base_dir=base_dir, last_rejection_class=summary["rejection_class"],
        )
    except Exception as exc:
        delivery["escalation"] = _record_escalation_failure(base_dir, plan_id, exc)
    return summary


def redeliver_stranded_converged_plans(
    *,
    runner: Any,
    cycle_id: str,
    base_dir: Path,
    workspace_root: Path,
    profile: str,
) -> dict[str, Any]:
    """The per-cycle sweep: re-offer CONVERGED plans an earlier cycle left behind.

    Runs before this cycle adopts or synthesizes a plan, so the plan this
    cycle converges is offered by the converging call and never also by the
    sweep. Exhausted plans are escalated (never while a request is live); at
    most ``REDELIVERIES_PER_CYCLE`` plans are offered; under a runner that
    cannot deliver, each stranded plan's uncounted cycle is noted; plans
    ended by exhaustion whose operator record is missing get it.
    """
    from .ledger import LedgerIntegrityError
    from .plan_convergence import counted_delivery_attempts, fold_plan_state
    from .tool_registry import GovernanceError, append_tools_governance

    report: dict[str, Any] = {
        "stranded": [], "offered": [], "escalated": [], "withheld": {}, "surfaced": [],
        "independence_failed": [],
        "repaired": [], "authority": bool(runner.delivers_implementation),
    }
    converged, exhausted = _plan_ledger_scan(base_dir)
    for plan_id in exhausted:
        if not _record_exists(base_dir, human_required_request_id(plan_id)):
            try:
                _record_exhaustion(plan_id, base_dir=base_dir, last_rejection_class=None)
                report["repaired"].append(plan_id)
            except Exception as exc:
                report["escalated"].append(_record_escalation_failure(base_dir, plan_id, exc))
    # Read once per sweep, and only when uncounted cycles will be noted.
    governance = load_jsonl(base_dir / "governance.jsonl") if converged and not report["authority"] else None
    for plan_id in converged:
        # ARIA-HIGH-375 — the migration runs here, before anything is offered
        # or escalated, and under every lane, including one without
        # authority: a plan converged before the independence gate is judged
        # by it once.
        try:
            not_independent = withhold_ungated_self_agreement(plan_id, base_dir=base_dir)
        except (GovernanceError, LedgerIntegrityError, OSError) as exc:
            # A store fault while judging or moving one plan is a row, never
            # the end of the cycle (the class #1813 closed for the uncounted
            # note). An unjudged plan is not offered either: its independence
            # is exactly what is unknown. The parked-item repair below covers
            # a move that landed without its item.
            append_tools_governance(
                base_dir, INDEPENDENCE_MIGRATION_FAILED_KIND,
                {"cycle_id": cycle_id, "plan_id": plan_id, "error_class": type(exc).__name__,
                 "error_message": str(exc)[:500]},
                bypass_profile_gate=True,
            )
            report["withheld"][plan_id] = WITHHELD_INDEPENDENCE_UNJUDGED
            continue
        if not_independent:
            report["independence_failed"].append(plan_id)
            continue
        report["stranded"].append(plan_id)
        state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        if len(counted_delivery_attempts(state)) >= MAX_DELIVERY_ATTEMPTS:
            try:
                outcome = escalate_exhausted_plan(plan_id, base_dir=base_dir)
            except Exception as exc:
                outcome = _record_escalation_failure(base_dir, plan_id, exc)
            if outcome.get("status") == WITHHELD_REQUEST_LIVE:
                report["withheld"][plan_id] = WITHHELD_REQUEST_LIVE
            else:
                report["escalated"].append(outcome)
            continue
        if not report["authority"]:
            report["withheld"][plan_id] = WITHHELD_NO_AUTHORITY
            note = _note_uncounted_guarded(plan_id, cycle_id=cycle_id, base_dir=base_dir,
                                           reason=WITHHELD_NO_AUTHORITY, governance=governance)
            if note["surfaced"]:
                report["surfaced"].append(plan_id)
            continue
        if len(report["offered"]) >= REDELIVERIES_PER_CYCLE:
            report["withheld"][plan_id] = WITHHELD_CYCLE_BOUND
            continue
        body = state.get("latest_revision") or {}
        outcome = deliver_converged_plan(
            runner=runner, cycle_id=cycle_id, plan_id=plan_id,
            workspace_root=workspace_root, base_dir=base_dir,
            cross_review_summary={
                "revision_id": body.get("revision_id") or plan_id,
                "rounds_count": state.get("current_round"),
                "request_ids": [],
            },
            profile=profile, origin=ORIGIN_REDELIVERY,
        )
        if outcome["delivery"].get("withheld"):
            report["withheld"][plan_id] = outcome["delivery"]["withheld"]
            continue
        report["offered"].append({"plan_id": plan_id, **{
            key: outcome.get(key) for key in ("terminal_state", "rejection_class")
        }, "attempt": outcome["delivery"]["attempt"]})
    # ARIA-HIGH-375 (second review) — every HUMAN_REQUIRED plan has its one
    # operator item, and a plan that left HUMAN_REQUIRED has its item
    # resolved: the single place that guarantees it, after this sweep's own
    # parkings. Faults are rows inside it, plan by plan.
    from .convergence_outcome import reconcile_parked_plans

    report["parked"] = reconcile_parked_plans(base_dir=base_dir)
    return report


__all__ = [
    "AUTHORITY_ABSENT_CYCLES",
    "AUTHORITY_ABSENT_REASON",
    "DELIVERY_EXHAUSTED_REASON",
    "HUMAN_REQUIRED_CONTEXT_KIND",
    "MAX_DELIVERY_ATTEMPTS",
    "ORIGIN_CONVERGED",
    "ORIGIN_EXECUTOR",
    "ORIGIN_REDELIVERY",
    "REDELIVERIES_PER_CYCLE",
    "authority_absent_request_id",
    "converged_plan_ids",
    "deliver_converged_plan",
    "escalate_exhausted_plan",
    "human_required_request_id",
    "live_implementation_request_ids",
    "note_uncounted_cycle",
    "redeliver_stranded_converged_plans",
    "withhold_ungated_self_agreement",
]
