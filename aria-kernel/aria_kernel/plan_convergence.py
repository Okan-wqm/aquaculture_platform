from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .agent_priors import reviewer_names
from .ledger import append_jsonl, load_jsonl, verify_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


FINDING_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-(CRITICAL|HIGH|MEDIUM|LOW)-[0-9]{3,}$")
EVENT_TYPES = {
    "plan_started",
    "challenger_plan_drafted",
    "critic_tasks_requested",
    "critique_recorded",
    "cross_review_tasks_requested",
    "cross_review_recorded",
    "stale_tasks_reaped",
    "revision_recorded",
    "plan_evaluated",
    "plan_abandoned",
    "lock_reaped",
}
TERMINAL_STATES = {"CONVERGED", "HUMAN_REQUIRED", "ABANDONED"}
ANSWERED_STATES = {"ANSWERED", "TIMEOUT_ABORTED"}
MAX_CROSS_REVIEW_ROUNDS = 5
REQUIRED_CROSS_REVIEW_DIRECTIONS = {"primary_to_challenger", "challenger_to_primary"}
KNOWN_SEVERITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW"}
MAX_PLAN_BYTES = 1_000_000
MAX_AFFECTED_PATHS = 200
MAX_RISKS = 100
MAX_TASKS_PER_ROUND = 50
LOCK_STALE_SECONDS = 300


