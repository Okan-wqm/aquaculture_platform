"""ARIA-MEDIUM-432 — the workspace an adapter sees: what git tracks.

WHY: the adapter room (ARIA-CRITICAL-399) bound the whole workspace read-only
and hid a fixed list of ARIA's own directories behind empty mounts: the store,
the signing keys, the request worktrees, the tools root and RUNNER_TEMP.
Everything else in the checkout stayed readable by adapter code whose stdout
is published. On an operator checkout that includes the gitignored ``.env*``,
``*.pem``, ``*.key`` and ``deploy/**/secret.yaml``, which this repository's
``.gitignore`` exists to keep out of git (security review of the 2026-10-10
repair stack, live bwrap probe). A list of known secret places cannot name
the ones nobody listed.

WHAT: the room's workspace is assembled from git's own answer, taken right
before the spawn:

* an empty tmpfs stands at the workspace path;
* each top-level entry git tracks is bound read-only into it (a tracked
  symlink is recreated as the symlink it is);
* every path beneath those entries that git does not track, ignored or not,
  is covered: a directory by an empty tmpfs, a file by ``/dev/null``;
* ``.git`` is bound, so git still answers inside.

So whatever git does not track is not in the room, whether or not anyone
listed it. The sandbox adds the installed dependency trees and remounts the
root read-only (``implementation_safety._sandbox_argv(workspace_view=...)``).

Why this shape, rather than one bind per tracked file or a copy. Measured on
the repair host (bwrap 0.9.0):

* bwrap re-reads the mount table on every bind, so 1,598 per-file binds took
  6.7-7.3 s per start.
* This shape (87 top-level binds, 35 covers, 15 dependency trees) took
  138-140 ms, against 18-19 ms for the whole workspace.
* A copy of HEAD would be 137 MB per run, and it describes HEAD, not the
  working tree the run's snapshot hashed.

Untracked symlinks are left in place: inside the room a symlink resolves
against the room's own view, so it reaches nothing that a path could not.
A path created after the listing, inside a bound directory, is visible until
the room exits.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .git_object_id import ANY_OBJECT_FORMAT, is_object_id

# Git that sees the tree as it is: no GIT_DIR / GIT_WORK_TREE /
# GIT_INDEX_FILE from the caller's environment, no fsmonitor hook and no
# untracked cache from the repository's config deciding what git reports.
HERMETIC_GIT_CONFIG_ARGS: tuple[str, ...] = ("-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false")
_GIT_LISTING_TIMEOUT_SECONDS = 60
_HEAD_TIMEOUT_SECONDS = 30
# The refusal reason of a HEAD read git could not answer (``workspace_head_sha``).
WORKSPACE_HEAD_UNREADABLE = "workspace_head_unreadable"
# The mode git records a submodule (gitlink) with.
_GITLINK_MODE = "160000"
_GIT_DIRNAME = ".git"


class WorkspaceViewRefused(RuntimeError):
    """The view cannot be built, so no room is: ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def hermetic_git(
    workspace_root: str | os.PathLike[str], *args: str, timeout: int = 60, text: bool = True,
) -> subprocess.CompletedProcess:
    """git in ``workspace_root`` with no caller-controlled GIT_* environment and no fsmonitor."""
    hermetic = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.run(
        ["git", *HERMETIC_GIT_CONFIG_ARGS, "-C", str(workspace_root), *args],
        capture_output=True, text=text, timeout=timeout, check=False, env=hermetic,
    )


def _inside_checkout(workspace_root: str | os.PathLike[str]) -> bool:
    """True when ``workspace_root`` or a directory above it holds a ``.git`` entry."""
    start = Path(workspace_root).resolve()
    return any((directory / _GIT_DIRNAME).exists() for directory in (start, *start.parents))


