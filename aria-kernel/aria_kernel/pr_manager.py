from __future__ import annotations

import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .apply_engine import list_apply_actions
from .auto_merge import record_pr_lifecycle
from .ledger import append_jsonl, load_jsonl
from .proposal import get_proposal
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import list_validation_plans


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
    validation_refs = "\n".join(f"- `{item}`" for item in action.get("validation_run_refs", []))
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
            "### Validation Evidence",
            validation_refs or "- No validation run refs recorded",
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
    if action.get("status") != "ready_for_pr":
        raise GovernanceError("apply action must pass validation gate before PR open")
    if not action.get("validation_gate_ref"):
        raise GovernanceError("PR open requires validation_gate_ref")
    action = dict(action)
    latest_validation = _latest_validation_plan_for_proposal(proposal_id, base_dir)
    if latest_validation:
        action["validation_plan_ref"] = latest_validation.get("ledger_hash")
        action["validation_plan_status"] = latest_validation.get("status")
        action["validation_run_refs"] = latest_validation.get("run_refs", [])
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


def plan_pr_lifecycle(
    *,
    open_prs: list[dict[str, Any]],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    stale_after_days: int = 7,
    close_after_days: int = 30,
) -> dict[str, Any]:
    if stale_after_days <= 0 or close_after_days <= stale_after_days:
        raise GovernanceError("PR lifecycle days must be positive and close_after_days must exceed stale_after_days")
    now = datetime.now(timezone.utc)
    actions = []
    for pr in open_prs:
        number = pr.get("number")
        if not isinstance(number, int):
            raise GovernanceError("open PR entries require numeric number")
        updated_at = _parse_time(str(pr.get("updated_at") or pr.get("updatedAt") or ""))
        if updated_at is None:
            raise GovernanceError("open PR entries require updated_at timestamp")
        age_days = (now - updated_at).days
        if age_days >= close_after_days:
            action = "recommend_close"
        elif age_days >= stale_after_days:
            action = "recommend_stale_comment"
        else:
            action = "observe"
        actions.append(
            {
                "pr_number": number,
                "age_days": age_days,
                "action": action,
                "title": pr.get("title"),
                "proposal_id": pr.get("proposal_id"),
            },
        )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "stale_after_days": stale_after_days,
        "close_after_days": close_after_days,
        "actions": actions,
        "status": "recommendation_only",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "pr-lifecycle-plans.jsonl", row)


def plan_pr_split(
    *,
    proposal_id: str,
    changed_files: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    max_files_per_pr: int = 12,
) -> dict[str, Any]:
    if max_files_per_pr <= 0:
        raise GovernanceError("max_files_per_pr must be positive")
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    files = [_normalize_path(path) for path in changed_files if isinstance(path, str) and path.strip()]
    if not files:
        raise GovernanceError("PR split planning requires changed_files")
    grouped: dict[str, list[str]] = {}
    for path in sorted(set(files)):
        grouped.setdefault(_split_group(path), []).append(path)
    prs = []
    index = 1
    for group, group_files in sorted(grouped.items()):
        for chunk in _chunks(group_files, max_files_per_pr):
            prs.append(
                {
                    "sequence": index,
                    "group": group,
                    "files": chunk,
                    "depends_on": [index - 1] if index > 1 and group == "migration" else [],
                },
            )
            index += 1
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "proposal_id": proposal_id,
        "proposal_title": proposal.get("title"),
        "split_required": len(prs) > 1,
        "prs": prs,
        "status": "planned",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "pr-split-plans.jsonl", row)


def list_pr_lifecycle_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "pr-lifecycle-plans.jsonl")


def list_pr_split_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "pr-split-plans.jsonl")


def _latest_action_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for action in reversed(list_apply_actions(base_dir=base_dir)):
        if action.get("proposal_id") == proposal_id:
            return action
    return None


def _latest_validation_plan_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for plan in reversed(list_validation_plans(base_dir=base_dir)):
        if plan.get("validation_plan_id") == proposal_id:
            return plan
    return None


def _validate_pr_body(body: str) -> None:
    missing = [section for section in REQUIRED_PR_SECTIONS if f"## {section}" not in body]
    if missing:
        raise GovernanceError("PR body missing required sections: " + ", ".join(missing))


def _parse_time(value: str) -> datetime | None:
    if not value:
        return None
    candidate = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _split_group(path: str) -> str:
    if "/migrations/" in path or path.endswith("Migration.ts"):
        return "migration"
    if path.startswith("apps/"):
        parts = path.split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else "apps"
    if path.startswith("web/"):
        parts = path.split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else "web"
    if path.startswith("libs/"):
        parts = path.split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else "libs"
    if path.startswith("platform/libs/"):
        parts = path.split("/")
        return "/".join(parts[:3]) if len(parts) >= 3 else "platform/libs"
    return path.split("/", 1)[0]


def _chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/").lstrip("./")
