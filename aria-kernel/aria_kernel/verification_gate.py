from __future__ import annotations

import subprocess
import shlex
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import append_tools_governance, ensure_tools_dir, update_tools_index


MAX_DIFF_BYTES = 1024 * 1024
ALLOWED_PREFIXES = (
    "npx nx test ",
    "npx nx lint ",
    "npx nx build ",
    "npm run type-check",
    "python -m pytest ",
    "python -m unittest ",
)


def submit_worker_result(
    *,
    from_worktree: str | Path,
    assignment_id: str | None = None,
    validation_commands: list[str] | None = None,
    tools_root: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(tools_root)
    worktree = Path(from_worktree).resolve()
    request = _request_for(root, assignment_id=assignment_id, worktree=worktree)
    if request is None:
        return _reject(root, "unknown_assignment", assignment_id=assignment_id, worktree=worktree)
    expected = Path(str(request["worktree_path"])).resolve()
    if worktree != expected:
        return _reject(root, "worktree_path_mismatch", assignment_id=str(request["assignment_id"]), worktree=worktree)
    if not worktree.exists():
        return _reject(root, "worktree_unreachable", assignment_id=str(request["assignment_id"]), worktree=worktree)
    commands = validation_commands or list(request.get("required_tests") or [])
    unsafe = [command for command in commands if not _allowed_command(command)]
    if unsafe:
        return _reject(root, "unsafe_validation_command", assignment_id=str(request["assignment_id"]), worktree=worktree, details={"commands": unsafe})
    required = set(str(command) for command in request.get("required_tests") or [])
    if any(command not in required for command in commands):
        return _reject(root, "validation_command_not_required", assignment_id=str(request["assignment_id"]), worktree=worktree, details={"required_tests": sorted(required), "commands": commands})
    base_sha = str(request["base_sha"])
    head_sha = _git(worktree, "rev-parse", "HEAD")
    diff = _git(worktree, "diff", f"{base_sha}...{head_sha}")
    too_large = len(diff.encode("utf-8")) > MAX_DIFF_BYTES
    row = {
        "$schema": "aria/worker-result/v1",
        "schema_version": 1,
        "assignment_id": request["assignment_id"],
        "pressure_event_id": request["pressure_event_id"],
        "target_agent": request["target_agent"],
        "worktree_path": str(expected),
        "base_sha": base_sha,
        "head_sha": head_sha,
        "validation_commands": commands,
        "unified_diff": "" if too_large else diff,
        "diff_truncated": too_large,
        "state": "accepted",
    }
    stored = append_jsonl(root / "dispatch" / "worker-results.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "worker_result_accepted", {"assignment_id": request["assignment_id"], "target_agent": request["target_agent"], "diff_truncated": too_large})
    return stored


def verify_worker_result(
    *,
    assignment_id: str,
    tools_root: str | Path | None = None,
    auto_merge_eligible: bool = False,
) -> dict[str, Any]:
    root = ensure_tools_dir(tools_root)
    request = _request_for(root, assignment_id=assignment_id)
    result = _latest_result(root, assignment_id)
    if request is None or result is None:
        return _verification(root, assignment_id, "failed", ["missing_dispatch_or_result"], auto_merge_eligible=False)
    worktree = Path(str(request["worktree_path"])).resolve()
    if not worktree.exists():
        return _verification(root, assignment_id, "failed", ["worktree_unreachable"], auto_merge_eligible=False)
    trailer = str(request.get("expected_trailer") or "")
    log = _git(worktree, "log", "--format=%B", f"{request['base_sha']}..HEAD")
    if trailer and trailer not in log:
        return _verification(root, assignment_id, "failed", ["trailer_mismatch"], auto_merge_eligible=False)
    failures: list[str] = []
    for command in result.get("validation_commands") or []:
        if not _allowed_command(str(command)):
            failures.append("unsafe_validation_command")
            continue
        completed = subprocess.run(shlex.split(str(command)), cwd=worktree, text=True, capture_output=True, check=False, timeout=120)
        if completed.returncode != 0:
            failures.append(f"validation_failed:{command}")
    status = "passed" if not failures else "failed"
    merge_evaluated = bool(auto_merge_eligible and status == "passed" and request.get("triage_tier") == "auto_fix_safe")
    return _verification(root, assignment_id, status, failures, auto_merge_eligible=auto_merge_eligible, auto_merge_evaluated=merge_evaluated)


def _verification(root: Path, assignment_id: str, status: str, failures: list[str], *, auto_merge_eligible: bool, auto_merge_evaluated: bool = False) -> dict[str, Any]:
    request = _request_for(root, assignment_id=assignment_id) or {}
    row = {
        "$schema": "aria/verification-result/v1",
        "schema_version": 1,
        "assignment_id": assignment_id,
        "pressure_event_id": request.get("pressure_event_id"),
        "target_agent": request.get("target_agent"),
        "status": status,
        "failures": failures,
        "auto_merge_eligible_flag": auto_merge_eligible,
        "auto_merge_evaluated": auto_merge_evaluated,
    }
    stored = append_jsonl(root / "dispatch" / "verification-results.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "verification_gate_passed" if status == "passed" else "verification_gate_failed", {"assignment_id": assignment_id, "result": status, "failures": failures})
    return stored


def _reject(root: Path, reason: str, *, assignment_id: str | None, worktree: Path, details: dict[str, Any] | None = None) -> dict[str, Any]:
    row = {
        "$schema": "aria/worker-result/v1",
        "schema_version": 1,
        "assignment_id": assignment_id,
        "worktree_path": worktree.as_posix(),
        "state": "rejected",
        "reason": reason,
        "details": details or {},
    }
    stored = append_jsonl(root / "dispatch" / "worker-results.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "worker_result_rejected", {"assignment_id": assignment_id, "reason": reason})
    return stored


def _request_for(root: Path, *, assignment_id: str | None = None, worktree: Path | None = None) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(root / "dispatch" / "requests.jsonl")):
        if assignment_id and row.get("assignment_id") == assignment_id:
            return row
        if worktree is not None and Path(str(row.get("worktree_path") or "")).resolve() == worktree:
            return row
    return None


def _latest_result(root: Path, assignment_id: str) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(root / "dispatch" / "worker-results.jsonl")):
        if row.get("assignment_id") == assignment_id and row.get("state") == "accepted":
            return row
    return None


def _allowed_command(command: str) -> bool:
    return command == "npm run type-check" or any(command.startswith(prefix) for prefix in ALLOWED_PREFIXES if prefix != "npm run type-check")


def _git(worktree: Path, *args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=worktree, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()
