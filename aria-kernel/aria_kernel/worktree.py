"""Worktree preflight gate (Plan 016 Faz 0, V-25).

Records a hash-chained `worktree_preflight` governance event capturing the
branch identity, dirty-file count, and ahead/behind state versus
`origin/<expected_branch>`. The event is always recorded so the gate state is
auditable; callers (cycle, apply, pr-create) consult `gate_pass` before
proceeding.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .tool_registry import append_tools_governance, ensure_tools_binding


def _run_git(args: list[str], cwd: Path, *, timeout: int = 10) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _try_git(args: list[str], cwd: Path, *, timeout: int = 10) -> str | None:
    code, out, _ = _run_git(args, cwd, timeout=timeout)
    return out if code == 0 else None


def preflight(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    expected_branch: str = "snowball",
    skip_fetch: bool = False,
) -> dict[str, Any]:
    """Record a `worktree_preflight` governance event and return the gate result.

    Why: ARIA implementation work must run from a clean snowball worktree
    (Plan 016 V-25, Faz 0). Persisting the precondition to governance.jsonl
    makes the gate auditable and hash-chained — callers fail closed when
    `gate_pass` is False rather than relying on out-of-band convention.

    Returns: {"event": <persisted row>, "gate_pass": bool, "details": {...}}
    """
    root = Path(workspace_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=root)

    branch = _try_git(["rev-parse", "--abbrev-ref", "HEAD"], root) or "<unknown>"
    head_sha = _try_git(["rev-parse", "HEAD"], root) or "<unknown>"
    porcelain = _try_git(["status", "--porcelain"], root) or ""
    dirty_lines = [line for line in porcelain.splitlines() if line.strip()]
    dirty_files_count = len(dirty_lines)

    if not skip_fetch:
        # Best-effort upstream sync. Offline / auth failures must not crash preflight.
        _run_git(["fetch", "--quiet", "origin", expected_branch], root, timeout=15)
    counts = _try_git(
        ["rev-list", "--left-right", "--count", f"origin/{expected_branch}...HEAD"],
        root,
    )
    upstream_known = False
    commits_ahead: int | None = None
    commits_behind: int | None = None
    base_sha: str | None = None
    if counts is not None:
        try:
            behind_str, ahead_str = counts.split("\t")
            commits_behind = int(behind_str)
            commits_ahead = int(ahead_str)
            upstream_known = True
            base_sha = _try_git(["rev-parse", f"origin/{expected_branch}"], root)
        except ValueError:
            upstream_known = False

    branch_ok = branch == expected_branch
    clean = dirty_files_count == 0
    gate_pass = branch_ok and clean

    details: dict[str, Any] = {
        "expected_branch": expected_branch,
        "actual_branch": branch,
        "head_sha": head_sha,
        "dirty_files_count": dirty_files_count,
        "branch_ok": branch_ok,
        "clean": clean,
        "gate_pass": gate_pass,
        "upstream_known": upstream_known,
    }
    if upstream_known:
        details["commits_ahead"] = commits_ahead
        details["commits_behind"] = commits_behind
        if base_sha is not None:
            details["base_sha"] = base_sha
    if dirty_files_count > 0:
        # Bound the sample to keep governance rows compact.
        details["dirty_sample"] = dirty_lines[:20]

    event = append_tools_governance(tools_root, "worktree_preflight", details)
    return {"event": event, "gate_pass": gate_pass, "details": details}
