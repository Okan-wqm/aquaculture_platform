"""Plan ARIA-V2 §3.6 — single source of truth for walk-time directory
exclusion.

Before this module existed, ``tools/aria-poc/poc.py`` and the ARIA
kernel maintained independent literal sets, which already drifted
(``.worktrees`` missing on the PoC side inflated MECHANICAL_DRIFTS
from ~10 to 126 once a sibling worktree existed). Centralising the
set is a Tier-1 architectural fix: the wrong behaviour is impossible
because both consumers reference the same frozenset object (locked
by invariant I-22 — ``poc.EXCLUDED_DIRS is discovery.EXCLUDED_DIRS``).

The runtime helper ``augmented_excluded_paths(repo_root)`` extends
the base set with the basenames of any git worktrees discovered via
``git worktree list``. Out-of-tree worktrees (e.g. ``/tmp/wt-foo``)
are still skipped because the basename participates in the
``dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]`` filter
applied during ``os.walk``.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

# Plan ARIA-V2 §3.6 — frozenset to enforce immutability across
# consumers; sets are interned at module-load time so ``poc.EXCLUDED_DIRS
# is discovery.EXCLUDED_DIRS`` is a Python ``is``-identity invariant
# (I-22).
BASE_EXCLUDED_DIRS: frozenset[str] = frozenset({
    # Repository plumbing — never legitimate ARIA scan targets.
    ".git",
    ".worktrees",  # Plan ARIA-V2 §3.6 + ARIA-V-003 — sibling worktree dir.
    # Build / dependency / cache artefacts.
    "agent-workspace",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nx",
    "target",
    "tmp",
    "out-tsc",
    ".aria-poc",
    ".aria-ci",
    ".turbo",
    ".cache",
})


def is_archived_migration_path(path: str | Path) -> bool:
    """True when ``path`` is a *superseded* (archived) database migration.

    WHY: services periodically re-baseline their schema — the old per-table
    migrations are moved under ``apps/<svc>/src/database/migrations/.archive/
    <timestamp>/`` and replaced by a consolidated active baseline. The archived
    files remain git-tracked (history is evidence) but they no longer describe
    the *current* schema.

    WHAT it guards: ARIA's mechanical drift detector compares a current TS
    entity's value-set against the SQL ``CREATE TYPE ... AS ENUM`` it can find.
    If an archived migration is in that corpus, the comparison runs against
    superseded schema and emits a *phantom* drift. Observed concretely: the
    ``goal`` enum's archived ``partially_completed`` value (dropped at the
    hr-service re-baseline, absent from the active ``hr.goals_status_enum``)
    was flagged as a TS-vs-SQL drift even though the TS entity matches the
    *active* baseline exactly. Excluding archived migrations from the drift
    corpus makes that whole false-positive class impossible (Tier-1).

    This is intentionally a file-level predicate, NOT a member of
    ``BASE_EXCLUDED_DIRS``: archived migrations must still be *walked* and
    *fated* by discovery (they are tracked repo content; skipping the walk
    would inflate the git↔filesystem reconciliation ``in_git_not_walked``
    count). Only the value-set drift corpus excludes them.
    """
    p = str(path).replace("\\", "/")
    return "/database/migrations/" in p and "/.archive/" in p


def augmented_excluded_paths(repo_root: Path | str) -> frozenset[str]:
    """Return ``BASE_EXCLUDED_DIRS`` augmented with git worktree basenames.

    Calls ``git worktree list --porcelain`` against ``repo_root`` and
    parses the canonical ``worktree <path>`` lines. Each worktree path's
    basename is unioned into the returned frozenset. When ``git`` is
    absent or the call fails, returns ``BASE_EXCLUDED_DIRS`` unchanged
    (degrade closed — no crash, but no extra exclusion either).

    The result is a *new* frozenset on each invocation; consumers that
    rely on ``is``-identity (I-22) MUST consume ``BASE_EXCLUDED_DIRS``
    directly. ``augmented_excluded_paths`` is for runtime walkers that
    can tolerate a fresh frozenset and want the latest worktree map.
    """
    extras: set[str] = set()
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        for line in result.stdout.splitlines():
            if line.startswith("worktree "):
                path_str = line.split(maxsplit=1)[1].strip()
                if path_str:
                    extras.add(Path(path_str).name)
    except (
        subprocess.CalledProcessError,
        FileNotFoundError,
        subprocess.TimeoutExpired,
        OSError,
    ):
        # ``git`` not available or worktree command failed — fall back
        # to base set unchanged. Walkers retain correctness for the
        # primary checkout; extra worktrees outside ``.worktrees/`` are
        # not protected but that is a degraded-mode acceptance, not a
        # bug class.
        pass
    return frozenset(BASE_EXCLUDED_DIRS | extras)


__all__ = [
    "BASE_EXCLUDED_DIRS",
    "augmented_excluded_paths",
    "is_archived_migration_path",
]
