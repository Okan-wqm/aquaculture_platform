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

ARIA-HIGH-363 — the same retry source closes the finding a merged plan was
planned from (``finding_closure``): this reconciler marked the plan merged
and left its finding, and every duplicate of it, OPEN for the aging-F source
to plan again. The finding store and the detector's checkout are the cycle's
``workspace_root``, so it is a required argument: a reconciler that cannot
reach the finding store is the defect, not a mode.

Small on purpose — operator preference: files stay short.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any, Mapping

from .finding_closure import FindingDetector, close_merged_plan_finding, default_detectors
from .implementation_rejections import MERGEABLE_AFTER_REJECTION
from .merge_record import (
    EVENT_CLOSED_UNMERGED,
    EVENT_MERGE_UNPROVEN,
    MERGED_BY_OBSERVED,
    MergeNotProven,
    classify_merged_head,
    lifecycle_rows,
    observed_merge,
    opened_row,
    record_merge,
    record_pr_unmergeable,
    verify_merge_after_rejection,
)
from .plan_convergence import events_path, fold_plan_state
from .ledger import LedgerIntegrityError, load_jsonl, state_transaction
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
            # ARIA-HIGH-390 — a plan ended after its PR existed may still be merged by a person.
            or (row.get("event_type") == "implementation_rejected"
                and (row.get("payload") or {}).get("rejection_class") in MERGEABLE_AFTER_REJECTION)
        })
    return {
        plan_id: fold_plan_state(plan_id=plan_id, base_dir=root)
        for plan_id in plan_ids
    }


def _plan_change_ids(root: Path) -> dict[str, tuple[str, ...]]:
    """plan id → the change ids the kernel minted for its implementation requests."""
    from .agent_invocations import list_agent_invocation_requests

    out: dict[str, list[str]] = {}
    for row in list_agent_invocation_requests(base_dir=root):
        change_id = (row.get("implementation_ids") or {}).get("change_id")
        if row.get("role") == "implementation" and row.get("convergence_id") and isinstance(change_id, str):
            out.setdefault(str(row["convergence_id"]), []).append(change_id)
    return {plan_id: tuple(ids) for plan_id, ids in out.items()}


def _terminal_prs(lifecycle: list[dict[str, Any]]) -> set[int]:
    """PRs whose lifecycle already ends: merged, closed unmerged, or a merge refused once (F7)."""
    return {row["pr_number"] for row in lifecycle if type(row.get("pr_number")) is int
            and row.get("event") in {"merged", EVENT_CLOSED_UNMERGED, EVENT_MERGE_UNPROVEN}}


