from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .pressure import effective_workspace_pressures
from .tool_registry import append_tools_governance, ensure_tools_binding, update_tools_index
from .triage import derive_required_tests, resolve_target_agent
from .workspace import WorkspacePaths


def create_dispatch_request(
    paths: WorkspacePaths,
    *,
    pressure_event_id: str,
    tools_root: str | Path | None = None,
    target_agent: str | None = None,
    prepare_worktree: bool = False,
    acknowledge: bool = False,
) -> dict[str, Any]:
    root = ensure_tools_binding(tools_root, workspace_root=paths.repo_root)
    pressure = _pressure_by_id(paths, pressure_event_id)
    if pressure is None:
        raise ValueError(f"pressure not found: {pressure_event_id}")
    decision = _latest_decision(root, pressure_event_id)
    tier = str((decision or {}).get("triage_tier") or "blocked")
    target = target_agent or str((decision or {}).get("target_agent") or "") or resolve_target_agent(pressure, root)
    if not target:
        event = append_tools_governance(root, "agent_resolution_failed", {"pressure_event_id": pressure_event_id, "capability_gap_key": pressure.get("capability_gap_key")})
        return {"schema_version": 1, "status": "not_created", "reason": "agent_resolution_failed", "governance_event_id": event.get("event_id")}
    if tier not in {"auto_fix_safe", "needs_review"}:
        return {"schema_version": 1, "status": "not_created", "reason": f"triage_tier_{tier}_not_dispatchable", "triage_tier": tier}
    if prepare_worktree and not acknowledge:
        raise ValueError("prepare_worktree_requires_acknowledge")
    base_sha = _git(paths.repo_root, "rev-parse", "HEAD")
    created_at = _git_timestamp(paths.repo_root)
    assignment_id = _assignment_id(pressure_event_id, created_at, target)
    worktree_path = paths.repo_root / "aria-worktrees" / assignment_id
    required_tests = list((decision or {}).get("required_tests") or derive_required_tests(paths.repo_root, _evidence_paths(pressure)))
    row = {
        "$schema": "aria/dispatch-request/v1",
        "schema_version": 1,
        "assignment_id": assignment_id,
        "pressure_event_id": pressure_event_id,
        "target_agent": target,
        "triage_tier": tier,
        "worktree_path": worktree_path.as_posix(),
        "base_sha": base_sha,
        "required_tests": required_tests,
        "expected_trailer": ("Closes-Pressure: " if tier == "auto_fix_safe" else "Addresses-Pressure: ") + pressure_event_id,
        "state": "pending",
        "created_at": created_at,
    }
    if prepare_worktree:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        completed = subprocess.run(["git", "worktree", "add", worktree_path.as_posix(), base_sha], cwd=paths.repo_root, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "git worktree add failed")
        row["state"] = "prepared"
    stored = append_jsonl(root / "dispatch" / "requests.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "dispatch_request_created", {"assignment_id": assignment_id, "pressure_event_id": pressure_event_id, "target_agent": target, "state": row["state"]})
    if row["state"] != "pending":
        append_tools_governance(root, "dispatch_request_state_changed", {"assignment_id": assignment_id, "from_state": "pending", "to_state": row["state"]})
    return stored


def _assignment_id(pressure_event_id: str, created_at: str, target_agent: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", target_agent.lower()).strip("-")[:32] or "worker"
    digest = hashlib.sha256(f"{pressure_event_id}{created_at}".encode("utf-8")).hexdigest()[:8]
    return f"A-{slug}-{digest}"


def _latest_decision(root: Path, pressure_event_id: str) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(root / "triage" / "decisions.jsonl")):
        if row.get("pressure_event_id") == pressure_event_id:
            return row
    return None


def _pressure_by_id(paths: WorkspacePaths, pressure_event_id: str) -> dict[str, Any] | None:
    for pressure in effective_workspace_pressures(paths):
        if pressure.get("event_id") == pressure_event_id or pressure.get("pressure_id") == pressure_event_id:
            return pressure
    return None


def _evidence_paths(pressure: dict[str, Any]) -> list[str]:
    refs = pressure.get("evidence_refs") if isinstance(pressure.get("evidence_refs"), list) else []
    return [str(ref) for ref in refs if isinstance(ref, str)]


def _git(repo_root: Path, *args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=repo_root, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()


def _git_timestamp(repo_root: Path) -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
