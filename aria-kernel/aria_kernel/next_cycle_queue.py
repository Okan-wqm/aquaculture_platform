"""Plan 026R §F.2 — bounded scheduler queue for next-cycle plan items.

Pre-§F.2 ``reflection.run_reflection`` (reflection.py:46-81) wrote
``next_cycle_plan`` items only to the reflection JSONL row + the
text daily report; the autonomy orchestrator had no machine-
readable queue to drain at cycle-start. §F.2 adds a dedicated
queue ledger so §F.1 can dequeue pending items and convert each
into an agent-invocation request at cycle start.

Queue shape:

* Backing store: ``<tools_root>/queues/next_cycle_queue.jsonl``
* Per-row schema:
  ``{schema_version: 1, queue_item_id, source_cycle_id,
    pressure_id, recommended_action, candidate_tools,
    state: 'pending'|'consumed', recorded_at,
    consumed_at?: str, consumed_by?: str}``
* Hash-chain bound via ``append_jsonl`` (Plan 026R §A.1 SSoT).

Depth bound:

* ``ARIA_NEXT_CYCLE_QUEUE_DEPTH`` env var caps the count of
  pending rows (default 32). ``append_pending`` rejects above
  the cap to prevent queue-bloat under high-pressure cycles.

Idempotency:

* ``mark_consumed`` writes a state=consumed transition row;
  read_pending sees the latest-row-per-queue_item_id is consumed
  and excludes it. No row is ever mutated in place — pure
  append-only ledger discipline.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import ensure_tools_dir, utc_now


__all__ = [
    "DEFAULT_QUEUE_DEPTH",
    "QUEUE_DEPTH_ENV",
    "queue_depth",
    "append_pending",
    "read_pending",
    "mark_consumed",
    "queue_path",
]


DEFAULT_QUEUE_DEPTH: int = 32
QUEUE_DEPTH_ENV: str = "ARIA_NEXT_CYCLE_QUEUE_DEPTH"


def queue_depth() -> int:
    """Plan 026R §F.2 — depth cap resolution.

    Reads ``ARIA_NEXT_CYCLE_QUEUE_DEPTH`` env var; falls back to
    ``DEFAULT_QUEUE_DEPTH`` (32). Negative or non-int values fall
    back to the default — an operator misconfiguration must NOT
    silently disable the bound.
    """
    raw = os.environ.get(QUEUE_DEPTH_ENV)
    if not raw:
        return DEFAULT_QUEUE_DEPTH
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_QUEUE_DEPTH
    if value < 1:
        return DEFAULT_QUEUE_DEPTH
    return value


def queue_path(base_dir: str | Path | None) -> Path:
    """Canonical queue ledger path under ``<tools_root>/queues/``."""
    root = ensure_tools_dir(base_dir)
    return root / "queues" / "next_cycle_queue.jsonl"


def append_pending(
    base_dir: str | Path | None,
    *,
    source_cycle_id: str,
    pressure_id: str,
    recommended_action: str | None = None,
    candidate_tools: list[str] | None = None,
) -> dict[str, Any] | None:
    """Append a pending queue item.

    Returns the persisted row on success, or ``None`` when the
    queue is at depth — caller can treat ``None`` as "cap hit;
    item dropped" and emit a governance event if desired.
    """
    path = queue_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = read_pending(base_dir)
    if len(pending) >= queue_depth():
        return None
    queue_item_id = f"qi-{uuid.uuid4().hex[:12]}"
    row: dict[str, Any] = {
        "schema_version": 1,
        "queue_item_id": queue_item_id,
        "source_cycle_id": source_cycle_id,
        "pressure_id": pressure_id,
        "recommended_action": recommended_action,
        "candidate_tools": list(candidate_tools or []),
        "state": "pending",
        "recorded_at": utc_now(),
    }
    return append_jsonl(path, row)


def read_pending(
    base_dir: str | Path | None,
    *,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Return queue items whose latest state is ``pending``.

    The ledger is append-only; this reducer folds rows by
    ``queue_item_id`` and emits only those whose last recorded
    state is ``pending`` (consumed rows are excluded). Optional
    ``limit`` truncates to N oldest pending items — §F.1
    orchestrator passes a per-cycle drain budget.
    """
    path = queue_path(base_dir)
    rows = load_jsonl(path, verify=True)
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        qid = str(row.get("queue_item_id") or "")
        if not qid:
            continue
        latest[qid] = row
    pending = [
        row for row in rows
        if str(row.get("queue_item_id") or "") in latest
        and latest[str(row["queue_item_id"])].get("state") == "pending"
        and row.get("state") == "pending"
    ]
    # De-dup: only keep the first pending row per queue_item_id
    # (insertion order = chronological).
    seen: set[str] = set()
    ordered: list[dict[str, Any]] = []
    for row in pending:
        qid = str(row["queue_item_id"])
        if qid in seen:
            continue
        seen.add(qid)
        ordered.append(row)
    if limit is not None and limit >= 0:
        return ordered[:limit]
    return ordered


def mark_consumed(
    base_dir: str | Path | None,
    *,
    queue_item_id: str,
    consumed_by: str,
) -> dict[str, Any]:
    """Append a state=consumed transition row for ``queue_item_id``.

    Idempotent: a second consume on the same id appends a second
    consumed row but ``read_pending`` already excludes the id
    after the first. No-op result is acceptable.
    """
    path = queue_path(base_dir)
    row: dict[str, Any] = {
        "schema_version": 1,
        "queue_item_id": queue_item_id,
        "state": "consumed",
        "consumed_by": consumed_by,
        "consumed_at": utc_now(),
        "recorded_at": utc_now(),
    }
    return append_jsonl(path, row)
