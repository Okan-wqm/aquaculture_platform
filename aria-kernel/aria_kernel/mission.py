"""Persistent missions — work identity that outlives the cycle that saw it.

PLAN Wave 2 PR 1.1 (`aria/mission/v1`). `task.py` derives task identity from
`cycle_id`, so the same defect rediscovered tonight is a NEW task every night:
nothing accumulates, nothing resumes, and "no plan silently half-done" has no
durable subject to be enforced against. A mission's identity is derived from
WHAT the work is — ``sha256(source_kind|source_id|repo_hash)`` — and NEVER
from when it was seen. Invariant I-W1-05 pins the derivation at the source
level (`test_mission_id_source_never_reads_cycle`).

State is an event-sourced ledger folded on read, the pattern
`plan_convergence` has proven in production: the history IS the audit trail —
how a mission got stuck, which retry rungs were spent, what it is waiting for.
The fold is authoritative; `missions/mission-index.json` is a derived
projection whose loss costs one rebuild.

THE VOCABULARIES ARE CLOSED. States, transition edges, retry rungs, wake
kinds and binding keys are each a finite table in this module and nowhere
else. A transition outside `ALLOWED_TRANSITIONS` is refused — with one stated
exception: a FORWARD jump along the mainline is legal when
``reason_code == "coarse_observation"``, because today's pipeline genuinely
cannot distinguish every intermediate state and a skip that says so is honest
where a skip wearing a precise reason would be the schema lying about its own
resolution. Backward moves always need an explicit edge.

The waiting states (blocked on revalidation, a capability, evidence, an
external system, or a human) are deliberately OUTSIDE `ACTIVE_WIP_STATES`: a
stuck mission releases its WIP slot rather than deadlocking the pipeline, and
the wake condition records what would un-stick it.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

from .ledger import (
    load_declared_jsonl,
    rewrite_declared_json,
    state_transaction,
)
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    utc_now,
)

MISSION_SCHEMA = "aria/mission/v1"

MAINLINE_STATES: tuple[str, ...] = (
    "DISCOVERED",
    "CONTRACTING",
    "PLANNING",
    "IMPLEMENTING",
    "VALIDATING",
    "READY",
    "MERGING",
    "MAIN_VERIFYING",
    "OUTCOME_OBSERVING",
)

WAITING_STATES: tuple[str, ...] = (
    "REVALIDATION_REQUIRED",
    "CAPABILITY_REQUIRED",
    "EVIDENCE_REQUIRED",
    "BLOCKED_EXTERNAL",
    "HUMAN_REQUIRED",
)

TERMINAL_STATES: tuple[str, ...] = (
    "VERIFIED",
    "POLICY_REJECTED",
    "CANCELLED_BY_CONSTITUTION",
    "SUPERSEDED",
    "FAILED_AND_ROLLED_BACK",
)

MISSION_STATES: tuple[str, ...] = MAINLINE_STATES + WAITING_STATES + TERMINAL_STATES

# WIP is counted over the states where a mission holds real resources — a
# branch, a worker, a PR slot. Waiting states are excluded ON PURPOSE: a
# mission waiting on a human must not starve the pipeline of its one slot.
ACTIVE_WIP_STATES: tuple[str, ...] = (
    "IMPLEMENTING",
    "VALIDATING",
    "READY",
    "MERGING",
    "MAIN_VERIFYING",
)

RETRY_LADDER: tuple[str, ...] = (
    "transient",
    "in_plan_repair",
    "alternative",
    "scope_shrink",
    "new_evidence",
    "new_capability",
    "justified_reject",
)

WAKE_KINDS: tuple[str, ...] = ("ci_status", "pr_state", "timer", "evidence")

BINDING_KEYS: tuple[str, ...] = (
    "plan_ids",
    "change_ids",
    "assignment_ids",
    "pr_numbers",
    "branch",
    "finding_ids",
    "queue_item_ids",
    "task_ids",
)

EVENT_KINDS: tuple[str, ...] = ("opened", "transition", "binding", "wake", "note")

# The reason every skip-forward must carry. Named once, here.
COARSE_OBSERVATION = "coarse_observation"


def _adjacent(state: str) -> frozenset[str]:
    index = MAINLINE_STATES.index(state)
    if index + 1 == len(MAINLINE_STATES):
        return frozenset()
    return frozenset({MAINLINE_STATES[index + 1]})


# Closed edge table. Three families beyond mainline adjacency:
#   * every non-terminal state may enter any waiting state (getting stuck is
#     not a privilege of a particular phase) and every terminal-cancel edge
#     (constitution/policy/supersession can end anything);
#   * waiting states re-enter through PLANNING — re-planning is the one safe
#     re-entry that cannot assume resources still exist — with HUMAN_REQUIRED
#     additionally able to end the mission outright;
#   * reconciliation's backward edges (lost branch, closed-unmerged PR) from
#     the WIP states back to PLANNING, and the failure edges from the merge
#     tail to FAILED_AND_ROLLED_BACK.
_ALWAYS_AVAILABLE: frozenset[str] = frozenset(WAITING_STATES) | frozenset(
    {"SUPERSEDED", "POLICY_REJECTED", "CANCELLED_BY_CONSTITUTION"}
)

ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "DISCOVERED": _adjacent("DISCOVERED") | _ALWAYS_AVAILABLE,
    "CONTRACTING": _adjacent("CONTRACTING") | _ALWAYS_AVAILABLE,
    "PLANNING": _adjacent("PLANNING") | _ALWAYS_AVAILABLE,
    "IMPLEMENTING": _adjacent("IMPLEMENTING") | _ALWAYS_AVAILABLE | frozenset({"PLANNING"}),
    "VALIDATING": _adjacent("VALIDATING") | _ALWAYS_AVAILABLE | frozenset({"PLANNING"}),
    "READY": _adjacent("READY") | _ALWAYS_AVAILABLE | frozenset({"PLANNING"}),
    "MERGING": (
        _adjacent("MERGING")
        | _ALWAYS_AVAILABLE
        | frozenset({"PLANNING", "FAILED_AND_ROLLED_BACK"})
    ),
    "MAIN_VERIFYING": (
        _adjacent("MAIN_VERIFYING") | _ALWAYS_AVAILABLE | frozenset({"FAILED_AND_ROLLED_BACK"})
    ),
    "OUTCOME_OBSERVING": (
        frozenset({"VERIFIED", "FAILED_AND_ROLLED_BACK"}) | _ALWAYS_AVAILABLE
    ),
    "REVALIDATION_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "CAPABILITY_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "EVIDENCE_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "BLOCKED_EXTERNAL": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "HUMAN_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "VERIFIED": frozenset(),
    "POLICY_REJECTED": frozenset(),
    "CANCELLED_BY_CONSTITUTION": frozenset(),
    "SUPERSEDED": frozenset(),
    "FAILED_AND_ROLLED_BACK": frozenset(),
}


def events_path(root: Path) -> Path:
    return root / "missions" / "mission-events.jsonl"


def index_path(root: Path) -> Path:
    return root / "missions" / "mission-index.json"


def mission_id_for(source_kind: str, source_id: str, repo_hash: str) -> str:
    """``m-`` + 16 hex of sha256 over WHAT the work is.

    No timestamp, no counter and no cycle reference may enter this
    derivation — the same source re-observed in any later cycle MUST fold
    into the same mission. I-W1-05 pins this at the AST level.
    """
    for name, value in (
        ("source_kind", source_kind),
        ("source_id", source_id),
        ("repo_hash", repo_hash),
    ):
        if not isinstance(value, str) or not value.strip():
            raise GovernanceError(f"mission identity requires a non-empty {name}")
    digest = hashlib.sha256(
        f"{source_kind}|{source_id}|{repo_hash}".encode("utf-8")
    ).hexdigest()
    return f"m-{digest[:16]}"


def _idempotency_key(
    mission_id: str, step_id: str, target_sha: str, action_type: str
) -> str:
    raw = f"{mission_id}|{step_id}|{target_sha}|{action_type}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _mainline_index(state: str) -> int | None:
    try:
        return MAINLINE_STATES.index(state)
    except ValueError:
        return None


def _validate_wake_condition(wake_condition: Any) -> dict[str, Any] | None:
    if wake_condition is None:
        return None
    if not isinstance(wake_condition, dict):
        raise GovernanceError("wake_condition must be an object")
    kind = wake_condition.get("kind")
    if kind not in WAKE_KINDS:
        raise GovernanceError(
            f"wake_condition.kind {kind!r} is outside the closed vocabulary {list(WAKE_KINDS)}"
        )
    key = wake_condition.get("key")
    if not isinstance(key, str) or not key.strip():
        raise GovernanceError("wake_condition.key must be a non-empty string")
    validated: dict[str, Any] = {"kind": kind, "key": key}
    not_before = wake_condition.get("not_before")
    if not_before is not None:
        if not isinstance(not_before, str) or not not_before.strip():
            raise GovernanceError("wake_condition.not_before must be a string timestamp")
        validated["not_before"] = not_before
    return validated


def _validate_bindings(bindings: Any) -> dict[str, list[Any]]:
    if not isinstance(bindings, dict) or not bindings:
        raise GovernanceError("bindings must be a non-empty object")
    validated: dict[str, list[Any]] = {}
    for key, values in bindings.items():
        if key not in BINDING_KEYS:
            raise GovernanceError(
                f"binding key {key!r} is outside the closed vocabulary {list(BINDING_KEYS)}"
            )
        if isinstance(values, (str, int)):
            values = [values]
        if not isinstance(values, list):
            raise GovernanceError(f"binding {key!r} must be a list")
        validated[key] = values
    return validated


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]


# ---------------------------------------------------------------------------
# Event store.
# ---------------------------------------------------------------------------


def _load_events(root: Path) -> list[dict[str, Any]]:
    path = events_path(root)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface="mission_events")


def _fold(events: list[dict[str, Any]], mission_id: str) -> dict[str, Any] | None:
    state: dict[str, Any] | None = None
    for event in events:
        if event.get("mission_id") != mission_id:
            continue
        kind = event.get("event")
        if kind == "opened":
            state = {
                "schema_version": 1,
                "schema": MISSION_SCHEMA,
                "mission_id": mission_id,
                "source_kind": event.get("source_kind"),
                "source_id": event.get("source_id"),
                "repo_hash": event.get("repo_hash"),
                "title": event.get("title"),
                "capability": event.get("capability"),
                "priority": event.get("priority"),
                "state": "DISCOVERED",
                "opened_at": event.get("recorded_at"),
                "updated_at": event.get("recorded_at"),
                "opened_count": 1,
                "transition_count": 0,
                "retry_rung": None,
                "next_action": None,
                "wake_condition": None,
                "bindings": {},
                "evidence_refs": [],
            }
            continue
        if state is None:
            continue
        state["updated_at"] = event.get("recorded_at")
        if kind == "transition":
            state["state"] = event.get("to_state")
            state["transition_count"] += 1
            state["next_action"] = event.get("next_action")
            state["wake_condition"] = event.get("wake_condition")
            if event.get("retry_rung") is not None:
                state["retry_rung"] = event.get("retry_rung")
            refs = _strings(event.get("evidence_refs"))
            if refs:
                merged = list(state["evidence_refs"]) + refs
                state["evidence_refs"] = sorted(set(merged))
        elif kind == "binding":
            for key, values in (event.get("bindings") or {}).items():
                existing = list(state["bindings"].get(key, []))
                for value in values:
                    if value not in existing:
                        existing.append(value)
                state["bindings"][key] = existing
        elif kind == "wake":
            state["wake_condition"] = event.get("wake_condition")
    return state


def fold_mission(
    *, mission_id: str, base_dir: str | Path | None = None
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    state = _fold(_load_events(root), mission_id)
    if state is None:
        raise GovernanceError(f"unknown mission: {mission_id}")
    return state


def list_open_missions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    root = ensure_tools_dir(base_dir)
    events = _load_events(root)
    seen: list[str] = []
    for event in events:
        mid = event.get("mission_id")
        if isinstance(mid, str) and mid not in seen:
            seen.append(mid)
    missions = []
    for mid in seen:
        state = _fold(events, mid)
        if state is not None and state["state"] not in TERMINAL_STATES:
            missions.append(state)
    return missions


def _find_by_idempotency(
    events: list[dict[str, Any]], key: str
) -> dict[str, Any] | None:
    for event in events:
        if event.get("idempotency_key") == key:
            return event
    return None


def _append(
    txn: Any, root: Path, event: dict[str, Any]
) -> dict[str, Any]:
    event = {
        "schema_version": 1,
        "schema": MISSION_SCHEMA,
        "event_id": str(uuid.uuid4()),
        "recorded_at": utc_now(),
        **event,
    }
    if event.get("event") not in EVENT_KINDS:
        raise GovernanceError(
            f"mission event {event.get('event')!r} is outside the closed vocabulary "
            f"{list(EVENT_KINDS)}"
        )
    return txn.append_declared_jsonl(
        events_path(root), event, expected_surface="mission_events"
    )


def _result(event: dict[str, Any], *, idempotent: bool) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "mission_id": event.get("mission_id"),
        "idempotent": idempotent,
        "event": event,
    }


# ---------------------------------------------------------------------------
# Commands.
# ---------------------------------------------------------------------------


def open_mission(
    *,
    source_kind: str,
    source_id: str,
    repo_hash: str,
    title: str,
    capability: str | None = None,
    priority: int | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Open (or replay-open) the mission this source identifies.

    Idempotent by construction: the mission_id IS the identity, so a second
    open of the same source is a no-op returning the existing mission.
    """
    root = ensure_tools_dir(base_dir)
    mission_id = mission_id_for(source_kind, source_id, repo_hash)
    if not isinstance(title, str) or not title.strip():
        raise GovernanceError("open_mission requires a non-empty title")
    key = _idempotency_key(mission_id, "genesis", "", "opened")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is not None:
            return _result(existing, idempotent=True)
        event = _append(
            txn,
            root,
            {
                "event": "opened",
                "mission_id": mission_id,
                "idempotency_key": key,
                "source_kind": source_kind,
                "source_id": source_id,
                "repo_hash": repo_hash,
                "title": title,
                "capability": capability,
                "priority": priority,
            },
        )
        return _result(event, idempotent=False)


