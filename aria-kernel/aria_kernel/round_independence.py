"""ARIA-HIGH-375 — one round's cross-review independence verdict, read off the store.

WHY a module of its own. The verdict (ORPHAN-HIGH-421 / ORPHAN-CRITICAL-446)
was computed inside the convergence drainer, AFTER ``evaluate_plan`` had
written CONVERGED, and only the drainer's own verdict was downgraded: the plan
stayed CONVERGED and the next cycle's sweep delivered it. Then it was passed
INTO ``evaluate_plan`` by the drainer, which left every other caller (the
operator's ``plan evaluate``, ``plan advance-rounds``) able to converge a round
without it. ``evaluate_plan`` now derives the verdict here itself, so no caller
can omit it; ``converged_delivery`` uses the same function to judge the plans
that converged before the gate existed.

Everything here reads the store only: the plan's fold, the round's minted
requests, and the cross-reviewer's accepted output.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .independence_check import (
    CHALLENGER_ROLE as IND_CHALLENGER_ROLE,
    CROSS_REVIEW_ROLE as IND_CROSS_REVIEW_ROLE,
    PRIMARY_ROLE as IND_PRIMARY_ROLE,
    IndependenceInputError,
    RoundDispatch,
    verify_independence,
)
from .ledger import load_segments
from .tool_registry import append_tools_governance_once, ensure_tools_dir

STEP_ROLE_PRIMARY = "primary_plan"
STEP_ROLE_CHALLENGER = "challenger_plan"
STEP_ROLE_CROSS_REVIEW = "cross_review"
ROUND_DISPATCH_REFUSED_KIND = "round_dispatch_record_refused"


def requests_for_step(
    base_dir: str | Path,
    *,
    convergence_id: str,
    role: str,
    round_number: int,
) -> list[dict[str, Any]]:
    """Every minted request for one (plan, role, round) — the remint budget's
    denominator and the idempotent-mint guard's haystack."""
    rows = load_segments(ensure_tools_dir(base_dir), "agent_invocation_requests")
    return [
        row
        for row in rows
        if row.get("convergence_id") == convergence_id
        and row.get("role") == role
        and row.get("round_number") == round_number
    ]


def accepted_output_text(*, request_id: str, role: str, base_dir: str | Path) -> str | None:
    """The text an agent actually produced, or ``None`` if unreadable.

    ORPHAN-CRITICAL-446 — the independence gate compares what the primary,
    the challenger and the cross-reviewer WROTE. Reading that text needs the
    accepted result row, because the row is the only evidence the agent
    delivered at all: ``accepted_result_for_request`` rejects a claim with no
    result, a rejection, and a HUMAN_REQUIRED escalation (ORPHAN-HIGH-422).

    Every failure returns ``None`` rather than an empty string: ``RoundDispatch``
    treats ``None`` as "no text to compare" and the diversity layer fails
    closed on it, whereas an empty string would score as maximally diverse
    against anything and pass.
    """
    from .agent_invocations import accepted_result_for_request, resolve_output_artifact_path

    if not request_id:
        return None
    try:
        accepted = accepted_result_for_request(request_id=request_id, role=role, base_dir=base_dir)
    except Exception:
        return None
    if not accepted:
        return None
    output_path = accepted.get("output_path")
    if not isinstance(output_path, str) or not output_path:
        return None
    path = resolve_output_artifact_path(ensure_tools_dir(base_dir), output_path)
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return text or None


def plan_texts_from_state(
    state: dict[str, Any], *, plan_id: str, round_number: int,
) -> tuple[str, bool, str, str, bool]:
    """(primary_text, primary_real, challenger_revision_id, challenger_text,
    challenger_real) — from kernel state only."""
    from .plan_convergence import _coerce_plan_body, plan_body_from_state
    from .tool_registry import GovernanceError

    primary_text = ""
    try:
        body = plan_body_from_state(state)
    except GovernanceError:
        # The native revision owner also accepts legacy prose. Preserve that
        # latest text without inventing a structured body or using an old
        # seed. Structured selection belongs to the hash owner.
        latest = state.get("latest_revision") or {}
        prose = latest.get("content")
        if isinstance(prose, str) and prose.strip() and _coerce_plan_body(prose) is None:
            primary_text = prose
    else:
        primary_text = json.dumps(body["plan_content"], indent=2, sort_keys=True)
    primary_real = bool(primary_text) and primary_text.strip() not in {"", "{}", "null"}

    challenger = state.get("challenger") or {}
    challenger_revision_id = f"{plan_id}-c{round_number}"
    challenger_text = ""
    if isinstance(challenger, dict):
        rid = challenger.get("challenger_revision_id")
        if isinstance(rid, str) and rid:
            challenger_revision_id = rid
        content = challenger.get("plan_content")
        if isinstance(content, dict):
            challenger_text = json.dumps(content, indent=2, sort_keys=True)
    challenger_real = bool(challenger_text)
    if not challenger_text:
        challenger_text = (
            f"{{\"error\": \"challenger plan_content unavailable in plan state for "
            f"plan_id={plan_id} revision_id={challenger_revision_id}\"}}"
        )
    if not primary_real:
        primary_text = (
            f"{{\"error\": \"primary plan content unavailable in plan state for "
            f"plan_id={plan_id}\"}}"
        )
    return primary_text, primary_real, challenger_revision_id, challenger_text, challenger_real


