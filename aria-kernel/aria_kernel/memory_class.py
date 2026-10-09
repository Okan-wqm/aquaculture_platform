"""ARIA's memory is an append-only log: its past is never rewritten.

WHY (the memory-laws finding, docs/reviews/claude/2026-10-10-aria-memory-laws.md).
ARIA lost what it had learned three ways, and the publish-time gates
(ARIA-HIGH-263) stand only at the end of the road:

- ``state_compact`` rewrote and re-chained ``memory/beliefs.jsonl`` (newest
  row per belief) and ``memory/learning-events.jsonl`` (seven days), moving
  662 of the 700 memory rows ever recorded into archives no memory reader
  opened — 350 beliefs and 350 learning events became 8 and 33;
- a manual "reset ledgers to empty" commit on the state branch
  (01f37e939, 2026-08-31) truncated beliefs (212 rows) and observations
  (30 rows), and an earlier "compaction — kept beliefs" (f5bcb194d) emptied
  learning events and runs;
- the next kernel publish (executor-33604693287-1, 2026-09-02) continued a
  snapshot that claimed those 212 belief rows and published zero.

A gate that fires at snapshot or publish time catches the loss only after
the tree is already built, and it says nothing about the 01f37e939 shape on
the thirty-plus self-learning ledgers beyond ``memory/*``. The writer is
earlier than every one of those roads: every rewrite of a declared ledger —
kernel code, migration, backfill, a test — reaches the disk through
``ledger._rewrite_jsonl_unlocked``.

WHAT. ``refuse_history_rewrite`` is that writer's memory law: a rewrite of
a surface the manifest flags ``memory`` must keep the content of every
recorded row at its position. Appends pass; a byte-idempotent restamp
passes (content the writer re-hashes gets the same hash again); the chain
backfill of an unchained legacy file passes (the chain fields are excluded
from the comparison). A collapse, a prune, an edit, a reorder or a
truncation refuses — ``memory_history_rewrite_refused`` — before a byte is
written.

The memory set is not restated here: ``state_manifest.memory_surfaces()``
is the one derivation (a surface that gains the flag is protected by this
refusal, by compaction's refusal and by the snapshot's shrink check at
once). Two surfaces stay out on purpose because tests fake legacy rows in
them by rewriting history: ``tools_governance`` and
``agent_invocation_requests``.

Size is managed only on reproducible bulk — run envelopes, raw findings,
adapter outputs (``state_compact``) — never by forgetting.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import LedgerIntegrityError, torn_tail_length
from .state_manifest import surface_for_path

REWRITE_REFUSAL = "memory_history_rewrite_refused"
# The fields the writer recomputes while re-chaining: two rewrites that
# agree on content agree on these, so they carry no memory of their own.
_CHAIN_FIELDS = ("ledger_hash", "previous_ledger_hash")


def refuse_history_rewrite(path: Path, rows: list[dict[str, Any]]) -> None:
    """Refuse a rewrite of a memory ledger that changes a recorded row.

    ``rows`` are the rows the writer is about to chain and store. Content is
    compared without the chain fields, which the writer recomputes: a row
    whose content survives at its position gets the same hash again, so an
    accepted rewrite leaves the existing chain byte-identical. Called by
    ``ledger._rewrite_jsonl_unlocked`` under the caller's locks, before the
    first byte is written — a refused rewrite writes nothing.
    """
    match = surface_for_path(path)
    if match is None or not match[0].memory or not path.exists():
        return
    existing = _stored_rows(path)
    if len(rows) < len(existing):
        raise LedgerIntegrityError(
            f"{REWRITE_REFUSAL}: surface={match[0].name!r} would drop "
            f"{len(existing) - len(rows)} of {len(existing)} recorded rows; "
            "memory is append-only"
        )
    for position, (before, after) in enumerate(zip(existing, rows)):
        if _content(before) != _content(after):
            raise LedgerIntegrityError(
                f"{REWRITE_REFUSAL}: surface={match[0].name!r} row {position} "
                "would change (an edit or a reorder); memory is append-only"
            )


def _stored_rows(path: Path) -> list[dict[str, Any]]:
    """The rows on disk, a torn trailing write (ORPHAN-CRITICAL-561) aside."""
    content = path.read_text(encoding="utf-8")
    torn = torn_tail_length(content)
    if torn:
        content = content[: len(content) - torn]
    return [json.loads(line) for line in content.splitlines() if line.strip()]


def _content(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key not in _CHAIN_FIELDS}


__all__ = (
    "REWRITE_REFUSAL",
    "refuse_history_rewrite",
)