def _observe_merge(
    plan_id: str, state: dict[str, Any], *, reader: Any, lifecycle: list[dict[str, Any]],
    change_ids: tuple[str, ...], base_branch: str, workspace: Path, root: Path,
) -> dict[str, Any] | None:
    """What GitHub says of the plan's PR: None (nothing to ask, or not merged), a refusal, or the merge."""
    impl = state.get("implementation") or {}
    if state.get("state") == "IMPLEMENTATION_RECORDED":
        pr_number = _pr_number_from_url(str(impl.get("pr_url") or ""))
        if pr_number is None:
            return None
        merge = observed_merge(reader.pr_merge_state(pr_number), pr_number=pr_number)
        if merge is None:
            return None
        merge_sha, merged_at, head = merge
        delivered = str(impl.get("branch_tip_sha") or "")
        pr = opened_row(lifecycle, pr_number=pr_number) or {"number": pr_number, "head_sha": delivered}
        # Review of #1910, F1 — the plan's PR merged (the plan folds MERGED
        # whatever happened on the branch), but the row says what merged: a
        # head with a person's commits is not ARIA's change, and the readers
        # that credit ARIA refuse it (`merge_record.merged_row_is_arias`).
        lineage = classify_merged_head(workspace, pr_number=pr_number, delivered_sha=delivered,
                                       head_sha=head, merge_sha=merge_sha)
        return {"merge": {
            "pr": pr, "merge_sha": merge_sha, "merged_at": merged_at, "merged_head_sha": head or None,
            "head_lineage": lineage,
            "idempotency_key_hash": _idempotency_key_hash(
                plan_id, str(impl.get("diff_hash") or ""), pr_number, base_branch, delivered),
        }}
    rejected_class = impl.get("rejection_class")
    if state.get("state") != "IMPLEMENTATION_REJECTED" or rejected_class not in MERGEABLE_AFTER_REJECTION:
        return None
    # ARIA-HIGH-390 — the kernel's own PRs for this plan, by the change it
    # minted; every one still open to a merge is asked (a re-opened PR is
    # another opened row), and a PR whose lifecycle ended is not asked again.
    terminal = _terminal_prs(lifecycle)
    candidates: dict[int, dict[str, Any]] = {}
    for change_id in change_ids:
        for row in lifecycle:
            if (row.get("event") == "opened" and row.get("change_id") == change_id
                    and type(row.get("pr_number")) is int and row["pr_number"] not in terminal):
                candidates[row["pr_number"]] = row
    for number, opened in sorted(candidates.items()):
        remote = reader.pr_merge_state(number)
        if not isinstance(remote, dict):
            continue
        state_name = str(remote.get("state") or "").upper()
        if state_name == "CLOSED":
            record_pr_unmergeable(pr=opened, event=EVENT_CLOSED_UNMERGED, reason="closed_unmerged_on_github",
                                  base_dir=root)
            continue
        if state_name != "MERGED":
            continue
        try:
            merge_sha, merged_at, head, lineage = verify_merge_after_rejection(
                opened=opened, remote=remote, workspace=workspace)
        except MergeNotProven as exc:
            record_pr_unmergeable(pr=opened, event=EVENT_MERGE_UNPROVEN, reason=str(exc), base_dir=root)
            return {"refused": str(exc)}
        return {"merge": {
            "pr": opened, "merge_sha": merge_sha, "merged_at": merged_at, "merged_head_sha": head,
            "head_lineage": lineage,
            "idempotency_key_hash": _idempotency_key_hash(plan_id, "", number, base_branch, str(opened["head_sha"])),
            "merged_after_rejection": {"rejection_class": str(rejected_class), "pr_number": number,
                                       "head_sha": str(opened["head_sha"])},
        }}
    return None