def transition_mission(
    *,
    mission_id: str,
    to_state: str,
    reason_code: str,
    step_id: str,
    target_sha: str = "",
    retry_rung: str | None = None,
    next_action: str | None = None,
    wake_condition: dict[str, Any] | None = None,
    evidence_refs: list[str] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Move a mission along the closed edge table, or refuse.

    One stated exception to the table: a FORWARD jump along the mainline is
    legal when ``reason_code == "coarse_observation"`` — today's pipeline
    cannot distinguish every intermediate state, and a skip that says so is
    honest where a skip wearing a precise reason would be the schema lying
    about its own resolution. Backward moves always need an explicit edge.
    """
    root = ensure_tools_dir(base_dir)
    if to_state not in MISSION_STATES:
        raise GovernanceError(f"unknown mission state: {to_state!r}")
    if not isinstance(reason_code, str) or not reason_code.strip():
        raise GovernanceError("transition requires a reason_code")
    if not isinstance(step_id, str) or not step_id.strip():
        raise GovernanceError("transition requires a step_id")
    if retry_rung is not None and retry_rung not in RETRY_LADDER:
        raise GovernanceError(
            f"retry_rung {retry_rung!r} is outside the closed ladder {list(RETRY_LADDER)}"
        )
    validated_wake = _validate_wake_condition(wake_condition)
    key = _idempotency_key(mission_id, step_id, target_sha, f"transition:{to_state}")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is not None:
            return _result(existing, idempotent=True)
        state = _fold(events, mission_id)
        if state is None:
            raise GovernanceError(f"unknown mission: {mission_id}")
        current = state["state"]
        if current in TERMINAL_STATES:
            raise GovernanceError(
                f"mission {mission_id} is terminal ({current}); no transition may leave it"
            )
        allowed = ALLOWED_TRANSITIONS[current]
        if to_state not in allowed:
            from_index = _mainline_index(current)
            to_index = _mainline_index(to_state)
            is_forward_skip = (
                from_index is not None and to_index is not None and to_index > from_index
            )
            if not (is_forward_skip and reason_code == COARSE_OBSERVATION):
                raise GovernanceError(
                    f"transition {current} -> {to_state} is not in the closed table "
                    f"(reason_code={reason_code!r}); forward mainline skips require "
                    f"reason_code={COARSE_OBSERVATION!r}"
                )
        if retry_rung is not None and state.get("retry_rung") is not None:
            if RETRY_LADDER.index(retry_rung) < RETRY_LADDER.index(state["retry_rung"]):
                raise GovernanceError(
                    f"retry_rung cannot move backward: {state['retry_rung']} -> {retry_rung}"
                )
        event = _append(
            txn,
            root,
            {
                "event": "transition",
                "mission_id": mission_id,
                "idempotency_key": key,
                "from_state": current,
                "to_state": to_state,
                "reason_code": reason_code,
                "retry_rung": retry_rung,
                "next_action": next_action,
                "wake_condition": validated_wake,
                "evidence_refs": _strings(evidence_refs),
            },
        )
        return _result(event, idempotent=False)


def bind_mission(
    *,
    mission_id: str,
    bindings: dict[str, Any],
    step_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    validated = _validate_bindings(bindings)
    if not isinstance(step_id, str) or not step_id.strip():
        raise GovernanceError("bind_mission requires a step_id")
    canonical = json.dumps(validated, sort_keys=True, separators=(",", ":"))
    key = _idempotency_key(mission_id, step_id, canonical, "binding")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is not None:
            return _result(existing, idempotent=True)
        if _fold(events, mission_id) is None:
            raise GovernanceError(f"unknown mission: {mission_id}")
        event = _append(
            txn,
            root,
            {
                "event": "binding",
                "mission_id": mission_id,
                "idempotency_key": key,
                "bindings": validated,
            },
        )
        return _result(event, idempotent=False)


# ---------------------------------------------------------------------------
# Projections and the closure gate.
# ---------------------------------------------------------------------------


def rebuild_mission_index(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Rewrite the derived index from the ledger. Deterministic: same events,
    same bytes — losing the index costs one rebuild and nothing else."""
    root = ensure_tools_dir(base_dir)
    events = _load_events(root)
    seen: list[str] = []
    for event in events:
        mid = event.get("mission_id")
        if isinstance(mid, str) and mid not in seen:
            seen.append(mid)
    missions = {}
    for mid in sorted(seen):
        state = _fold(events, mid)
        if state is not None:
            missions[mid] = {
                "state": state["state"],
                "source_kind": state["source_kind"],
                "source_id": state["source_id"],
                "title": state["title"],
                "retry_rung": state["retry_rung"],
                "next_action": state["next_action"],
                "wake_condition": state["wake_condition"],
                "updated_at": state["updated_at"],
            }
    payload = {
        "schema_version": 1,
        "schema": MISSION_SCHEMA,
        "mission_count": len(missions),
        "missions": missions,
    }
    path = index_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    rewrite_declared_json(path, payload, expected_surface="mission_index")
    return {"schema_version": 1, "path": str(path), "mission_count": len(missions)}


def assert_cycle_closure(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """"No plan silently half-done", executable.

    Every open mission must say what happens next (``next_action``) and what
    it is waiting for (``wake_condition``). A mission carrying neither is
    exactly the shape that used to rot in a worktree nothing revisits — so it
    is a violation, and the violation is RECORDED as a governance event
    because a violation nobody recorded is a violation nobody will fix.

    This function observes and records; the cycle_seal phase (PR 1.2) owns
    the decision of what a violation does to the cycle under each profile.
    """
    root = ensure_tools_dir(base_dir)
    violations = []
    for state in list_open_missions(base_dir=root):
        missing = []
        if not state.get("next_action"):
            missing.append("next_action")
        if not state.get("wake_condition"):
            missing.append("wake_condition")
        if missing:
            violations.append(
                {
                    "mission_id": state["mission_id"],
                    "state": state["state"],
                    "missing": missing,
                }
            )
    governance_recorded = False
    if violations:
        append_tools_governance(
            root,
            "mission_closure_violation",
            {
                "schema_version": 1,
                "violation_count": len(violations),
                "violations": violations,
            },
        )
        governance_recorded = True
    return {
        "schema_version": 1,
        "open_missions": len(list_open_missions(base_dir=root)),
        "violations": violations,
        "governance_recorded": governance_recorded,
    }


__all__ = [
    "ACTIVE_WIP_STATES",
    "ALLOWED_TRANSITIONS",
    "BINDING_KEYS",
    "COARSE_OBSERVATION",
    "EVENT_KINDS",
    "WAITING_STATES",
    "MAINLINE_STATES",
    "MISSION_SCHEMA",
    "MISSION_STATES",
    "RETRY_LADDER",
    "TERMINAL_STATES",
    "WAKE_KINDS",
    "assert_cycle_closure",
    "bind_mission",
    "events_path",
    "fold_mission",
    "index_path",
    "list_open_missions",
    "mission_id_for",
    "open_mission",
    "rebuild_mission_index",
    "transition_mission",
]
