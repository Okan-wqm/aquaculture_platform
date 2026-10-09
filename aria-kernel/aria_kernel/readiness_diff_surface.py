"""The readiness claim's DLP ``diff`` surface, built from git.

WHY THIS EXISTS. ``produce_dlp_proof`` derives the files a PR head touched
from the workspace's own object store and refuses a diff surface that does
not name every one of them (ARIA-AUDIT-022: scope is proven, not promised).
The claim lane used to build that surface from the GitHub compare API's
``.files[].patch`` — hunk bodies with no ``diff --git a/<path> b/<path>``
headers, and no body at all for binary or oversized files — so a path
reached the scanned text only when the file's content happened to spell it.
Every claim the lane attempted failed ``dlp_diff_surface_incomplete``.

WHAT IT DOES. ``git diff <base>...<head>`` in the same workspace the scope
check reads: one object store answers both "what changed" and "what was
scanned", so they cannot disagree about file names, and every text change
of the PR is in the scanned bytes. Inputs are full object ids only — a ref
name moves under the claim, and an option-shaped value must never reach
git's argv. An unresolvable commit fails closed before anything is written:
a surface that was never built cannot be scanned vacuously.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError

_FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
_DIFF_HEADER = re.compile(r"^diff --git ", re.MULTILINE)
_GIT_TIMEOUT_SECONDS = 120


def _require_sha(value: object, *, name: str) -> str:
    if not isinstance(value, str) or not _FULL_SHA.fullmatch(value):
        raise GovernanceError(f"dlp_diff_surface_sha_invalid:{name}")
    return value


def _require_commit(workspace: Path, sha: str, *, name: str) -> None:
    probe = subprocess.run(
        ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
        cwd=workspace, capture_output=True, text=True, check=False,
        timeout=_GIT_TIMEOUT_SECONDS,
    )
    if probe.returncode != 0:
        raise GovernanceError(f"dlp_diff_surface_commit_unresolvable:{name}:{sha[:12]}")


def build_diff_surface(
    *,
    workspace_root: str | Path,
    base_sha: str,
    head_sha: str,
    output_path: str | Path,
) -> dict[str, Any]:
    """Write the PR's unified diff (merge-base of ``base_sha`` to ``head_sha``)
    to ``output_path`` and return what was written."""
    base = _require_sha(base_sha, name="base")
    head = _require_sha(head_sha, name="head")
    workspace = Path(workspace_root).resolve()
    _require_commit(workspace, base, name="base")
    _require_commit(workspace, head, name="head")
    diff = subprocess.run(
        [
            "git", "-c", "core.quotePath=true", "diff",
            "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames",
            f"{base}...{head}",
        ],
        cwd=workspace, capture_output=True, check=False,
        timeout=_GIT_TIMEOUT_SECONDS,
    )
    if diff.returncode != 0:
        detail = diff.stderr.decode("utf-8", errors="replace").strip().splitlines()
        raise GovernanceError(
            f"dlp_diff_surface_git_diff_failed:{detail[-1][:200] if detail else diff.returncode}"
        )
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(diff.stdout)
    return {
        "path": output.as_posix(),
        "base_sha": base,
        "head_sha": head,
        "file_count": len(_DIFF_HEADER.findall(diff.stdout.decode("utf-8", errors="replace"))),
        "size_bytes": len(diff.stdout),
        "sha256": "sha256:" + hashlib.sha256(diff.stdout).hexdigest(),
    }