def _backfill_lifecycle(
    plan_id: str, state: dict[str, Any], lifecycle: list[dict[str, Any]], root: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(backfilled, skipped) for a plan merged before the one owner existed.

    The row is written only from the kernel's own ``opened`` row and the
    plan's merge facts (``merge_sha``, ``merged_at``); without an opened row
    nothing is guessed (review of #1910, F3).
    """
    impl = state.get("implementation") or {}
    after = impl.get("merged_after_rejection") or {}
    pr_number = _pr_number_from_url(str(impl.get("pr_url") or "")) or after.get("pr_number")
    if type(pr_number) is not int or any(row.get("event") == "merged" and row.get("pr_number") == pr_number
                                         for row in lifecycle):
        return [], []
    pr = opened_row(lifecycle, pr_number=pr_number)
    if pr is None:
        return [], [{"plan_id": plan_id, "pr_number": pr_number, "reason": "no_opened_row"}]
    written = record_merge(pr=pr, merged_by=MERGED_BY_OBSERVED, base_dir=root,
                           merge_sha=str(impl.get("merge_sha") or "") or None,
                           merged_at=str(impl.get("merged_at") or "") or None)
    lifecycle[:] = lifecycle_rows(root)
    return ([{"plan_id": plan_id, "pr_number": pr_number}] if written["lifecycle_row"] else []), []


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


def _close_finding(
    plan_id: str, state: dict[str, Any], root: Path, workspace_root: Path,
    detectors: Mapping[str, FindingDetector], history: list[dict[str, Any]],
) -> dict[str, Any]:
    """One merged plan's finding closure; a failed write is reported and retried next cycle."""
    try:
        return close_merged_plan_finding(
            plan_id=plan_id, state=state, repo_root=workspace_root,
            base_dir=root, detectors=detectors, history=history,
        )
    except (GovernanceError, LedgerIntegrityError, OSError) as exc:
        return {"plan_id": plan_id, "status": "closure_error",
                "error_type": type(exc).__name__, "reason": str(exc)[:500]}


def reconcile_recorded_implementations(
    *,
    base_dir: str | Path | None,
    reader: Any,
    workspace_root: str | Path,
    base_branch: str = "main",
    detectors: Mapping[str, FindingDetector] | None = None,
) -> dict[str, Any]:
    """Observe new merges and resume learning from durable merge evidence.

    ``merged`` and ``checked`` describe this call's new merge events and remote
    checks. ``promotions`` independently reports learning progress or failure.
    Existing merge-backed convention status is not a measured-gain verdict.
    ``finding_closures`` reports, per merged plan, whether its source finding
    (and its subject's duplicates) were closed, and if not, why.
    """
    root = ensure_tools_dir(base_dir)
    checkout = Path(workspace_root)
    finding_detectors = default_detectors() if detectors is None else detectors
    states = _implementation_states(root)
    # ARIA-HIGH-363 (review B1(b)) — read once: every merged plan's closure
    # pass checks its completion and its unverifiable tries against it, and a
    # completed pass is skipped without folding the finding store.
    history = load_jsonl(root / "governance.jsonl") if any(
        state.get("state") in {"IMPLEMENTATION_MERGED", "IMPLEMENTATION_RECORDED", "IMPLEMENTATION_REJECTED"}
        for state in states.values()
    ) else []
    result: dict[str, Any] = {
        "status": "reconciled", "merged": [], "checked": 0,
        "promotions": [], "merge_errors": [], "finding_closures": [],
        "merge_refusals": [], "lifecycle_backfilled": [], "lifecycle_backfill_skipped": [],
    }
    for plan_id, state in states.items():
        if state.get("state") == "IMPLEMENTATION_MERGED":
            result["promotions"].append(_reconcile_promotion(plan_id, root))
            result["finding_closures"].append(
                _close_finding(plan_id, state, root, checkout, finding_detectors, history),
            )

    # ARIA-HIGH-390 — a plan merged before the one owner existed (or by a
    # writer that recorded only the plan) gets its PR's lifecycle row from
    # the plan's own merge: no GitHub read, the merge is already proven.
    lifecycle = lifecycle_rows(root)
    for plan_id, state in states.items():
        if state.get("state") == "IMPLEMENTATION_MERGED":
            backfilled, skipped = _backfill_lifecycle(plan_id, state, lifecycle, root)
            result["lifecycle_backfilled"].extend(backfilled)
            result["lifecycle_backfill_skipped"].extend(skipped)

    # Local recovery above does not depend on credentials or network health.
    # Neither this call nor pr_merge_state below runs inside a state lock.
    readable, reason = reader.readable()
    if not readable:
        result.update(status="unreadable", reason=reason)
        return result

    change_ids = _plan_change_ids(root)
    for plan_id, state in states.items():
        observed = _observe_merge(plan_id, state, reader=reader, lifecycle=lifecycle,
                                  change_ids=change_ids.get(plan_id, ()), base_branch=base_branch,
                                  workspace=checkout, root=root)
        if observed is None:
            continue
        result["checked"] += 1
        if "refused" in observed:
            result["merge_refusals"].append({"plan_id": plan_id, "reason": observed["refused"]})
            continue
        try:
            written = record_merge(plan_id=plan_id, merged_by=MERGED_BY_OBSERVED, base_dir=root, **observed["merge"])
        except (GovernanceError, MergeNotProven) as exc:
            # Contention or a refused transition is observable. The next pass
            # discovers any concurrently persisted merge from its own ledger.
            result["merge_errors"].append({"plan_id": plan_id, "reason": str(exc)[:500]})
            continue
        event = written.get("plan_event") or {}
        if event.get("event_appended"):
            result["merged"].append({"plan_id": plan_id, "pr_number": written["pr_number"],
                                     "merge_sha": observed["merge"]["merge_sha"]})
        result["promotions"].append(_reconcile_promotion(plan_id, root))
        result["finding_closures"].append(_close_finding(
            plan_id, fold_plan_state(plan_id=plan_id, base_dir=root), root, checkout, finding_detectors, history,
        ))

    return result
