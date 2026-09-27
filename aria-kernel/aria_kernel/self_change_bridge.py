"""The self-change contract: what a `propose_self_change` mission asks an agent, and how the answer reaches the kernel.

WHY: `open_self_improvement_missions` (Plan 032 Faz 032i) minted missions
whose `next_action == "propose_self_change"`, the orchestrator's mission
branch forwarded that string as free prompt text under the generic
`queue_item_projected` contract, and NOTHING mapped an accepted answer onto
`propose_self_change` — so `authority_surface_violations` and the
HUMAN_REQUIRED adjudication could only ever fire from the CLI. Confirmed
live 2026-09-12 (the ORPHAN-694 class: mechanism present, caller absent).

WHAT: one contract, three consumers.
* `self_change_must_satisfy()` / `build_self_change_prompt()` — what the
  mission branch mints (`aria/self-change-request/v1`): the agent must answer
  with `details.evidence_paths`, `details.problem`, `details.proposed_change`.
* `validate_self_change_response()` — the SHAPE check, used by the executor's
  pre-submit gate (release + retry, harness-class) and by the bridge, so the
  two can never disagree about what a well-formed answer is (the Y5 lesson).
* `record_self_change_result()` — the accepted-result bridge: reads the
  structured fields off the envelope, calls `propose_self_change` (which is
  where the AUTHORITY boundary is judged — authority surfaces AND the
  mission's state, pointer and open adjudication — and the HUMAN_REQUIRED
  opens), then parks the mission in HUMAN_REQUIRED, a WAITING state
  `mission_scheduler.select_next_mission` skips. A refusal raises before the
  park, so a refused answer leaves the mission exactly as it was.

The bridge dispatches on the CONTRACT the request declared (its must_satisfy
ids, part of the request identity), never on the agent's prose; the mission
identity comes from the request's `pressure_event_id` (D1: identity from what
was asked, never from what the agent volunteers).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .self_improvement import (
    AUTHORITY_SURFACES,
    DEFAULT_VALIDATION_COMMAND,
    SELF_CHANGE_ALLOWED_PREFIXES,
    SELF_CHANGE_NEXT_ACTION,
)
from .tool_registry import GovernanceError, ensure_tools_dir

SELF_CHANGE_REQUEST_SCHEMA = "aria/self-change-request/v1"
# The same lane the queue projection uses: the planner is read-only and
# kernel-envelope only, which is exactly the shape a PROPOSAL needs — the
# change itself is applied by nobody until a person adjudicates.
SELF_CHANGE_TARGET_AGENT = "aria-autonomy-planner"
SELF_CHANGE_ROLE = "maintenance_utility"
# The structured fields `propose_self_change` takes, in the order the
# contract names them; `details.<field>` on the response envelope.
SELF_CHANGE_FIELDS: tuple[str, ...] = ("evidence_paths", "problem", "proposed_change")
SELF_CHANGE_MUST_SATISFY: tuple[dict[str, str], ...] = (
    {"id": "self_change_evidence_paths",
     "description": "details.evidence_paths is a non-empty list of repo-relative file paths that evidence the defect, "
                  "every one inside ARIA's own scope (allowed_prefixes) and none on an authority surface "
                  "(authority_surfaces); each path was read at the request's target SHA"},
    {"id": "self_change_problem",
     "description": "details.problem states the defect the mission's signal evidences, grounded in evidence_paths"},
    {"id": "self_change_proposed_change",
     "description": "details.proposed_change states the concrete change to ARIA's own code and how validation_command proves it"},
)
SELF_CHANGE_CONTRACT_IDS: tuple[str, ...] = tuple(item["id"] for item in SELF_CHANGE_MUST_SATISFY)
# The executor's release reason for a malformed answer — harness-class (the
# shape says nothing about the mission; re-asking usually succeeds), listed
# in agent_invocations.HARNESS_FAULT_RELEASE_REASONS.
SELF_CHANGE_CONTRACT_RELEASE_REASON = "self_change_contract_violation"
SELF_CHANGE_STEP_PREFIX = "self_change:"
SELF_CHANGE_MISSION_REASON = "self_change_adjudication"


def self_change_must_satisfy() -> list[dict[str, Any]]:
    return [dict(item) for item in SELF_CHANGE_MUST_SATISFY]


def self_change_allowed_scope() -> list[str]:
    """`SELF_CHANGE_ALLOWED_PREFIXES` as evidence-validator globs (`dir/**`, `stem*`)."""
    return [prefix + "**" if prefix.endswith("/") else prefix + "*" for prefix in SELF_CHANGE_ALLOWED_PREFIXES]


def is_self_change_request(request: dict[str, Any]) -> bool:
    """A request whose declared contract IS the self-change contract."""
    ids = {str(item.get("id")) for item in (request.get("must_satisfy") or []) if isinstance(item, dict)}
    return ids == set(SELF_CHANGE_CONTRACT_IDS)


def mission_id_of(request: dict[str, Any]) -> str | None:
    marker = str(request.get("pressure_event_id") or "")
    return marker.split(":", 1)[1] if marker.startswith("mission:") else None


def build_self_change_prompt(*, queue_item_id: str, source_cycle_id: str | None, mission_row: dict[str, Any]) -> dict[str, Any]:
    """The sealed prompt: the mission, the boundary, and the answer shape — no free text."""
    return {
        "$schema": SELF_CHANGE_REQUEST_SCHEMA,
        "queue_item_id": queue_item_id,
        "source_cycle_id": source_cycle_id,
        "mission_id": str(mission_row.get("mission_id") or ""),
        "source_id": mission_row.get("source_id"),
        "title": mission_row.get("title"),
        "next_action": SELF_CHANGE_NEXT_ACTION,
        "response_details_fields": list(SELF_CHANGE_FIELDS),
        "allowed_prefixes": list(SELF_CHANGE_ALLOWED_PREFIXES),
        "authority_surfaces": list(AUTHORITY_SURFACES),
        "validation_command": DEFAULT_VALIDATION_COMMAND,
    }


def validate_self_change_response(*, request: dict[str, Any], response: dict[str, Any]) -> list[str]:
    """Shape errors of a self-change answer, named per contract id; [] for other requests.

    Shape only — the authority boundary is judged by `propose_self_change`
    in the kernel, so a refusal is a governance row and not a silent
    pre-submit release.
    """
    if not is_self_change_request(request):
        return []
    details = response.get("details")
    if not isinstance(details, dict):
        details = {}
    errors: list[str] = []
    paths = details.get("evidence_paths")
    if paths is None:
        errors.append("self_change_evidence_paths:absent")
    elif not isinstance(paths, list) or any(not isinstance(p, str) or not p.strip() for p in paths):
        errors.append("self_change_evidence_paths:not_a_list_of_paths")
    elif not paths:
        errors.append("self_change_evidence_paths:empty")
    for field in ("problem", "proposed_change"):
        value = details.get(field)
        if value is None:
            errors.append(f"self_change_{field}:absent")
        elif not isinstance(value, str) or not value.strip():
            errors.append(f"self_change_{field}:empty")
    return errors


def record_self_change_result(*, request: dict[str, Any], response: dict[str, Any], base_dir: str | Path | None) -> dict[str, Any] | None:
    """The accepted-result bridge. ``None`` for every request that is not a self-change.

    Raises ``GovernanceError`` (recorded by the caller as `agent_bridge_warning`)
    when the answer is malformed, when the request names no mission, or when
    `propose_self_change` refuses — the refusal has already written
    `self_change_authority_surface_refused` or `self_change_mission_refused`
    by then, which is the point: the boundary fires from the kernel, on the
    ledger, for every accepted answer, and it fires BEFORE the park below, so
    a refused answer (a stale second request, an operator-held mission)
    transitions nothing and overwrites nobody's `next_action`.
    """
    if not is_self_change_request(request):
        return None
    root = ensure_tools_dir(base_dir)
    mission_id = mission_id_of(request)
    if mission_id is None:
        raise GovernanceError(f"self_change_bridge_missing_mission_id:{request.get('request_id')}")
    errors = validate_self_change_response(request=request, response=response)
    if errors:
        raise GovernanceError("self_change_response_contract:" + ",".join(errors))
    details = response["details"]
    from .mission import transition_mission
    from .self_improvement import propose_self_change
    from .tool_registry import bound_workspace_root

    outcome = propose_self_change(
        mission_id=mission_id, base_dir=root, workspace_root=bound_workspace_root(root),
        evidence_paths=[str(p) for p in details["evidence_paths"]], problem=str(details["problem"]),
        proposed_change=str(details["proposed_change"]),
    )
    proposal_id = str(outcome["proposal"].get("proposal_id"))
    adjudication_id = str(outcome["human_required"].get("request_id"))
    # The park, and what each part of it does. HUMAN_REQUIRED is in
    # WAITING_STATES, which `select_next_mission` skips, so no later cycle
    # queues this mission — that is the mechanism against a THIRD request.
    # A request already in flight when this one was accepted is not stopped
    # by the park; it is stopped by `propose_self_change`, which refuses an
    # operator-held mission, a replaced pointer and an open adjudication by
    # name before writing anything. The pointer becomes the operator's
    # sentence (OPERATOR_HELD_STATES: no unattended writer may replace it),
    # and the wake key records the adjudication whose resolution is what a
    # person acts on: `human-required resolve`, then `mission transition`
    # HUMAN_REQUIRED -> PLANNING with a new pointer. Nothing automatic reads
    # the key; it is the ledger's pointer from the mission to its question.
    transition = transition_mission(
        mission_id=mission_id, to_state="HUMAN_REQUIRED", reason_code=SELF_CHANGE_MISSION_REASON,
        step_id=f"{SELF_CHANGE_STEP_PREFIX}{proposal_id}",
        next_action=f"Operator adjudicates self_change proposal {proposal_id} (human_required {adjudication_id})",
        wake_condition={"kind": "evidence", "key": f"human_required:{adjudication_id}"},
        evidence_refs=[str(p) for p in details["evidence_paths"]], base_dir=root,
    )
    return {**outcome, "mission_transition": {"to_state": "HUMAN_REQUIRED", "idempotent": bool(transition.get("idempotent"))}}


__all__ = ["SELF_CHANGE_CONTRACT_IDS", "SELF_CHANGE_CONTRACT_RELEASE_REASON", "SELF_CHANGE_FIELDS", "SELF_CHANGE_MISSION_REASON",
           "SELF_CHANGE_MUST_SATISFY", "SELF_CHANGE_REQUEST_SCHEMA", "SELF_CHANGE_ROLE", "SELF_CHANGE_STEP_PREFIX",
           "SELF_CHANGE_TARGET_AGENT", "build_self_change_prompt", "is_self_change_request", "mission_id_of",
           "record_self_change_result", "self_change_allowed_scope", "self_change_must_satisfy", "validate_self_change_response"]
