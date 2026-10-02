"""ADR-0018 D3 — an operator request is spent once, keyed on its SIGNED id.

WHY. Request rows are append-only and their ``status`` stays ``unaddressed``
forever, so before D3 every cycle re-admitted the same request at priority 0.
Round 1 keyed the spend on ``(id, ledger_hash)``; review round 2
(AISAFETY-HIGH-001, GSEC-MEDIUM-001) showed ``ledger_hash`` is unsigned and
positional — a copy of a spent row at another position, or a forged hash, was
a fresh request. The only identity a signature vouches for is the request
``id`` together with the signed subject.

WHAT. :func:`request_history` reads the kernel's own hash-chained ingestion
ledger (never the feedback ledger, whose rows an appender can add or drop)
and derives, independent of where a row sits in the feedback ledger:

* ``claimed`` — every request id the kernel ever admitted, bound or refused,
  with the digest of the subject it carried (first record wins, in the
  kernel's chain order). A row reusing a claimed id with another subject is
  refused (``request_id_reused``), never admitted and never allowed to spend
  the original;
* ``spent`` — ids consumed by a binding whose plan started
  (``plan_started.content_hash`` join) or named by a ``request_refused`` row.
  A binding whose plan never started does not spend;
* ``reported`` — drop keys already announced, so a row that stays bad is
  reported once, not every cycle (GSEC-LOW-009).

Refusals split in two (arbiter ruling iii): :data:`REQUEST_REFUSAL_REASONS`
are request-intrinsic and spend; runner faults (no anchor, no verifier, no
finding store) are not in the list, so ``record_request_refused`` cannot be
called with one. An abandoned or HUMAN_REQUIRED plan leaves its request spent.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .finding_grounding import INTRINSIC_ADMISSION_REASONS
from .operator_request_terms import TERMS_REASONS

INGESTION_ROW_TYPE = "ingestion"
SYNTHESIS_BOUND_ROW_TYPE = "synthesis_bound"
REQUEST_REFUSED_ROW_TYPE = "request_refused"
SPENT_CONSUMED = "consumed_by_started_plan"
SPENT_REFUSED = "refused"
# A request whose finding passed admission but whose plan content could not
# be built (the request text sanitised to nothing).
REQUEST_TEXT_UNUSABLE = "request_text_unusable"
# Schema refusals of a validly signed row (operator_feedback_signature).
_SIGNED_SCHEMA_REASONS: tuple[str, ...] = ("schema_invalid", "finding_id_missing", "finding_id_invalid")
REQUEST_REFUSAL_REASONS: tuple[str, ...] = (
    *INTRINSIC_ADMISSION_REASONS, REQUEST_TEXT_UNUSABLE, *_SIGNED_SCHEMA_REASONS, *TERMS_REASONS,
)


@dataclass(frozen=True)
class RequestHistory:
    claimed: dict[str, str | None]
    spent: dict[str, str]
    reported: frozenset[str]


def drop_key(row_key: str, reason: str) -> str:
    return f"{row_key}|{reason}"


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


def _claim(claimed: dict[str, str | None], entry: Any) -> str | None:
    if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
        return None
    digest = entry.get("subject_digest")
    claimed.setdefault(entry["id"], digest if isinstance(digest, str) else None)
    return entry["id"]


def request_history(
    *, ingestion_rows: Iterable[dict[str, Any]], started_hashes: frozenset[str],
) -> RequestHistory:
    """Claimed ids, spent ids and reported drops from the hash-chained ingestion ledger."""
    claimed: dict[str, str | None] = {}
    spent: dict[str, str] = {}
    reported: set[str] = set()
    for row in ingestion_rows:
        row_type = row.get("row_type")
        if row_type == INGESTION_ROW_TYPE:
            for entry in row.get("admitted") or []:
                _claim(claimed, entry)
            for entry in row.get("dropped") or []:
                if isinstance(entry, dict) and isinstance(entry.get("row_key"), str):
                    reported.add(drop_key(entry["row_key"], str(entry.get("reason"))))
        elif row_type == REQUEST_REFUSED_ROW_TYPE:
            identifier = _claim(claimed, row)
            if identifier is not None:
                spent[identifier] = SPENT_REFUSED
        elif row_type == SYNTHESIS_BOUND_ROW_TYPE:
            started = row.get("plan_content_hash") in started_hashes
            for entry in row.get("consumed") or []:
                identifier = _claim(claimed, entry)
                if identifier is not None and started:
                    spent.setdefault(identifier, SPENT_CONSUMED)
    return RequestHistory(claimed=claimed, spent=spent, reported=frozenset(reported))


__all__ = [
    "INGESTION_ROW_TYPE",
    "REQUEST_REFUSAL_REASONS",
    "REQUEST_REFUSED_ROW_TYPE",
    "REQUEST_TEXT_UNUSABLE",
    "SPENT_CONSUMED",
    "SPENT_REFUSED",
    "SYNTHESIS_BOUND_ROW_TYPE",
    "RequestHistory",
    "drop_key",
    "request_history",
    "started_plan_hashes",
]
