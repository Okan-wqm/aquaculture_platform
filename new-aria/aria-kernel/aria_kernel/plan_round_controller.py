from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .agent_invocations import create_agent_invocation_request, list_agent_invocation_requests
from .plan_convergence import (
    content_hash,
    evaluate_plan,
    fold_plan_state,
    force_plan_human_required,
    request_cross_review,
    submit_challenger_plan,
)
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


# Y3 (ORPHAN-703) — successor budget for planner envelopes that died of
# queue mechanics, mirroring DEFAULT_MAX_REQUEUES (2) and MAX_PANEL_REOPENS
# (2): two lineage steps, then an honest exhausted disclosure instead of a
# silent wedge OR a silent infinite retry.
MAX_PLANNER_REQUEST_REMINTS = 2

DEFAULT_PLANNER_AGENTS = {
    "primary_plan": "aria-primary-planner",
    "challenger_plan": "aria-challenger-planner",
    "cross_review": "aria-cross-reviewer",
}


def advance_plan_rounds(
    *,
    plan_id: str,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    max_rounds: int = 5,
) -> dict[str, Any]:
    """Advance one active convergent-planning state-machine step.

    The controller is deliberately conservative: it opens missing planner
    requests, evaluates only answered rounds, and escalates to HUMAN_REQUIRED
    when a material risk remains unresolved past the round cap.
    """
    root = ensure_tools_dir(base_dir)
    state = fold_plan_state(plan_id=plan_id, base_dir=root)
    current = state.get("state")
    actions: list[dict[str, Any]] = []
    if current in {"CONVERGED", "HUMAN_REQUIRED", "ABANDONED"}:
        return {
            "schema_version": 1,
            "plan_id": plan_id,
            "status": "terminal",
            "state": current,
            "actions": actions,
        }
    if current in {"DRAFT", "REVISED"}:
        actions.append(_ensure_planner_request(root, state, role="challenger_plan"))
        return _result(plan_id, state, "challenger_request_opened", actions)
    if current == "CHALLENGER_DRAFTED":
        actions.extend(_ensure_cross_review_round(root, state))
        return _result(plan_id, fold_plan_state(plan_id=plan_id, base_dir=root), "cross_review_opened", actions)
    if current in {"CRITIQUED", "CROSS_REVIEWED"}:
        round_number = int(state.get("current_round") or 1)
        evaluation = evaluate_plan(
            plan_id=plan_id,
            round_number=round_number,
            base_dir=root,
            max_rounds=max_rounds,
        )
        if evaluation.get("status") == "next_round_required":
            if round_number >= max_rounds:
                forced = force_plan_human_required(
                    plan_id=plan_id,
                    round_number=round_number,
                    reason_codes=["max_rounds_reached", "unresolved_material_risk"],
                    base_dir=root,
                )
                actions.append({"kind": "human_required", "result": forced})
                return _result(plan_id, fold_plan_state(plan_id=plan_id, base_dir=root), "human_required", actions)
            actions.append({"kind": "evaluate_plan", "result": evaluation})
            actions.append(_ensure_planner_request(root, state, role="primary_plan", round_number=round_number + 1))
            return _result(plan_id, fold_plan_state(plan_id=plan_id, base_dir=root), "primary_revision_requested", actions)
        actions.append({"kind": "evaluate_plan", "result": evaluation})
        return _result(plan_id, fold_plan_state(plan_id=plan_id, base_dir=root), "evaluated", actions)
    if current in {"CRITIQUE_REQUESTED", "CROSS_REVIEW_REQUESTED"}:
        return _result(plan_id, state, "waiting_for_reviews", actions)
    append_tools_governance(root, "plan_round_controller_blocked", {"plan_id": plan_id, "state": current})
    return _result(plan_id, state, "blocked", actions)


