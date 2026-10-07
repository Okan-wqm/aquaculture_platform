"""ARIA-HIGH-374 — when may a PR head that is not the delivered commit still be ARIA's?

WHY. ``main`` is strict (up-to-date branches required, no merge queue), so an
ARIA PR is mergeable only after ``main`` has been merged into it
(ARIA-HIGH-372: ``pr_branch_update``). Every self-merge gate bound the PR head
to the commit the delivery verified, signed, gated and recorded
(``change_committed.commit_sha``): the triple gate
(``auto_merge._evaluate_triple_gate``), the native merge context
(``merge_authority._capture_pre_merge_context``) and the implementation join
(``merge_authority._join_pre_merge_implementation``). An updated PR was
therefore refused by all three, and an L1 ARIA PR self-merged only if ``main``
had not moved since its anchor — hourly, here.

WHAT. :func:`verify_branch_update_lineage` is the ONE answer all three gates
(and the human-merge surface) read. A head that differs from the delivered
commit is accepted only when walking its FIRST-parent chain back to the
delivered commit, every commit on the way is:

1. a two-parent merge whose first parent ARIA itself asked GitHub to update:
   a ``pr_branch_update`` intent on the external-effects ledger for this PR
   with that ``expected_head_sha`` and a CONFIRMED receipt (an accepted call,
   or an unreceipted one later answered from the moved head);
2. merging a commit of ``main``: the second parent descends from the base the
   intent recorded (GitHub merges the base tip at call time, which may have
   moved after the read) and is contained in the live base;
3. pure: its tree is exactly the tree ``git merge-tree --write-tree`` computes
   for merging that second parent into that first parent — no hunk resolved
   by hand, no file added, no foreign content.

Anything else — a commit a person or another tool pushed, a non-merge, an
unrecorded update, a base not on ``main``, a conflict, a different tree, an
unreadable object — is refused by name (``BranchUpdateLineageRefused``). The
walk is bounded (``MAX_RECORDED_UPDATES``). CI on the CURRENT head stays the
merge authority's own requirement (``evaluate_auto_merge`` reads every check
run on the live head), so this helper never stands in for checks.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, ensure_tools_dir

# ~1 update per main commit while the PR waits: 64 is two days of hourly
# merges to main, past which a person is better placed to look anyway.
MAX_RECORDED_UPDATES = 64
_FULL_SHA = re.compile(r"[0-9a-f]{40}")
_GIT_TIMEOUT_SECONDS = 60


class BranchUpdateLineageRefused(GovernanceError):
    """The head is not the delivered commit plus ARIA's own pure updates."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"branch_update_lineage_refused:{reason}")


@dataclass(frozen=True)
class BranchUpdateLineage:
    """The verified chain: ``updates`` are ``(previous_head, merged_base, result)``, newest first."""

    head_sha: str
    delivered_sha: str
    updates: tuple[tuple[str, str, str], ...]


def _git(workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=workspace, capture_output=True, text=True, check=False, timeout=_GIT_TIMEOUT_SECONDS,
    )


def recorded_updates(*, base_dir: str | Path | None, pr_number: int) -> dict[str, tuple[str, ...]]:
    """``{expected_head_sha: (recorded base shas...)}`` of this PR's CONFIRMED update requests."""
    from .ledger import load_declared_jsonl
    from .pr_branch_update import EFFECT_KIND, update_request_id
    from .recovery import EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE

    path = ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH)
    if not path.exists():
        return {}
    request_id = update_request_id(pr_number)
    rows = [row for row in load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE)
            if row.get("request_id") == request_id]
    confirmed = {str(row.get("operation_id")) for row in rows
                 if row.get("event") == "receipt" and row.get("status") == "confirmed"}
    recorded: dict[str, list[str]] = {}
    for row in rows:
        intended = row.get("intended_postcondition") or {}
        if (
            row.get("event") == "intent" and row.get("effect_kind") == EFFECT_KIND
            and row.get("target") == f"pr#{pr_number}" and str(row.get("operation_id")) in confirmed
            and intended.get("pr_number") == pr_number
        ):
            head, base = str(intended.get("expected_head_sha") or ""), str(intended.get("base_sha") or "")
            if _FULL_SHA.fullmatch(head) and _FULL_SHA.fullmatch(base):
                recorded.setdefault(head, []).append(base)
    return {head: tuple(bases) for head, bases in recorded.items()}


