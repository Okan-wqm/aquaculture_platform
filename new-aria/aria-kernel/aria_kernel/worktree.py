"""Worktree preflight gate (Plan 016 Faz 0, V-25).

Records a hash-chained `worktree_preflight` governance event capturing the
branch identity, source-dirty file count, and ahead/behind state versus
`origin/<expected_branch>`. The event is always recorded so the gate state is
auditable; callers (cycle, apply, pr-create) consult `gate_pass` before
proceeding.

Source-dirty vs runtime-dirty: the gate's purpose is to verify the SOURCE
tree is in a known state before implementation work starts. The kernel
itself appends to its runtime ledgers (`aria-tools/**`, `.aria-poc/**`,
`aria-findings/**`, `aria-debts/**`, `agent-workspace/**`) on every cycle —
those changes are not a sign of in-flight implementation work and must not
block the gate.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .tool_registry import append_tools_governance, ensure_tools_binding


# Runtime artifacts the kernel itself produces; not "source dirty" by design.
KERNEL_RUNTIME_PATH_PREFIXES: tuple[str, ...] = (
    "aria-tools/",
    ".aria-poc/",
    "aria-findings/",
    "aria-debts/",
    "agent-workspace/",
)


def is_runtime_path(porcelain_line: str) -> bool:
    """Detect if a `git status --porcelain` line refers to a kernel-runtime path.

    Porcelain v1 format: `XY <path>` (X=index status, Y=worktree status, two
    chars then space, then optionally a quoted path). Untracked is `?? <path>`.

    Public because more than one guard needs the same notion of "the kernel
    wrote this itself". ``burn_in`` previously carried no such notion at all
    and rejected any porcelain output, which made the observe burn-in
    unstartable the moment a runtime write became visible to git.
    """
    if len(porcelain_line) < 4:
        return False
    rest = porcelain_line[3:].strip()
    if rest.startswith('"') and rest.endswith('"'):
        rest = rest[1:-1]
    # Renames render as `R  <old> -> <new>`; the worktree-relevant path is the new one.
    if " -> " in rest:
        rest = rest.split(" -> ", 1)[1]
    return any(rest.startswith(prefix) for prefix in KERNEL_RUNTIME_PATH_PREFIXES)


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
    expected_branch: str = "main",
    skip_fetch: bool = False,
) -> dict[str, Any]:
    """Record a `worktree_preflight` governance event and return the gate result.

    Why: ARIA implementation work must run from a clean mainline worktree
    (Plan 016 V-25, Faz 0). Persisting the precondition to governance.jsonl
    makes the gate auditable and hash-chained — callers fail closed when
    `gate_pass` is False rather than relying on out-of-band convention.

    Returns: {"event": <persisted row>, "gate_pass": bool, "details": {...}}
    """
    root = Path(workspace_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=root)

    branch = _try_git(["rev-parse", "--abbrev-ref", "HEAD"], root) or "<unknown>"
    head_sha = _try_git(["rev-parse", "HEAD"], root) or "<unknown>"
    # Read porcelain via raw subprocess: _try_git's str.strip() removes the
    # leading space on the first line, breaking the fixed-width status decoder.
    porcelain_proc = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(root),
        capture_output=True,
        text=True,
        timeout=10,
    )
    porcelain = porcelain_proc.stdout if porcelain_proc.returncode == 0 else ""
    raw_dirty_lines = [line for line in porcelain.splitlines() if line.strip()]
    runtime_dirty_lines = [line for line in raw_dirty_lines if is_runtime_path(line)]
    source_dirty_lines = [line for line in raw_dirty_lines if not is_runtime_path(line)]
    # Source-dirty drives the gate; runtime-dirty is recorded for auditability only.
    dirty_lines = source_dirty_lines
    dirty_files_count = len(source_dirty_lines)

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
    if runtime_dirty_lines:
        # Auditability: record runtime-dirty paths so operators can see ARIA's
        # own write activity without conflating it with source-state.
        details["runtime_dirty_count"] = len(runtime_dirty_lines)
        details["runtime_dirty_sample"] = runtime_dirty_lines[:10]

    event = append_tools_governance(tools_root, "worktree_preflight", details)
    return {"event": event, "gate_pass": gate_pass, "details": details}
