from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .apply_engine import list_apply_actions
from .auto_merge import record_pr_lifecycle
from .proposal import get_proposal
from .tool_registry import GovernanceError


REQUIRED_PR_SECTIONS = (
    "Problem",
    "Evidence",
    "Solution",
    "Validation",
    "Baseline Comparison",
    "Rollback",
    "Provenance",
)


def build_pr_body(*, proposal: dict[str, Any], action: dict[str, Any]) -> str:
    evidence = "\n".join(f"- `{item}`" for item in proposal.get("evidence", []))
    validation = "\n".join(f"- `{item}`" for item in action.get("validation_commands", []))
    return "\n".join(
        [
            "## Problem",
            str(proposal.get("problem", "")),
            "",
            "## Evidence",
            evidence or "- No evidence recorded",
            "",
            "## Solution",
            str(proposal.get("proposed_change", proposal.get("title", ""))),
            "",
            "## Validation",
            validation or "- No validation commands recorded",
            "",
            "## Baseline Comparison",
            f"- Base SHA: `{action.get('base_sha')}`",
            "- Result: pending CI / local validation",
            "",
            "## Rollback",
            "- Revert the ARIA branch commit or close this PR without merge.",
            "",
            "## Provenance",
            f"- Proposal: `{proposal.get('proposal_id')}`",
            f"- Worktree: `{action.get('worktree_path')}`",
            "",
        ],
    )


def open_pr_for_action(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if not action:
        raise GovernanceError("no apply action exists for proposal")
    body = build_pr_body(proposal=proposal, action=action)
    _validate_pr_body(body)
    payload = {
        "number": None,
        "base_branch": "snowball",
        "head_sha": action.get("base_sha"),
        "task_id": proposal.get("task_id"),
        "proposal_id": proposal_id,
        "changed_files": action.get("changed_files", []),
        "title": proposal.get("title"),
        "body": body,
        "dry_run": dry_run,
    }
    if dry_run:
        row = record_pr_lifecycle(payload, event="pr_dry_run", base_dir=base_dir)
        row["body"] = body
        return row
    completed = subprocess.run(
        ["gh", "pr", "create", "--base", "snowball", "--title", str(proposal.get("title")), "--body", body],
        cwd=Path(workspace_root).resolve(),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh pr create failed")
    payload["url"] = completed.stdout.strip()
    return record_pr_lifecycle(payload, event="opened", base_dir=base_dir)


def _latest_action_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for action in reversed(list_apply_actions(base_dir=base_dir)):
        if action.get("proposal_id") == proposal_id:
            return action
    return None


def _validate_pr_body(body: str) -> None:
    missing = [section for section in REQUIRED_PR_SECTIONS if f"## {section}" not in body]
    if missing:
        raise GovernanceError("PR body missing required sections: " + ", ".join(missing))
