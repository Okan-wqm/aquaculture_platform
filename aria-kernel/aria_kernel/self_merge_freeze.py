"""ARIA-HIGH-200 — the self-merge freeze ARIA sets and only an operator lifts.

After a bad ARIA merge nothing stopped the next one: ``merge_authority``
checked the external watchdog freeze but ARIA had no freeze of its own. This
module is that freeze, one declared ledger
(``enterprise/self-merge-freeze.jsonl``) folded into one state:

* ``self_merge_frozen`` — written by ARIA (the self-revert producer) BEFORE it
  opens the revert, naming the merge it reverts. Idempotent per merge sha.
* ``revert_registered`` — the revert PR (number + head sha) that the freeze
  admits. A frozen merge authority refuses every PR except this one.
* ``self_merge_unfrozen`` — written only through :func:`unfreeze_self_merge`,
  which demands an operator approval reference that resolves to a recorded
  operator act (``gov:`` or ``review:``). ``ack-env`` is refused: an
  environment variable is something a workflow can set for itself.

A frozen state survives the revert merging: reverting restores the code, it
does not establish why the change was bad. Lifting the freeze is the
operator's decision.

The freeze and the unfreeze rows bypass the runtime-profile write gate, as
``runtime_profile.set_profile`` does for a thaw: a restriction must land
whatever profile is active, and the operator's recorded act is the authority
for lifting it. ``revert_registered`` keeps the gate — it is what lets a merge
through, so only a profile that grants ``pr_merge`` may write it.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .operator_approval import OperatorApprovalUnrecorded, verify_operator_approval_ref
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now

SELF_MERGE_FREEZE_SURFACE = "enterprise_self_merge_freeze"
SELF_MERGE_FREEZE_RELPATH = ("enterprise", "self-merge-freeze.jsonl")
FROZEN_EVENT = "self_merge_frozen"
REVERT_REGISTERED_EVENT = "revert_registered"
UNFROZEN_EVENT = "self_merge_unfrozen"
UNFREEZE_APPROVAL_KINDS = frozenset({"gov", "review"})


def freeze_ledger_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*SELF_MERGE_FREEZE_RELPATH)


def _rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    path = freeze_ledger_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=SELF_MERGE_FREEZE_SURFACE)


def freeze_id_for(merge_sha: str) -> str:
    return "freeze-" + hashlib.sha256(merge_sha.encode("utf-8")).hexdigest()[:16]


def active_freeze(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    """The freeze in force, with the revert it admits, or None."""
    frozen: dict[str, dict[str, Any]] = {}
    for row in _rows(base_dir):
        freeze_id = str(row.get("freeze_id") or "")
        event = row.get("event")
        if event == FROZEN_EVENT:
            frozen[freeze_id] = {**row, "revert": None}
        elif event == REVERT_REGISTERED_EVENT and freeze_id in frozen:
            frozen[freeze_id]["revert"] = {
                "pr_number": row.get("pr_number"),
                "head_sha": row.get("head_sha"),
            }
        elif event == UNFROZEN_EVENT:
            frozen.pop(freeze_id, None)
    if not frozen:
        return None
    # The oldest freeze in force is the one an operator must clear first.
    return min(frozen.values(), key=lambda row: str(row.get("recorded_at") or ""))


def freeze_self_merge(
    *,
    merge_sha: str,
    pr_number: int | None,
    trigger: str,
    evidence: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Freeze self-merge for a bad merge; the same merge freezes once."""
    if not merge_sha.strip():
        raise GovernanceError("self_merge_freeze_requires_merge_sha")
    freeze_id = freeze_id_for(merge_sha)
    for row in _rows(base_dir):
        if row.get("event") == FROZEN_EVENT and row.get("freeze_id") == freeze_id:
            return row
    row = append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "event": FROZEN_EVENT,
            "freeze_id": freeze_id,
            "merge_sha": merge_sha,
            "pr_number": pr_number,
            "trigger": trigger,
            "evidence": dict(evidence),
        },
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
        bypass_profile_gate=True,
    )
    append_tools_governance(
        ensure_tools_dir(base_dir),
        FROZEN_EVENT,
        {"freeze_id": freeze_id, "merge_sha": merge_sha, "pr_number": pr_number, "trigger": trigger},
        bypass_profile_gate=True,
    )
    return row


