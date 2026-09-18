"""Where a checkout begins — the one answer for every walker that asks.

WHY. Two kernel walkers looked for a checkout root by walking up the
filesystem, and each read ``.git`` its own way. ``fixture_runner``
accepted only a ``.git`` DIRECTORY (ORPHAN-HIGH-797 taught it to step past
a ``.git`` FILE, because the state store nested inside the checkout is a
linked worktree and its stub must not anchor the fixture path guard).
``agent_invocations`` resolved a ``.git`` FILE through its ``gitdir:``
pointer. Trial eleven (2026-09-12, ``cyc-20260912T221237Z-auto``) ran the
kernel in a workspace that is ITSELF a linked worktree — ``.git`` is a
file there too — so the fixture walker stepped past the checkout's own
marker, found nothing, fell back to ``tools_root.parent`` (the state
store), and judged every registry fixture path an escape:
``fixture_path_escape_outside_repo`` for nine of ten tools. The executor's
per-request worktrees (``aria-worktrees/``) have the same shape.

WHAT. A checkout root is the directory holding ``.git``, whether that is a
directory or a ``gitdir:`` pointer file — ``git worktree add`` writes the
file, and a linked worktree is as much a checkout as the main one. The
state store is the one linked worktree that is NOT a source checkout: it is
ARIA's memory, checked out from ``aria/state``, and the kernel itself marks
it with the ``GENESIS`` record at its root (``state_store``). That record —
not the shape of ``.git`` — is what discovery skips, so the walk lands on
the tree that owns ``tools/aria-adapters/fixtures`` in both layouts:

* ``<checkout>/.aria-state-store/tools`` → ``.aria-state-store`` holds a
  ``.git`` file AND ``GENESIS`` → skipped → ``<checkout>`` (dir or file);
* a lane worktree ``<main>/.worktrees/<lane>`` → its own ``.git`` file →
  that worktree, never the enclosing main checkout whose fixture corpus is
  a different tree.

The structural checks (``is_git_worktree_marker``) that the request-anchor
gate relies on live here too, so the ``gitdir:`` grammar is parsed in one
place; that gate keeps its stricter standard because it activates
destructive anchor expiry and a host-owned empty ``.git`` must not.
"""
from __future__ import annotations

from pathlib import Path

GITDIR_POINTER_PREFIX = "gitdir: "


