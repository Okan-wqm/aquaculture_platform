"""Plan 031-R R2 — canonical expert-review verdict ledger.

The expert-consensus gate (``expert_review_gate``) produces a verdict; this
ledger PERSISTS it keyed by ``change_id`` so the pre-PR-open chokepoint
(``pr_manager.open_pr_for_action``) can READ an approved, head-matching verdict
and fail closed when none exists. Dispatch and enforcement are thus decoupled:
the worker/bridge dispatches reviewers and runs the gate (which writes here);
``pr_manager`` never dispatches — it only requires that an evidence-verified
consensus was already recorded for the EXACT code being PR'd.

Read policy: latest row for a change_id wins, but the verdict is bound to a
``head_sha`` — an approval for v1 must not clear a PR of v2. A head-sha
mismatch fails closed (stale approval), as does a missing or non-approved row.

The ledger is a plain hash-chained jsonl (``append_jsonl`` stamps ``ledger_hash``)
under ``aria-tools/expert-verdicts.jsonl`` — deliberately not an enterprise
declared surface, so it cannot be confused with merge-authority ledgers.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

EXPERT_VERDICTS_SCHEMA_VERSION: int = 1


def _ledger_path(base_dir: str | Path | None) -> Path:
    return ensure_tools_dir(base_dir) / "expert-verdicts.jsonl"


def record_expert_verdicts(
    *,
    change_id: str,
    base_sha: str | None,
    head_sha: str,
    verdicts: list[dict[str, Any]],
    approved: bool,
    reason: str,
    unverifiable_refs: list[dict[str, str]] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Append one expert-consensus verdict row (approved or not) for a change."""
    if not change_id.strip():
        raise GovernanceError("change_id is required")
    if not (head_sha or "").strip():
        raise GovernanceError("head_sha is required (the verdict binds to the PR'd code)")
    reviewers = sorted({str(v.get("expert") or "") for v in verdicts if v.get("expert")})
    row = {
        "schema_version": EXPERT_VERDICTS_SCHEMA_VERSION,
        "recorded_at": utc_now(),
        "change_id": change_id,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "reviewers": reviewers,
        "verdicts": verdicts,
        "approved": bool(approved),
        "reason": reason or "",
        "unverifiable_refs": list(unverifiable_refs or []),
    }
    return append_jsonl(_ledger_path(base_dir), row)


def latest_verdict_for_change(
    *,
    change_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Return the most recent verdict row for ``change_id`` (latest wins)."""
    path = _ledger_path(base_dir)
    if not path.exists():
        return None
    latest: dict[str, Any] | None = None
    for row in load_jsonl(path):
        if row.get("change_id") == change_id:
            latest = row
    return latest


def assert_change_expert_approved(
    *,
    change_id: str,
    head_sha: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Fail closed unless an approved verdict bound to ``head_sha`` exists.

    Called by the pre-PR-open chokepoint. Raises ``GovernanceError`` when no
    verdict row exists, the latest row is not approved, or its head_sha does not
    match the PR's head (a stale approval for different code).
    """
    row = latest_verdict_for_change(change_id=change_id, base_dir=base_dir)
    if row is None:
        raise GovernanceError(
            f"expert_consensus_verdict_missing: no expert-verdict row for "
            f"change_id={change_id!r}; an autonomous fix PR requires an "
            f"evidence-verified expert consensus recorded before PR open"
        )
    if not row.get("approved"):
        raise GovernanceError(
            f"expert_consensus_not_approved: change_id={change_id!r} latest "
            f"expert verdict is not approved (reason={row.get('reason')!r})"
        )
    if row.get("head_sha") != head_sha:
        raise GovernanceError(
            f"expert_consensus_head_drift: approved verdict bound to head_sha="
            f"{row.get('head_sha')!r} but PR head_sha={head_sha!r} — the approval "
            f"is for different code (stale); re-review the current head"
        )
    return row


__all__ = [
    "EXPERT_VERDICTS_SCHEMA_VERSION",
    "record_expert_verdicts",
    "latest_verdict_for_change",
    "assert_change_expert_approved",
]