def register_revert(
    *,
    freeze_id: str,
    pr_number: int,
    head_sha: str,
    purity: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Name the one PR a freeze admits: the revert whose purity was proven."""
    if purity.get("pure") is not True:
        raise GovernanceError("self_merge_revert_not_pure")
    if not any(
        row.get("event") == FROZEN_EVENT and row.get("freeze_id") == freeze_id
        for row in _rows(base_dir)
    ):
        raise GovernanceError(f"self_merge_revert_unknown_freeze:{freeze_id}")
    return append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "event": REVERT_REGISTERED_EVENT,
            "freeze_id": freeze_id,
            "pr_number": pr_number,
            "head_sha": head_sha,
            "purity": dict(purity),
        },
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
    )


def assert_self_merge_not_frozen(
    *,
    pr_number: int,
    head_sha: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Refuse a self-merge while frozen, except the registered revert.

    Returns the freeze when the PR is its admitted revert, None when no
    freeze is in force; raises otherwise.
    """
    freeze = active_freeze(base_dir=base_dir)
    if freeze is None:
        return None
    revert = freeze.get("revert") or {}
    if revert.get("pr_number") == pr_number and revert.get("head_sha") == head_sha:
        return freeze
    raise GovernanceError(
        f"self_merge_frozen:{freeze.get('freeze_id')}: ARIA merge "
        f"{freeze.get('merge_sha')} is being reverted; only its registered revert "
        "may merge until an operator unfreezes"
    )


def unfreeze_self_merge(
    *,
    freeze_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Lift a freeze on an operator's recorded act, and nothing else."""
    freeze = active_freeze(base_dir=base_dir)
    if freeze is None or freeze.get("freeze_id") != freeze_id:
        raise GovernanceError(f"self_merge_unfreeze_unknown_or_inactive:{freeze_id}")
    kind = (operator_approval_ref or "").partition(":")[0]
    if kind not in UNFREEZE_APPROVAL_KINDS:
        raise GovernanceError(
            f"self_merge_unfreeze_requires_recorded_operator_act:{kind or 'none'}"
        )
    try:
        approval = verify_operator_approval_ref(
            operator_approval_ref, base_dir=base_dir, surface="self_merge_unfreeze",
        )
    except OperatorApprovalUnrecorded as exc:
        raise GovernanceError(f"self_merge_unfreeze_approval_unrecorded:{exc}") from exc
    row = append_declared_jsonl(
        freeze_ledger_path(base_dir),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "event": UNFROZEN_EVENT,
            "freeze_id": freeze_id,
            "merge_sha": freeze.get("merge_sha"),
            "operator_approval_ref": operator_approval_ref,
            "approval": approval,
        },
        expected_surface=SELF_MERGE_FREEZE_SURFACE,
        bypass_profile_gate=True,
    )
    append_tools_governance(
        ensure_tools_dir(base_dir),
        UNFROZEN_EVENT,
        {"freeze_id": freeze_id, "operator_approval_ref": operator_approval_ref},
        bypass_profile_gate=True,
    )
    return row


__all__ = [
    "FROZEN_EVENT",
    "REVERT_REGISTERED_EVENT",
    "SELF_MERGE_FREEZE_SURFACE",
    "UNFREEZE_APPROVAL_KINDS",
    "UNFROZEN_EVENT",
    "active_freeze",
    "assert_self_merge_not_frozen",
    "freeze_id_for",
    "freeze_ledger_path",
    "freeze_self_merge",
    "register_revert",
    "unfreeze_self_merge",
]
