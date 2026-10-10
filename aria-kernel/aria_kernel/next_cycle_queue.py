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
    state: 'pending'|'consumed'|'blocked'|'superseded'|'expired',
    recorded_at, consumed_at?: str, consumed_by?: str}``
* Hash-chain bound via ``append_jsonl`` (Plan 026R §A.1 SSoT).

One live item per pressure (ARIA-MEDIUM-428):

* ``pressure_id`` is the queue's idempotency key, so the queue's
  unit of work is the pressure, not the row. ``fold_queue`` keeps,
  per pressure, the pending item enqueued last (the freshest
  snapshot of the pressure); every other pending item of that
  pressure is ``superseded`` by it. A live item not offered (enqueued
  or re-offered) within the request-anchor window is ``expired``: a
  pressure that still holds is queued again, with a fresh snapshot,
  by the next reflection.
* ``read_pending`` returns the fold's live items, so a reader never
  sees a duplicate. Every writer appends the fold's verdicts it does
  not yet hold (``superseded`` / ``expired`` transition rows) in its
  own transaction before its own row, so the ledger records each
  verdict once and consuming a live item cannot bring a superseded
  sibling back.

Depth bound:

* ``ARIA_NEXT_CYCLE_QUEUE_DEPTH`` env var caps the count of
  live pressures (default 32). ``append_pending`` rejects above
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
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import load_declared_jsonl, state_transaction
from .tool_registry import disclosure_fingerprint, ensure_tools_dir, parse_utc_stamp, utc_now
from .workspace import governance_event


