from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .pressure import effective_workspace_pressures
from .tool_registry import append_tools_governance, ensure_tools_binding, update_tools_index
from .triage import derive_required_tests, resolve_target_agent
from .workspace import WorkspacePaths


DEFAULT_WORKTREE_TTL_DAYS = 7
DEFAULT_AUTO_BATCH_LIMIT = 10


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


def list_dispatch_requests(
    tools_root: str | Path,
    *,
    state: str | None = None,
    target_agent: str | None = None,
    pressure_event_id: str | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(Path(tools_root) / "dispatch" / "requests.jsonl")
    states = _latest_request_states(Path(tools_root))
    enriched: list[dict[str, Any]] = []
    for row in rows:
        pe = row.get("pressure_event_id")
        current_state = states.get(pe, row.get("state", "pending")) if pe else row.get("state", "pending")
        view = dict(row)
        view["current_state"] = current_state
        enriched.append(view)
    if state is not None:
        enriched = [r for r in enriched if r.get("current_state") == state]
    if target_agent is not None:
        enriched = [r for r in enriched if r.get("target_agent") == target_agent]
    if pressure_event_id is not None:
        enriched = [r for r in enriched if r.get("pressure_event_id") == pressure_event_id]
    return enriched


def mark_dispatch_picked_up(
    tools_root: str | Path,
    *,
    pressure_event_id: str,
    actor: str,
) -> dict[str, Any]:
    if not actor or not actor.strip():
        raise ValueError("mark_picked_up_requires_actor")
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    matching = [r for r in rows if r.get("pressure_event_id") == pressure_event_id]
    if not matching:
        return {"schema_version": 1, "status": "not_found", "pressure_event_id": pressure_event_id}
    latest = matching[-1]
    states = _latest_request_states(root)
    current_state = states.get(pressure_event_id, latest.get("state", "pending"))
    if current_state in {"completed", "cancelled", "expired"}:
        return {
            "schema_version": 1,
            "status": "rejected",
            "pressure_event_id": pressure_event_id,
            "reason": f"already_{current_state}",
        }
    event = append_tools_governance(
        root,
        "dispatch_request_state_changed",
        {
            "assignment_id": latest.get("assignment_id"),
            "pressure_event_id": pressure_event_id,
            "from_state": current_state,
            "to_state": "picked_up",
            "actor": actor,
        },
    )
    return {
        "schema_version": 1,
        "status": "marked",
        "pressure_event_id": pressure_event_id,
        "assignment_id": latest.get("assignment_id"),
        "from_state": current_state,
        "to_state": "picked_up",
        "actor": actor,
        "governance_event_id": event.get("event_id"),
    }


def cancel_dispatch_request(
    tools_root: str | Path,
    *,
    pressure_event_id: str,
    reason: str,
) -> dict[str, Any]:
    if not reason or not reason.strip():
        raise ValueError("cancel_requires_reason")
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    matching = [r for r in rows if r.get("pressure_event_id") == pressure_event_id]
    if not matching:
        return {"schema_version": 1, "status": "not_found", "pressure_event_id": pressure_event_id}
    latest = matching[-1]
    states = _latest_request_states(root)
    current_state = states.get(pressure_event_id, latest.get("state", "pending"))
    if current_state == "cancelled":
        return {"schema_version": 1, "status": "already_cancelled", "pressure_event_id": pressure_event_id}
    if current_state == "completed":
        return {
            "schema_version": 1,
            "status": "rejected",
            "pressure_event_id": pressure_event_id,
            "reason": "already_completed",
        }
    event = append_tools_governance(
        root,
        "dispatch_request_state_changed",
        {
            "assignment_id": latest.get("assignment_id"),
            "pressure_event_id": pressure_event_id,
            "from_state": current_state,
            "to_state": "cancelled",
            "reason": reason,
        },
    )
    return {
        "schema_version": 1,
        "status": "cancelled",
        "pressure_event_id": pressure_event_id,
        "assignment_id": latest.get("assignment_id"),
        "from_state": current_state,
        "to_state": "cancelled",
        "reason": reason,
        "governance_event_id": event.get("event_id"),
    }


def auto_batch_dispatch(
    paths: WorkspacePaths,
    *,
    tools_root: str | Path | None = None,
    limit: int = DEFAULT_AUTO_BATCH_LIMIT,
    prepare_worktree: bool = False,
    acknowledge: bool = False,
) -> dict[str, Any]:
    root = ensure_tools_binding(tools_root, workspace_root=paths.repo_root)
    decisions = load_jsonl(root / "triage" / "decisions.jsonl")
    eligible_states = _latest_request_states(root)
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for row in reversed(decisions):
        if row.get("triage_tier") != "auto_fix_safe":
            continue
        pe = str(row.get("pressure_event_id") or "")
        if not pe or pe in seen:
            continue
        if eligible_states.get(pe) in {"pending", "prepared", "picked_up", "completed"}:
            continue
        seen.add(pe)
        candidates.append(row)
        if len(candidates) >= max(0, int(limit)):
            break
    results: list[dict[str, Any]] = []
    for decision in candidates:
        pe = str(decision.get("pressure_event_id") or "")
        try:
            result = create_dispatch_request(
                paths,
                pressure_event_id=pe,
                tools_root=root,
                target_agent=decision.get("target_agent"),
                prepare_worktree=prepare_worktree,
                acknowledge=acknowledge,
            )
        except (RuntimeError, ValueError) as exc:
            result = {"schema_version": 1, "status": "error", "pressure_event_id": pe, "error": str(exc)}
        results.append(result)
    return {
        "schema_version": 1,
        "dispatched_count": sum(1 for r in results if r.get("status") not in {"error", "not_created"}),
        "candidate_count": len(candidates),
        "results": results,
    }


def prune_worktrees(
    repo_root: str | Path,
    tools_root: str | Path,
    *,
    acknowledge: bool,
    ttl_days: int = DEFAULT_WORKTREE_TTL_DAYS,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not acknowledge:
        return {"schema_version": 1, "status": "skipped", "reason": "missing_acknowledge"}
    repo = Path(repo_root)
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    states = _latest_request_states(root)
    moment = now or datetime.now(timezone.utc)
    pruned: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in rows:
        pe = row.get("pressure_event_id")
        worktree_rel = row.get("worktree_path")
        assignment_id = row.get("assignment_id")
        if not pe or not worktree_rel or not assignment_id:
            continue
        current_state = states.get(pe, row.get("state", "pending"))
        if current_state not in {"completed", "cancelled", "expired"}:
            continue
        created = _parse_iso(row.get("created_at"))
        if created is None:
            skipped.append({"assignment_id": assignment_id, "reason": "invalid_created_at"})
            continue
        age_days = (moment - created).days
        if age_days < ttl_days:
            skipped.append({"assignment_id": assignment_id, "reason": "ttl_not_reached", "age_days": age_days})
            continue
        worktree_path = Path(worktree_rel)
        if not worktree_path.is_absolute():
            worktree_path = repo / worktree_rel
        if not worktree_path.exists():
            skipped.append({"assignment_id": assignment_id, "reason": "worktree_missing"})
            continue
        try:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )
        except OSError:
            pass
        if worktree_path.exists():
            shutil.rmtree(worktree_path, ignore_errors=True)
        event = append_tools_governance(
            root,
            "worktree_pruned",
            {
                "assignment_id": assignment_id,
                "pressure_event_id": pe,
                "worktree_path": worktree_rel,
                "state": current_state,
                "age_days": age_days,
            },
        )
        pruned.append({
            "assignment_id": assignment_id,
            "pressure_event_id": pe,
            "worktree_path": worktree_rel,
            "state": current_state,
            "age_days": age_days,
            "governance_event_id": event.get("event_id"),
        })
    return {
        "schema_version": 1,
        "status": "ok",
        "pruned_count": len(pruned),
        "skipped_count": len(skipped),
        "ttl_days": ttl_days,
        "pruned": pruned,
        "skipped": skipped,
    }


def _latest_request_states(root: Path) -> dict[str, str]:
    states: dict[str, str] = {}
    for row in load_jsonl(root / "dispatch" / "requests.jsonl"):
        pe = row.get("pressure_event_id")
        if pe:
            states[pe] = row.get("state", "pending")
    for row in load_jsonl(root / "governance.jsonl"):
        if row.get("kind") != "dispatch_request_state_changed":
            continue
        details = row.get("details") or {}
        pe = details.get("pressure_event_id")
        to_state = details.get("to_state")
        if pe and to_state:
            states[pe] = str(to_state)
    return states


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
