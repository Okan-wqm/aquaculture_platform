"""ARIA-HIGH-374 — the merge lane reads GitHub's mergeability verdict before it tries.

WHY. ``main`` is strict: a PR whose branch lacks main's newest commits is
``mergeStateStatus: BEHIND`` and GitHub refuses its merge. The merge lane
never read that field, so an otherwise green L1 ARIA PR reached
``gh pr merge --match-head-commit``, was refused, and the lane wrote a
pre-merge incident row and a ``merge_failed`` incident on every hourly run
(``aria-merge-runner.yml``, cron ``47 * * * *``) without ever changing the
outcome.

WHAT. :func:`route_unmergeable_merge_state` runs in
``merge_authority.merge_pr_if_ready`` after the authority, human-merge and
freeze refusals and BEFORE the risk decision, the readiness proofs and the
incident pre-row:

* ``BEHIND`` — the lane asks for the update itself, through the ONE call
  the cycle uses (``pr_branch_update.request_branch_update``, idempotent per
  (pr, head, base) via ``already_requested``), and returns a named skip. The
  candidate already holds a readiness claim, which the readiness lane mints
  only on a green head, so the update never cancels a pending run. The
  update's record is what lets the merged-in head through every self-merge
  gate next time (``branch_update_lineage``).
* ``DIRTY`` / ``BLOCKED`` — a named skip and nothing written: a conflict or
  a protection rule is a person's (``human_merge_surface`` names it on the
  PR's one HUMAN_REQUIRED item), not an hourly incident.
* anything else, or a state the adapter cannot read — None: the existing
  gates decide exactly as before (an unread state loosens nothing).
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable

from .tool_registry import GovernanceError, utc_now

_FULL_SHA = re.compile(r"[0-9a-f]{40}")
SKIP_BEHIND = "skipped_branch_behind_base"
SKIP_STATES: dict[str, str] = {
    "DIRTY": "skipped_merge_state_dirty",
    "BLOCKED": "skipped_merge_state_blocked",
}


def route_unmergeable_merge_state(
    *,
    adapter: Any,
    pr_number: int,
    head_sha: str,
    base_dir: str | Path | None,
    workspace_root: str | Path | None,
    runner: Callable[..., Any] | None = None,
) -> dict[str, Any] | None:
    """A named skip (and, for ``BEHIND``, the update request) or None to proceed."""
    from .pr_branch_update import already_requested, request_branch_update

    read = getattr(adapter, "get_merge_state", None)
    if read is None:
        return None
    try:
        observed = read(pr_number)
    except GovernanceError:
        return None
    status = str((observed or {}).get("merge_state_status") or "").upper()
    decision: dict[str, Any] = {
        "schema_version": 1, "recorded_at": utc_now(), "pr_number": pr_number, "eligible": False,
        "stage": "merge_state", "head_sha": head_sha, "merge_state_status": status,
    }
    if status in SKIP_STATES:
        return {**decision, "decision": SKIP_STATES[status], "reasons": [f"merge_state:{status}"]}
    if status != "BEHIND":
        return None
    base_sha = str((observed or {}).get("base_sha") or "")
    if not _FULL_SHA.fullmatch(head_sha) or not _FULL_SHA.fullmatch(base_sha):
        update: dict[str, Any] = {"outcome": "head_or_base_unreadable"}
    elif already_requested(pr_number=pr_number, head_sha=head_sha, base_sha=base_sha, base_dir=base_dir):
        update = {"outcome": "already_requested_for_this_head_and_base"}
    else:
        update = request_branch_update(
            pr_number=pr_number, head_sha=head_sha, base_sha=base_sha, environment=dict(os.environ),
            workspace_root=workspace_root if workspace_root is not None else ".", base_dir=base_dir,
            runner=runner,
        )
    return {**decision, "decision": SKIP_BEHIND, "reasons": ["merge_state:BEHIND"], "branch_update": update}


__all__ = ["SKIP_BEHIND", "SKIP_STATES", "route_unmergeable_merge_state"]
