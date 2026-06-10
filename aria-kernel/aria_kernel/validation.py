from __future__ import annotations

import hashlib
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

from .ledger import (
    append_declared_jsonl,
    load_declared_jsonl,
)
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


ALLOWED_COMMANDS = (
    ("npm", "run"),
    ("npx", "nx"),
    ("npx", "ts-node"),
    ("python3", "-m", "aria_kernel"),
    ("python3", "-m", "unittest"),
)


_VALIDATION_SURFACE_BY_FILENAME: dict[str, str] = {
    "validation-plans.jsonl": "validation_plans",
    "validation-runs.jsonl": "validation_runs",
    "validation-comparisons.jsonl": "validation_comparisons",
    "validation-gates.jsonl": "validation_gates",
}


def _validation_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if concrete.parent.name != "validation":
        return None
    return _VALIDATION_SURFACE_BY_FILENAME.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _validation_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    raise GovernanceError(f"validation_append_unknown_surface:{path.as_posix()}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _validation_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    raise GovernanceError(f"validation_load_unknown_surface:{path.as_posix()}")


def run_validation_commands(
    *,
    commands: list[str],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    validation_plan_id: str | None = None,
    timeout_ms: int = 120_000,
    require_clean_worktree: bool = True,
) -> dict[str, Any]:
    if not commands or not all(isinstance(command, str) and command.strip() for command in commands):
        raise GovernanceError("validation commands must contain at least one non-empty command")
    if timeout_ms <= 0:
        raise GovernanceError("validation timeout_ms must be positive")
    root = Path(workspace_root).resolve()
    if not root.exists() or not root.is_dir():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    if require_clean_worktree and _dirty_worktree(root):
        raise GovernanceError("validation requires a clean git worktree")

    runs = []
    for index, command in enumerate(commands):
        runs.append(
            _run_one(
                command=command,
                workspace_root=root,
                base_dir=base_dir,
                cycle_id=cycle_id,
                validation_plan_id=validation_plan_id,
                ordinal=index,
                timeout_ms=timeout_ms,
            ),
        )
    payload = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "validation_plan_id": validation_plan_id,
        "status": "ok" if all(run["status"] == "ok" for run in runs) else "failed",
        "command_count": len(runs),
        "run_refs": [run["ledger_hash"] for run in runs],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-plans.jsonl", payload)


def compare_validation_groups(
    *,
    baseline_ref: str,
    worktree_ref: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    if not baseline_ref.strip() or not worktree_ref.strip():
        raise GovernanceError("baseline_ref and worktree_ref are required")
    plans = list_validation_plans(base_dir=base_dir)
    baseline = _find_plan(plans, baseline_ref)
    worktree = _find_plan(plans, worktree_ref)
    if baseline is None:
        raise GovernanceError(f"baseline validation plan not found: {baseline_ref}")
    if worktree is None:
        raise GovernanceError(f"worktree validation plan not found: {worktree_ref}")
    regression_status = _regression_status(baseline, worktree)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "baseline_ref": baseline_ref,
        "worktree_ref": worktree_ref,
        "baseline_status": baseline.get("status"),
        "worktree_status": worktree.get("status"),
        "regression_status": regression_status,
        "blocked_by": [] if regression_status in ("no_regression", "improved") else ["validation_regression"],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-comparisons.jsonl", row)


def evaluate_validation_gate(
    *,
    comparison_ref: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    require_worktree_ok: bool = True,
) -> dict[str, Any]:
    if not comparison_ref.strip():
        raise GovernanceError("comparison_ref is required")
    comparison = _find_comparison(list_validation_comparisons(base_dir=base_dir), comparison_ref)
    if comparison is None:
        raise GovernanceError(f"validation comparison not found: {comparison_ref}")
    blockers: list[str] = []
    if comparison.get("regression_status") not in ("no_regression", "improved"):
        blockers.append("validation_regression")
    if require_worktree_ok and comparison.get("worktree_status") != "ok":
        blockers.append("candidate_validation_not_green")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "comparison_ref": comparison_ref,
        "baseline_ref": comparison.get("baseline_ref"),
        "worktree_ref": comparison.get("worktree_ref"),
        "baseline_status": comparison.get("baseline_status"),
        "worktree_status": comparison.get("worktree_status"),
        "regression_status": comparison.get("regression_status"),
        "status": "ready_for_pr" if not blockers else "blocked",
        "blocked_by": sorted(set(blockers)),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-gates.jsonl", row)


def list_validation_runs(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-runs.jsonl")


def list_validation_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-plans.jsonl")


def list_validation_comparisons(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-comparisons.jsonl")


def list_validation_gates(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-gates.jsonl")


def _find_plan(plans: list[dict[str, Any]], plan_ref: str) -> dict[str, Any] | None:
    for plan in reversed(plans):
        if plan.get("ledger_hash") == plan_ref or plan.get("validation_plan_id") == plan_ref:
            return plan
    return None


def _find_comparison(comparisons: list[dict[str, Any]], comparison_ref: str) -> dict[str, Any] | None:
    for comparison in reversed(comparisons):
        if comparison.get("ledger_hash") == comparison_ref:
            return comparison
    return None


def _regression_status(baseline: dict[str, Any], worktree: dict[str, Any]) -> str:
    if baseline.get("status") == "ok" and worktree.get("status") != "ok":
        return "regression"
    if baseline.get("status") != "ok" and worktree.get("status") == "ok":
        return "improved"
    if baseline.get("status") == worktree.get("status"):
        return "no_regression"
    return "changed"


def _run_one(
    *,
    command: str,
    workspace_root: Path,
    base_dir: str | Path | None,
    cycle_id: str | None,
    validation_plan_id: str | None,
    ordinal: int,
    timeout_ms: int,
) -> dict[str, Any]:
    argv, env_updates = _parse_allowed_command(command)
    started = time.monotonic()
    status = "ok"
    stdout = ""
    stderr = ""
    exit_code: int | None = None
    timed_out = False
    try:
        completed = subprocess.run(
            argv,
            cwd=workspace_root,
            env={**os.environ, **env_updates},
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
            check=False,
            shell=False,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        exit_code = completed.returncode
        if completed.returncode != 0:
            status = "failed"
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        status = "timeout"
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
    duration_ms = int(round((time.monotonic() - started) * 1000))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "validation_plan_id": validation_plan_id,
        "ordinal": ordinal,
        "command": command,
        "argv": argv,
        "status": status,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
        "stdout_hash": _sha256(stdout.encode("utf-8")),
        "stderr_hash": _sha256(stderr.encode("utf-8")),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-runs.jsonl", row)


def _parse_allowed_command(command: str) -> tuple[list[str], dict[str, str]]:
    if any(token in command for token in (";", "|", "&&", "||", ">", "<", "`", "$(")):
        raise GovernanceError("validation command contains unsupported shell syntax")
    try:
        parts = shlex.split(command)
    except ValueError as exc:
        raise GovernanceError(f"validation command cannot be parsed: {exc}") from exc
    if not parts:
        raise GovernanceError("validation command must not be empty")
    env_updates: dict[str, str] = {}
    while parts and "=" in parts[0] and not parts[0].startswith("-"):
        key, value = parts.pop(0).split("=", 1)
        if key != "PYTHONPATH":
            raise GovernanceError(f"validation command environment override is not allowed: {key}")
        env_updates[key] = value
    if not any(tuple(parts[: len(prefix)]) == prefix for prefix in ALLOWED_COMMANDS):
        raise GovernanceError("validation command is not in the approved allowlist")
    _validate_command_details(parts)
    return parts, env_updates


def _validate_command_details(parts: list[str]) -> None:
    if parts[:2] == ["npm", "run"]:
        if len(parts) < 3 or not _allowed_npm_script(parts[2]):
            raise GovernanceError("npm validation script is not approved")
    elif parts[:2] == ["npx", "nx"]:
        if len(parts) < 3 or parts[2] not in ("affected", "run-many"):
            raise GovernanceError("nx validation command must use affected or run-many")
        joined = " ".join(parts[3:])
        if not any(f"--target={target}" in joined or f"-t={target}" in joined for target in ("test", "lint", "build", "type-check")):
            raise GovernanceError("nx validation target is not approved")
    elif parts[:2] == ["npx", "ts-node"]:
        if not any(part.startswith("tools/aria-adapters/") and part.endswith((".test.ts", ".spec.ts")) for part in parts):
            raise GovernanceError("ts-node validation is limited to ARIA adapter tests")
    elif parts[:3] == ["python3", "-m", "aria_kernel"]:
        if parts[3:] != ["integrity", "verify"]:
            raise GovernanceError("aria_kernel validation command is limited to integrity verify")
    elif parts[:3] == ["python3", "-m", "unittest"]:
        return


def _allowed_npm_script(script: str) -> bool:
    allowed_exact = {
        "test",
        "test:all",
        "lint",
        "lint:all",
        "build",
        "build:all",
        "build:web",
        "type-check",
        "format:check",
    }
    return script in allowed_exact or script.startswith("gates:") or script.startswith("invariants:")


def _dirty_worktree(root: Path) -> bool:
    if not (root / ".git").exists():
        return False
    completed = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError("unable to inspect git worktree before validation")
    return bool(completed.stdout.strip())


def _decode_timeout_stream(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()