def read_single_control_line(path: Path) -> str | None:
    """One non-empty line from a git control file; None for any other shape."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return None
    if len(lines) != 1:
        return None
    value = lines[0].strip()
    return value or None


def read_gitdir_pointer(marker: Path) -> Path | None:
    """The path a ``.git`` FILE points at, or None when it is not a pointer.

    Shape only: the pointed-at directory is not required to exist. A linked
    worktree whose common repository moved still marks its own root, and
    the path guard asks "where does this checkout begin", not "is git able
    to operate here".
    """
    try:
        if not marker.is_file():
            return None
    except OSError:
        return None
    pointer = read_single_control_line(marker)
    if pointer is None or not pointer.startswith(GITDIR_POINTER_PREFIX):
        return None
    raw = pointer.removeprefix(GITDIR_POINTER_PREFIX).strip()
    if not raw:
        return None
    target = Path(raw)
    return target if target.is_absolute() else marker.parent / target


def is_checkout_root(candidate: Path) -> bool:
    """Does ``candidate`` hold a ``.git`` directory or a ``gitdir:`` pointer file?"""
    marker = candidate / ".git"
    try:
        if marker.is_dir():
            return True
    except OSError:
        return False
    return read_gitdir_pointer(marker) is not None


def is_state_store_worktree(candidate: Path) -> bool:
    """Is this checkout ARIA's state store rather than a source tree?

    The kernel writes ``GENESIS`` into the store's root commit at bootstrap
    (``state_store._checkout_state_store_locked``) and reads the lineage
    branch back from it (``state_store.store_lineage_branch``), so the file
    is present in every checked-out store and in no source checkout.
    """
    from .state_store import GENESIS_FILENAME

    try:
        return (candidate / GENESIS_FILENAME).is_file()
    except OSError:
        return False


def discover_checkout_root(start: Path) -> Path | None:
    """The nearest source checkout root at or above ``start``.

    Walks upward through ``start`` and its parents; the first directory that
    is a checkout root (directory or pointer-file ``.git``) and is not a
    state-store worktree wins. None when no ancestor is a checkout — a bare
    temp tree, a genesis sandbox — and the caller keeps its own fallback.
    """
    current = start.resolve()
    for candidate in (current, *current.parents):
        if is_checkout_root(candidate) and not is_state_store_worktree(candidate):
            return candidate
    return None


def resolve_git_directory(marker: Path) -> Path | None:
    """Resolve a worktree marker to its per-worktree git directory, if it exists."""
    try:
        if marker.is_dir():
            return marker.resolve()
    except OSError:
        return None
    git_dir = read_gitdir_pointer(marker)
    if git_dir is None:
        return None
    try:
        resolved = git_dir.resolve()
        return resolved if resolved.is_dir() else None
    except (OSError, RuntimeError):
        return None


def resolve_git_common_directory(git_dir: Path) -> Path | None:
    """Resolve the object/ref store shared by a normal or linked worktree."""
    commondir_file = git_dir / "commondir"
    if not commondir_file.exists():
        return git_dir
    if not commondir_file.is_file():
        return None
    raw_common_dir = read_single_control_line(commondir_file)
    if raw_common_dir is None:
        return None
    common_dir = Path(raw_common_dir)
    if not common_dir.is_absolute():
        common_dir = git_dir / common_dir
    try:
        resolved = common_dir.resolve()
        return resolved if resolved.is_dir() else None
    except (OSError, RuntimeError):
        return None


def checkout_common_directory(root: Path) -> Path | None:
    """The object/ref store ``root`` shares with its sibling worktrees, or None.

    Two checkouts of ONE repository — the main checkout and any linked
    worktree of it — resolve to the same common directory (``git worktree
    add`` writes ``commondir`` into the per-worktree git directory); two
    checkouts of different repositories never do. Filesystem-only: the
    fixture path guard asks this on every fixture resolution, and a git
    subprocess per call is the cost the pure walk above exists to avoid.
    """
    git_dir = resolve_git_directory(root / ".git")
    if git_dir is None:
        return None
    return resolve_git_common_directory(git_dir)


def same_repository(left: Path, right: Path) -> bool:
    """Are ``left`` and ``right`` checkouts (worktrees) of one repository?

    False when either is not a checkout: a path that cannot name its
    repository cannot be shown to share one.
    """
    left_common = checkout_common_directory(left)
    if left_common is None:
        return False
    return left_common == checkout_common_directory(right)


def has_valid_git_head(git_dir: Path) -> bool:
    """Validate symbolic and detached HEAD forms used by Git worktrees."""
    head = read_single_control_line(git_dir / "HEAD")
    if head is None:
        return False
    if head.startswith("ref: "):
        return head.removeprefix("ref: ").startswith("refs/")
    return len(head) in {40, 64} and all(char in "0123456789abcdefABCDEF" for char in head)


def is_git_worktree_marker(marker: Path) -> bool:
    """Whether ``marker`` names a structurally complete Git worktree."""
    git_dir = resolve_git_directory(marker)
    if git_dir is None or not has_valid_git_head(git_dir):
        return False
    common_dir = resolve_git_common_directory(git_dir)
    if common_dir is None or not (common_dir / "objects").is_dir():
        return False
    return (
        (common_dir / "refs").is_dir()
        or (common_dir / "packed-refs").is_file()
        or (common_dir / "reftable").is_dir()
    )


__all__ = [
    "GITDIR_POINTER_PREFIX",
    "checkout_common_directory",
    "discover_checkout_root",
    "has_valid_git_head",
    "is_checkout_root",
    "is_git_worktree_marker",
    "is_state_store_worktree",
    "read_gitdir_pointer",
    "read_single_control_line",
    "resolve_git_common_directory",
    "resolve_git_directory",
    "same_repository",
]