def _ensure_planner_request(root: Path, state: dict[str, Any], *, role: str, round_number: int | None = None) -> dict[str, Any]:
    plan_id = str(state["plan_id"])
    revision = state.get("latest_revision") or {}
    revision_id = str(revision.get("revision_id") or "unknown")
    request_round = round_number or int(state.get("current_round") or 1)
    existing = [
        row for row in list_agent_invocation_requests(
            base_dir=root,
            convergence_id=plan_id,
            role=role,
        )
        if row.get("round_number") == request_round
    ]
    # Y3 (ORPHAN-703) — the idempotency check must not count a DEAD request
    # as a live one. The shipped filter matched any row, so a round whose
    # envelope died of queue mechanics (measured: HUMAN_REQUIRED after three
    # lease expiries) was wedged forever — the plan could never converge and
    # nothing ever re-minted. A live-or-outcome match still short-circuits;
    # an all-dead match mints a successor with remint_of lineage, budgeted
    # like the X4 panel reopen.
    remint_of: str | None = None
    if existing:
        from .agent_invocations import derive_request_state
        from .agent_surface import REMINT_ELIGIBLE_DEAD_STATES

        latest = existing[-1]
        states = {
            str(row.get("request_id")): derive_request_state(
                request_id=str(row.get("request_id")), base_dir=root,
            )
            for row in existing
        }
        if any(state not in REMINT_ELIGIBLE_DEAD_STATES for state in states.values()):
            return {"kind": "planner_request_exists", "role": role, "request_id": latest.get("request_id")}
        remints_so_far = sum(1 for row in existing if row.get("remint_of"))
        if remints_so_far >= MAX_PLANNER_REQUEST_REMINTS:
            append_tools_governance(
                root, "planner_request_remint_exhausted",
                {
                    "plan_id": plan_id, "role": role, "round_number": request_round,
                    "dead_request_states": states,
                    "remint_budget": MAX_PLANNER_REQUEST_REMINTS,
                },
            )
            return {"kind": "planner_request_remint_exhausted", "role": role, "request_id": latest.get("request_id")}
        remint_of = str(latest.get("request_id"))
    request = create_agent_invocation_request(
        target_agent=DEFAULT_PLANNER_AGENTS[role],
        role=role,
        convergence_id=plan_id,
        round_number=request_round,
        suggested_prompt=_prompt_for_role(role, state),
        must_satisfy=[
            {
                "id": f"{role}_material_risk_review",
                "description": "Return risks, validation commands, evidence refs, and a clear recommendation.",
                "required": True,
            }
        ],
        allowed_scope=["aria-kernel/**", "aria-tools/**", ".claude/**"],
        evidence_refs=[revision_id],
        remint_of=remint_of,
        base_dir=root,
    )
    kind = "planner_request_reminted" if remint_of else "planner_request_created"
    return {"kind": kind, "role": role, "request_id": request.get("request_id"), "remint_of": remint_of}


def _ensure_cross_review_round(root: Path, state: dict[str, Any]) -> list[dict[str, Any]]:
    plan_id = str(state["plan_id"])
    round_number = int(state.get("current_round") or 1)
    latest = state.get("latest_revision") or {}
    target_revision_id = str(latest.get("revision_id") or "")
    target_hash = str(latest.get("content_hash") or "")
    if not target_revision_id or not target_hash:
        raise GovernanceError("plan_round_controller_missing_latest_revision")
    payload = {
        "round_number": round_number,
        "target_revision_id": target_revision_id,
        "target_plan_content_hash": target_hash,
        "tasks": [
            _cross_task(
                plan_id=plan_id,
                round_number=round_number,
                direction="primary_to_challenger",
                target_revision_id=target_revision_id,
                target_hash=target_hash,
            ),
            _cross_task(
                plan_id=plan_id,
                round_number=round_number,
                direction="challenger_to_primary",
                target_revision_id=target_revision_id,
                target_hash=target_hash,
            ),
        ],
    }
    event = request_cross_review(plan_id=plan_id, request=payload, base_dir=root)
    actions = [{"kind": "cross_review_event", "event_appended": event.get("event_appended")}]
    for task in payload["tasks"]:
        request = create_agent_invocation_request(
            target_agent=DEFAULT_PLANNER_AGENTS["cross_review"],
            role="cross_review",
            convergence_id=plan_id,
            round_number=round_number,
            suggested_prompt=json.dumps({"task": task, "plan_id": plan_id}, sort_keys=True),
            must_satisfy=[
                {
                    "id": "cross_review_direction",
                    "description": f"Answer {task['review_direction']} with risks and required revisions.",
                    "required": True,
                }
            ],
            allowed_scope=["aria-kernel/**", "aria-tools/**", ".claude/**"],
            evidence_refs=[target_revision_id],
            base_dir=root,
        )
        actions.append({
            "kind": "cross_review_request_created",
            "direction": task["review_direction"],
            "request_id": request.get("request_id"),
        })
    return actions


