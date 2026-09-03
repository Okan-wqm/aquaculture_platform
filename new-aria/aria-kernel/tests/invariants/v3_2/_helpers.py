"""Plan ARIA-V3.2 shared test helpers.

Hermetic fixtures consumed by the V3.2 invariant suite. Each helper
goes through the kernel's own writer surfaces (``append_jsonl``,
``append_tools_governance``, ``ensure_tools_dir``) so the ledger
integrity hash chain stays valid — hand-crafted JSON would silently
break the integrity-index group invariant.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def init_minimal_git_repo(workspace: Path, files: dict[str, str]) -> str:
    """Plan ARIA-V3.2 §3 — bootstrap a minimal git repo for hermetic
    discovery tests. Returns the resulting HEAD SHA.

    ``files`` maps path → content. The function git-init the workspace,
    writes the files, commits with a deterministic author, and returns
    the commit SHA.
    """
    workspace.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({
        "GIT_AUTHOR_NAME": "aria-v3_2-test",
        "GIT_AUTHOR_EMAIL": "aria-v3_2-test@example.com",
        "GIT_COMMITTER_NAME": "aria-v3_2-test",
        "GIT_COMMITTER_EMAIL": "aria-v3_2-test@example.com",
    })
    subprocess.run(
        ["git", "init", "-q", "-b", "main"],
        cwd=workspace, check=True, env=env,
    )
    for rel, content in files.items():
        target = workspace / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=workspace, check=True, env=env)
    subprocess.run(
        ["git", "commit", "-q", "-m", "v3_2 fixture baseline"],
        cwd=workspace, check=True, env=env,
    )
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=workspace, check=True, capture_output=True, text=True, env=env,
    ).stdout.strip()
    return sha


def seed_governance_jsonl(
    tools_root: Path,
    kinds_with_counts: dict[str, int],
    *,
    cycle_id: str = "cycle-fixture",
    ts_base: datetime | None = None,
    ts_step: timedelta | None = None,
) -> int:
    """Plan ARIA-V3.2 §2c — seed governance.jsonl via the kernel's
    own append helper (so the ledger hash chain is valid).

    Returns the total number of rows written.
    """
    from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(tools_root)
    total = 0
    for kind, count in kinds_with_counts.items():
        for n in range(count):
            append_tools_governance(
                root, kind,
                {"cycle_id": cycle_id, "seed_index": n},
            )
            total += 1
    return total


def read_governance_rows(tools_root: Path) -> list[dict[str, Any]]:
    """Plan ARIA-V3.2 §2c — read governance.jsonl rows back via
    strict_jsonl_reader for the invariant-test assertion paths.
    """
    from aria_kernel.strict_jsonl_reader import read_strict_jsonl

    path = Path(tools_root) / "governance.jsonl"
    if not path.exists():
        return []
    return list(
        read_strict_jsonl(
            path, on_corruption="tolerant",
            base_dir=Path(tools_root),
        )
    )


__all__ = [
    "init_minimal_git_repo",
    "read_governance_rows",
    "seed_governance_jsonl",
]
