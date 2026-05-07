from __future__ import annotations

import errno
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .feedback import derive_pressure
from .ledger import verify_index_hashes, write_index
from .learning import run_learning_pass
from .workspace import WorkspacePaths, ensure_workspace, workspace_paths
from .discovery import run_discovery
from .cycle_diff import run_cycle_diff
from .memory import update_memory
from .observability import generate_observability_dashboard, record_cycle_metrics
from .pressure import run_pressure
from .reflection import run_reflection
from .tool_health import load_jsonl, runs_path
from .tool_registry import ensure_tools_binding, list_tools, utc_now
from .tool_runner import run_tool
from .ledger import append_jsonl


def run_cycle(paths: WorkspacePaths | None = None, **kwargs: Any) -> dict[str, object]:
    if paths is None:
        return run_enterprise_cycle(**kwargs)
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    emitted = derive_pressure(paths, index)
    write_index(paths.feedback_index, index, paths.ledgers)

    cycle_id = datetime.now(timezone.utc).strftime("cyc-%Y%m%dT%H%M%SZ")
    git_head_sha_at_cycle = _git_head_sha(paths.repo_root)
    learning = run_learning_pass(paths, cycle_id=cycle_id)
    state = {
        "cycle_id": cycle_id,
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "repo_root": str(paths.repo_root),
        "workspace_root": str(paths.workspace_root),
        "feedback_pressure_emitted": len(emitted),
        "learning": learning,
        "schema_version": 2,
    }
    _write_workspace_cycle_artifact(paths, state)
    return state


def run_enterprise_cycle(
    *,
    workspace_root: str | Path,
    cycle_id: str,
    workspace_base: str | Path | None = None,
    base_dir: str | Path | None = None,
    shadow_only: bool = False,
    discovery_only: bool = False,
    snapshot_mode: str = "committed",
) -> dict[str, Any]:
    started = time.monotonic()
    root = ensure_tools_binding(base_dir, workspace_root=workspace_root)
    if (root / "ARIA_STOP").exists():
        return {"schema_version": 2, "cycle_id": cycle_id, "event": "stopped", "status": "stopped"}
    workspace = _ensure_enterprise_workspace(workspace_root, workspace_base, root)
    git_head_sha_at_cycle = _git_head_sha(Path(workspace_root))
    append_jsonl(root / "cycles.jsonl", {"schema_version": 2, "at": utc_now(), "cycle_id": cycle_id, "event": "started"})
    learning = run_learning_pass(workspace, cycle_id=cycle_id, tools_root=root)
    discovery = run_discovery(workspace_root=workspace_root, cycle_id=cycle_id, base_dir=root, snapshot_mode=snapshot_mode)
    diff = run_cycle_diff(cycle_id=cycle_id, base_dir=root)
    if discovery_only:
        event = _complete_event(root, cycle_id, 0, git_head_sha_at_cycle=git_head_sha_at_cycle)
        state = {
            "schema_version": 2,
            "cycle_id": cycle_id,
            "git_head_sha_at_cycle": git_head_sha_at_cycle,
            "status": "completed",
            "event": event,
            "learning": learning,
            "discovery": discovery,
            "cycle_diff": diff,
        }
        _write_workspace_cycle_artifact(workspace, _workspace_cycle_state(workspace, state))
        return state

    decisions = []
    run_summary = []
    pressure_summary: dict[str, Any] = {}
    for tool in list_tools(base_dir=root):
        if shadow_only and tool.get("status") not in ("SHADOW", "ACTIVE", "CALIBRATE"):
            continue
        if not shadow_only and tool.get("status") not in ("ACTIVE", "SHADOW", "CALIBRATE"):
            continue
        payload = dict(tool.get("default_input") or {})
        payload.update({"cycle_id": cycle_id, "pressure_summary": pressure_summary})
        decision = run_tool(
            str(tool["tool_id"]),
            payload,
            cycle_id,
            workspace_root=workspace_root,
            base_dir=root,
        )
        decisions.append(decision)
    for run in load_jsonl(runs_path(root)):
        if run.get("cycle_id") != cycle_id:
            continue
        run_summary.append(
            {
                "tool_id": run.get("tool_id"),
                "status": run.get("status"),
                "raw_findings_count": int(run.get("runner", {}).get("raw_findings_count") or 0),
                "raw_observations_count": int(run.get("runner", {}).get("raw_observations_count") or 0),
                "emitted_findings_count": len(run.get("emitted_findings", [])) if isinstance(run.get("emitted_findings"), list) else 0,
                "emitted_observations_count": len(run.get("emitted_observations", [])) if isinstance(run.get("emitted_observations"), list) else 0,
            },
        )
    memory = update_memory(cycle_id=cycle_id, base_dir=root)
    pressure = run_pressure(cycle_id=cycle_id, base_dir=root)
    reflection = run_reflection(cycle_id=cycle_id, base_dir=root, repo_root=workspace_root)
    metrics = record_cycle_metrics(
        cycle_id=cycle_id,
        phase_durations_ms={"cycle": int((time.monotonic() - started) * 1000)},
        artifact_count=len(run_summary) + 4,
        status="ok",
        base_dir=root,
    )
    dashboard = generate_observability_dashboard(cycle_id=cycle_id, base_dir=root)
    event = _complete_event(root, cycle_id, len(decisions), git_head_sha_at_cycle=git_head_sha_at_cycle)
    state = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "status": "completed",
        "event": event,
        "learning": learning,
        "discovery": discovery,
        "cycle_diff": diff,
        "memory": memory,
        "pressure": pressure,
        "reflection": reflection,
        "cycle_metrics": metrics,
        "observability_dashboard": dashboard,
        "tool_decisions": decisions,
        "tool_governance_decisions": decisions,
        "tool_run_summary": run_summary,
    }
    _write_workspace_cycle_artifact(workspace, _workspace_cycle_state(workspace, state))
    return state


def _complete_event(root: Path, cycle_id: str, decision_count: int, *, git_head_sha_at_cycle: str | None = None) -> dict[str, Any]:
    event = {
        "schema_version": 2,
        "at": utc_now(),
        "cycle_id": cycle_id,
        "event": "completed",
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "tool_decision_count": decision_count,
        "tool_governance_decision_count": decision_count,
    }
    append_jsonl(root / "cycles.jsonl", event)
    return event


def _ensure_enterprise_workspace(workspace_root: str | Path, workspace_base: str | Path | None, tools_root: Path) -> WorkspacePaths:
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    try:
        ensure_workspace(paths)
        return paths
    except OSError as exc:
        if workspace_base is not None or exc.errno not in {errno.EROFS, errno.EACCES, errno.EPERM}:
            raise
    fallback = workspace_paths(Path(workspace_root), tools_root / "workspaces")
    ensure_workspace(fallback)
    return fallback


def _workspace_cycle_state(paths: WorkspacePaths, state: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "cycle_id": state.get("cycle_id"),
        "git_head_sha_at_cycle": state.get("git_head_sha_at_cycle"),
        "status": state.get("status"),
        "repo_root": str(paths.repo_root),
        "workspace_root": str(paths.workspace_root),
        "learning": state.get("learning"),
        "tools_event": state.get("event"),
    }


def _write_workspace_cycle_artifact(paths: WorkspacePaths, state: dict[str, Any]) -> None:
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    (paths.cycle_dir / f"{state['cycle_id']}.json").write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _git_head_sha(repo_root: Path) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root.resolve(),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None
