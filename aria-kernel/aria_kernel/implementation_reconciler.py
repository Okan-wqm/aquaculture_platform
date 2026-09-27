"""E2/F1 — the producer of `implementation_merged` (the arc's last event).

WHY: the transition existed with full ceremony and no writer. The merge
itself is performed by the OPERATOR on GitHub (ARIA never merges its own
work — standing rule), so the truthful producer is a RECONCILER: each
cycle, every plan resting in IMPLEMENTATION_RECORDED is checked against
GitHub's own answer for its recorded PR; a merged PR becomes the
`implementation_merged` terminal event with the V9.6 idempotency 5-tuple.

Merge and learning completion are separate. Persisted terminal merges remain
eligible for convention reconciliation even when the remote reader is offline.
The existing ledgers are the retry source; a merge is never reopened or repeated.

Small on purpose — operator preference: files stay short.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .plan_convergence import (
    events_path,
    fold_plan_state,
    record_implementation_merged,
)
from .ledger import LedgerIntegrityError, state_transaction
from .tool_registry import GovernanceError, ensure_tools_dir

_PR_NUMBER_RE = re.compile(r"/pull/(\d+)")


def _pr_number_from_url(pr_url: str) -> int | None:
    match = _PR_NUMBER_RE.search(pr_url or "")
    return int(match.group(1)) if match else None


def _idempotency_key_hash(
    plan_id: str, diff_hash: str, pr_number: int, base_branch: str, branch_tip_sha: str
) -> str:
    canonical = "|".join((plan_id, diff_hash, str(pr_number), base_branch, branch_tip_sha))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _implementation_states(root: Path) -> dict[str, dict[str, Any]]:
    """Verify persisted evidence before consulting even a warm plan-fold cache."""
    path = events_path(root)
    with state_transaction([path]) as transaction:
        events = transaction.load_declared_jsonl(
            path, expected_surface="plan_convergence_events",
        )
        plan_ids = sorted({
            str(row["plan_id"]) for row in events
            if row.get("event_type") in {"implementation_outcome_recorded", "implementation_merged"}
        })
    return {
        plan_id: fold_plan_state(plan_id=plan_id, base_dir=root)
        for plan_id in plan_ids
    }


def _reconcile_promotion(plan_id: str, root: Path) -> dict[str, Any]:
    from .knowledge_graph import (
        KnowledgeGraphSchemaError,
        KnowledgeGraphTamper,
        reconcile_convention_promotion,
    )

    try:
        outcome = reconcile_convention_promotion(
            plan_id=plan_id, base_dir=root,
        )
        return {"plan_id": plan_id, **{k: v for k, v in outcome.items() if k != "convention"}}
    except (KnowledgeGraphTamper, LedgerIntegrityError) as exc:
        # The knowledge reader preserves I/O errors as chained causes. An
        # unavailable read is not evidence that persisted history is corrupt.
        if isinstance(exc.__cause__, OSError):
            status = "retryable_error"
            error = exc.__cause__
        else:
            status = "integrity_error"
            error = exc
    except KnowledgeGraphSchemaError as exc:
        status = "schema_error"
        error = exc
    except GovernanceError as exc:
        status = "authority_error"
        error = exc
    except OSError as exc:
        status = "retryable_error"
        error = exc
    return {
        "plan_id": plan_id, "status": status,
        "error_type": type(error).__name__, "reason": str(error)[:500],
    }


def reconcile_recorded_implementations(
    *,
    base_dir: str | Path | None,
    reader: Any,
    base_branch: str = "main",
) -> dict[str, Any]:
    """Observe new merges and resume learning from durable merge evidence.

    ``merged`` and ``checked`` describe this call's new merge events and remote
    checks. ``promotions`` independently reports learning progress or failure.
    Existing merge-backed convention status is not a measured-gain verdict.
    """
    root = ensure_tools_dir(base_dir)
    states = _implementation_states(root)
    result: dict[str, Any] = {
        "status": "reconciled", "merged": [], "checked": 0,
        "promotions": [], "merge_errors": [],
    }
    for plan_id, state in states.items():
        if state.get("state") == "IMPLEMENTATION_MERGED":
            result["promotions"].append(_reconcile_promotion(plan_id, root))

    # Local recovery above does not depend on credentials or network health.
    # Neither this call nor pr_merge_state below runs inside a state lock.
    readable, reason = reader.readable()
    if not readable:
        result.update(status="unreadable", reason=reason)
        return result

    for plan_id, state in states.items():
        if state.get("state") != "IMPLEMENTATION_RECORDED":
            continue
        impl = state.get("implementation") or {}
        pr_number = _pr_number_from_url(str(impl.get("pr_url") or ""))
        if pr_number is None:
            continue
        result["checked"] += 1
        remote = reader.pr_merge_state(pr_number)
        if not isinstance(remote, dict):
            continue
        merged_at = remote.get("mergedAt")
        merge_commit = remote.get("mergeCommit") or {}
        merge_sha = str(merge_commit.get("oid") or "") if isinstance(merge_commit, dict) else ""
        if str(remote.get("state") or "").upper() != "MERGED" or not merged_at or not merge_sha:
            continue
        try:
            event = record_implementation_merged(
                plan_id=plan_id,
                merge_sha=merge_sha,
                merged_at=str(merged_at),
                idempotency_key_hash=_idempotency_key_hash(
                    plan_id,
                    str(impl.get("diff_hash") or ""),
                    pr_number,
                    base_branch,
                    str(impl.get("branch_tip_sha") or ""),
                ),
                base_dir=root,
            )
        except GovernanceError as exc:
            # Contention or a refused transition is observable. The next pass
            # discovers any concurrently persisted merge from its own ledger.
            result["merge_errors"].append({"plan_id": plan_id, "reason": str(exc)[:500]})
            continue
        if event["event_appended"]:
            result["merged"].append({"plan_id": plan_id, "pr_number": pr_number, "merge_sha": merge_sha})
        result["promotions"].append(_reconcile_promotion(plan_id, root))

    return result
