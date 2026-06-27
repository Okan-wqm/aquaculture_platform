from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .calibration import recommend_calibration
from .ci import list_ci_failures, produce_ci_review
from .cycle import run_cycle
from .feedback_store import generate_ai_consensus, generate_judgment_sample
from .judge_fanout import dispatch_judges_for_sample
from .fixture_runner import refresh_fixture_suite
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, utc_now


def heartbeat_tick(
    *,
    workspace_root: str | Path,
    cycle_id: str,
    base_dir: str | Path | None = None,
    run_cycle_step: bool = False,
    snapshot_mode: str = "committed",
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    with _heartbeat_lock(root):
        actions = []
        if run_cycle_step:
            actions.append({"action": "cycle", "result": run_cycle(workspace_root=workspace_root, cycle_id=cycle_id, base_dir=root, snapshot_mode=snapshot_mode)})
        actions.extend(_refresh_fixtures(workspace_root=workspace_root, cycle_id=cycle_id, base_dir=root))
        actions.extend(_produce_judgment_work(cycle_id=cycle_id, base_dir=root, workspace_root=workspace_root))
        actions.append({"action": "calibration", "result": recommend_calibration(cycle_id=cycle_id, base_dir=root)})
        actions.extend(_produce_ci_review_tasks(cycle_id=cycle_id, base_dir=root))
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "workspace_root": Path(workspace_root).resolve().as_posix(),
            "safe_actions": [item["action"] for item in actions],
            "action_count": len(actions),
            "actions": actions,
            "status": "completed",
        }
        return append_declared_jsonl(
            root / "heartbeat" / "ticks.jsonl",
            row,
            expected_surface="heartbeat_ticks",
        )


def heartbeat_status(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    rows = load_declared_jsonl(root / "heartbeat" / "ticks.jsonl", expected_surface="heartbeat_ticks")
    return {
        "schema_version": 1,
        "locked": (root / "heartbeat" / "heartbeat.lock").exists(),
        "tick_count": len(rows),
        "latest_tick": rows[-1] if rows else None,
    }


def cycle_run_batch(
    *,
    workspace_root: str | Path,
    count: int,
    cycle_prefix: str = "heartbeat",
    base_dir: str | Path | None = None,
    discovery_only: bool = False,
    snapshot_mode: str = "committed",
) -> dict[str, Any]:
    if count <= 0:
        raise GovernanceError("cycle run-batch count must be positive")
    root = ensure_tools_dir(base_dir)
    with _batch_lock(root):
        runs = []
        for index in range(count):
            cycle_id = f"{cycle_prefix}-{index + 1}"
            runs.append(
                run_cycle(
                    workspace_root=workspace_root,
                    cycle_id=cycle_id,
                    base_dir=root,
                    discovery_only=discovery_only,
                    shadow_only=False,
                    snapshot_mode=snapshot_mode,
                ),
            )
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_prefix": cycle_prefix,
            "requested_count": count,
            "completed_count": len(runs),
            "run_cycle_ids": [run.get("cycle_id") for run in runs],
            "status": "completed",
        }
        return append_declared_jsonl(
            root / "heartbeat" / "cycle-batches.jsonl",
            row,
            expected_surface="heartbeat_cycle_batches",
        )


def _refresh_fixtures(*, workspace_root: str | Path, cycle_id: str, base_dir: Path) -> list[dict[str, Any]]:
    actions = []
    for tool in list_tools(base_dir=base_dir):
        if not tool.get("fixture_set"):
            continue
        try:
            result = refresh_fixture_suite(
                str(tool.get("tool_id")),
                workspace_root=workspace_root,
                cycle_id=cycle_id,
                base_dir=base_dir,
            )
            actions.append({"action": "fixture_refresh", "tool_id": tool.get("tool_id"), "result": result})
        except GovernanceError as exc:
            actions.append({"action": "fixture_refresh", "tool_id": tool.get("tool_id"), "status": "blocked", "reason": str(exc)})
    return actions


def _produce_judgment_work(
    *, cycle_id: str, base_dir: Path, workspace_root: str | Path | None = None,
) -> list[dict[str, Any]]:
    actions = []
    for tool in list_tools(base_dir=base_dir):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id:
            continue
        try:
            sample = generate_judgment_sample(
                tool_id=tool_id,
                sample_size=5,
                strategy="stratified_by_uncertainty",
                cycle_id=cycle_id,
                base_dir=base_dir,
            )
            actions.append({"action": "ai_judge_sample", "tool_id": tool_id, "result": sample})
            # Plan 025 §A — turn the worklist into actual judge dispatch: two
            # distinct judges per sampled finding so consensus (>=2 unique
            # judges) can fire by construction once they respond.
            fanout = dispatch_judges_for_sample(sample=sample, base_dir=base_dir, target_sha=None)
            actions.append({"action": "ai_judge_fanout", "tool_id": tool_id, "result": fanout})
        except GovernanceError as exc:
            actions.append({"action": "ai_judge_sample", "tool_id": tool_id, "status": "blocked", "reason": str(exc)})
        try:
            consensus = generate_ai_consensus(tool_id=tool_id, cycle_id=cycle_id, base_dir=base_dir, workspace_root=workspace_root)
            actions.append({"action": "ai_consensus", "tool_id": tool_id, "result": consensus})
        except GovernanceError as exc:
            actions.append({"action": "ai_consensus", "tool_id": tool_id, "status": "blocked", "reason": str(exc)})
    return actions


def _produce_ci_review_tasks(*, cycle_id: str, base_dir: Path) -> list[dict[str, Any]]:
    existing = {
        row.get("ci_failure_id")
        for row in load_declared_jsonl(
            base_dir / "ci" / "agent-review-tasks.jsonl",
            expected_surface="ci_agent_review_tasks",
        )
    }
    actions = []
    for failure in list_ci_failures(base_dir=base_dir):
        failure_id = str(failure.get("ci_failure_id") or "")
        if not failure_id or failure_id in existing:
            continue
        actions.append({"action": "ci_failure_review_task", "result": produce_ci_review(ci_failure_id=failure_id, cycle_id=cycle_id, base_dir=base_dir)})
    return actions


class _lock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.fd: int | None = None

    def __enter__(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(self.fd, str(os.getpid()).encode("utf-8"))
        except FileExistsError as exc:
            raise GovernanceError(f"lock already held: {self.path.name}") from exc

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.fd is not None:
            os.close(self.fd)
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def _heartbeat_lock(root: Path) -> _lock:
    return _lock(root / "heartbeat" / "heartbeat.lock")


def _batch_lock(root: Path) -> _lock:
    return _lock(root / "heartbeat" / "cycle-batch.lock")
