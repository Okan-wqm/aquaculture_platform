"""Lane-A validation command runner.

E21-a — this module no longer writes the ``validation_runs`` surface.

``_run_one`` used to append its own row shape to
``validation/validation-runs.jsonl``, in parallel with
``validation_runs_ledger.record_validation_run``. One declared surface,
two writers, two schemas: the merge gate read ``change_id`` (absent from
Lane-A rows) and the observability dashboard read ``status`` (absent from
Lane-B rows), so each reader was blind to half the surface. Lane A now
records THROUGH the ledger, which is the single writer, and this module
REFUSES the runs path outright so the second writer cannot come back.

That fold is why ``run_validation_commands`` demands ``change_id``,
``commit_sha`` and ``runner_identity``: a validation run that cannot say
which change and which commit it validated is not evidence, which is
exactly why the merge gate ignored Lane A's rows.
"""
from __future__ import annotations

import os
import secrets
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
from .validation_runs_ledger import (
    VALIDATION_RUNS_FILENAME,
    record_validation_run,
    validation_run_log_dir,
)


ALLOWED_COMMANDS = (
    ("npm", "run"),
    ("npx", "nx"),
    ("npx", "ts-node"),
    ("python3", "-m", "aria_kernel"),
    ("python3", "-m", "unittest"),
)


_VALIDATION_SURFACE_BY_FILENAME: dict[str, str] = {
    "validation-plans.jsonl": "validation_plans",
    "validation-comparisons.jsonl": "validation_comparisons",
    "validation-gates.jsonl": "validation_gates",
}

# E21-a — the surfaces this module must NOT touch, and the module that
# owns each. Kept as data rather than a comment so the refusal below and
# the invariant test read the same list.
_LEDGER_OWNED_SURFACE_FILENAMES: dict[str, str] = {
    VALIDATION_RUNS_FILENAME: "aria_kernel.validation_runs_ledger",
}


