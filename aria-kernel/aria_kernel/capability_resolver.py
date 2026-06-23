from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Literal

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


CapabilityDecision = Literal["reuse", "extend", "request", "reject_duplicate"]


def resolve_capability(
    *,
    capability_key: str,
    requested_kind: str,
    title: str,
    existing_capabilities: list[dict[str, Any]] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not capability_key.strip():
        raise GovernanceError("capability_key_required")
    if requested_kind not in {"agent", "skill"}:
        raise GovernanceError("capability_requested_kind_unknown")
    existing = existing_capabilities or []
    exact = [
        item for item in existing
        if str(item.get("capability_key") or "") == capability_key
        or str(item.get("name") or "").lower() == title.strip().lower()
    ]
    if exact:
        decision: CapabilityDecision = "reuse"
    elif existing:
        decision = "extend"
    else:
        decision = "request"
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": _resolution_id(capability_key, requested_kind, title),
        "row_type": "capability_resolution_decision",
        "capability_key": capability_key,
        "requested_kind": requested_kind,
        "title": title,
        "decision": decision,
        "existing_capabilities": existing,
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "capability-resolution" / "decisions.jsonl",
        row,
        expected_surface="capability_resolution_decisions",
    )


def require_capability_resolution(
    *,
    capability_key: str,
    requested_kind: str,
    base_dir: str | Path | None = None,
    allowed_decisions: set[str] | None = None,
) -> dict[str, Any]:
    allowed = allowed_decisions or {"request", "extend"}
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "capability-resolution" / "decisions.jsonl",
        expected_surface="capability_resolution_decisions",
    )
    match = next(
        (
            row for row in reversed(rows)
            if row.get("capability_key") == capability_key
            and row.get("requested_kind") == requested_kind
        ),
        None,
    )
    if match is None:
        raise GovernanceError("capability_resolution_required_for_genesis")
    if match.get("decision") not in allowed:
        raise GovernanceError(f"capability_resolution_decision_rejected:{match.get('decision')}")
    return match


def _resolution_id(capability_key: str, requested_kind: str, title: str) -> str:
    raw = f"{capability_key}\0{requested_kind}\0{title}".encode("utf-8")
    return "capability-resolution:" + hashlib.sha256(raw).hexdigest()[:24]


__all__ = [
    "resolve_capability",
    "require_capability_resolution",
]
