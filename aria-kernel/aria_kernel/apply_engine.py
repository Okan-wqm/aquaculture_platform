from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .proposal import get_proposal
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


APPROVED_STATUSES = ("approved_for_apply",)


def plan_apply_worktree(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    if proposal.get("status") not in APPROVED_STATUSES:
        raise GovernanceError("proposal must be approved_for_apply before worktree planning")
    root = Path(workspace_root).resolve()
    base_sha = _git(root, ["rev-parse", "HEAD"])
    worktree_path = root / "aria-worktrees" / f"A-{proposal_id}"
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "proposal_id": proposal_id,
        "workspace_root": root.as_posix(),
        "base_sha": base_sha,
        "worktree_path": worktree_path.as_posix(),
        "branch": f"aria/{_slug(str(proposal.get('title') or proposal_id))}-{proposal_id[-8:]}",
        "dry_run": dry_run,
        "status": "planned" if dry_run else "worktree_created",
        "validation_commands": proposal.get("validation_scope", {}).get("commands", []),
    }
    if not dry_run:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        _git(root, ["worktree", "add", "-b", row["branch"], worktree_path.as_posix(), base_sha])
    return append_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl", row)


def list_apply_actions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl")


def _git(cwd: Path, args: list[str]) -> str:
    completed = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "git command failed")
    return completed.stdout.strip()


def _slug(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:48] or "proposal"
