"""The kernel lane's PR surface, read from its one owner (ARIA-HIGH-530, INFRA-HIGH-215).

`aria-kernel` is a required context, so the workflow runs on every pull
request and reports on every one. Whether a PR runs the suite is decided by the
`changes` job from `.github/manifests/aria-kernel-surface.json`. That manifest
is the surface's only owner: the workflow reads it with jq, the pre-push
selector reads it, and tests that pin a path into the surface read it here. A list kept in aria-kernel.yml and a second,
different one in the selector let a PR that changed only inputs the suite reads
(.claude/agents, tools/aria-acceptance, .github/actions, package.json) pass the
required check without running it.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
KERNEL_SURFACE_MANIFEST = ".github/manifests/aria-kernel-surface.json"


def kernel_surface_entries(repo_root: Path = REPO_ROOT) -> list[dict[str, str]]:
    """The manifest's entries, each a git `:(glob)` pattern and the readers that need it."""
    manifest = json.loads((repo_root / KERNEL_SURFACE_MANIFEST).read_text(encoding="utf-8"))
    return list(manifest["surface"])


def kernel_lane_surface(repo_root: Path = REPO_ROOT) -> list[str]:
    """The globs a PR must touch for the kernel lane to run its jobs."""
    return [entry["glob"] for entry in kernel_surface_entries(repo_root)]
