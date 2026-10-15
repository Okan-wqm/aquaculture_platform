from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import read_jsonl
from .workspace import WorkspacePaths, record_workspace_governance


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def record_workspace_governance_once(paths: WorkspacePaths, kind: str, details: dict[str, Any]) -> dict[str, Any]:
    for row in read_jsonl(paths.ledgers["governance"]):
        if row.get("kind") == kind and row.get("details") == details:
            return row
    return record_workspace_governance(paths, kind, details)


def git_head(repo_root: Path, *, timeout: int = 5) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root.resolve(),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None
