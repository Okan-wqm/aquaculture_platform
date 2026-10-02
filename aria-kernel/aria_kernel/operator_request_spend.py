"""ADR-0018 D3 — an operator request is spent once, computed at ingestion.

WHY. Request rows are append-only and their ``status`` stays
``unaddressed`` forever, so before this rule every cycle re-admitted the same
request at priority 0: it outranked every other source indefinitely and the
operator could not tell an answered request from a pending one. Marking the
row "addressed" would need a writer for an operator-signed row, which is the
authority the signature exists to deny the runner.

WHAT. Spent is derived from the two hash-chained ledgers the kernel already
writes, never from the request row:

* ``consumed_by_started_plan`` — a ``synthesis_bound`` row consumed the
  request AND its ``plan_content_hash`` equals some ``plan_started``
  ``content_hash`` in ``plans/events.jsonl`` (the join the pre-merge
  observer walks). A binding whose plan never started (the cycle died
  between synthesis and start) does not spend the request; it is admitted
  again next cycle.
* ``refused`` — a ``request_refused`` row names it (the target was not a
  plan ground; :data:`REQUEST_REFUSAL_REASONS`).

An abandoned or HUMAN_REQUIRED plan leaves its request spent: each retry is
a new signed operator act, never a silent loop. Functions here are pure over
rows the caller read; the ledger I/O stays with
``operator_feedback_ingestion``.
"""
from __future__ import annotations

from typing import Any, Iterable

from .finding_grounding import ADMISSION_REASONS

SYNTHESIS_BOUND_ROW_TYPE = "synthesis_bound"
REQUEST_REFUSED_ROW_TYPE = "request_refused"
SPENT_CONSUMED = "consumed_by_started_plan"
SPENT_REFUSED = "refused"
# A request whose finding passed admission but whose plan content could not
# be built (the request text sanitised to nothing) is refused under this
# name; every other refusal is an admission reason.
REQUEST_TEXT_UNUSABLE = "request_text_unusable"
REQUEST_REFUSAL_REASONS: tuple[str, ...] = (*ADMISSION_REASONS, REQUEST_TEXT_UNUSABLE)


def request_key(row: dict[str, Any]) -> tuple[str, str] | None:
    """``(id, ledger_hash)`` — a request's identity on the ledger, or None."""
    identifier, ledger_hash = row.get("id"), row.get("ledger_hash")
    if isinstance(identifier, str) and identifier and isinstance(ledger_hash, str) and ledger_hash:
        return identifier, ledger_hash
    return None


def started_plan_hashes(plan_events: Iterable[dict[str, Any]]) -> frozenset[str]:
    """Every ``plan_started`` content hash the plan ledger holds."""
    hashes: set[str] = set()
    for event in plan_events:
        if event.get("event_type") != "plan_started":
            continue
        payload = event.get("payload")
        value = payload.get("content_hash") if isinstance(payload, dict) else None
        if isinstance(value, str) and value:
            hashes.add(value)
    return frozenset(hashes)


def spent_requests(
    *, ingestion_rows: Iterable[dict[str, Any]], started_hashes: frozenset[str],
) -> dict[tuple[str, str], str]:
    """``(id, ledger_hash) -> spend reason`` for every spent request."""
    spent: dict[tuple[str, str], str] = {}
    for row in ingestion_rows:
        row_type = row.get("row_type")
        if row_type == REQUEST_REFUSED_ROW_TYPE:
            # The refusal row's own ``ledger_hash`` is its chain position; the
            # request it spends is named by ``request_ledger_hash``.
            key = request_key({"id": row.get("id"), "ledger_hash": row.get("request_ledger_hash")})
            if key is not None:
                spent[key] = SPENT_REFUSED
        elif row_type == SYNTHESIS_BOUND_ROW_TYPE and row.get("plan_content_hash") in started_hashes:
            for entry in row.get("consumed") or []:
                key = request_key(entry) if isinstance(entry, dict) else None
                if key is not None:
                    spent.setdefault(key, SPENT_CONSUMED)
    return spent


__all__ = [
    "REQUEST_REFUSAL_REASONS",
    "REQUEST_REFUSED_ROW_TYPE",
    "REQUEST_TEXT_UNUSABLE",
    "SPENT_CONSUMED",
    "SPENT_REFUSED",
    "SYNTHESIS_BOUND_ROW_TYPE",
    "request_key",
    "spent_requests",
    "started_plan_hashes",
]
