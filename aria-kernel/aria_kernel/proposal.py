from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


PROPOSAL_KINDS = ("test_gap", "architecture", "security_hardening", "performance", "self_change")


def record_proposal(
    *,
    kind: str,
    title: str,
    problem: str,
    evidence: list[str],
    validation_command: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if kind not in PROPOSAL_KINDS:
        raise GovernanceError(f"unknown proposal kind: {kind}")
    if not title.strip() or not problem.strip() or not validation_command.strip():
        raise GovernanceError("proposal title, problem and validation command are required")
    if not evidence or not all(isinstance(item, str) and item.strip() for item in evidence):
        raise GovernanceError("proposal evidence must contain at least one repo evidence path")
    row = {
        "schema_version": 1,
        "proposal_id": f"proposal-{uuid.uuid4()}",
        "recorded_at": utc_now(),
        "kind": kind,
        "title": title,
        "problem": problem,
        "evidence": evidence,
        "validation_command": validation_command,
        "status": "open",
    }
    append_jsonl(ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl", row)
    return row


def list_proposals(*, base_dir: str | Path | None = None, kind: str | None = None) -> list[dict[str, Any]]:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl")
    if kind is not None:
        rows = [row for row in rows if row.get("kind") == kind]
    return rows