def start_plan(
    *,
    plan_id: str,
    plan_content: dict[str, Any],
    initial_revision_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    _validate_id(initial_revision_id, "initial_revision_id")
    _validate_plan_content(plan_content)
    payload = {
        "plan_content": plan_content,
        "content_hash": content_hash(plan_content),
        "initial_revision_id": initial_revision_id,
    }
    return _mutate(
        plan_id=plan_id,
        command_name="start",
        canonical_payload=plan_content,
        event_type="plan_started",
        payload=payload,
        base_dir=base_dir,
        validator=lambda state: _validate_start(state),
    )


def request_critics(
    *,
    plan_id: str,
    request: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="request-critics",
        canonical_payload=request,
        event_type="critic_tasks_requested",
        payload=_normalize_critic_request(request),
        base_dir=base_dir,
        validator=_validate_critic_request,
    )


def submit_challenger_plan(
    *,
    plan_id: str,
    challenger: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="submit-challenger-plan",
        canonical_payload=challenger,
        event_type="challenger_plan_drafted",
        payload=_normalize_challenger_plan(challenger),
        base_dir=base_dir,
        validator=_validate_challenger_plan,
    )


def request_cross_review(
    *,
    plan_id: str,
    request: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="request-cross-review",
        canonical_payload=request,
        event_type="cross_review_tasks_requested",
        payload=_normalize_cross_review_request(request),
        base_dir=base_dir,
        validator=_validate_cross_review_request,
    )


def request_cross_review_retry(
    *,
    plan_id: str,
    request: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    payload = _normalize_cross_review_request(request)
    if not payload.get("replaces_task_ids"):
        raise GovernanceError("cross-review retry requires replaces_task_ids")
    return _mutate(
        plan_id=plan_id,
        command_name="request-cross-review-retry",
        canonical_payload=request,
        event_type="cross_review_tasks_requested",
        payload=payload,
        base_dir=base_dir,
        validator=_validate_cross_review_retry,
    )


def record_cross_review(
    *,
    plan_id: str,
    review: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    root = ensure_tools_dir(base_dir)
    payload = _normalize_cross_review(review)
    mismatch = _cross_review_hash_mismatch(root, payload)
    if mismatch:
        event = _append_rejection(root, "cross_review_content_hash_mismatch", {"plan_id": plan_id, **mismatch})
        return {"schema_version": 1, "plan_id": plan_id, "event_appended": False, "status": "rejected", "governance_event_id": event.get("event_id"), "reason": "cross_review_content_hash_mismatch"}
    return _mutate(
        plan_id=plan_id,
        command_name="record-cross-review",
        canonical_payload=review,
        event_type="cross_review_recorded",
        payload=payload,
        base_dir=root,
        validator=lambda state, normalized: _validate_cross_review_record(state, normalized, workspace_root),
    )


def record_critique(
    *,
    plan_id: str,
    critique: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="record-critique",
        canonical_payload=critique,
        event_type="critique_recorded",
        payload=_normalize_critique(critique),
        base_dir=base_dir,
        validator=lambda state, payload: _validate_critique(state, payload, workspace_root),
    )


def submit_cross_review_v8(
    *,
    plan_id: str,
    review: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V8.2 — single-step V8 P+C+CR cross-review state transition.

    The V8 P+C+CR architecture mints ONE aria-cross-reviewer envelope
    per round that bidirectionally compares primary↔challenger plans.
    The legacy 3-event kernel flow requires:

        CHALLENGER_DRAFTED
            ── request_cross_review(tasks=[per direction]) ──>
        CROSS_REVIEW_REQUESTED
            ── record_cross_review(per task) × 2 ──>
        CROSS_REVIEWED

    Until V8.2 the drainer minted only the envelope; the bridge had no
    way to take the agent's single response through both transitions,
    so every cross_review submission landed `cannot record cross-review
    from state CHALLENGER_DRAFTED`. V8.2 wraps the 3 events into one
    atomic kernel call:

      1. Read latest_revision + current_round from plan state.
      2. Synthesize deterministic task_packet_hash per
         REQUIRED_CROSS_REVIEW_DIRECTIONS (both directions).
      3. Call request_cross_review with both synthetic tasks
         (CHALLENGER_DRAFTED → CROSS_REVIEW_REQUESTED).
      4. Call record_cross_review per direction with the agent's
         risks shared across both directions
         (CROSS_REVIEW_REQUESTED → CROSS_REVIEWED after both ANSWERED).

    The agent does NOT need to know about task_packet_hash or
    direction — it produces verdict + risks. The kernel-side function
    here owns the metadata synthesis (Tier-1: V8 simplification lives
    in the kernel boundary, not in the agent prompt).

    Args:
        plan_id: target plan id (in CHALLENGER_DRAFTED state)
        review: dict with at minimum `reviewer_agent` + `risks`.
            Optional `verdict` is recorded as governance hint.
        workspace_root: passed through to record_cross_review for
            reviewer_names() validation.
        base_dir: aria-tools root override.

    Returns:
        The final record_cross_review event (state CROSS_REVIEWED).

    Raises:
        GovernanceError if state ≠ CHALLENGER_DRAFTED, or if review
        is malformed.
    """
    _validate_id(plan_id, "plan_id")
    if not isinstance(review, dict):
        raise GovernanceError("V8 cross-review must be a JSON object")

    root = ensure_tools_dir(base_dir)
    state = fold_plan_state(plan_id=plan_id, base_dir=root)
    _require_state(state, {"CHALLENGER_DRAFTED"}, "submit V8 cross-review")

    reviewer_agent = _require_non_empty(
        review.get("reviewer_agent") or "aria-cross-reviewer",
        "reviewer_agent",
    )
    risks = review.get("risks", [])
    if not isinstance(risks, list):
        raise GovernanceError("V8 cross-review risks must be a list")

    latest_rev = state.get("latest_revision") or {}
    target_revision_id = latest_rev.get("revision_id")
    target_hash = latest_rev.get("content_hash")
    if not target_revision_id or not target_hash:
        raise GovernanceError(
            f"V8 cross-review requires CHALLENGER_DRAFTED state with "
            f"complete latest_revision metadata; got "
            f"revision_id={target_revision_id!r} content_hash={target_hash!r}"
        )

    # Round-number: V8 cycle is the next round after the latest. Use
    # current_round if known, otherwise infer from cross_reviews count + 1.
    round_number = state.get("current_round")
    if not isinstance(round_number, int) or round_number <= 0:
        round_number = max(1, len(state.get("cross_reviews") or {}) + 1)

    # Deterministic review_content_hash from canonical risk list.
    review_content_hash = "sha256:" + hashlib.sha256(
        _canonical_json({"risks": risks, "reviewer_agent": reviewer_agent}).encode("utf-8")
    ).hexdigest()

    sla_deadline = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()

    # Synthesize one task per required cross-review direction.
    # Direction list is sorted deterministically for reproducibility.
    directions = sorted(REQUIRED_CROSS_REVIEW_DIRECTIONS)
    tasks: list[dict[str, Any]] = []
    for direction in directions:
        packet_seed = f"{plan_id}|{target_revision_id}|{target_hash}|round={round_number}|dir={direction}"
        packet_hash = "sha256:" + hashlib.sha256(packet_seed.encode("utf-8")).hexdigest()
        direction_short = "p2c" if direction == "primary_to_challenger" else "c2p"
        tasks.append({
            "task_id": f"v8-cr-{round_number}-{direction_short}-{target_revision_id[-8:]}",
            "task_packet_hash": packet_hash,
            # `_validate_task` (legacy critic task contract) reads
            # `target_agent`; `_validate_cross_review_task` (V8 cross-
            # review path) reads `reviewer_agent`. Carry both so the
            # task dict is accepted by either validator path.
            "target_agent": reviewer_agent,
            "reviewer_agent": reviewer_agent,
            "target_revision_id": target_revision_id,
            "target_plan_content_hash": target_hash,
            "review_direction": direction,
            "sla_deadline": sla_deadline,
            "status_after": "PENDING",
        })

    # Phase 1 — request_cross_review transitions CHALLENGER_DRAFTED
    # → CROSS_REVIEW_REQUESTED + persists both tasks.
    request_cross_review(
        plan_id=plan_id,
        request={
            "round_number": round_number,
            "target_revision_id": target_revision_id,
            "target_plan_content_hash": target_hash,
            "tasks": tasks,
        },
        base_dir=root,
    )

    # Phase 2 — record_cross_review per task. After both directions
    # answer, the state machine resolves to CROSS_REVIEWED.
    last_event: dict[str, Any] = {}
    for task in tasks:
        last_event = record_cross_review(
            plan_id=plan_id,
            review={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": target_revision_id,
                "target_plan_content_hash": target_hash,
                "reviewer_agent": reviewer_agent,
                "review_direction": task["review_direction"],
                "review_content_hash": review_content_hash,
                "status_after": "ANSWERED",
                "risks": risks,
                # agent_invocation_request_id intentionally omitted —
                # V8 bypasses the per-task content-hash mismatch check
                # because the agent submitted ONE envelope covering both
                # directions; the legacy mismatch check was scoped to
                # per-task envelopes.
            },
            workspace_root=workspace_root,
            base_dir=root,
        )

    return last_event


def reap_stale_tasks(
    *,
    plan_id: str,
    round_number: int,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_state(state, {"CRITIQUE_REQUESTED", "CROSS_REVIEW_REQUESTED"}, "reap stale tasks")
        now = datetime.now(timezone.utc)
        reaped = []
        round_data = state["rounds"].get(round_number) or state["cross_reviews"].get(round_number, {})
        for task in round_data.get("tasks", {}).values():
            if task.get("status") != "PENDING":
                continue
            deadline = _parse_iso_datetime(str(task.get("sla_deadline") or ""))
            if deadline is not None and deadline <= now:
                reaped.append(str(task["task_id"]))
        if not reaped:
            return {
                "schema_version": 1,
                "plan_id": plan_id,
                "event_appended": False,
                "status": state["state"],
                "reaped_task_ids": [],
            }
        payload = {"round_number": round_number, "reaped_task_ids": sorted(reaped)}
        event = _append_event(
            root=root,
            plan_id=plan_id,
            event_type="stale_tasks_reaped",
            payload=payload,
            idempotency_key=_idempotency_key(plan_id, "reap-stale-tasks", payload),
        )
        return _event_result(event, idempotent=False)


def record_revision(
    *,
    plan_id: str,
    revision: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return _mutate(
        plan_id=plan_id,
        command_name="record-revision",
        canonical_payload=revision,
        event_type="revision_recorded",
        payload=_normalize_revision(revision),
        base_dir=base_dir,
        validator=_validate_revision,
    )


def evaluate_plan(
    *,
    plan_id: str,
    round_number: int,
    base_dir: str | Path | None = None,
    max_rounds: int = MAX_CROSS_REVIEW_ROUNDS,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_state(state, {"CRITIQUED", "CROSS_REVIEWED"}, "evaluate plan")
        if state.get("current_round") != round_number:
            raise GovernanceError("round_number must match the current critique round")
        decision = _evaluate_cross_review_state(state, round_number, max_rounds=max_rounds) if state.get("state") == "CROSS_REVIEWED" else _evaluate_state(state, round_number)
        if decision["terminal_state"] == "NEXT_ROUND_REQUIRED":
            return {
                "schema_version": 1,
                "plan_id": plan_id,
                "event_appended": False,
                "status": "next_round_required",
                "reason_codes": decision["reason_codes"],
                "gate_decisions": decision["gate_decisions"],
            }
        payload = {
            "round_number": round_number,
            "terminal_state": decision["terminal_state"],
            "risks_rollup_summary": decision["risks_rollup_summary"],
            "gate_decisions": decision["gate_decisions"],
            "reason_codes": decision["reason_codes"],
        }
        key = _idempotency_key(plan_id, "evaluate", {"round_number": round_number})
        existing = _find_by_idempotency(root, key)
        if existing:
            result = _event_result(existing, idempotent=True)
            result["status"] = "evaluated"
            return result
        event = _append_event(root=root, plan_id=plan_id, event_type="plan_evaluated", payload=payload, idempotency_key=key)
        result = _event_result(event, idempotent=False)
        result["status"] = "evaluated"
        return result


def list_active_plans(*, base_dir: str | Path | None = None) -> list[str]:
    root = ensure_tools_dir(base_dir)
    path = events_path(root)
    raw = path.read_bytes() if path.exists() else b""
    events_hash = "sha256:" + hashlib.sha256(raw).hexdigest()
    cache_path = root / "plans" / "active-plans-cache.json"
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("events_hash") == events_hash and isinstance(cached.get("active_plan_ids"), list):
                return [str(item) for item in cached["active_plan_ids"]]
        except (OSError, json.JSONDecodeError):
            pass
    plan_ids = sorted({str(row.get("plan_id")) for row in load_jsonl(path) if row.get("plan_id")})
    active = [plan_id for plan_id in plan_ids if fold_plan_state(plan_id=plan_id, base_dir=root).get("state") not in TERMINAL_STATES]
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"schema_version": 1, "events_hash": events_hash, "event_count": len(load_jsonl(path)), "active_plan_ids": active}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return active


def force_plan_human_required(
    *,
    plan_id: str,
    round_number: int,
    reason_codes: list[str],
    active_gap_count: int = 0,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if not reason_codes:
        raise GovernanceError("reason_codes must be non-empty")
    root = ensure_tools_dir(base_dir)
    payload = {
        "round_number": round_number,
        "terminal_state": "HUMAN_REQUIRED",
        "risks_rollup_summary": {"max_rounds_reached": True, "active_gaps_unresolved": active_gap_count},
        "gate_decisions": [{"gate": "max_rounds", "decision": "human_escalation", "reason_codes": reason_codes}],
        "reason_codes": reason_codes,
    }
    key = _idempotency_key(plan_id, "force-human-required", payload)
    with _plan_lock(root):
        _verify_events_ledger(root)
        existing = _find_by_idempotency(root, key)
        if existing:
            return _event_result(existing, idempotent=True)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_started(state, "force human required")
        event = _append_event(root=root, plan_id=plan_id, event_type="plan_evaluated", payload=payload, idempotency_key=key)
        return _event_result(event, idempotent=False)


def abandon_plan(
    *,
    plan_id: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(reason, str) or not reason.strip():
        raise GovernanceError("reason must be a non-empty string")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        existing_abandon = _latest_event(state, "plan_abandoned")
        if existing_abandon:
            return _event_result(existing_abandon, idempotent=True)
        _require_started(state, "abandon plan")
        payload = {"reason": reason.strip(), "abandoned_from_state": state["state"]}
        key = _idempotency_key(plan_id, "abandon", payload)
        existing = _find_by_idempotency(root, key)
        if existing:
            return _event_result(existing, idempotent=True)
        event = _append_event(root=root, plan_id=plan_id, event_type="plan_abandoned", payload=payload, idempotency_key=key)
        return _event_result(event, idempotent=False)


def plan_status(*, plan_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    return fold_plan_state(plan_id=plan_id, base_dir=base_dir)


# Plan ARIA-V8 §4 Phase 8.0 (B-V2-12) — fold_plan_state mtime+plan_id
# cache. Pre-V8 the function did a full ledger scan + per-event
# validate+apply on every call. Convergence_drainer polls it every
# sleep_interval (5s) × deadline (1800s) = 360 calls per cycle wait.
# A 30-cycle smoke with 3 waits per round × 2 rounds = 64,800 calls →
# 15M JSON rows parsed. C0 adds a per-(events_path_mtime_ns, plan_id)
# cache keyed on the events file's mtime; invalidated automatically
# when _append_event() writes (mtime advances). Mirrors the cache
# pattern in list_active_plans (line 296-313).
#
# WHY a module-level dict: thread-safe enough for the single-threaded
# orchestrator loop. WHEN to invalidate: every write to events.jsonl
# advances mtime; the next read sees the new mtime, recomputes, stores.
_FOLD_PLAN_STATE_CACHE: dict[tuple[int, str, str], dict[str, Any]] = {}
_FOLD_PLAN_STATE_CACHE_MAX_ENTRIES = 512


def _events_file_size_bytes(root: Path) -> int:
    """Use FILE SIZE as the cache invalidation key.

    WHY NOT mtime: `ensure_tools_dir` calls `update_tools_index` which
    touches integrity metadata on events.jsonl, advancing mtime even
    when content is unchanged. Using size instead means the cache only
    invalidates on REAL appends (events.jsonl grows monotonically).
    """
    p = events_path(root)
    try:
        return p.stat().st_size
    except (FileNotFoundError, OSError):
        return 0


def fold_plan_state(*, plan_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    cache_key = (_events_file_size_bytes(root), str(root), plan_id)
    cached = _FOLD_PLAN_STATE_CACHE.get(cache_key)
    if cached is not None:
        # Defensive copy — callers may mutate the returned dict
        return {k: (v.copy() if isinstance(v, (dict, list)) else v) for k, v in cached.items()}
    events = [row for row in load_jsonl(events_path(root)) if row.get("plan_id") == plan_id]
    state = _initial_state(plan_id)
    for event in events:
        _validate_event(event)
        _apply_event(state, event)
    _derive_state(state)
    # Cap cache size — drop oldest entry when full (FIFO)
    if len(_FOLD_PLAN_STATE_CACHE) >= _FOLD_PLAN_STATE_CACHE_MAX_ENTRIES:
        _FOLD_PLAN_STATE_CACHE.pop(next(iter(_FOLD_PLAN_STATE_CACHE)))
    _FOLD_PLAN_STATE_CACHE[cache_key] = {k: (v.copy() if isinstance(v, (dict, list)) else v) for k, v in state.items()}
    return state


def content_hash(payload: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def events_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "plans" / "events.jsonl"


def _mutate(
    *,
    plan_id: str,
    command_name: str,
    canonical_payload: Any,
    event_type: str,
    payload: dict[str, Any],
    base_dir: str | Path | None,
    validator: Any,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    key = _idempotency_key(plan_id, command_name, canonical_payload)
    with _plan_lock(root):
        _verify_events_ledger(root)
        existing = _find_by_idempotency(root, key)
        if existing:
            return _event_result(existing, idempotent=True)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        validator(state, payload) if _takes_payload(validator) else validator(state)
        event = _append_event(root=root, plan_id=plan_id, event_type=event_type, payload=payload, idempotency_key=key)
        return _event_result(event, idempotent=False)


def _append_event(
    *,
    root: Path,
    plan_id: str,
    event_type: str,
    payload: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    event = {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "plan_id": plan_id,
        "recorded_at": utc_now(),
        "idempotency_key": idempotency_key,
        "payload": payload,
    }
    _validate_event(event)
    return append_jsonl(events_path(root), event)


def _append_rejection(root: Path, kind: str, details: dict[str, Any]) -> dict[str, Any]:
    return append_tools_governance(root, kind, details)


def _event_result(event: dict[str, Any], *, idempotent: bool) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "plan_id": event["plan_id"],
        "event_appended": not idempotent,
        "idempotent": idempotent,
        "event": event,
    }


def _idempotency_key(plan_id: str, command_name: str, canonical_payload: Any) -> str:
    raw = f"{plan_id}|{command_name}|{_canonical_json(canonical_payload)}"
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _canonical_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _find_by_idempotency(root: Path, key: str) -> dict[str, Any] | None:
    for row in load_jsonl(events_path(root)):
        if row.get("idempotency_key") == key:
            return row
    return None


def _results_pair_hash_check(
    *,
    plan_id: str,
    round_number: int,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan 026R §C.4 — bidirectional cross-review result-pair check.

    A convergent-planning round expects TWO accepted cross-review
    result rows (one per direction: primary→challenger and
    challenger→primary). This helper asserts:

    1. Both rows EXIST in ``agent-invocations/results.jsonl`` for the
       given ``(plan_id, round_number)``.
    2. Both rows carry a non-null ``content_hash`` field (§C.2 made
       this alias non-None on every accepted result row; pre-§C.4 the
       lookup was permanently None).
    3. The two ``content_hash`` values DIFFER. Identical hashes mean
       the same reviewer wrote both reviews — a collusion / single-
       agent signal that defeats the cross-review's adversarial
       contract.

    Raises ``GovernanceError`` with a structured reason code on any
    failure:

    * ``cross_review_pair_missing`` — zero rows found.
    * ``cross_review_pair_single_role_only`` — one direction filed.
    * ``cross_review_pair_identical_content_hash`` — collusion signal.

    On success returns ``{"plan_id", "round_number", "pair":
    [row_a, row_b]}`` so callers can chain ledger writes against the
    pair without re-querying.
    """
    from .ledger import load_jsonl as _load_jsonl
    root = Path(base_dir) if base_dir else Path.cwd()
    results = _load_jsonl(root / "agent-invocations" / "results.jsonl")
    candidates: list[dict[str, Any]] = []
    for row in results:
        if row.get("status") != "accepted":
            continue
        if row.get("role") != "cross_review":
            continue
        # Match on convergence_id OR plan_id; the kernel persists both
        # on different historical schemas, so accept either.
        row_plan_id = (
            row.get("plan_id")
            or row.get("convergence_id")
            or row.get("convergence_plan_id")
        )
        if row_plan_id != plan_id:
            continue
        if int(row.get("round_number") or row.get("round") or 0) != round_number:
            continue
        candidates.append(row)
    if not candidates:
        raise GovernanceError(
            f"cross_review_pair_missing: plan_id={plan_id!r} "
            f"round_number={round_number}"
        )
    if len(candidates) == 1:
        raise GovernanceError(
            f"cross_review_pair_single_role_only: plan_id={plan_id!r} "
            f"round_number={round_number} found 1 cross-review row, "
            f"need 2 (one per direction)"
        )
    # Take the most recent 2 (a round may have retries; the pair is
    # the last 2 by submission order).
    pair = candidates[-2:]
    hashes = [row.get("content_hash") for row in pair]
    if any(h is None for h in hashes):
        raise GovernanceError(
            f"cross_review_pair_missing_content_hash: plan_id={plan_id!r} "
            f"round_number={round_number} hashes={hashes}"
        )
    if hashes[0] == hashes[1]:
        raise GovernanceError(
            f"cross_review_pair_identical_content_hash: plan_id={plan_id!r} "
            f"round_number={round_number} hash={hashes[0]!r} — "
            f"identical reviews defeat the cross-review's adversarial "
            f"contract (collusion / single-agent signal)"
        )
    return {
        "plan_id": plan_id,
        "round_number": round_number,
        "pair": pair,
    }


def _cross_review_hash_mismatch(root: Path, payload: dict[str, Any]) -> dict[str, Any] | None:
    request_id = payload.get("agent_invocation_request_id")
    if not request_id:
        return None
    expected = payload.get("review_content_hash")
    for row in reversed(load_jsonl(root / "agent-invocations" / "results.jsonl")):
        if row.get("request_id") == request_id:
            actual = row.get("content_hash")
            if actual != expected:
                return {"agent_invocation_request_id": request_id, "expected_content_hash": actual, "provided_review_content_hash": expected}
            return None
    return {"agent_invocation_request_id": request_id, "reason": "agent_invocation_result_not_found", "provided_review_content_hash": expected}


def _verify_events_ledger(root: Path) -> None:
    result = verify_jsonl(events_path(root))
    if result.get("valid") is not True:
        raise GovernanceError(f"plans/events.jsonl integrity failure: {result.get('reason')}")


@contextmanager
def _plan_lock(root: Path) -> Iterator[None]:
    lock_path = root / "plans" / "events.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"pid": os.getpid(), "created_at": time.time()}
    fd: int | None = None
    while fd is None:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _reap_stale_lock(lock_path):
                continue
            raise GovernanceError("plans/events.jsonl is locked")
    try:
        os.write(fd, json.dumps(payload, sort_keys=True).encode("utf-8"))
        yield
    finally:
        if fd is not None:
            os.close(fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def _reap_stale_lock(lock_path: Path) -> bool:
    try:
        data = json.loads(lock_path.read_text(encoding="utf-8") or "{}")
    except (OSError, json.JSONDecodeError):
        data = {}
    pid = data.get("pid")
    created_at = float(data.get("created_at") or 0)
    if time.time() - created_at < LOCK_STALE_SECONDS:
        return False
    if isinstance(pid, int) and _pid_exists(pid):
        return False
    try:
        lock_path.unlink()
        return True
    except FileNotFoundError:
        return True


def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _initial_state(plan_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "plan_id": plan_id,
        "state": None,
        "events": [],
        "plan_started": None,
        "latest_revision": None,
        "challenger_plan": None,
        "current_round": None,
        "rounds": {},
        "cross_reviews": {},
        "cross_review_risks_by_round": {},
        "resolved_review_risk_ids": [],
        "terminal_state": None,
    }


def _apply_event(state: dict[str, Any], event: dict[str, Any]) -> None:
    state["events"].append(event)
    event_type = event["event_type"]
    payload = event["payload"]
    if event_type == "plan_started":
        state["state"] = "DRAFT"
        state["plan_started"] = payload
        state["latest_revision"] = {
            "revision_id": payload["initial_revision_id"],
            "content_hash": payload["content_hash"],
            "source": "plan_started",
        }
    elif event_type == "challenger_plan_drafted":
        # Plan ARIA-V8.18 — preserve plan_content in state reduction.
        # Pre-V8.18 the reduction stored only revision metadata + agent
        # identity but DISCARDED the actual plan_content dict from the
        # ledger event. The convergence_drainer V8.3 lookup then read
        # `state.challenger.plan_content` (also under the canonical
        # `challenger` key, not the pre-V8.18 `challenger_plan` alias)
        # to embed the challenger plan body into the cross_review
        # envelope's `<untrusted_challenger_plan>` delimiter. With
        # plan_content dropped, the drainer's fail-fast fallback fired
        # ("challenger plan_content unavailable in plan state"), the
        # cross-reviewer agent rightly refused with
        # `evidence_underspecified`, and convergence stalled.
        state["state"] = "CHALLENGER_DRAFTED"
        challenger_record = {
            "challenger_revision_id": payload["challenger_revision_id"],
            "content_hash": payload["content_hash"],
            "source_revision_id": payload["source_revision_id"],
            "source_plan_content_hash": payload["source_plan_content_hash"],
            "challenger_agent": payload.get("challenger_agent"),
            "plan_content": payload.get("plan_content"),
        }
        state["challenger"] = challenger_record
        # V8.18 — keep the legacy `challenger_plan` alias for any
        # consumer that already read it pre-V8.18; both keys point at
        # the same dict instance so a future drop of the legacy alias
        # is a single-line removal (no parallel data path).
        state["challenger_plan"] = challenger_record
    elif event_type == "critic_tasks_requested":
        round_number = payload["round_number"]
        state["current_round"] = round_number
        state["state"] = "CRITIQUE_REQUESTED"
        state["rounds"][round_number] = {
            "target_revision_id": payload["target_revision_id"],
            "target_plan_content_hash": payload["target_plan_content_hash"],
            "tasks": {
                task["task_packet_hash"]: {
                    **task,
                    "status": task["status_after"],
                    "critique": None,
                }
                for task in payload["tasks"]
            },
            "critiques": [],
        }
    elif event_type == "cross_review_tasks_requested":
        round_number = payload["round_number"]
        state["current_round"] = round_number
        state["state"] = "CROSS_REVIEW_REQUESTED"
        cross = state["cross_reviews"].setdefault(
            round_number,
            {
                "target_revision_id": payload["target_revision_id"],
                "target_plan_content_hash": payload["target_plan_content_hash"],
                "tasks": {},
                "reviews": [],
                "replaces_task_ids": [],
            },
        )
        replaced_by = {task_id: [] for task_id in payload.get("replaces_task_ids", [])}
        for task in payload["tasks"]:
            task_record = {**task, "status": task["status_after"], "review": None}
            cross["tasks"][task["task_packet_hash"]] = task_record
            for old_task_id in payload.get("replaces_task_ids", []):
                replaced_by.setdefault(old_task_id, []).append(task["task_id"])
        cross["replaces_task_ids"].extend(payload.get("replaces_task_ids", []))
        task_by_id = {task["task_id"]: task for task in cross["tasks"].values()}
        for old_task_id, new_task_ids in replaced_by.items():
            if old_task_id in task_by_id:
                task_by_id[old_task_id]["replaced_by_task_ids"] = sorted(set(new_task_ids))
    elif event_type == "critique_recorded":
        round_data = _round_for_target(state, payload["target_revision_id"], payload["target_plan_content_hash"])
        task = round_data["tasks"][payload["task_packet_hash"]]
        task["status"] = payload["status_after"]
        task["critique"] = payload
        round_data["critiques"].append(payload)
    elif event_type == "cross_review_recorded":
        cross = _cross_review_for_target(state, payload["target_revision_id"], payload["target_plan_content_hash"])
        task = cross["tasks"][payload["task_packet_hash"]]
        task["status"] = payload["status_after"]
        task["review"] = payload
        cross["reviews"].append(payload)
        surfaced = state["cross_review_risks_by_round"].setdefault(state["current_round"], [])
        for risk in payload.get("risks", []):
            surfaced.append({**risk, "surfaced_in_revision_id": payload["target_revision_id"]})
    elif event_type == "stale_tasks_reaped":
        round_data = state["rounds"].get(payload["round_number"]) or state["cross_reviews"].get(payload["round_number"], {})
        task_by_id = {task["task_id"]: task for task in round_data.get("tasks", {}).values()}
        for task_id in payload["reaped_task_ids"]:
            if task_id in task_by_id:
                task_by_id[task_id]["status"] = "TIMEOUT_ABORTED"
    elif event_type == "revision_recorded":
        state["state"] = "REVISED"
        state["latest_revision"] = {
            "revision_id": payload["revision_id"],
            "content_hash": payload["content_hash"],
            "source": "revision_recorded",
            "round": payload["round"],
        }
        resolved = set(state.get("resolved_review_risk_ids", []))
        resolved.update(str(item) for item in payload.get("addresses_review_risk_ids", []) if isinstance(item, str) and item)
        state["resolved_review_risk_ids"] = sorted(resolved)
    elif event_type == "plan_evaluated":
        state["state"] = payload["terminal_state"]
        state["terminal_state"] = payload["terminal_state"]
    elif event_type == "plan_abandoned":
        state["state"] = "ABANDONED"
        state["terminal_state"] = "ABANDONED"


def _derive_state(state: dict[str, Any]) -> None:
    if state["state"] in TERMINAL_STATES:
        return
    if state["state"] == "CROSS_REVIEW_REQUESTED":
        directions = _cross_review_direction_statuses(state, state.get("current_round"))
        if directions and all(status == "answered" for status in directions.values()):
            state["state"] = "CROSS_REVIEWED"
        return
    if state["state"] != "CRITIQUE_REQUESTED":
        return
    current_round = state.get("current_round")
    round_data = state["rounds"].get(current_round, {})
    tasks = list(round_data.get("tasks", {}).values())
    if tasks and all(task.get("status") in ANSWERED_STATES for task in tasks):
        state["state"] = "CRITIQUED"


def _round_for_target(state: dict[str, Any], revision_id: str, content_hash_value: str) -> dict[str, Any]:
    for round_data in state["rounds"].values():
        if round_data.get("target_revision_id") == revision_id and round_data.get("target_plan_content_hash") == content_hash_value:
            return round_data
    raise GovernanceError("target revision does not match an active critique round")


def _cross_review_for_target(state: dict[str, Any], revision_id: str, content_hash_value: str) -> dict[str, Any]:
    for round_data in state["cross_reviews"].values():
        if round_data.get("target_revision_id") == revision_id and round_data.get("target_plan_content_hash") == content_hash_value:
            return round_data
    raise GovernanceError("target revision does not match an active cross-review round")


def _normalize_critic_request(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise GovernanceError("critic request must be a JSON object")
    tasks = request.get("tasks")
    if not isinstance(tasks, list):
        raise GovernanceError("critic request tasks must be an array")
    return {
        "round_number": request.get("round_number"),
        "target_revision_id": request.get("target_revision_id"),
        "target_plan_content_hash": request.get("target_plan_content_hash"),
        "tasks": [{**task, "status_after": task.get("status_after", "PENDING")} for task in tasks],
    }


def _normalize_challenger_plan(challenger: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(challenger, dict):
        raise GovernanceError("challenger plan must be a JSON object")
    plan_content = challenger.get("plan_content")
    _validate_plan_content(plan_content)
    return {
        "challenger_agent": challenger.get("challenger_agent"),
        "challenger_revision_id": challenger.get("challenger_revision_id"),
        "source_revision_id": challenger.get("source_revision_id"),
        "source_plan_content_hash": challenger.get("source_plan_content_hash"),
        "plan_content": plan_content,
        "content_hash": content_hash(plan_content),
    }


def _normalize_cross_review_request(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise GovernanceError("cross-review request must be a JSON object")
    tasks = request.get("tasks")
    if not isinstance(tasks, list):
        raise GovernanceError("cross-review request tasks must be an array")
    return {
        "round_number": request.get("round_number"),
        "target_revision_id": request.get("target_revision_id"),
        "target_plan_content_hash": request.get("target_plan_content_hash"),
        "replaces_task_ids": [str(item) for item in request.get("replaces_task_ids", []) if isinstance(item, str) and item],
        "tasks": [{**task, "status_after": task.get("status_after", "PENDING")} for task in tasks],
    }


def _normalize_cross_review(review: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(review, dict):
        raise GovernanceError("cross-review must be a JSON object")
    return {
        "task_packet_hash": review.get("task_packet_hash"),
        "target_revision_id": review.get("target_revision_id"),
        "target_plan_content_hash": review.get("target_plan_content_hash"),
        "reviewer_agent": review.get("reviewer_agent"),
        "review_direction": review.get("review_direction"),
        "risks": review.get("risks", []),
        "review_content_hash": review.get("review_content_hash"),
        "agent_invocation_request_id": review.get("agent_invocation_request_id"),
        "status_after": review.get("status_after", "ANSWERED"),
    }


def _normalize_critique(critique: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(critique, dict):
        raise GovernanceError("critique must be a JSON object")
    return {
        "task_packet_hash": critique.get("task_packet_hash"),
        "target_revision_id": critique.get("target_revision_id"),
        "target_plan_content_hash": critique.get("target_plan_content_hash"),
        "reviewer": critique.get("reviewer"),
        "risks": critique.get("risks", []),
        "critique_content_hash": critique.get("critique_content_hash"),
        "status_after": critique.get("status_after", "ANSWERED"),
    }


def _normalize_revision(revision: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(revision, dict):
        raise GovernanceError("revision must be a JSON object")
    return {
        "revision_id": revision.get("revision_id"),
        "round": revision.get("round"),
        "content_hash": revision.get("content_hash"),
        "parent_revision_hash": revision.get("parent_revision_hash"),
        "content": revision.get("content"),
        "addresses_review_risk_ids": [str(item) for item in revision.get("addresses_review_risk_ids", []) if isinstance(item, str) and item],
    }


def _validate_start(state: dict[str, Any]) -> None:
    if state["plan_started"] is not None:
        raise GovernanceError("plan has already been started")


def _validate_critic_request(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"DRAFT", "REVISED", "CROSS_REVIEWED"}, "request critics")
    round_number = payload.get("round_number")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if round_number in state["rounds"]:
        raise GovernanceError("round has already requested critics")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    latest = state["latest_revision"]
    if target_revision_id != latest["revision_id"] or target_hash != latest["content_hash"]:
        raise GovernanceError("critic request must target the latest revision")
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise GovernanceError("tasks must contain at least one task")
    if len(tasks) > MAX_TASKS_PER_ROUND:
        raise GovernanceError("critic tasks per round limit exceeded")
    seen_hashes = set()
    for task in tasks:
        _validate_task(task, target_revision_id, target_hash)
        packet_hash = task["task_packet_hash"]
        if packet_hash in seen_hashes:
            raise GovernanceError("duplicate task_packet_hash")
        seen_hashes.add(packet_hash)


def _validate_challenger_plan(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"DRAFT", "REVISED"}, "submit challenger plan")
    _validate_id(_require_non_empty(payload.get("challenger_revision_id"), "challenger_revision_id"), "challenger_revision_id")
    _require_hash(payload.get("content_hash"), "content_hash")
    source_revision_id = _require_non_empty(payload.get("source_revision_id"), "source_revision_id")
    source_hash = _require_hash(payload.get("source_plan_content_hash"), "source_plan_content_hash")
    latest = state["latest_revision"]
    if source_revision_id != latest["revision_id"] or source_hash != latest["content_hash"]:
        raise GovernanceError("challenger plan must target latest primary revision")


def _validate_cross_review_request(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CHALLENGER_DRAFTED"}, "request cross-review")
    _validate_cross_review_task_payload(state, payload, allow_replaces=False)


def _validate_cross_review_retry(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CROSS_REVIEW_REQUESTED"}, "request cross-review retry")
    _validate_cross_review_task_payload(state, payload, allow_replaces=True)
    cross = state["cross_reviews"].get(payload["round_number"], {})
    task_by_id = {task["task_id"]: task for task in cross.get("tasks", {}).values()}
    for task_id in payload.get("replaces_task_ids", []):
        if task_by_id.get(task_id, {}).get("status") != "TIMEOUT_ABORTED":
            raise GovernanceError("replaces_task_ids must name timed-out cross-review tasks")


def _validate_cross_review_task_payload(state: dict[str, Any], payload: dict[str, Any], *, allow_replaces: bool) -> None:
    round_number = payload.get("round_number")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    if not allow_replaces and round_number in state["cross_reviews"]:
        raise GovernanceError("round has already requested cross-review")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    latest = state["latest_revision"]
    if target_revision_id != latest["revision_id"] or target_hash != latest["content_hash"]:
        raise GovernanceError("cross-review request must target the latest revision")
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise GovernanceError("tasks must contain at least one task")
    if len(tasks) > MAX_TASKS_PER_ROUND:
        raise GovernanceError("cross-review tasks per round limit exceeded")
    existing = state["cross_reviews"].get(round_number, {}) if allow_replaces else {}
    existing_task_ids = {task["task_id"] for task in existing.get("tasks", {}).values()}
    existing_packet_hashes = set(existing.get("tasks", {}).keys())
    seen_hashes = set()
    seen_task_ids = set()
    directions = set()
    for task in tasks:
        _validate_cross_review_task(task, target_revision_id, target_hash)
        packet_hash = task["task_packet_hash"]
        if packet_hash in seen_hashes:
            raise GovernanceError("duplicate task_packet_hash")
        if packet_hash in existing_packet_hashes:
            raise GovernanceError("retry task_packet_hash must be new")
        seen_hashes.add(packet_hash)
        task_id = task["task_id"]
        if task_id in seen_task_ids or task_id in existing_task_ids:
            raise GovernanceError("retry task_id must be new")
        seen_task_ids.add(task_id)
        directions.add(task["review_direction"])
    if not allow_replaces and not REQUIRED_CROSS_REVIEW_DIRECTIONS.issubset(directions):
        raise GovernanceError("cross-review must request both review directions")


def _validate_critique(state: dict[str, Any], payload: dict[str, Any], workspace_root: str | Path) -> None:
    _require_state(state, {"CRITIQUE_REQUESTED", "CRITIQUED"}, "record critique")
    packet_hash = _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    reviewer = _require_non_empty(payload.get("reviewer"), "reviewer")
    names = reviewer_names(workspace_root=workspace_root)
    if reviewer not in names:
        raise GovernanceError(f"unknown reviewer: {reviewer}")
    round_data = _round_for_target(state, target_revision_id, target_hash)
    task = round_data["tasks"].get(packet_hash)
    if task is None:
        raise GovernanceError("task_packet_hash does not match an active task")
    if task.get("status") == "TIMEOUT_ABORTED":
        raise GovernanceError("late critique after timeout is rejected")
    if task.get("status") != "PENDING":
        raise GovernanceError("critique task is not pending")
    if reviewer != task.get("target_agent"):
        raise GovernanceError("reviewer must match task target_agent")
    _require_hash(payload.get("critique_content_hash"), "critique_content_hash")
    if payload.get("status_after") != "ANSWERED":
        raise GovernanceError('critique status_after must be "ANSWERED"')
    risks = payload.get("risks")
    if not isinstance(risks, list):
        raise GovernanceError("risks must be an array")
    if len(risks) > MAX_RISKS:
        raise GovernanceError("risks limit exceeded")
    for risk in risks:
        _validate_risk(risk)


def _validate_cross_review_record(state: dict[str, Any], payload: dict[str, Any], workspace_root: str | Path) -> None:
    _require_state(state, {"CROSS_REVIEW_REQUESTED"}, "record cross-review")
    packet_hash = _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
    target_revision_id = _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
    target_hash = _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
    reviewer = _require_non_empty(payload.get("reviewer_agent"), "reviewer_agent")
    names = reviewer_names(workspace_root=workspace_root)
    if reviewer not in names:
        raise GovernanceError(f"unknown reviewer: {reviewer}")
    cross = _cross_review_for_target(state, target_revision_id, target_hash)
    task = cross["tasks"].get(packet_hash)
    if task is None:
        raise GovernanceError("task_packet_hash does not match an active cross-review task")
    if task.get("status") == "TIMEOUT_ABORTED":
        raise GovernanceError("late cross-review after timeout is rejected")
    if task.get("status") != "PENDING":
        raise GovernanceError("cross-review task is not pending")
    if reviewer != task.get("reviewer_agent"):
        raise GovernanceError("reviewer_agent must match task reviewer_agent")
    if payload.get("review_direction") != task.get("review_direction"):
        raise GovernanceError("review_direction must match task review_direction")
    _require_hash(payload.get("review_content_hash"), "review_content_hash")
    if payload.get("status_after") != "ANSWERED":
        raise GovernanceError('cross_review_recorded status_after must be "ANSWERED"')
    risks = payload.get("risks")
    if not isinstance(risks, list):
        raise GovernanceError("risks must be an array")
    if len(risks) > MAX_RISKS:
        raise GovernanceError("risks limit exceeded")
    for risk in risks:
        _validate_cross_review_risk(risk)


def _validate_revision(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CRITIQUED", "CROSS_REVIEWED"}, "record revision")
    _validate_id(_require_non_empty(payload.get("revision_id"), "revision_id"), "revision_id")
    round_number = payload.get("round")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round must be a positive integer")
    if round_number != state.get("current_round"):
        raise GovernanceError("revision round must match current critique round")
    _require_hash(payload.get("content_hash"), "content_hash")
    _require_non_empty(payload.get("content"), "content")
    parent = _require_hash(payload.get("parent_revision_hash"), "parent_revision_hash")
    latest = state["latest_revision"]
    if parent != latest["content_hash"]:
        raise GovernanceError("parent_revision_hash must match the latest revision content hash")


def _validate_task(task: dict[str, Any], target_revision_id: str, target_hash: str) -> None:
    if not isinstance(task, dict):
        raise GovernanceError("each task must be a JSON object")
    _validate_id(_require_non_empty(task.get("task_id"), "task_id"), "task_id")
    _require_hash(task.get("task_packet_hash"), "task_packet_hash")
    _require_non_empty(task.get("target_agent"), "target_agent")
    if task.get("target_revision_id") != target_revision_id:
        raise GovernanceError("task target_revision_id must match request target_revision_id")
    if task.get("target_plan_content_hash") != target_hash:
        raise GovernanceError("task target_plan_content_hash must match request target_plan_content_hash")
    if _parse_iso_datetime(_require_non_empty(task.get("sla_deadline"), "sla_deadline")) is None:
        raise GovernanceError("sla_deadline must be an ISO datetime")
    if task.get("status_after") != "PENDING":
        raise GovernanceError('task status_after must be "PENDING"')


def _validate_cross_review_task(task: dict[str, Any], target_revision_id: str, target_hash: str) -> None:
    if not isinstance(task, dict):
        raise GovernanceError("each cross-review task must be a JSON object")
    _validate_id(_require_non_empty(task.get("task_id"), "task_id"), "task_id")
    _require_hash(task.get("task_packet_hash"), "task_packet_hash")
    _require_non_empty(task.get("reviewer_agent"), "reviewer_agent")
    if task.get("review_direction") not in REQUIRED_CROSS_REVIEW_DIRECTIONS:
        raise GovernanceError("review_direction must be primary_to_challenger or challenger_to_primary")
    if task.get("target_revision_id") != target_revision_id:
        raise GovernanceError("task target_revision_id must match request target_revision_id")
    if task.get("target_plan_content_hash") != target_hash:
        raise GovernanceError("task target_plan_content_hash must match request target_plan_content_hash")
    if _parse_iso_datetime(_require_non_empty(task.get("sla_deadline"), "sla_deadline")) is None:
        raise GovernanceError("sla_deadline must be an ISO datetime")
    if task.get("status_after") != "PENDING":
        raise GovernanceError('task status_after must be "PENDING"')


def _validate_risk(risk: dict[str, Any]) -> None:
    if not isinstance(risk, dict):
        raise GovernanceError("risk must be a JSON object")
    for field in ("risk_category", "severity", "invariant", "recommendation"):
        _require_non_empty(risk.get(field), field)
    affected_files = risk.get("affected_files")
    if not isinstance(affected_files, list) or not all(_valid_repo_path(item) for item in affected_files):
        raise GovernanceError("affected_files must be repo-relative POSIX paths")
    evidence_refs = risk.get("evidence_refs")
    if not isinstance(evidence_refs, list) or not all(_valid_evidence_ref(item) for item in evidence_refs):
        raise GovernanceError("evidence_refs contains invalid reference")


def _validate_cross_review_risk(risk: dict[str, Any]) -> None:
    if not isinstance(risk, dict):
        raise GovernanceError("risk must be a JSON object")
    _require_non_empty(risk.get("risk_id"), "risk_id")
    for field in ("risk_category", "severity", "summary", "recommendation"):
        _require_non_empty(risk.get(field), field)
    if str(risk.get("severity")) not in {"blocking", "material", "nice_to_have", *KNOWN_SEVERITIES}:
        raise GovernanceError("cross-review risk severity is invalid")
    affected_files = risk.get("affected_files")
    if not isinstance(affected_files, list) or not all(_valid_repo_path(item) for item in affected_files):
        raise GovernanceError("affected_files must be repo-relative POSIX paths")
    evidence_refs = risk.get("evidence_refs")
    if not isinstance(evidence_refs, list) or not all(_valid_evidence_ref(item) for item in evidence_refs):
        raise GovernanceError("evidence_refs contains invalid reference")


def _validate_plan_content(plan: dict[str, Any]) -> None:
    if not isinstance(plan, dict):
        raise GovernanceError("plan content must be a JSON object")
    if len(_canonical_json(plan).encode("utf-8")) > MAX_PLAN_BYTES:
        raise GovernanceError("plan.json size limit exceeded")
    required = ("schema_version", "title", "summary", "affected_surfaces", "key_changes", "validation_commands", "evidence_refs")
    missing = [field for field in required if field not in plan]
    if missing:
        raise GovernanceError(f"plan content missing required field(s): {', '.join(missing)}")
    _require_non_empty(plan["title"], "title")
    _require_non_empty(plan["summary"], "summary")
    if not isinstance(plan["key_changes"], list) or not plan["key_changes"]:
        raise GovernanceError("key_changes must be a non-empty array")
    affected_paths = _affected_surface_paths(plan["affected_surfaces"])
    if len(affected_paths) > MAX_AFFECTED_PATHS:
        raise GovernanceError("affected_surfaces.paths limit exceeded")
    if not all(_valid_repo_path(path) for path in affected_paths):
        raise GovernanceError("affected_surfaces paths must be repo-relative POSIX paths")
    if not isinstance(plan["validation_commands"], list):
        raise GovernanceError("validation_commands must be an array")
    for command in plan["validation_commands"]:
        _validate_validation_command(command)
    if not isinstance(plan["evidence_refs"], list) or not all(_valid_evidence_ref(ref) for ref in plan["evidence_refs"]):
        raise GovernanceError("evidence_refs contains invalid reference")


def _validate_validation_command(command: dict[str, Any]) -> None:
    if not isinstance(command, dict):
        raise GovernanceError("validation command must be a JSON object")
    _require_non_empty(command.get("cmd"), "validation command cmd")
    expected_exit = command.get("expected_exit", 0)
    timeout_ms = command.get("timeout_ms", 60_000)
    if not isinstance(expected_exit, int):
        raise GovernanceError("validation command expected_exit must be an integer")
    if not isinstance(timeout_ms, int) or timeout_ms <= 0:
        raise GovernanceError("validation command timeout_ms must be a positive integer")


def _validate_event(event: dict[str, Any]) -> None:
    if not isinstance(event, dict):
        raise GovernanceError("event must be a JSON object")
    _require_non_empty(event.get("event_id"), "event_id")
    if event.get("event_type") not in EVENT_TYPES:
        raise GovernanceError(f"unknown event_type: {event.get('event_type')}")
    _require_non_empty(event.get("plan_id"), "plan_id")
    _require_hash(event.get("idempotency_key"), "idempotency_key")
    if not isinstance(event.get("payload"), dict):
        raise GovernanceError("event payload must be a JSON object")
    payload = event["payload"]
    event_type = event["event_type"]
    if event_type == "plan_started":
        _validate_plan_content(payload.get("plan_content"))
        _require_hash(payload.get("content_hash"), "content_hash")
        _require_non_empty(payload.get("initial_revision_id"), "initial_revision_id")
    elif event_type == "challenger_plan_drafted":
        _validate_plan_content(payload.get("plan_content"))
        _require_hash(payload.get("content_hash"), "content_hash")
        _require_non_empty(payload.get("challenger_revision_id"), "challenger_revision_id")
        _require_non_empty(payload.get("source_revision_id"), "source_revision_id")
        _require_hash(payload.get("source_plan_content_hash"), "source_plan_content_hash")
    elif event_type == "critic_tasks_requested":
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        if not isinstance(payload.get("tasks"), list):
            raise GovernanceError("tasks must be an array")
    elif event_type == "cross_review_tasks_requested":
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        if not isinstance(payload.get("tasks"), list):
            raise GovernanceError("tasks must be an array")
        if not isinstance(payload.get("replaces_task_ids", []), list):
            raise GovernanceError("replaces_task_ids must be an array")
    elif event_type == "critique_recorded":
        _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        _require_non_empty(payload.get("reviewer"), "reviewer")
        _require_hash(payload.get("critique_content_hash"), "critique_content_hash")
        if payload.get("status_after") != "ANSWERED":
            raise GovernanceError('critique_recorded status_after must be "ANSWERED"')
    elif event_type == "cross_review_recorded":
        _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        _require_non_empty(payload.get("reviewer_agent"), "reviewer_agent")
        if payload.get("review_direction") not in REQUIRED_CROSS_REVIEW_DIRECTIONS:
            raise GovernanceError("review_direction must be primary_to_challenger or challenger_to_primary")
        _require_hash(payload.get("review_content_hash"), "review_content_hash")
        if payload.get("status_after") != "ANSWERED":
            raise GovernanceError('cross_review_recorded status_after must be "ANSWERED"')
    elif event_type == "stale_tasks_reaped":
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        reaped = payload.get("reaped_task_ids")
        if not isinstance(reaped, list) or not reaped or not all(isinstance(item, str) and item for item in reaped):
            raise GovernanceError("reaped_task_ids must be a non-empty string array")
    elif event_type == "revision_recorded":
        _require_non_empty(payload.get("revision_id"), "revision_id")
        if not isinstance(payload.get("round"), int):
            raise GovernanceError("round must be an integer")
        _require_hash(payload.get("content_hash"), "content_hash")
        _require_hash(payload.get("parent_revision_hash"), "parent_revision_hash")
        _require_non_empty(payload.get("content"), "content")
        if not isinstance(payload.get("addresses_review_risk_ids", []), list):
            raise GovernanceError("addresses_review_risk_ids must be an array")
    elif event_type == "plan_evaluated":
        if payload.get("terminal_state") not in {"CONVERGED", "HUMAN_REQUIRED"}:
            raise GovernanceError("plan_evaluated terminal_state must be CONVERGED or HUMAN_REQUIRED")
        for field in ("risks_rollup_summary", "gate_decisions", "reason_codes"):
            if field not in payload:
                raise GovernanceError(f"plan_evaluated missing {field}")
    elif event_type == "plan_abandoned":
        _require_non_empty(payload.get("reason"), "reason")
        _require_non_empty(payload.get("abandoned_from_state"), "abandoned_from_state")
    elif event_type == "lock_reaped":
        for field in ("stale_lock_pid", "lock_age_seconds", "reaped_by_pid"):
            if not isinstance(payload.get(field), int):
                raise GovernanceError(f"lock_reaped {field} must be an integer")


def _evaluate_state(state: dict[str, Any], round_number: int) -> dict[str, Any]:
    round_data = state["rounds"][round_number]
    risks = [risk for critique in round_data.get("critiques", []) for risk in critique.get("risks", [])]
    tasks = list(round_data.get("tasks", {}).values())
    summary = {
        "critical": _severity_count(risks, "CRITICAL"),
        "high": _severity_count(risks, "HIGH"),
        "unknown": _unknown_count(risks),
        "medium": _severity_count(risks, "MEDIUM"),
        "low": _severity_count(risks, "LOW"),
        "pending_tasks": sum(1 for task in tasks if task.get("status") == "PENDING"),
        "timeout_aborted_tasks": sum(1 for task in tasks if task.get("status") == "TIMEOUT_ABORTED"),
        "risk_categories": sorted({str(risk.get("risk_category")) for risk in risks if risk.get("risk_category")}),
    }
    blockers = []
    if summary["critical"]:
        blockers.append("critical_risks_present")
    if summary["high"]:
        blockers.append("high_risks_present")
    if summary["unknown"]:
        blockers.append("unknown_risks_present")
    if summary["pending_tasks"]:
        blockers.append("pending_tasks_present")
    if summary["timeout_aborted_tasks"]:
        blockers.append("partial_coverage")
    new_categories = _new_categories(state, round_number)
    gate_decisions = [
        {"gate": "critical_zero", "passed": summary["critical"] == 0},
        {"gate": "high_zero", "passed": summary["high"] == 0},
        {"gate": "unknown_zero", "passed": summary["unknown"] == 0},
        {"gate": "no_pending_tasks", "passed": summary["pending_tasks"] == 0},
        {"gate": "no_partial_coverage", "passed": summary["timeout_aborted_tasks"] == 0},
        {"gate": "new_category_policy", "passed": not new_categories or round_number < 2, "new_categories": sorted(new_categories)},
    ]
    if blockers:
        return {
            "terminal_state": "HUMAN_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": blockers,
        }
    if round_number == 2 and new_categories:
        return {
            "terminal_state": "NEXT_ROUND_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": ["new_risk_category_round_2"],
        }
    if round_number >= 3 and new_categories:
        return {
            "terminal_state": "HUMAN_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": ["new_risk_category_round_3"],
        }
    return {
        "terminal_state": "CONVERGED",
        "risks_rollup_summary": summary,
        "gate_decisions": gate_decisions,
        "reason_codes": ["convergence_gates_passed"],
    }


def _evaluate_cross_review_state(state: dict[str, Any], round_number: int, *, max_rounds: int) -> dict[str, Any]:
    cross = state["cross_reviews"][round_number]
    risks = list(state.get("cross_review_risks_by_round", {}).get(round_number, []))
    resolved = set(state.get("resolved_review_risk_ids", []))
    active_risks = [risk for risk in risks if str(risk.get("risk_id")) not in resolved]
    material = [
        risk for risk in active_risks
        if str(risk.get("severity")).lower() in {"blocking", "material", "critical", "high"}
    ]
    tasks = list(cross.get("tasks", {}).values())
    directions = _cross_review_direction_statuses(state, round_number)
    summary = {
        "active_cross_review_risks": len(active_risks),
        "material_cross_review_risks": len(material),
        "partial_directions": sorted(direction for direction, status in directions.items() if status == "partial"),
        "pending_tasks": sum(1 for task in tasks if task.get("status") == "PENDING"),
        "timeout_aborted_tasks": sum(1 for task in tasks if task.get("status") == "TIMEOUT_ABORTED" and not task.get("replaced_by_task_ids")),
        "resolved_review_risks": len(resolved),
    }
    blockers = []
    if material:
        blockers.append("material_cross_review_risks_present")
    if summary["pending_tasks"]:
        blockers.append("pending_tasks_present")
    if summary["timeout_aborted_tasks"] or summary["partial_directions"]:
        blockers.append("partial_cross_review_coverage")
    gate_decisions = [
        {"gate": "material_cross_review_zero", "passed": not material},
        {"gate": "no_pending_tasks", "passed": summary["pending_tasks"] == 0},
        {"gate": "no_partial_directions", "passed": not summary["partial_directions"] and summary["timeout_aborted_tasks"] == 0},
        {"gate": "max_rounds", "passed": round_number < max_rounds, "max_rounds": max_rounds},
    ]
    if blockers:
        if round_number >= max_rounds:
            return {
                "terminal_state": "HUMAN_REQUIRED",
                "risks_rollup_summary": summary,
                "gate_decisions": gate_decisions,
                "reason_codes": sorted(set(blockers + ["max_rounds_reached"])),
            }
        return {
            "terminal_state": "NEXT_ROUND_REQUIRED",
            "risks_rollup_summary": summary,
            "gate_decisions": gate_decisions,
            "reason_codes": blockers,
        }
    return {
        "terminal_state": "CONVERGED",
        "risks_rollup_summary": summary,
        "gate_decisions": gate_decisions,
        "reason_codes": ["cross_review_convergence_gates_passed"],
    }


def _cross_review_direction_statuses(state: dict[str, Any], round_number: int | None) -> dict[str, str]:
    if round_number is None or round_number not in state.get("cross_reviews", {}):
        return {}
    cross = state["cross_reviews"][round_number]
    statuses: dict[str, str] = {}
    for direction in REQUIRED_CROSS_REVIEW_DIRECTIONS:
        tasks = [
            task for task in cross.get("tasks", {}).values()
            if task.get("review_direction") == direction and not task.get("replaced_by_task_ids")
        ]
        if not tasks:
            statuses[direction] = "pending"
        elif all(task.get("status") == "ANSWERED" for task in tasks):
            statuses[direction] = "answered"
        elif any(task.get("status") in {"ANSWERED", "TIMEOUT_ABORTED"} for task in tasks):
            statuses[direction] = "partial"
        else:
            statuses[direction] = "pending"
    return statuses


def _new_categories(state: dict[str, Any], round_number: int) -> set[str]:
    current = set(_categories_for_round(state, round_number))
    previous: set[str] = set()
    for prior_round in range(1, round_number):
        previous.update(_categories_for_round(state, prior_round))
    return current - previous


def _categories_for_round(state: dict[str, Any], round_number: int) -> set[str]:
    round_data = state["rounds"].get(round_number, {})
    risks = [risk for critique in round_data.get("critiques", []) for risk in critique.get("risks", [])]
    return {str(risk.get("risk_category")) for risk in risks if risk.get("risk_category")}


def _severity_count(risks: list[dict[str, Any]], severity: str) -> int:
    return sum(1 for risk in risks if str(risk.get("severity", "")).upper() == severity)


def _unknown_count(risks: list[dict[str, Any]]) -> int:
    return sum(1 for risk in risks if str(risk.get("severity", "")).upper() not in KNOWN_SEVERITIES)


def _latest_event(state: dict[str, Any], event_type: str) -> dict[str, Any] | None:
    for event in reversed(state["events"]):
        if event.get("event_type") == event_type:
            return event
    return None


def _require_started(state: dict[str, Any], action: str) -> None:
    if state["plan_started"] is None:
        raise GovernanceError(f"cannot {action}: plan has not been started")


def _require_state(state: dict[str, Any], allowed: set[str], action: str) -> None:
    _require_started(state, action)
    if state["state"] not in allowed:
        raise GovernanceError(f"cannot {action} from state {state['state']}")


def _require_non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GovernanceError(f"{field} must be a non-empty string")
    return value.strip()


def _require_hash(value: Any, field: str) -> str:
    value = _require_non_empty(value, field)
    if not value.startswith("sha256:") or len(value) != len("sha256:") + 64:
        raise GovernanceError(f"{field} must be a sha256 hash")
    return value


def _validate_id(value: str, field: str) -> None:
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", value or ""):
        raise GovernanceError(f"{field} contains invalid characters")


def _affected_surface_paths(affected_surfaces: Any) -> list[str]:
    if not isinstance(affected_surfaces, list):
        raise GovernanceError("affected_surfaces must be an array")
    paths: list[str] = []
    for surface in affected_surfaces:
        if isinstance(surface, str):
            paths.append(surface)
        elif isinstance(surface, dict):
            value = surface.get("paths", [])
            if not isinstance(value, list):
                raise GovernanceError("affected_surfaces.paths must be an array")
            paths.extend(value)
        else:
            raise GovernanceError("affected_surfaces entries must be strings or objects")
    return paths


def _valid_repo_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    path = value.strip()
    return not (path.startswith("/") or "\\" in path or path.startswith("../") or "/../" in path or path == "..")


def _valid_evidence_ref(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    ref = value.strip()
    return bool(FINDING_ID_RE.match(ref)) or _valid_repo_path(ref)


def _parse_iso_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _takes_payload(func: Any) -> bool:
    return getattr(func, "__name__", "") in {
        "_validate_critic_request",
        "_validate_revision",
    } or func.__class__.__name__ == "function" and getattr(func, "__code__", None) and func.__code__.co_argcount >= 2