def _validation_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if concrete.parent.name != "validation":
        return None
    owner = _LEDGER_OWNED_SURFACE_FILENAMES.get(concrete.name)
    if owner is not None:
        raise GovernanceError(
            f"validation_surface_owned_elsewhere:{concrete.name}: this "
            f"surface has exactly one writer, {owner}; route the write "
            f"through record_validation_run() instead of re-opening a "
            f"second schema on it"
        )
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
    change_id: str,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    validation_plan_id: str | None = None,
    timeout_ms: int = 120_000,
    require_clean_worktree: bool = True,
) -> dict[str, Any]:
    """Execute allowlisted commands and record each through the ledger.

    ``change_id``, ``commit_sha`` and ``runner_identity`` are REQUIRED and
    resolved, not merely non-empty: the change must exist in the change
    ledger and the commit must exist in the workspace repository. A
    caller that cannot supply real provenance gets a named
    ``GovernanceError`` — never a placeholder row, because a placeholder
    row is evidence the merge gate would then honour.
    """
    if not commands or not all(isinstance(command, str) and command.strip() for command in commands):
        raise GovernanceError("validation commands must contain at least one non-empty command")
    if timeout_ms <= 0:
        raise GovernanceError("validation timeout_ms must be positive")
    root = Path(workspace_root).resolve()
    if not root.exists() or not root.is_dir():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    _assert_change_id_resolves(change_id, base_dir=base_dir)
    _assert_commit_sha_resolves(root, commit_sha)
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
                change_id=change_id,
                commit_sha=commit_sha,
                runner_identity=runner_identity,
                change_author_identity=change_author_identity,
                ordinal=index,
                timeout_ms=timeout_ms,
            ),
        )
    payload = {
        "schema_version": 2,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "validation_plan_id": validation_plan_id,
        "change_id": change_id,
        "commit_sha": commit_sha,
        "status": "ok" if all(run["status"] == "ok" for run in runs) else "failed",
        "command_count": len(runs),
        "run_refs": [run["ledger_hash"] for run in runs],
        "validation_run_ids": [run["validation_run_id"] for run in runs],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-plans.jsonl", payload)


def _assert_change_id_resolves(
    change_id: str, *, base_dir: str | Path | None,
) -> None:
    """Refuse to record evidence against a change that does not exist.

    The merge gate joins runs to changes on ``change_id``; a run whose
    change_id names nothing is a row that can never be read, and a row
    that can never be read is indistinguishable from a fabricated one.
    """
    if not isinstance(change_id, str) or not change_id.strip():
        raise GovernanceError("validation_change_id_required")
    from .change_ledger import get_change_chain

    chain = get_change_chain(change_id=change_id, base_dir=base_dir)
    if chain.get("planned") is None and chain.get("committed") is None:
        raise GovernanceError(
            f"validation_change_id_unknown: {change_id!r} has neither a "
            f"change_planned nor a change_committed row; emit the change "
            f"chain before recording validation evidence against it"
        )


def _assert_commit_sha_resolves(root: Path, commit_sha: str) -> None:
    """Refuse a commit_sha the workspace repository cannot resolve."""
    if not isinstance(commit_sha, str) or not commit_sha.strip():
        raise GovernanceError("validation_commit_sha_required")
    completed = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{commit_sha}^{{commit}}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError(
            f"validation_commit_sha_unresolvable: {commit_sha!r} does not "
            f"resolve to a commit in {root.as_posix()}; a validation run "
            f"must name the commit it actually ran against"
        )


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
    change_id: str,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None,
    ordinal: int,
    timeout_ms: int,
) -> dict[str, Any]:
    argv, env_updates = _parse_allowed_command(command)
    started_at = utc_now()
    started = time.monotonic()
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
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
    duration_ms = int(round((time.monotonic() - started) * 1000))
    log_path = _write_run_log(
        base_dir=base_dir,
        cycle_id=cycle_id,
        validation_plan_id=validation_plan_id,
        ordinal=ordinal,
        command=command,
        argv=argv,
        stdout=stdout,
        stderr=stderr,
    )
    # E21-a — ONE writer for the validation_runs surface. The argv that
    # actually executed lives in the hash-bound log rather than as a
    # second ledger column, so ``cmd`` and the executed vector cannot
    # drift apart without breaking log_hash verification.
    return record_validation_run(
        change_id=change_id,
        cmd=command,
        exit_code=exit_code,
        duration_ms=duration_ms,
        timed_out=timed_out,
        log_path=log_path,
        commit_sha=commit_sha,
        runner_identity=runner_identity,
        change_author_identity=change_author_identity,
        started_at=started_at,
        completed_at=utc_now(),
        base_dir=base_dir,
    )


def _write_run_log(
    *,
    base_dir: str | Path | None,
    cycle_id: str | None,
    validation_plan_id: str | None,
    ordinal: int,
    command: str,
    argv: list[str],
    stdout: str,
    stderr: str,
) -> Path:
    """Persist the run's output on the declared log artifact surface.

    ``verify_validation_run`` re-hashes this file at gate time, so the
    log is the content-addressed anchor of the run — not a convenience
    dump. The random suffix keeps two runs of the same command in the
    same plan from overwriting each other's evidence.
    """
    slug = _log_slug(validation_plan_id or cycle_id or "run")
    path = validation_run_log_dir(base_dir) / (
        f"{slug}-{ordinal:03d}-{secrets.token_hex(6)}.log"
    )
    path.write_text(
        "\n".join(
            [
                f"command: {command}",
                f"argv: {argv!r}",
                "--- stdout ---",
                stdout,
                "--- stderr ---",
                stderr,
                "",
            ],
        ),
        encoding="utf-8",
    )
    return path


def _log_slug(value: str) -> str:
    cleaned = "".join(
        char if char.isalnum() or char in "-_" else "-" for char in value
    ).strip("-")
    return cleaned[:48] or "run"


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
