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
    diff_text: str | None = None,
) -> dict[str, Any]:
    """Promote an apply action to `ready_for_pr` after validation gate passes.

    Plan 017 Phase 3 adds the optional `diff_text` kwarg. When provided,
    the apply gate runs the suppression scanner over the unified diff and
    rejects the action when any banned suppression pattern (test skip,
    CI masking, TS escape, runtime swallow, ARIA suppression honor)
    appears in changed lines. Backward compatible: `diff_text=None`
    preserves the original validation-gate-only behavior.
    """
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if action is None:
        raise GovernanceError("no apply action exists for proposal")
    gate = evaluate_validation_gate(
        comparison_ref=validation_comparison_ref,
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    # Plan 022 §H-1 — suppression scan fail-closed when diff_text=None.
    # Pre-fix: caller could omit diff_text and the suppression scan
    # silently skipped entirely. Post-fix: try to fetch diff via
    # `git diff base_sha..branch` from the action; if unavailable
    # (no branch/base in action, or git command fails), raise so the
    # gate cannot pass without diff coverage.
    if diff_text is None:
        diff_text = _read_diff_from_action(action)
        if diff_text is None:
            raise GovernanceError(
                "suppression_scan_requires_diff_content: gate_apply_action "
                "diff_text=None and the action does not carry branch+base_sha "
                "to recover diff via git. Suppression scanner cannot run on "
                "an empty diff; pass diff_text explicitly or ensure the "
                "action has branch + base_sha set."
            )
    suppression_matches: list[dict[str, Any]] = []
    from .suppression_scanner import scan_unified_diff_text

    for match in scan_unified_diff_text(diff_text):
        suppression_matches.append(
            {
                "category": match.category,
                "detector": match.detector,
                "file": match.file,
                "line": match.line,
                "text": match.text,
            }
        )
    blocked_by = list(gate["blocked_by"] or [])
    if suppression_matches:
        blocked_by.append("suppression_pattern")
    final_status = (
        "ready_for_pr"
        if gate["status"] == "ready_for_pr" and not suppression_matches
        else "blocked"
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
            "suppression_matches": suppression_matches,
            "status": final_status,
            "blocked_by": blocked_by,
        },
    )
    return append_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl", row)


def _read_diff_from_action(action: dict[str, Any]) -> str | None:
    """Plan 023 v3 §P-1 — worktree-aware 3-diff union.

    Pre-Plan-023 the diff fetcher ran a single `git diff base..branch`
    in the workspace_root cwd. Two layered bugs:
      1. Branch-only diff missed worktree drift — a caller could write
         a banned-phrase patch into the working tree (staged or
         unstaged) and pass through gate_apply_action because the
         committed branch diff didn't reflect it.
      2. cwd = workspace_root, not the action's worktree_path. Plan
         016's plan_apply_worktree creates a separate worktree at
         action.worktree_path; the branch only resolves there.

    Plan 023 v3 fix:
      * Three diffs run and unioned:
          git diff base_sha..branch     (committed branch history)
          git diff branch..HEAD         (worktree drift vs. the branch)
          git diff --staged             (staged uncommitted)
        The union is concatenated as bytes-equivalent text so the
        suppression scanner downstream sees every line that could
        appear in the actual change.
      * cwd = action.worktree_path or workspace_root (worktree-aware).
      * Fail-closed dirty-worktree gate: if the worktree has dirty
        paths AND action.allow_dirty_worktree is not True, raise
        GovernanceError. Operators who want to scan the dirty content
        opt in explicitly; the default refuses to scan a tree whose
        commit graph and working state disagree.

    Returns the unioned diff string or None when prerequisites
    (workspace_root + branch + base_sha) are missing or every git
    invocation fails.
    """
    workspace_root = action.get("workspace_root")
    branch = action.get("branch")
    base_sha = action.get("base_sha")
    if not (workspace_root and branch and base_sha):
        return None
    # Plan 023 v3 §P-1 — worktree-aware cwd. action.worktree_path is
    # populated by plan_apply_worktree when the worktree was created;
    # fall back to workspace_root for legacy actions.
    cwd_path = Path(action.get("worktree_path") or workspace_root).resolve()

    # Plan 023 v3 §P-1 — fail-closed dirty-worktree gate.
    if not action.get("allow_dirty_worktree"):
        try:
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=cwd_path, capture_output=True, text=True, check=False,
            )
        except (FileNotFoundError, OSError):
            status = None
        if status is not None and status.returncode == 0 and status.stdout.strip():
            raise GovernanceError(
                "apply_engine_worktree_dirty_without_explicit_allow: "
                f"worktree at {cwd_path} has uncommitted changes; pass "
                "action.allow_dirty_worktree=True to scan dirty content "
                "or commit / stash before invoking gate_apply_action"
            )

    diff_pieces: list[str] = []
    # Plan 023 v3 §P-1 — three sources unioned:
    #   git diff base..branch  : committed branch history.
    #   git diff --staged      : staged uncommitted in the worktree.
    #   git diff               : unstaged uncommitted (working tree vs index).
    # The union covers every line that could appear in the actual
    # change-set being applied, regardless of whether it sits in a
    # commit, the staging area, or the working tree.
    diff_invocations = (
        ["git", "diff", f"{base_sha}..{branch}"],   # committed branch history
        ["git", "diff", "--staged"],                # staged uncommitted
        ["git", "diff"],                            # unstaged worktree
    )
    any_succeeded = False
    for argv in diff_invocations:
        try:
            completed = subprocess.run(
                argv, cwd=cwd_path, capture_output=True, text=True, check=False,
            )
        except (FileNotFoundError, OSError):
            continue
        if completed.returncode != 0:
            continue
        any_succeeded = True
        if completed.stdout:
            diff_pieces.append(completed.stdout)
    if not any_succeeded:
        return None
    return "\n".join(diff_pieces) if diff_pieces else ""


def list_apply_actions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "apply" / "actions.jsonl")


def latest_ready_apply_action(*, proposal_id: str, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if not action or action.get("status") != "ready_for_pr":
        return None
    gate_ref = action.get("validation_gate_ref")
    if not isinstance(gate_ref, str) or not gate_ref:
        return None
    gates = list_validation_gates(base_dir=base_dir)
    for gate in reversed(gates):
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
