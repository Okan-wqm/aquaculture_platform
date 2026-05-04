from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .proposal import get_proposal
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import evaluate_validation_gate, list_validation_gates


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
    if proposal.get("kind") == "self_change":
        raise GovernanceError("kernel self-change proposals require the dedicated kernel-change lane")
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
        "changed_files": proposal.get("evidence", []),
    }
    if not dry_run:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        _git(root, ["worktree", "add", "-b", row["branch"], worktree_path.as_posix(), base_sha])
    return append_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl", row)


def gate_apply_action(
    *,
    proposal_id: str,
    validation_comparison_ref: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if action is None:
        raise GovernanceError("no apply action exists for proposal")
    gate = evaluate_validation_gate(
        comparison_ref=validation_comparison_ref,
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    row = dict(action)
    row.update(
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "validation_comparison_ref": validation_comparison_ref,
            "validation_gate_ref": gate["ledger_hash"],
            "validation_gate_status": gate["status"],
            "validation_gate_blocked_by": gate["blocked_by"],
            "status": "ready_for_pr" if gate["status"] == "ready_for_pr" else "blocked",
            "blocked_by": gate["blocked_by"],
        },
    )
    return append_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl", row)


def list_apply_actions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl")


def latest_ready_apply_action(*, proposal_id: str, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if not action or action.get("status") != "ready_for_pr":
        return None
    gate_ref = action.get("validation_gate_ref")
    if not isinstance(gate_ref, str) or not gate_ref:
        return None
    for gate in reversed(list_validation_gates(base_dir=base_dir)):
        if gate.get("ledger_hash") == gate_ref and gate.get("status") == "ready_for_pr":
            return action
    return None


def _latest_action_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for action in reversed(list_apply_actions(base_dir=base_dir)):
        if action.get("proposal_id") == proposal_id:
            return action
    return None


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