def round_dispatches(
    *, plan_id: str, round_number: int, state: dict[str, Any], base_dir: str | Path,
) -> dict[str, RoundDispatch]:
    """ORPHAN-HIGH-421 — keyed store lookup per role, never positional. A
    role whose record the checks refuse is absent from the map; the refusal
    is disclosed once per (plan, round, role, reason), never once per read."""
    primary_text, primary_real, challenger_rid, challenger_text, challenger_real = (
        plan_texts_from_state(state, plan_id=plan_id, round_number=round_number)
    )
    out: dict[str, RoundDispatch] = {}

    def _latest_request_id(role: str) -> str:
        rows = requests_for_step(base_dir, convergence_id=plan_id, role=role, round_number=round_number)
        return str(rows[-1].get("request_id") or "") if rows else ""

    def _put(ind_role: str, *, request_id: str, revision_id: str | None, agent_text: str | None) -> None:
        try:
            out[ind_role] = RoundDispatch(
                role=ind_role, request_id=request_id or None,
                revision_id=revision_id, agent_text=agent_text,
            )
        except IndependenceInputError as exc:
            append_tools_governance_once(
                ensure_tools_dir(base_dir), ROUND_DISPATCH_REFUSED_KIND,
                {"plan_id": plan_id, "round_number": round_number, "role": ind_role, "reason": str(exc)},
                claim_keys=("plan_id", "round_number", "role", "reason"),
            )

    primary_revision_id = f"{plan_id}-r{round_number}"
    latest = state.get("latest_revision") or {}
    if isinstance(latest, dict) and isinstance(latest.get("revision_id"), str):
        primary_revision_id = latest["revision_id"] if round_number > 1 else f"{plan_id}-r1"
    _put(IND_PRIMARY_ROLE, request_id=_latest_request_id(STEP_ROLE_PRIMARY),
         revision_id=primary_revision_id, agent_text=primary_text if primary_real else None)
    _put(IND_CHALLENGER_ROLE, request_id=_latest_request_id(STEP_ROLE_CHALLENGER),
         revision_id=challenger_rid, agent_text=challenger_text if challenger_real else None)
    cross_review_request_id = _latest_request_id(STEP_ROLE_CROSS_REVIEW)
    _put(
        IND_CROSS_REVIEW_ROLE,
        request_id=cross_review_request_id,
        revision_id=None,
        # ORPHAN-CRITICAL-446 — the reviewer's REAL accepted output, or None
        # so the gate says self_agreement instead of assuming.
        agent_text=accepted_output_text(
            request_id=cross_review_request_id, role=STEP_ROLE_CROSS_REVIEW, base_dir=base_dir,
        ) if cross_review_request_id else None,
    )
    return out


def round_independence_verdict(
    *, plan_id: str, round_number: int, state: dict[str, Any], base_dir: str | Path,
) -> tuple[bool, list[str]]:
    """``(passed, violation_reasons)`` for one round of ``plan_id``."""
    dispatches = round_dispatches(plan_id=plan_id, round_number=round_number, state=state, base_dir=base_dir)
    missing = [role for role in (IND_PRIMARY_ROLE, IND_CHALLENGER_ROLE, IND_CROSS_REVIEW_ROLE)
               if role not in dispatches]
    if missing:
        return False, [f"round_dispatch_missing:{role}" for role in missing]
    return verify_independence(
        primary=dispatches[IND_PRIMARY_ROLE],
        challenger=dispatches[IND_CHALLENGER_ROLE],
        cross_review=dispatches[IND_CROSS_REVIEW_ROLE],
        base_dir=base_dir,
    )


__all__ = [
    "ROUND_DISPATCH_REFUSED_KIND",
    "accepted_output_text",
    "plan_texts_from_state",
    "requests_for_step",
    "round_dispatches",
    "round_independence_verdict",
]
