"""ARIA-HIGH-217 — the pre-merge perimeter is evaluated on the PR it judges.

WHY this module exists
----------------------
The pre-merge perimeter binds the change to a workspace. The committed
snapshot must be built at the PR head (``merge_authority._capture_pre_merge_context``:
``base_commit_sha == head``), and the branch-tip lock
(``implementation_safety._check_branch_tip_lock_and_recheck``) requires HEAD
and ``refs/heads/<branch>`` at the PR head and ``refs/heads/<base>`` at the
implementation base. The merge lane (``aria-merge-runner.yml``) and the
claim lane check out ``main``, so every capture stopped at
``committed_snapshot_unavailable`` and every lock at
``native_branch_tip_changed``. The perimeter could never pass, and the
expert-review requests it gates were never made.

WHAT it does
------------
:func:`pr_head_workspace` yields a workspace in that shape for ONE PR:

* the given workspace itself, untouched, when it already stands there
  (HEAD and the PR branch at the head, the base branch at the
  implementation base);
* otherwise a throwaway worktree of it. The worktree shares the repository
  the tools root is bound to (same git common directory, same remote
  identity). It stands detached on the PR head, with the PR's local branch
  at the head (created when absent) and the base branch moved to the
  implementation base.

The implementation base is where the head forked from the live base
(``git merge-base``): the base the implementation ledger names while main
still contains it (ARIA-HIGH-221 — main moves ahead while the PR waits in
the merge queue). The PR head and the live base are fetched from ``origin``
when the checkout does not hold them (``refs/pull/<n>/head``,
``refs/heads/<base>``). Every ref it moves is put back afterwards: the
branch it created is deleted, the base branch is restored to the commit it
held, and the worktree is removed.

It never moves a branch it did not create. A PR branch the checkout already
holds at another commit stays where it is, and the branch-tip lock names
the divergence. It refuses by name rather than move the base branch under a
checkout that stands on it; the lanes detach their checkout from ``main``
first.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .git_containment import KERNEL_GIT_NO_HOOKS_ARGS
from .state_store import GIT_TIMEOUT_SECONDS
from .tool_registry import GovernanceError

_FULL_SHA = re.compile(r"^[0-9a-f]{40}$")


class MergeLaneWorkspaceRefusal(GovernanceError):
    """The PR-head workspace cannot be shaped; the message names why."""


def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *KERNEL_GIT_NO_HOOKS_ARGS, *args],
        cwd=root, capture_output=True, text=True, check=False, timeout=GIT_TIMEOUT_SECONDS,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise MergeLaneWorkspaceRefusal(
            f"merge_lane_workspace_git_failed:{args[0]}:{detail[-1] if detail else completed.returncode}"
        )
    return completed


def _commit_present(root: Path, sha: str) -> bool:
    return _git(root, "cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


def _ref_value(root: Path, ref: str) -> str | None:
    completed = _git(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value else None


def _checked_out_refs(root: Path) -> dict[str, str]:
    """``{refs/heads/x: worktree path}`` for every branch a worktree stands on."""
    listing = _git(root, "worktree", "list", "--porcelain").stdout
    checked_out: dict[str, str] = {}
    path = ""
    for line in listing.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line.startswith("branch "):
            checked_out[line[len("branch "):]] = path
    return checked_out


def _first(pr: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = pr.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def pr_workspace_identity(pr: dict[str, Any]) -> dict[str, Any]:
    """The live PR fields the workspace is shaped from, validated."""
    number = pr.get("number")
    identity: dict[str, Any] = {
        "number": number,
        "head_ref": _first(pr, "head_ref", "headRefName"),
        "head_sha": _first(pr, "head_sha", "headRefOid", "head"),
        "base_branch": _first(pr, "base_branch", "baseRefName", "base", "target_ref"),
        "live_base_sha": _first(pr, "base_sha", "baseRefOid"),
    }
    missing = [
        name for name, value in identity.items()
        if (name == "number" and (type(value) is not int or value <= 0)) or value == ""
    ]
    if missing:
        raise MergeLaneWorkspaceRefusal("merge_lane_workspace_pr_fields_required:" + ",".join(missing))
    for name in ("head_sha", "live_base_sha"):
        if _FULL_SHA.fullmatch(identity[name]) is None:
            raise MergeLaneWorkspaceRefusal(f"merge_lane_workspace_{name}_not_a_full_sha")
    return identity


@contextmanager
def pr_head_workspace(
    *,
    source_root: str | Path,
    pr: dict[str, Any],
    scratch_root: str | Path | None = None,
    remote: str = "origin",
) -> Iterator[Path]:
    """Yield a workspace on the PR head, the base branch at the implementation base."""
    source = Path(source_root).resolve()
    identity = pr_workspace_identity(pr)
    number = identity["number"]
    head_ref = identity["head_ref"]
    head_sha = identity["head_sha"]
    base_branch = identity["base_branch"]
    live_base_sha = identity["live_base_sha"]
    for ref_name in (head_ref, base_branch):
        if _git(source, "check-ref-format", "--branch", ref_name, check=False).returncode != 0:
            raise MergeLaneWorkspaceRefusal(f"merge_lane_workspace_branch_name_invalid:{ref_name}")
    if head_ref == base_branch:
        raise MergeLaneWorkspaceRefusal("merge_lane_workspace_head_is_the_base_branch")

    # The objects: the PR head and the live base, fetched only when the
    # checkout does not already hold them (content-addressed, so a present
    # object IS the live one). The PR head lands on a private ref that is
    # deleted again on the way out; the objects stay, as fetched objects do.
    fetched_ref = f"refs/aria/merge-lane/pr-{number}"
    fetched = False
    try:
        if not _commit_present(source, head_sha):
            fetched = True
            _git(source, "fetch", "--no-tags", remote, f"+refs/pull/{number}/head:{fetched_ref}")
        if not _commit_present(source, live_base_sha):
            _git(source, "fetch", "--no-tags", remote, f"+refs/heads/{base_branch}:refs/remotes/{remote}/{base_branch}")
        for label, sha in (("pr_head", head_sha), ("live_base", live_base_sha)):
            if not _commit_present(source, sha):
                raise MergeLaneWorkspaceRefusal(f"merge_lane_workspace_{label}_unavailable:{sha}")
        implementation_base = _git(source, "merge-base", live_base_sha, head_sha).stdout.strip()
        if _FULL_SHA.fullmatch(implementation_base) is None:
            raise MergeLaneWorkspaceRefusal("merge_lane_workspace_no_common_base")
        with _shaped(
            source=source, source_root=source_root, number=number, head_ref=head_ref,
            head_sha=head_sha, base_branch=base_branch, implementation_base=implementation_base,
            scratch_root=scratch_root,
        ) as workspace:
            yield workspace
    finally:
        if fetched:
            _git(source, "update-ref", "-d", fetched_ref, check=False)


@contextmanager
def _shaped(
    *,
    source: Path,
    source_root: str | Path,
    number: int,
    head_ref: str,
    head_sha: str,
    base_branch: str,
    implementation_base: str,
    scratch_root: str | Path | None,
) -> Iterator[Path]:
    """The workspace itself when already in shape, else a worktree put back after."""
    head_branch_ref = f"refs/heads/{head_ref}"
    base_branch_ref = f"refs/heads/{base_branch}"
    existing_head = _ref_value(source, head_branch_ref)
    previous_base = _ref_value(source, base_branch_ref)
    if (
        _ref_value(source, "HEAD") == head_sha
        and existing_head == head_sha
        and previous_base == implementation_base
    ):
        # Already the shape the perimeter reads: nothing to move.
        yield Path(source_root)
        return

    # The base branch is moved only when it must be, and never under a
    # checkout that stands on it.
    move_base = previous_base != implementation_base
    if move_base:
        checked_out = _checked_out_refs(source)
        if base_branch_ref in checked_out:
            raise MergeLaneWorkspaceRefusal(
                f"merge_lane_workspace_branch_checked_out:{base_branch_ref}:{checked_out[base_branch_ref]}"
            )

    scratch = Path(scratch_root or os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    holder = Path(tempfile.mkdtemp(prefix=f"aria-merge-lane-pr-{number}-", dir=scratch))
    worktree = holder / "workspace"
    created_branch = False
    moved_base = False
    added = False
    try:
        # The PR branch is created at the head when the checkout has none. A
        # branch the checkout already has is never moved: at another commit,
        # it stays there, and the branch-tip lock (which reads it) names the
        # divergence rather than this module hiding it.
        if existing_head is None:
            _git(source, "update-ref", head_branch_ref, head_sha, "")
            created_branch = True
        if move_base:
            _git(source, "update-ref", base_branch_ref, implementation_base)
            moved_base = True
        # Detached at the head: the lock reads HEAD and the shared branch
        # refs, and a detached worktree leaves every branch free to restore.
        _git(source, "worktree", "add", "--quiet", "--detach", str(worktree), head_sha)
        added = True
        yield worktree
    finally:
        if added:
            _git(source, "worktree", "remove", "--force", str(worktree), check=False)
        _git(source, "worktree", "prune", check=False)
        if created_branch:
            _git(source, "update-ref", "-d", head_branch_ref, head_sha, check=False)
        if moved_base:
            if previous_base is None:
                _git(source, "update-ref", "-d", base_branch_ref, check=False)
            else:
                _git(source, "update-ref", base_branch_ref, previous_base, check=False)
        shutil.rmtree(holder, ignore_errors=True)


__all__ = [
    "MergeLaneWorkspaceRefusal",
    "pr_head_workspace",
    "pr_workspace_identity",
]
