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

from .ledger import load_declared_jsonl, state_transaction
from .tool_registry import disclosure_fingerprint, ensure_tools_dir, utc_now
from .workspace import governance_event


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


def _pending_from_rows(
    rows: list[dict[str, Any]],
    *,
    limit: int | None = None,
) -> list[dict[str, Any]]:
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


def append_pending(
    base_dir: str | Path | None,
    *,
    source_cycle_id: str,
    pressure_id: str,
    recommended_action: str | None = None,
    candidate_tools: list[str] | None = None,
) -> dict[str, Any] | None:
    """Append a pending queue item under the queue transaction lock.

    The depth check and append run in the same transaction so two cycle
    starters cannot both observe spare capacity and overfill the queue.
    """
    root = ensure_tools_dir(base_dir)
    path = root / "queues" / "next_cycle_queue.jsonl"
    governance_path = root / "governance.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)

    # The overflow identity must survive a crash between the governance and
    # queue appends.  A random queue id made a retry look like a second
    # overflow, duplicating both evidence and the terminal blocked row.
    overflow_kind = "next_cycle_queue_overflow_blocked"
    overflow_claim = {
        "source_cycle_id": source_cycle_id,
        "pressure_id": pressure_id,
    }
    overflow_fingerprint = disclosure_fingerprint(
        overflow_kind,
        overflow_claim,
    )
    overflow_queue_item_id = f"qi-{overflow_fingerprint}"
    pending_queue_item_id = f"qi-{uuid.uuid4().hex[:12]}"
    candidate_tool_rows = list(candidate_tools or [])

    # Validate the queue write authority before acquiring the transaction and
    # before constructing any row that could be persisted.  The held append
    # validates again; this early check guarantees profile refusal has zero
    # ledger side effects.
    from .runtime_profile import enforce_profile_for_write

    enforce_profile_for_write("plan_promotion_dispatch", base_dir=root)

    # Governance and queue are one lock domain for this operation.  Passing
    # both surfaces up front lets state_transaction acquire the global lexical
    # group order (governance -> queue) and prevents the former queue ->
    # governance nested-writer inversion with recovery.
    with state_transaction([governance_path, path]) as txn:
        queue_rows = txn.load_declared_jsonl(
            path,
            expected_surface="next_cycle_queue",
        )
        governance_rows = txn.load_declared_jsonl(
            governance_path,
            expected_surface="tools_governance",
        )
        pending = _pending_from_rows(
            queue_rows,
        )
        # C10/E8 — pressure_id IS the queue's idempotency key (reflection.py
        # names it so), but every row was keyed on a fresh uuid, so a
        # persistent pressure re-enqueued a NEW pending row every cycle until
        # the depth cap "blocked" it — bloat surfaced as overflow, never
        # deduped, and the blocked report read as capacity pressure when it
        # was really the same item N times. An already-pending pressure needs
        # no second request: return the standing row unchanged (append-only,
        # no mutation), before the depth check so a self-duplicating pressure
        # can never consume a slot twice.
        for row in pending:
            if row.get("pressure_id") == pressure_id:
                return row
        depth = queue_depth()
        if len(pending) >= depth:
            existing_blocked = next(
                (
                    row
                    for row in queue_rows
                    if row.get("state") == "blocked"
                    and row.get("queue_item_id") == overflow_queue_item_id
                    and row.get("source_cycle_id") == source_cycle_id
                    and row.get("pressure_id") == pressure_id
                ),
                None,
            )
            blocked_row = {
                "schema_version": 1,
                "queue_item_id": overflow_queue_item_id,
                "source_cycle_id": source_cycle_id,
                "pressure_id": pressure_id,
                "recommended_action": recommended_action,
                "candidate_tools": candidate_tool_rows,
                "state": "blocked",
                "reason": "queue_depth_exceeded",
                "queue_depth": depth,
                "pending_count": len(pending),
                "overflow_fingerprint": overflow_fingerprint,
                "recorded_at": utc_now(),
            }
            governance_details = {
                "queue_item_id": overflow_queue_item_id,
                "source_cycle_id": source_cycle_id,
                "pressure_id": pressure_id,
                "queue_depth": depth,
                "pending_count": len(pending),
                "disclosure_fingerprint": overflow_fingerprint,
            }
            prepared_governance = governance_event(
                kind=overflow_kind,
                details=governance_details,
            )

            # Governance has the stricter profile.  Check it only once the
            # strict reads prove this is an overflow, but still before either
            # append.  A refusal or append failure therefore leaves no
            # terminal blocked row behind.
            enforce_profile_for_write("tool_governance", base_dir=root)
            governance_exists = any(
                row.get("kind") == overflow_kind
                and isinstance(row.get("details"), dict)
                and row["details"].get("disclosure_fingerprint")
                == overflow_fingerprint
                for row in governance_rows
            )
            if not governance_exists:
                txn.append_declared_jsonl(
                    governance_path,
                    prepared_governance,
                    expected_surface="tools_governance",
                )
            if existing_blocked is not None:
                return existing_blocked

            # Terminal row is deliberately last.  If the process dies after
            # governance, retry observes the fingerprint above and appends
            # this row exactly once; if governance fails, no blocked row can
            # have escaped.
            return txn.append_declared_jsonl(
                path,
                blocked_row,
                expected_surface="next_cycle_queue",
            )
        row: dict[str, Any] = {
            "schema_version": 1,
            "queue_item_id": pending_queue_item_id,
            "source_cycle_id": source_cycle_id,
            "pressure_id": pressure_id,
            "recommended_action": recommended_action,
            "candidate_tools": candidate_tool_rows,
            "state": "pending",
            "recorded_at": utc_now(),
        }
        return txn.append_declared_jsonl(
            path,
            row,
            expected_surface="next_cycle_queue",
        )


def read_pending(
    base_dir: str | Path | None,
    *,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Return queue items whose latest state is ``pending``."""
    path = queue_path(base_dir)
    rows = load_declared_jsonl(path, expected_surface="next_cycle_queue")
    return _pending_from_rows(rows, limit=limit)


def mark_consumed(
    base_dir: str | Path | None,
    *,
    queue_item_id: str,
    consumed_by: str,
) -> dict[str, Any]:
    """Append a state=consumed transition row for ``queue_item_id``."""
    path = queue_path(base_dir)
    row: dict[str, Any] = {
        "schema_version": 1,
        "queue_item_id": queue_item_id,
        "state": "consumed",
        "consumed_by": consumed_by,
        "consumed_at": utc_now(),
        "recorded_at": utc_now(),
    }
    with state_transaction([path]) as txn:
        return txn.append_declared_jsonl(
            path,
            row,
            expected_surface="next_cycle_queue",
        )