__all__ = [
    "DEFAULT_QUEUE_DEPTH",
    "QUEUE_DEPTH_ENV",
    "queue_depth",
    "append_pending",
    "read_pending",
    "mark_consumed",
    "queue_path",
    "REOFFERED",
    "REOFFER_ALREADY_PENDING",
    "REOFFER_NEVER_QUEUED",
    "REOFFER_QUEUE_FULL",
    "reoffer_item",
    "defer_projection",
    "EXPIRED",
    "EXPIRED_REASON",
    "SUPERSEDED",
    "SUPERSEDED_REASON",
    "QueueFold",
    "fold_queue",
    "item_max_age_seconds",
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


# ARIA-MEDIUM-428 — the two terminal verdicts the fold writes. Neither is a
# consumption: no request was minted for the item.
SUPERSEDED: str = "superseded"
SUPERSEDED_REASON: str = "pressure_already_pending"
EXPIRED: str = "expired"
EXPIRED_REASON: str = "queue_item_aged_out"


def _now() -> datetime:
    """The fold's clock: one seam, so a test can age an item."""
    return datetime.now(timezone.utc)


def item_max_age_seconds(base_dir: str | Path | None) -> int:
    """How long an offered item may wait for the drain (ARIA-MEDIUM-428).

    A queue item is the agent request before its mint, so it ages by the
    operator's request-anchor window (``genesis_policy``
    ``agent_request_anchor.max_age_seconds``, the one
    ``request_drain_capacity`` reads too). Past it, the pressure snapshot of
    its ``source_cycle_id`` is older than any request ARIA would still run.
    Live, the drain was refused by request admission for days (backlog over
    the drain budget), and the items it could not mint sat in depth slots.
    """
    from .agent_invocations import _anchor_max_age_seconds

    return _anchor_max_age_seconds(ensure_tools_dir(base_dir))


@dataclass(frozen=True)
class QueueFold:
    """``live``: one item per pressure, as its enqueue row, in queue order.
    ``transitions``: the ``superseded`` / ``expired`` rows the ledger does
    not hold yet."""

    live: list[dict[str, Any]]
    transitions: list[dict[str, Any]]


def fold_queue(rows: list[dict[str, Any]], *, now: datetime, max_age_seconds: int) -> QueueFold:
    """The queue's one reading: which items are live, and which verdicts are unwritten.

    ARIA-MEDIUM-428. ``append_pending`` keyed its dedupe on pending rows
    only, and ``reoffer_item`` (ARIA-HIGH-360) put a consumed item back
    without asking whether its pressure was already pending again. On
    aria/state f5c5c86a1 the 32 pending items held 10 pressures (8 items of
    one pressure, 27 of them re-offered on 2026-10-08), so the depth cap
    blocked every new pressure while it held ten.

    Per pressure, the pending item ENQUEUED last is live: the drain reads
    the pressure as stored by the item's ``source_cycle_id``, so the newest
    enqueue is the freshest evidence. Its siblings are superseded by it. An
    item's OFFER is its enqueue row or a re-offer row (a deferral row keeps
    it pending but offers nothing new); the live item is expired when its
    latest offer is older than ``max_age_seconds`` or carries no readable
    stamp (a corrupt stamp must not buy a slot forever).
    """
    enqueued: dict[str, tuple[int, dict[str, Any]]] = {}
    offered: dict[str, int] = {}
    latest: dict[str, dict[str, Any]] = {}
    for position, row in enumerate(rows):
        qid = str(row.get("queue_item_id") or "")
        if not qid:
            continue
        latest[qid] = row
        if row.get("state") != "pending":
            continue
        if qid not in enqueued:
            enqueued[qid] = (position, row)
            offered[qid] = position
        elif row.get("reoffered_reason"):
            offered[qid] = position
    by_pressure: dict[str, list[str]] = {}
    for qid, row in latest.items():
        if row.get("state") == "pending":
            # An item without a pressure is its own group: nothing can supersede it.
            pressure = str(enqueued[qid][1].get("pressure_id") or "") or f"queue-item:{qid}"
            by_pressure.setdefault(pressure, []).append(qid)
    horizon = now - timedelta(seconds=max_age_seconds)
    stamp = now.replace(microsecond=0).isoformat()
    live: list[tuple[int, dict[str, Any]]] = []
    transitions: list[dict[str, Any]] = []
    for pressure, qids in by_pressure.items():
        keep = max(qids, key=lambda qid: enqueued[qid][0])
        pressure_id = enqueued[keep][1].get("pressure_id")
        for qid in qids:
            if qid != keep:
                transitions.append({
                    "schema_version": 1, "queue_item_id": qid, "state": SUPERSEDED,
                    "pressure_id": pressure_id, "superseded_by": keep,
                    "reason": SUPERSEDED_REASON, "recorded_at": stamp,
                })
        offered_at = str(rows[offered[keep]].get("recorded_at") or "")
        offered_stamp = parse_utc_stamp(offered_at)
        if offered_stamp is None or offered_stamp < horizon:
            transitions.append({
                "schema_version": 1, "queue_item_id": keep, "state": EXPIRED,
                "pressure_id": pressure_id, "reason": EXPIRED_REASON,
                "offered_at": offered_at or None, "max_age_seconds": max_age_seconds,
                "recorded_at": stamp,
            })
            continue
        live.append(enqueued[keep])
    live.sort(key=lambda entry: entry[0])
    return QueueFold(live=[row for _, row in live], transitions=transitions)


def _settled_fold(txn: Any, path: Path, rows: list[dict[str, Any]], *, max_age_seconds: int) -> QueueFold:
    """Fold ``rows`` and append the verdicts the ledger lacks, inside the caller's transaction."""
    fold = fold_queue(rows, now=_now(), max_age_seconds=max_age_seconds)
    for row in fold.transitions:
        txn.append_declared_jsonl(path, row, expected_surface="next_cycle_queue")
    return fold


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
    max_age_seconds = item_max_age_seconds(root)

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
        # ARIA-MEDIUM-428 — the depth cap and the dedupe below read the fold:
        # one live item per pressure, the verdicts written first.
        pending = _settled_fold(
            txn, path, queue_rows, max_age_seconds=max_age_seconds,
        ).live
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
    """The live items (one per pressure, ``fold_queue``), oldest enqueue first.

    A pure read: a duplicate or an aged item is left out here before any
    writer has recorded its verdict.
    """
    path = queue_path(base_dir)
    rows = load_declared_jsonl(path, expected_surface="next_cycle_queue")
    live = fold_queue(rows, now=_now(), max_age_seconds=item_max_age_seconds(base_dir)).live
    if limit is not None and limit >= 0:
        return live[:limit]
    return live


def mark_consumed(
    base_dir: str | Path | None,
    *,
    queue_item_id: str,
    consumed_by: str,
) -> dict[str, Any]:
    """Append a state=consumed transition row for ``queue_item_id``.

    The fold's verdicts are written first (ARIA-MEDIUM-428): once the live
    item is consumed, a sibling it superseded must already read as
    superseded, or it would be the pressure's live item again.
    """
    path = queue_path(base_dir)
    max_age_seconds = item_max_age_seconds(base_dir)
    row: dict[str, Any] = {
        "schema_version": 1,
        "queue_item_id": queue_item_id,
        "state": "consumed",
        "consumed_by": consumed_by,
        "consumed_at": utc_now(),
        "recorded_at": utc_now(),
    }
    with state_transaction([path]) as txn:
        rows = txn.load_declared_jsonl(path, expected_surface="next_cycle_queue")
        _settled_fold(txn, path, rows, max_age_seconds=max_age_seconds)
        return txn.append_declared_jsonl(
            path,
            row,
            expected_surface="next_cycle_queue",
        )


REOFFERED = "reoffered"
REOFFER_ALREADY_PENDING = "already_pending"
REOFFER_NEVER_QUEUED = "never_queued"
REOFFER_QUEUE_FULL = "queue_full"


def reoffer_item(
    base_dir: str | Path | None,
    *,
    queue_item_id: str,
    reason: str,
) -> str:
    """Make a consumed item pending again; ``REOFFERED`` or why it was not.

    ARIA-HIGH-360 — the autonomy orchestrator consumes an item when it mints
    the item's request, so a request that expired unclaimed left nothing to
    re-offer it and the work was lost. The anchor-stale disposition puts the
    item back; the orchestrator's projection then sees the dead request and
    mints its successor under its own remint budget. ``fold_queue`` reads an
    item as its FIRST pending row (the enqueue), so this row carries only the
    transition; it is the item's new offer.

    ``REOFFER_ALREADY_PENDING`` is the item's pressure already offered: by
    this item (a sweep that re-offered it and crashed before recording that
    finds it so, review of PR #1825) or by a live sibling of the same
    pressure (ARIA-MEDIUM-428: re-offering it anyway was how one pressure
    came to hold eight depth slots). Either way the work is where the caller
    wants it. The caller hands the work to the operator only for
    ``REOFFER_NEVER_QUEUED`` and ``REOFFER_QUEUE_FULL``.
    """
    path = queue_path(base_dir)
    max_age_seconds = item_max_age_seconds(base_dir)
    with state_transaction([path]) as txn:
        rows = load_declared_jsonl(path, expected_surface="next_cycle_queue")
        mine = [row for row in rows if str(row.get("queue_item_id") or "") == queue_item_id]
        if not any(row.get("state") == "pending" for row in mine):
            return REOFFER_NEVER_QUEUED
        live = _settled_fold(txn, path, rows, max_age_seconds=max_age_seconds).live
        pressure_id = next(row for row in mine if row.get("state") == "pending").get("pressure_id")
        if any(
            row.get("queue_item_id") == queue_item_id
            or (pressure_id and row.get("pressure_id") == pressure_id)
            for row in live
        ):
            return REOFFER_ALREADY_PENDING
        if len(live) >= queue_depth():
            return REOFFER_QUEUE_FULL
        txn.append_declared_jsonl(
            path,
            {
                "schema_version": 1,
                "queue_item_id": queue_item_id,
                "state": "pending",
                "reoffered_reason": reason,
                "recorded_at": utc_now(),
            },
            expected_surface="next_cycle_queue",
        )
        return REOFFERED


def defer_projection(
    base_dir: str | Path | None,
    *,
    queue_item_id: str,
    reason: str,
    budget: int,
) -> int | None:
    """Keep a pending item pending for one more drain; the deferral's ordinal, or ``None`` past ``budget``.

    ARIA-HIGH-384 review — the drain leaves an item pending when the host
    could not verify its evidence (the law's harness-class refusal, or an I/O
    fault of the projection). Unbounded, an item whose host fault is
    permanent sat in a queue-depth slot forever. Each deferral is a
    ``state=pending`` row carrying ``deferred_reason`` (the item stays
    pending; ``fold_queue`` reads it as its first row), so the count
    lives in the queue's own ledger and is read under the same transaction
    that appends it. Past ``budget`` nothing is written: the caller consumes
    the item and discloses it.
    """
    path = queue_path(base_dir)
    with state_transaction([path]) as txn:
        rows = load_declared_jsonl(path, expected_surface="next_cycle_queue")
        prior = sum(
            1 for row in rows
            if str(row.get("queue_item_id") or "") == queue_item_id and row.get("deferred_reason")
        )
        if prior >= budget:
            return None
        txn.append_declared_jsonl(
            path,
            {
                "schema_version": 1,
                "queue_item_id": queue_item_id,
                "state": "pending",
                "deferred_reason": reason,
                "recorded_at": utc_now(),
            },
            expected_surface="next_cycle_queue",
        )
        return prior + 1