def _head_git(workspace_root: str | os.PathLike[str], *args: str) -> subprocess.CompletedProcess:
    try:
        return hermetic_git(workspace_root, *args, timeout=_HEAD_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise WorkspaceViewRefused(f"{WORKSPACE_HEAD_UNREADABLE}:{type(exc).__name__}") from exc


def workspace_head_sha(workspace_root: str | os.PathLike[str]) -> str | None:
    """The checkout's HEAD commit; None when there is none; raise when git cannot say.

    None means one of two facts: ``workspace_root`` is not inside a git
    checkout (no ``.git`` entry on its path), or the checkout's HEAD names a
    branch with no commit yet (unborn). Any other answer is a git failure, not
    a fact about the tree: a checkout git refuses (dubious ownership, a broken
    ``gitdir``), a ref naming a missing object, a timeout, or no git at all.
    That raises :class:`WorkspaceViewRefused` (``workspace_head_unreadable:…``),
    because a caller that read it as "no commit" would bind a verdict, an
    evidence anchor or a suite to the empty tree while the checkout holds one
    (PV R4).
    """
    if not _inside_checkout(workspace_root):
        return None
    completed = _head_git(workspace_root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
    head = completed.stdout.strip()
    if completed.returncode == 0 and is_object_id(head, formats=ANY_OBJECT_FORMAT):
        return head
    if completed.returncode == 1:
        # `--quiet` exits 1 when git read the repository but HEAD names no
        # commit; it is unborn only when HEAD is a branch whose ref is absent.
        symbolic = _head_git(workspace_root, "symbolic-ref", "--quiet", "HEAD")
        branch = symbolic.stdout.strip()
        if symbolic.returncode == 0 and branch:
            ref = _head_git(workspace_root, "rev-parse", "--verify", "--quiet", "--end-of-options", branch)
            if ref.returncode == 1:
                return None
    raise WorkspaceViewRefused(f"{WORKSPACE_HEAD_UNREADABLE}:git_exit_{completed.returncode}")


def commit_names_blob(workspace_root: str | os.PathLike[str], commit: str | None, path: str) -> bool:
    """Whether ``path`` names a file (a blob) in ``commit`` of the checkout at ``workspace_root``.

    ``commit`` None is the empty tree, which names no file. ``<commit>:<path>``
    is git's literal tree lookup: no pathspec magic, no glob, so ``f.ts#L1``
    asks for a file of that exact name. Anything git cannot show as a blob
    (no such path, a directory, a commit the checkout does not hold) is False:
    the caller refuses what this cannot prove. A timeout or no git at all
    raises :class:`WorkspaceViewRefused` (``_head_git``).
    """
    if commit is None:
        return False
    completed = _head_git(workspace_root, "cat-file", "-t", f"{commit}:{path}")
    return completed.returncode == 0 and completed.stdout.strip() == "blob"


def index_flagged_paths(workspace_root: str | os.PathLike[str]) -> tuple[str, ...]:
    """Tracked paths whose index entry stops ``git status`` from comparing them with the disk.

    An entry flagged assume-unchanged (``git ls-files -v`` tags it in lower case) or
    skip-worktree (tag ``S``) is reported clean whatever its file holds, so a clean status
    proves nothing about it. A caller that vouches for the disk being HEAD refuses these.
    Raises :class:`WorkspaceViewRefused` when git cannot list the index.
    """
    try:
        completed = hermetic_git(
            workspace_root, "ls-files", "-v", "-z", timeout=_GIT_LISTING_TIMEOUT_SECONDS, text=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise WorkspaceViewRefused(f"workspace_view_git_unavailable:{type(exc).__name__}") from exc
    if completed.returncode != 0:
        raise WorkspaceViewRefused("workspace_view_not_a_checkout")
    flagged: list[str] = []
    for entry in completed.stdout.split(b"\0"):
        tag, path = entry[:1], entry[2:]
        if tag.islower() or tag == b"S":
            flagged.append(os.fsdecode(path))
    return tuple(flagged)


@dataclass(frozen=True)
class WorkspaceView:
    """The mounts that assemble the tracked view of ``root``.

    ``flags`` are bwrap flags, in mount order. ``bound_top_level`` names the
    top-level entries bound in, and ``covered`` the untracked paths beneath
    them that are hidden, so a caller can ask :meth:`hides` about a path.
    """

    root: Path
    flags: tuple[str, ...]
    bound_top_level: frozenset[str]
    covered: tuple[Path, ...]

    def hides(self, path: str | os.PathLike[str]) -> bool:
        """True when ``path``, inside the workspace, is not visible in the view."""
        candidate = Path(path).resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError(f"{candidate} is not inside the workspace {self.root}")
        if candidate == self.root:
            return False
        if candidate.relative_to(self.root).parts[0] not in self.bound_top_level:
            return True
        return any(candidate == cover or candidate.is_relative_to(cover) for cover in self.covered)


def _listing(workspace: Path, *args: str) -> list[str]:
    try:
        completed = hermetic_git(workspace, "ls-files", "-z", *args, timeout=_GIT_LISTING_TIMEOUT_SECONDS, text=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise WorkspaceViewRefused(f"workspace_view_git_unavailable:{type(exc).__name__}") from exc
    if completed.returncode != 0:
        raise WorkspaceViewRefused("workspace_view_not_a_checkout")
    return [os.fsdecode(entry) for entry in completed.stdout.split(b"\0") if entry]


def _is_inside(parent: Path, child: Path) -> bool:
    return child == parent or child.is_relative_to(parent)


def build_workspace_view(workspace_root: str | os.PathLike[str]) -> WorkspaceView:
    """The tracked view of ``workspace_root``, or :class:`WorkspaceViewRefused`.

    A workspace that is not a git checkout has no tracked set, so it has no
    view and no room. A submodule is refused as well: its own untracked files
    are another repository's answer, which this listing cannot give.
    """
    workspace = Path(workspace_root).resolve()
    tracked_top: set[str] = set()
    for row in _listing(workspace, "--stage"):
        meta, _, path = row.partition("\t")
        if meta.split(" ", 1)[0] == _GITLINK_MODE:
            raise WorkspaceViewRefused(f"workspace_view_submodule_unsupported:{path}")
        tracked_top.add(PurePosixPath(path).parts[0])
    flags: list[str] = ["--tmpfs", str(workspace)]
    bound: set[str] = set()
    for name in sorted(tracked_top):
        entry = workspace / name
        if entry.is_symlink():
            flags.extend(["--symlink", os.readlink(entry), str(entry)])
        elif entry.exists():
            flags.extend(["--ro-bind", str(entry), str(entry)])
            bound.add(name)
    covered: list[Path] = []
    for raw in _listing(workspace, "--others", "--directory"):
        relative = PurePosixPath(raw.rstrip("/"))
        if len(relative.parts) < 2 or relative.parts[0] not in bound:
            continue  # beneath nothing bound: never in the view
        path = workspace.joinpath(*relative.parts)
        # A cover over a path a symlink spells would land on the link's
        # target; an untracked symlink resolves inside the view anyway.
        if any((workspace.joinpath(*relative.parts[:depth])).is_symlink() for depth in range(1, len(relative.parts) + 1)):
            continue
        if any(_is_inside(cover, path) for cover in covered):
            continue
        if path.is_dir():
            flags.extend(["--tmpfs", str(path)])
        elif path.exists():
            flags.extend(["--ro-bind", os.devnull, str(path)])
        else:
            continue  # gone since the listing: nothing to hide
        covered.append(path)
    git_entry = workspace / _GIT_DIRNAME
    if git_entry.exists() and not git_entry.is_symlink():
        flags.extend(["--ro-bind", str(git_entry), str(git_entry)])
    return WorkspaceView(
        root=workspace, flags=tuple(flags), bound_top_level=frozenset(bound), covered=tuple(covered),
    )


__all__ = [
    "HERMETIC_GIT_CONFIG_ARGS",
    "WORKSPACE_HEAD_UNREADABLE",
    "WorkspaceView",
    "WorkspaceViewRefused",
    "build_workspace_view",
    "hermetic_git",
    "index_flagged_paths",
    "workspace_head_sha",
]
