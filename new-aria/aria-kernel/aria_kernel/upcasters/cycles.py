"""Plan 024 v3 followup §E (ORPHAN-LOW-057) — cycles.jsonl read-time
upcaster for legacy schema_version=2 rows.

Pre-fix cycles.jsonl rows omitted status (a structural omission, not
silent null). The new schema (E Implementer-A) ships at v3 with status
required. Existing v2 rows on disk MUST NOT be rewritten in place
because aria-tools/integrity_index.json hashes the ledger byte-stream;
mutating historical rows would break the cross-cycle hash chain.

This upcaster runs at READ TIME: load_jsonl callers that want the
v3 shape route through upcast_cycle_row(row) which:
* For schema_version >= 3 rows: returns the row unchanged.
* For schema_version == 2 (or absent) rows: derives status from the
  event field per the canonical mapping {started->started,
  completed->completed, failed->failed, stopped->stopped,
  aborted->aborted}. If event is unrecognized, raises GovernanceError
  (no silent default; legacy rows are limited to a closed event set).

The upcaster is read-only and side-effect-free. It does NOT
re-write the row to disk; that would break the ledger-hash chain.
"""
from __future__ import annotations

from typing import Any

from aria_kernel.tool_registry import GovernanceError


# Canonical legacy event -> v3 status mapping. Closed set: any row whose
# event is not in this dict raises GovernanceError so the operator can
# investigate (ledger snapshots may surface forgotten edge cases that
# silent defaulting would hide).
_LEGACY_EVENT_TO_STATUS: dict[str, str] = {
    "started": "started",
    "completed": "completed",
    "failed": "failed",
    "stopped": "stopped",
    "aborted": "aborted",
}


def upcast_cycle_row(row: dict[str, Any]) -> dict[str, Any]:
    """Return a v3-shaped cycle row.

    v3+ rows pass through unchanged (their status field is the SSoT
    written by the cycle.py writer, not derived). v2 rows (or rows with
    schema_version absent / non-int) are augmented with a status field
    derived from event via the closed _LEGACY_EVENT_TO_STATUS mapping.

    Raises:
        GovernanceError: row is v2 and event is missing or unrecognized.
            The closed-event-set defense surface is intentional; silent
            defaults would hide ledger snapshot recovery bugs.
    """
    schema_version = row.get("schema_version", 1)
    if isinstance(schema_version, int) and schema_version >= 3:
        return row
    event = row.get("event")
    if not isinstance(event, str):
        raise GovernanceError(
            f"cycle_row_upcast_event_missing_or_invalid: row={row!r}"
        )
    status = _LEGACY_EVENT_TO_STATUS.get(event)
    if status is None:
        raise GovernanceError(
            f"cycle_row_upcast_unknown_legacy_event: event={event!r}; "
            f"closed set is {sorted(_LEGACY_EVENT_TO_STATUS)}"
        )
    # Return a NEW dict; do NOT mutate the input (callers may rely on
    # the original row reference for ledger-hash recomputation).
    upcast = dict(row)
    upcast["status"] = status
    return upcast


def upcast_cycle_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Bulk variant. Each row passes through upcast_cycle_row; the
    function preserves order and is side-effect-free."""
    return [upcast_cycle_row(r) for r in rows]


__all__ = ["upcast_cycle_row", "upcast_cycle_rows"]