def submit_synthetic_challenger_for_tests(
    *,
    plan_id: str,
    base_dir: str | Path | None = None,
    challenger_agent: str = "aria-challenger-planner",
) -> dict[str, Any]:
    """Small test helper: materializes a challenger event from current state."""
    root = ensure_tools_dir(base_dir)
    state = fold_plan_state(plan_id=plan_id, base_dir=root)
    latest = state.get("latest_revision") or {}
    payload = {
        "challenger_revision_id": f"{latest.get('revision_id')}-challenger",
        "source_revision_id": latest.get("revision_id"),
        "source_plan_content_hash": latest.get("content_hash"),
        "challenger_agent": challenger_agent,
        "plan_content": {
            "schema_version": 1,
            "title": "Synthetic challenger",
            "summary": "synthetic challenger for controller tests",
            "affected_surfaces": [{"paths": ["aria-kernel/**"]}],
            "key_changes": ["challenge primary assumptions"],
            "validation_commands": [
                {"cmd": "python3 -m compileall -q aria-kernel/aria_kernel", "expected_exit": 0, "timeout_ms": 60000}
            ],
            "evidence_refs": ["aria-kernel/aria_kernel/plan_round_controller.py"],
            "risks": [],
        },
    }
    payload["content_hash"] = content_hash(payload["plan_content"])
    return submit_challenger_plan(plan_id=plan_id, challenger=payload, base_dir=root)


def _cross_task(
    *,
    plan_id: str,
    round_number: int,
    direction: str,
    target_revision_id: str,
    target_hash: str,
) -> dict[str, Any]:
    raw = f"{plan_id}:{round_number}:{direction}:{target_revision_id}:{target_hash}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    task_id = f"cross-{direction}-{digest[:10]}"
    packet = {
        "task_id": task_id,
        "reviewer_agent": DEFAULT_PLANNER_AGENTS["cross_review"],
        "review_direction": direction,
        "target_revision_id": target_revision_id,
        "target_plan_content_hash": target_hash,
        "status_after": "PENDING",
        "sla_deadline": f"round-{round_number}-operator-policy",
    }
    packet["task_packet_hash"] = "sha256:" + hashlib.sha256(
        json.dumps(packet, sort_keys=True, separators=(",", ":")).encode("utf-8"),
    ).hexdigest()
    return packet


def _prompt_for_role(role: str, state: dict[str, Any]) -> str:
    payload = {
        "$schema": "aria/plan-round-request/v1",
        "role": role,
        "plan_id": state.get("plan_id"),
        "state": state.get("state"),
        "latest_revision": state.get("latest_revision"),
        "current_round": state.get("current_round") or 1,
    }
    return json.dumps(payload, indent=2, sort_keys=True)


def _result(plan_id: str, state: dict[str, Any], status: str, actions: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "plan_id": plan_id,
        "status": status,
        "state": state.get("state"),
        "actions": actions,
    }


__all__ = [
    "DEFAULT_PLANNER_AGENTS",
    "advance_plan_rounds",
    "submit_synthetic_challenger_for_tests",
]
