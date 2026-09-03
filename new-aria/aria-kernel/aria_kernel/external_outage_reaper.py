"""V10.5 Phase 3 — EXTERNAL_OUTAGE lifecycle reaper.

Per ADR-0001: a request that enters EXTERNAL_OUTAGE state via
`api_backoff_exhausted` claim event is non-sticky. After 30 min
wall-clock, the reaper appends a `requeued` claim event and the
request returns to REQUEUED state (where `next_pending_request` will
pick it up again). After `MAX_EXTERNAL_OUTAGE_REQUEUES = 4` cumulative
requeues, the reaper escalates to HUMAN_REQUIRED so the operator MUST
be in the loop for sustained external dependency failures.

Module mirrors aria_kernel/human_required.py:177-193 reaper pattern.
Registered in aria-kernel/aria_kernel/cycle.py reaping pipeline.

Reference: docs/recommendations/architectural-arbiter/2026-05-20-adr-0001-external-outage-state.md
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .agent_invocations import _claim_event_time
from .ledger import state_transaction

# Per-request requeue delay (30 min per ADR-0001).
EXTERNAL_OUTAGE_REQUEUE_DELAY_SECONDS: int = 1800

# Per-request maximum requeues. After this cap, escalate to HUMAN_REQUIRED.
# Total ceiling = 4 requeues × 30min = 2 hours of sustained outage before
# the operator MUST be in the loop.
MAX_EXTERNAL_OUTAGE_REQUEUES: int = 4
_SUBMISSION_JOURNAL_EVENT = "result_submission_prepared"
_TERMINAL_RESULT_STATUSES = frozenset({"accepted", "rejected", "completed"})
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _find_external_outage_requests(
    rows: list[dict[str, Any]],
    *,
    now: datetime,
    requeue_delay_seconds: int,
    max_requeues: int,
) -> list[dict[str, Any]]:
    """Purely fold verified claim rows into elapsed-outage candidates.

    Returns list of dicts with keys:
        - request_id
        - latest_exhausted_at (ISO timestamp)
        - requeue_count (number of prior requeues from EXTERNAL_OUTAGE)
        - should_escalate (True if requeue_count >= MAX_EXTERNAL_OUTAGE_REQUEUES)
    """
    history: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        request_id = row.get("request_id")
        if not isinstance(request_id, str):
            continue
        history.setdefault(request_id, []).append(row)

    candidates: list[dict[str, Any]] = []
    deadline_window = timedelta(seconds=requeue_delay_seconds)

    for request_id, rows in history.items():
        # Claim lifecycle producers deliberately use distinct native time
        # fields (claimed_at, released_at, stale_at, at, ...).  Sorting only
        # outage-native occurred_at/ts can resurrect an older outage after a
        # newer release or requeue.  Python's stable sort preserves append
        # order when timestamps tie or a legacy row has no usable timestamp.
        sorted_rows = sorted(rows, key=lambda row: _claim_event_time(row)[0])
        # Find the latest meaningful claim event.
        # If latest is human_required → skip (sticky, NOT eligible for outage reaper).
        # If latest is api_backoff_exhausted → check timing.
        # Otherwise → skip.
        latest = sorted_rows[-1] if sorted_rows else None
        if not latest:
            continue
        latest_event = latest.get("event")
        if latest_event == "human_required":
            continue
        if latest_event != "api_backoff_exhausted":
            continue
        # Count prior requeues from EXTERNAL_OUTAGE (events with reason=external_outage_requeue).
        requeue_count = sum(
            1 for r in sorted_rows
            if r.get("event") == "requeued"
            and r.get("reason") == "external_outage_requeue"
        )
        # Check window — has 30 min elapsed since latest api_backoff_exhausted?
        latest_ts, latest_ts_raw = _claim_event_time(latest)
        if latest_ts_raw is None:
            continue
        if (now - latest_ts) < deadline_window:
            continue
        # Eligible for reaping.
        candidates.append({
            "request_id": request_id,
            "latest_exhausted_at": latest_ts_raw,
            "requeue_count": requeue_count,
            "should_escalate": requeue_count >= max_requeues,
        })

    return candidates


def find_external_outage_requests(
    *,
    claims_path: Path,
    now: datetime | None = None,
    requeue_delay_seconds: int = EXTERNAL_OUTAGE_REQUEUE_DELAY_SECONDS,
    max_requeues: int = MAX_EXTERNAL_OUTAGE_REQUEUES,
) -> list[dict[str, Any]]:
    """Strictly load claims under its state lock and find elapsed outages."""
    if now is None:
        now = _now_utc()
    with state_transaction([claims_path]) as transaction:
        rows = transaction.load_declared_jsonl(
            claims_path,
            expected_surface="agent_invocation_claims",
            verify=True,
        )
        return _find_external_outage_requests(
            rows,
            now=now,
            requeue_delay_seconds=requeue_delay_seconds,
            max_requeues=max_requeues,
        )


def _commit_pending_request_ids(rows: list[dict[str, Any]]) -> set[str]:
    return {
        str(row["request_id"])
        for row in rows
        if row.get("event") == _SUBMISSION_JOURNAL_EVENT
        and isinstance(row.get("request_id"), str)
    }


def _terminal_result_request_ids(rows: list[dict[str, Any]]) -> set[str]:
    return {
        str(row["request_id"])
        for row in rows
        if row.get("status") in _TERMINAL_RESULT_STATUSES
        and isinstance(row.get("request_id"), str)
    }


def reap_external_outage_requests(
    *,
    claims_path: Path,
    now: datetime | None = None,
    requeue_delay_seconds: int = EXTERNAL_OUTAGE_REQUEUE_DELAY_SECONDS,
    max_requeues: int = MAX_EXTERNAL_OUTAGE_REQUEUES,
) -> dict[str, Any]:
    """Find EXTERNAL_OUTAGE requests + append requeued/human_required events.

    Returns summary dict:
        {
            "requeued_count": int,
            "escalated_count": int,
            "request_ids_requeued": [...],
            "request_ids_escalated": [...],
        }

    Reaping rules:
        - latest event = api_backoff_exhausted, window elapsed → append `requeued`
          with reason=external_outage_requeue
        - requeue_count >= max_requeues → append `human_required` event instead
          (escalation; operator MUST review)
    """
    if now is None:
        now = _now_utc()
    requeued: list[str] = []
    escalated: list[str] = []
    now_iso = now.isoformat()
    results_path = claims_path.with_name("results.jsonl")
    with state_transaction([claims_path, results_path]) as transaction:
        locked_claims = transaction.load_declared_jsonl(
            claims_path,
            expected_surface="agent_invocation_claims",
            verify=True,
        )
        locked_results = transaction.load_declared_jsonl(
            results_path,
            expected_surface="agent_invocation_results",
            verify=True,
        )
        protected_requests = (
            _commit_pending_request_ids(locked_claims)
            | _terminal_result_request_ids(locked_results)
        )
        candidates = _find_external_outage_requests(
            locked_claims,
            now=now,
            requeue_delay_seconds=requeue_delay_seconds,
            max_requeues=max_requeues,
        )
        for cand in candidates:
            request_id = cand["request_id"]
            if request_id in protected_requests:
                continue
            if cand["should_escalate"]:
                event_row = {
                    "schema_version": 1,
                    "request_id": request_id,
                    "event": "human_required",
                    "occurred_at": now_iso,
                    "reason": "external_outage_max_requeues_exceeded",
                    "prior_requeue_count": cand["requeue_count"],
                }
                transaction.append_declared_jsonl(
                    claims_path,
                    event_row,
                    expected_surface="agent_invocation_claims",
                )
                escalated.append(request_id)
            else:
                event_row = {
                    "schema_version": 1,
                    "request_id": request_id,
                    "event": "requeued",
                    "occurred_at": now_iso,
                    "reason": "external_outage_requeue",
                    "prior_requeue_count": cand["requeue_count"],
                }
                transaction.append_declared_jsonl(
                    claims_path,
                    event_row,
                    expected_surface="agent_invocation_claims",
                )
                requeued.append(request_id)

    return {
        "requeued_count": len(requeued),
        "escalated_count": len(escalated),
        "request_ids_requeued": requeued,
        "request_ids_escalated": escalated,
    }
