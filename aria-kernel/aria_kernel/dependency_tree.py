"""The installed dependency tree, as a nested worktree must see it.

A per-request worktree (``<checkout>/aria-worktrees/req-<id>``) carries no
``node_modules`` of its own. ARIA-HIGH-123 bound the checkout's tree
read-only at its own path, so node's upward walk from inside the worktree
found it. That answers a bare ``require`` from the worktree root and nothing
more, and the canonical suite needs more:

- **Workspace links resolve to the wrong tree.** The root tree links each
  npm workspace by a relative symlink (``@aquaculture/testing ->
  ../../libs/testing``, ``eslint-plugin-aquaculture -> ../tools/eslint-rules``).
  Bound at the checkout's path, they resolve into the CHECKOUT's ``libs/`` and
  ``tools/``. Those are hidden in the sandbox, and outside it they are another
  revision of the code under test.
- **Nested installs are missing.** npm installs a package that conflicts with
  the hoisted version into the workspace's own ``node_modules``
  (``web/modules/hr-module/node_modules/react-router-dom``). The worktree has
  none of them, so hr-module's vitest config cannot resolve its router.
- **Fixed binary paths fail.** ``tools/scripts/type-check-all.mjs`` runs
  ``<cwd>/node_modules/.bin/tsc``, which does not exist in a worktree.

Measured on the runner on 2026-10-06 (ARIA-HIGH-361). The first web plan,
F-015 in hr-module, would have failed its own validation at the apply gate.

The tree is therefore mounted INSIDE the worktree, at the same relative paths
the checkout has it at: the root tree at ``<worktree>/node_modules`` and each
workspace's nested tree at ``<worktree>/<package>/node_modules``. A bind mount
keeps the path it is mounted at, so the relative links resolve against the
worktree, which is the code under test. This module is the one place that
knows the layout. The sandbox (``implementation_safety._dependency_tree_binds``)
creates the empty mountpoints host-side, where the worktree is writable, and
binds what this module lists. Every spawn into a nested worktree therefore
gets the tree, whichever code made the worktree (request drain, planner
dispatch, apply_engine, worker dispatch). ``.gitignore`` already hides the
mountpoints from git.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEPENDENCY_TREE_DIRNAME = "node_modules"
_MANIFEST = "package.json"

# The directories tools write INTO a dependency tree while they run: Vite
# bundles its config into the nearest `node_modules/.vite-temp` (an
# uncaught EROFS otherwise, measured with hr-module's vitest), its optimizer
# and vitest's results go to `.vite`, and babel, eslint and others use
# `.cache`. The tree is shared by every request and stays read-only, so the
# sandbox gives each of these a private, empty tmpfs. A tool that writes
# anywhere else fails loudly with EROFS rather than leaking state into the
# next request.
TOOL_CACHE_DIRNAMES = (".vite-temp", ".vite", ".cache")


@dataclass(frozen=True)
class DependencyMount:
    """One installed tree and the path the workspace sees it at."""

    source: Path
    mountpoint: Path


def installed_checkout(workspace: Path) -> Path | None:
    """The nearest ancestor of ``workspace`` that carries an installed tree."""
    for ancestor in Path(workspace).resolve().parents:
        if (ancestor / DEPENDENCY_TREE_DIRNAME).is_dir():
            return ancestor
    return None


def _workspace_patterns(checkout: Path) -> list[str]:
    """The npm workspace globs the installed tree was built from."""
    try:
        manifest = json.loads((checkout / _MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    declared = manifest.get("workspaces") if isinstance(manifest, dict) else None
    if isinstance(declared, dict):
        declared = declared.get("packages")
    if not isinstance(declared, list):
        return []
    return [pattern for pattern in declared if isinstance(pattern, str) and pattern and not pattern.startswith("!")]


def dependency_mounts(workspace: Path) -> list[DependencyMount]:
    """Every installed tree a workspace nested in a checkout must see in place.

    The list is empty when the workspace is not nested in an installed
    checkout. A workspace package's nested tree is listed only when the
    workspace has that package: a package added or removed after the
    install has no counterpart to mount over.
    """
    workspace = Path(workspace).resolve()
    checkout = installed_checkout(workspace)
    if checkout is None:
        return []
    mounts = [DependencyMount(checkout / DEPENDENCY_TREE_DIRNAME, workspace / DEPENDENCY_TREE_DIRNAME)]
    seen: set[Path] = set()
    for pattern in _workspace_patterns(checkout):
        for package in sorted(checkout.glob(pattern)):
            nested = package / DEPENDENCY_TREE_DIRNAME
            relative = package.relative_to(checkout)
            if relative in seen or not nested.is_dir() or not (workspace / relative).is_dir():
                continue
            seen.add(relative)
            mounts.append(DependencyMount(nested, workspace / relative / DEPENDENCY_TREE_DIRNAME))
    return mounts


def prepare_dependency_mountpoints(workspace: Path) -> list[Path]:
    """Create the empty directories the sandbox mounts the trees over.

    bwrap cannot create a mountpoint under a read-only bind, and a
    write-scoped spawn binds the workspace read-only. The spawn creates
    them host-side first, where the worktree is writable. Returns the ones
    it made.
    """
    made: list[Path] = []
    for mount in dependency_mounts(workspace):
        if not mount.mountpoint.is_dir():
            mount.mountpoint.mkdir(parents=False, exist_ok=False)
            made.append(mount.mountpoint)
        # A tmpfs needs its mountpoint inside the read-only tree, so it is
        # made in the installed tree itself, which is writable host-side.
        for name in TOOL_CACHE_DIRNAMES:
            cache = mount.source / name
            if not cache.is_dir():
                cache.mkdir(exist_ok=True)
                made.append(cache)
    return made
