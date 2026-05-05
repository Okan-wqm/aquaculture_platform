from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .agent_priors import reviewer_names
from .ledger import append_jsonl, load_jsonl, verify_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FINDING_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-(CRITICAL|HIGH|MEDIUM|LOW)-[0-9]{3,}$")
EVENT_TYPES = {
    "plan_started",
    "critic_tasks_requested",
    "critique_recorded",
    "stale_tasks_reaped",
    "revision_recorded",
    "plan_evaluated",
    "plan_abandoned",
    "lock_reaped",
}
TERMINAL_STATES = {"CONVERGED", "HUMAN_REQUIRED", "ABANDONED"}
ANSWERED_STATES = {"ANSWERED", "TIMEOUT_ABORTED"}
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
        _require_state(state, {"CRITIQUE_REQUESTED"}, "reap stale tasks")
        now = datetime.now(timezone.utc)
        reaped = []
        for task in state["rounds"].get(round_number, {}).get("tasks", {}).values():
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
) -> dict[str, Any]:
    _validate_id(plan_id, "plan_id")
    if not isinstance(round_number, int) or round_number <= 0:
        raise GovernanceError("round_number must be a positive integer")
    root = ensure_tools_dir(base_dir)
    with _plan_lock(root):
        _verify_events_ledger(root)
        state = fold_plan_state(plan_id=plan_id, base_dir=root)
        _require_state(state, {"CRITIQUED"}, "evaluate plan")
        if state.get("current_round") != round_number:
            raise GovernanceError("round_number must match the current critique round")
        decision = _evaluate_state(state, round_number)
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
            return _event_result(existing, idempotent=True)
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


def fold_plan_state(*, plan_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    events = [row for row in load_jsonl(events_path(root)) if row.get("plan_id") == plan_id]
    state = _initial_state(plan_id)
    for event in events:
        _validate_event(event)
        _apply_event(state, event)
    _derive_state(state)
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
        "current_round": None,
        "rounds": {},
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
    elif event_type == "critique_recorded":
        round_data = _round_for_target(state, payload["target_revision_id"], payload["target_plan_content_hash"])
        task = round_data["tasks"][payload["task_packet_hash"]]
        task["status"] = payload["status_after"]
        task["critique"] = payload
        round_data["critiques"].append(payload)
    elif event_type == "stale_tasks_reaped":
        round_data = state["rounds"].get(payload["round_number"], {})
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
    elif event_type == "plan_evaluated":
        state["state"] = payload["terminal_state"]
        state["terminal_state"] = payload["terminal_state"]
    elif event_type == "plan_abandoned":
        state["state"] = "ABANDONED"
        state["terminal_state"] = "ABANDONED"


def _derive_state(state: dict[str, Any]) -> None:
    if state["state"] in TERMINAL_STATES or state["state"] != "CRITIQUE_REQUESTED":
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
    }


def _validate_start(state: dict[str, Any]) -> None:
    if state["plan_started"] is not None:
        raise GovernanceError("plan has already been started")


def _validate_critic_request(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"DRAFT", "REVISED"}, "request critics")
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


def _validate_revision(state: dict[str, Any], payload: dict[str, Any]) -> None:
    _require_state(state, {"CRITIQUED"}, "record revision")
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
    elif event_type == "critic_tasks_requested":
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        if not isinstance(payload.get("round_number"), int):
            raise GovernanceError("round_number must be an integer")
        if not isinstance(payload.get("tasks"), list):
            raise GovernanceError("tasks must be an array")
    elif event_type == "critique_recorded":
        _require_hash(payload.get("task_packet_hash"), "task_packet_hash")
        _require_hash(payload.get("target_plan_content_hash"), "target_plan_content_hash")
        _require_non_empty(payload.get("target_revision_id"), "target_revision_id")
        _require_non_empty(payload.get("reviewer"), "reviewer")
        _require_hash(payload.get("critique_content_hash"), "critique_content_hash")
        if payload.get("status_after") != "ANSWERED":
            raise GovernanceError('critique_recorded status_after must be "ANSWERED"')
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
