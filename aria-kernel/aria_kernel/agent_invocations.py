from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


ROLES = {
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "gap_finding",
    "implementation",
    "verification",
    "gap_closure",
    "maintenance_utility",
}
STATUSES = {"completed", "rejected", "partial"}


def create_agent_invocation_request(
    *,
    target_agent: str,
    role: str,
    suggested_prompt: str,
    convergence_id: str | None = None,
    pressure_event_id: str | None = None,
    round_number: int | None = None,
    expected_output_path: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if role not in ROLES:
        raise GovernanceError(f"unknown invocation role: {role}")
    if not target_agent.strip():
        raise GovernanceError("target_agent is required")
    if not suggested_prompt.strip():
        raise GovernanceError("suggested_prompt is required")
    root = ensure_tools_dir(base_dir)
    request_id = _request_id(target_agent, role, suggested_prompt, convergence_id, round_number)
    expected = expected_output_path or _default_expected_output_path(root, request_id, convergence_id, round_number, role)
    row = {
        "$schema": "aria/agent-invocation-request/v1",
        "schema_version": 1,
        "request_id": request_id,
        "convergence_id": convergence_id,
        "pressure_event_id": pressure_event_id,
        "round_number": round_number,
        "role": role,
        "target_agent": target_agent,
        "suggested_prompt": suggested_prompt,
        "expected_output_path": expected,
        "state": "pending",
        "created_at": utc_now(),
    }
    return append_jsonl(root / "agent-invocations" / "requests.jsonl", row)


def submit_agent_invocation_result(
    *,
    request_id: str,
    output_path: str | Path,
    status: str = "completed",
    by: str | None = None,
    rejection_reason: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if status not in STATUSES:
        raise GovernanceError("status must be completed, rejected, or partial")
    if status != "completed" and not (rejection_reason or "").strip():
        raise GovernanceError("rejection_reason is required unless status is completed")
    root = ensure_tools_dir(base_dir)
    request = _find_request(root, request_id)
    expected = _resolve_for_compare(request.get("expected_output_path"))
    actual = _resolve_for_compare(output_path)
    if expected != actual:
        event = append_tools_governance(
            root,
            "agent_invocation_path_mismatch",
            {"request_id": request_id, "expected_output_path": str(expected), "output_path": str(actual)},
        )
        return {"schema_version": 1, "status": "rejected", "reason": "agent_invocation_path_mismatch", "governance_event_id": event.get("event_id")}
    path = Path(output_path)
    if not path.exists():
        raise GovernanceError(f"output_path does not exist: {output_path}")
    row = {
        "$schema": "aria/agent-invocation-result/v1",
        "schema_version": 1,
        "request_id": request_id,
        "convergence_id": request.get("convergence_id"),
        "pressure_event_id": request.get("pressure_event_id"),
        "round_number": request.get("round_number"),
        "role": request.get("role"),
        "target_agent": request.get("target_agent"),
        "output_path": path.resolve().as_posix(),
        "content_hash": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
        "status": status,
        "by": by,
        "rejection_reason": rejection_reason,
        "submitted_at": utc_now(),
    }
    return append_jsonl(root / "agent-invocations" / "results.jsonl", row)


def list_agent_invocation_requests(
    *,
    base_dir: str | Path | None = None,
    state: str | None = None,
    convergence_id: str | None = None,
    target_agent: str | None = None,
    request_id: str | None = None,
    role: str | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "agent-invocations" / "requests.jsonl")
    if state is not None:
        rows = [row for row in rows if row.get("state") == state]
    if convergence_id is not None:
        rows = [row for row in rows if row.get("convergence_id") == convergence_id]
    if target_agent is not None:
        rows = [row for row in rows if row.get("target_agent") == target_agent]
    if request_id is not None:
        rows = [row for row in rows if row.get("request_id") == request_id]
    if role is not None:
        rows = [row for row in rows if row.get("role") == role]
    return rows


def _find_request(root: Path, request_id: str) -> dict[str, Any]:
    for row in reversed(load_jsonl(root / "agent-invocations" / "requests.jsonl")):
        if row.get("request_id") == request_id:
            return row
    raise GovernanceError(f"agent invocation request not found: {request_id}")


def _request_id(target_agent: str, role: str, prompt: str, convergence_id: str | None, round_number: int | None) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in target_agent.lower()).strip("-")[:32] or "agent"
    digest = hashlib.sha256(f"{target_agent}|{role}|{prompt}|{convergence_id}|{round_number}|{utc_now()}".encode("utf-8")).hexdigest()[:8]
    return f"AIR-{slug}-{digest}"


def _default_expected_output_path(root: Path, request_id: str, convergence_id: str | None, round_number: int | None, role: str) -> str:
    group = convergence_id or "general"
    round_part = f"round-{round_number}" if round_number is not None else "round-na"
    return (root / "agent-invocations" / "outputs" / group / f"{round_part}-{role}-{request_id}.md").resolve().as_posix()


def _resolve_for_compare(path: str | Path | None) -> Path:
    if path is None:
        raise GovernanceError("output path is required")
    return Path(path).expanduser().resolve()
