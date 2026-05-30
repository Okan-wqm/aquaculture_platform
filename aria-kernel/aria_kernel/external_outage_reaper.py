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

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Per-request requeue delay (30 min per ADR-0001).
EXTERNAL_OUTAGE_REQUEUE_DELAY_SECONDS: int = 1800

# Per-request maximum requeues. After this cap, escalate to HUMAN_REQUIRED.
# Total ceiling = 4 requeues × 30min = 2 hours of sustained outage before
# the operator MUST be in the loop.
MAX_EXTERNAL_OUTAGE_REQUEUES: int = 4


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


def find_external_outage_requests(
    *,
    claims_path: Path,
    now: datetime | None = None,
    requeue_delay_seconds: int = EXTERNAL_OUTAGE_REQUEUE_DELAY_SECONDS,
) -> list[dict[str, Any]]:
    """Scan claims.jsonl for requests in EXTERNAL_OUTAGE state whose
    backoff window has elapsed.

    Returns list of dicts with keys:
        - request_id
        - latest_exhausted_at (ISO timestamp)
        - requeue_count (number of prior requeues from EXTERNAL_OUTAGE)
        - should_escalate (True if requeue_count >= MAX_EXTERNAL_OUTAGE_REQUEUES)
    """
    if now is None:
        now = _now_utc()
    if not claims_path.exists():
        return []

    # Build per-request event history from claims.jsonl.
    history: dict[str, list[dict[str, Any]]] = {}
    try:
        with claims_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                request_id = row.get("request_id")
                if not isinstance(request_id, str):
                    continue
                history.setdefault(request_id, []).append(row)
    except OSError:
        return []

    candidates: list[dict[str, Any]] = []
    deadline_window = timedelta(seconds=requeue_delay_seconds)

    for request_id, rows in history.items():
        # Sort by occurred_at ascending
        sorted_rows = sorted(
            rows,
            key=lambda r: r.get("occurred_at", "") or r.get("ts", "")
        )
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
        latest_ts = _parse_iso(latest.get("occurred_at") or latest.get("ts"))
        if latest_ts is None:
            continue
        if (now - latest_ts) < deadline_window:
            continue
        # Eligible for reaping.
        candidates.append({
            "request_id": request_id,
            "latest_exhausted_at": latest.get("occurred_at") or latest.get("ts"),
            "requeue_count": requeue_count,
            "should_escalate": requeue_count >= MAX_EXTERNAL_OUTAGE_REQUEUES,
        })

    return candidates


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
    candidates = find_external_outage_requests(
        claims_path=claims_path,
        now=now,
        requeue_delay_seconds=requeue_delay_seconds,
    )

    requeued: list[str] = []
    escalated: list[str] = []
    now_iso = now.isoformat()

    if not candidates:
        return {
            "requeued_count": 0,
            "escalated_count": 0,
            "request_ids_requeued": [],
            "request_ids_escalated": [],
        }

    # Append all events atomically (single open + flush).
    try:
        with claims_path.open("a", encoding="utf-8") as fh:
            for cand in candidates:
                request_id = cand["request_id"]
                if cand["should_escalate"]:
                    event_row = {
                        "request_id": request_id,
                        "event": "human_required",
                        "occurred_at": now_iso,
                        "reason": "external_outage_max_requeues_exceeded",
                        "prior_requeue_count": cand["requeue_count"],
                    }
                    fh.write(json.dumps(event_row, sort_keys=True) + "\n")
                    escalated.append(request_id)
                else:
                    event_row = {
                        "request_id": request_id,
                        "event": "requeued",
                        "occurred_at": now_iso,
                        "reason": "external_outage_requeue",
                        "prior_requeue_count": cand["requeue_count"],
                    }
                    fh.write(json.dumps(event_row, sort_keys=True) + "\n")
                    requeued.append(request_id)
    except OSError:
        # Best-effort; on write failure return empty summary.
        return {
            "requeued_count": 0,
            "escalated_count": 0,
            "request_ids_requeued": [],
            "request_ids_escalated": [],
        }

    return {
        "requeued_count": len(requeued),
        "escalated_count": len(escalated),
        "request_ids_requeued": requeued,
        "request_ids_escalated": escalated,
    }
