from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


PROPOSAL_KINDS = ("test_gap", "architecture", "security_hardening", "performance", "self_change")


def record_proposal(
    *,
    kind: str,
    title: str,
    problem: str,
    evidence: list[str],
    validation_command: str,
    validation_commands: list[str] | None = None,
    source_authority: str = "manual",
    risk_class: str = "unknown",
    task_id: str | None = None,
    proposed_change: str | None = None,
    status: str = "open",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if kind not in PROPOSAL_KINDS:
        raise GovernanceError(f"unknown proposal kind: {kind}")
    if not title.strip() or not problem.strip() or not validation_command.strip():
        raise GovernanceError("proposal title, problem and validation command are required")
    if not evidence or not all(isinstance(item, str) and item.strip() for item in evidence):
        raise GovernanceError("proposal evidence must contain at least one repo evidence path")
    if validation_commands is not None and (
        not validation_commands or not all(isinstance(item, str) and item.strip() for item in validation_commands)
    ):
        raise GovernanceError("proposal validation_commands must be non-empty strings when provided")
    row = {
        "schema_version": 1,
        "proposal_id": f"proposal-{uuid.uuid4()}",
        "recorded_at": utc_now(),
        "kind": kind,
        "title": title,
        "problem": problem,
        "evidence": evidence,
        "validation_command": validation_command,
        "source_authority": source_authority,
        "risk_class": risk_class,
        "task_id": task_id,
        "proposed_change": proposed_change or title,
        "validation_scope": {"commands": validation_commands or [validation_command]},
        "blocked_by": _blocked_by(source_authority, status),
        "status": status,
    }
    append_declared_jsonl(
        ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
        row,
        expected_surface="proposals",
    )
    return row


def list_proposals(*, base_dir: str | Path | None = None, kind: str | None = None) -> list[dict[str, Any]]:
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
        expected_surface="proposals",
    )
    if kind is not None:
        rows = [row for row in rows if row.get("kind") == kind]
    return rows


def get_proposal(*, proposal_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    for row in reversed(
        load_declared_jsonl(
            ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
            expected_surface="proposals",
        ),
    ):
        if row.get("proposal_id") == proposal_id:
            return row
    raise GovernanceError(f"proposal not found: {proposal_id}")


def approve_proposal(
    *,
    proposal_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not operator_approval_ref.strip():
        raise GovernanceError("operator approval ref is required")
    previous = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    row = dict(previous)
    row["recorded_at"] = utc_now()
    row["status"] = "approved_for_apply"
    row["operator_approval_ref"] = operator_approval_ref
    row["blocked_by"] = []
    append_declared_jsonl(
        ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
        row,
        expected_surface="proposals",
    )
    return row


def proposal_packet_from_task(task: dict[str, Any]) -> dict[str, Any]:
    evidence_refs = task.get("evidence_refs", [])
    validation_commands = task.get("validation_commands", [])
    if not isinstance(evidence_refs, list) or not evidence_refs:
        raise GovernanceError("task has no evidence refs")
    if not isinstance(validation_commands, list) or not validation_commands:
        raise GovernanceError("task has no validation commands")
    task_id = str(task.get("task_id") or "")
    packet_id = "packet-" + hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    return {
        "schema_version": 1,
        "packet_id": packet_id,
        "task_id": task_id,
        "source_authority": task.get("source_authority"),
        "title": task.get("title"),
        "problem": task.get("problem"),
        "risk_class": task.get("risk_class"),
        "evidence_refs": [str(item) for item in evidence_refs],
        "validation_commands": [str(item) for item in validation_commands],
        "blocked_by": task.get("blocked_by", []),
    }


def record_proposal_from_amplification(
    *,
    task: dict[str, Any],
    amplification: dict[str, Any],
    kind: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    response = amplification.get("response", {})
    status = "draft_shadow" if task.get("source_authority") == "shadow_draft" else "ready_for_operator"
    return record_proposal(
        kind=kind,
        title=str(response.get("title")),
        problem=str(response.get("problem")),
        evidence=[str(item) for item in response.get("evidence_refs", [])],
        validation_command=str(response.get("validation_commands", [""])[0]),
        validation_commands=[str(item) for item in response.get("validation_commands", [])],
        source_authority=str(task.get("source_authority") or "unknown"),
        risk_class=str(task.get("risk_class") or "unknown"),
        task_id=str(task.get("task_id") or ""),
        proposed_change=str(response.get("proposed_change")),
        status=status,
        base_dir=base_dir,
    )


def _blocked_by(source_authority: str, status: str) -> list[str]:
    if status == "approved_for_apply":
        return []
    if source_authority == "shadow_draft":
        return ["operator_feedback_required", "active_finding_required"]
    if status in ("open", "ready_for_operator"):
        return ["operator_approval_required"]
    return []