def _is_ancestor(workspace: Path, older: str, newer: str) -> bool:
    return _git(workspace, "merge-base", "--is-ancestor", older, newer).returncode == 0


def _verify_pure_update(
    workspace: Path, commit: str, *, recorded: dict[str, tuple[str, ...]], live_base_sha: str,
) -> tuple[str, str]:
    """``(first_parent, merged_base)`` of one verified update commit, or refuse."""
    short = commit[:12]
    listed = _git(workspace, "rev-list", "--parents", "-n", "1", commit)
    parents = listed.stdout.split()[1:] if listed.returncode == 0 else None
    if parents is None:
        raise BranchUpdateLineageRefused(f"commit_unreadable:{short}")
    if len(parents) != 2:
        raise BranchUpdateLineageRefused(f"unrecorded_commit:{short}:parents={len(parents)}")
    previous, merged = parents
    bases = recorded.get(previous)
    if not bases:
        raise BranchUpdateLineageRefused(f"unrecorded_commit:{short}:no_update_requested_at:{previous[:12]}")
    if not any(_is_ancestor(workspace, base, merged) for base in bases) \
            or not _is_ancestor(workspace, merged, live_base_sha):
        raise BranchUpdateLineageRefused(f"merged_base_not_main:{short}:{merged[:12]}")
    computed = _git(workspace, "merge-tree", "--write-tree", previous, merged)
    tree = _git(workspace, "rev-parse", f"{commit}^{{tree}}")
    expected = (computed.stdout.splitlines() or [""])[0].strip()
    if computed.returncode != 0 or tree.returncode != 0 or not _FULL_SHA.fullmatch(expected):
        raise BranchUpdateLineageRefused(f"merge_not_clean:{short}:rc={computed.returncode}")
    if tree.stdout.strip() != expected:
        raise BranchUpdateLineageRefused(f"tree_differs_from_pure_merge:{short}")
    return previous, merged


def verify_branch_update_lineage(
    *,
    workspace: str | Path,
    base_dir: str | Path | None,
    pr_number: int,
    head_sha: str,
    delivered_sha: str,
    live_base_sha: str,
) -> BranchUpdateLineage:
    """Accept ``head_sha`` as ``delivered_sha`` plus ARIA's own pure updates, or refuse.

    ``head_sha == delivered_sha`` is the zero-update lineage. The walk reads
    the given checkout's objects; a missing one is a refusal, never a pass.
    """
    for label, value in (("head", head_sha), ("delivered", delivered_sha), ("live_base", live_base_sha)):
        if not isinstance(value, str) or not _FULL_SHA.fullmatch(value):
            raise BranchUpdateLineageRefused(f"{label}_sha_unreadable")
    if head_sha == delivered_sha:
        return BranchUpdateLineage(head_sha=head_sha, delivered_sha=delivered_sha, updates=())
    root = Path(workspace).resolve()
    recorded = recorded_updates(base_dir=base_dir, pr_number=pr_number)
    if not recorded:
        raise BranchUpdateLineageRefused(f"unrecorded_commit:{head_sha[:12]}:no_update_recorded_for_pr")
    updates: list[tuple[str, str, str]] = []
    current = head_sha
    try:
        while current != delivered_sha:
            if len(updates) >= MAX_RECORDED_UPDATES:
                raise BranchUpdateLineageRefused(f"more_than_{MAX_RECORDED_UPDATES}_updates")
            previous, merged = _verify_pure_update(root, current, recorded=recorded, live_base_sha=live_base_sha)
            updates.append((previous, merged, current))
            current = previous
    except (OSError, subprocess.SubprocessError) as exc:
        raise BranchUpdateLineageRefused(f"git_unavailable:{type(exc).__name__}") from exc
    return BranchUpdateLineage(head_sha=head_sha, delivered_sha=delivered_sha, updates=tuple(updates))


def lineage_summary(lineage: BranchUpdateLineage) -> dict[str, Any]:
    return {"head_sha": lineage.head_sha, "delivered_sha": lineage.delivered_sha,
            "updates": [list(update) for update in lineage.updates]}


__all__ = [
    "BranchUpdateLineage",
    "BranchUpdateLineageRefused",
    "MAX_RECORDED_UPDATES",
    "lineage_summary",
    "recorded_updates",
    "verify_branch_update_lineage",
]
