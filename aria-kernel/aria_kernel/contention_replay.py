"""Rebuild the loser of a publish race onto the winner's tip, deterministically.

PLAN Wave 1 PR 2.6. `publish_state` pushes to a fast-forward-only branch, so
the push IS the compare-and-swap: when two lanes publish from the same tip the
server rejects the second. Today that refusal ends the story — the commit rolls
back, the rows stay staged, and the caller is told to fetch and rebuild by
hand.

Rebuilding is deterministic, so it should not be by hand. Both lanes' ledgers
are the same base plus their own append-only suffix; replaying the loser's
suffix onto the winner's tip yields a state containing both lanes' work. The
resolution is NOT a git merge — a hash-chained JSONL file has no meaningful
textual merge, and `-X ours`/`-X theirs` would silently drop one lane's rows.

THE COMMON PREFIX IS PROVEN, NOT ASSUMED. Every row carries a `ledger_hash`
computed over the whole chain behind it, and the snapshot both lanes published
from records each surface's `row_count` and `tail_ledger_hash`. So "these two
files share the first N rows" is exactly answerable: the row at index N-1 must
carry the base's tail hash in BOTH files. A match there implies the entire
prefix matches — that is what a hash chain is for. Anything else is a rewrite
wearing an append's clothes, and it is refused rather than merged.

WHY THE WINNER IS CHECKED TOO. It would be easy to trust the winner because it
won. But "won the push" only means it got there first; it says nothing about
whether its tree descends from the base. Checking only the loser would let a
lane that rewrote its own history absorb the loser's rows into a chain neither
of them shares.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, read_jsonl
from .state_manifest import surface_key_name

# The two fields the chain owns. A replayed row is re-chained onto its new
# predecessor, so these are recomputed rather than carried: a copied
# `ledger_hash` would describe a predecessor the row no longer has, producing a
# file that looks valid to a naive reader and fails the real verifier.
_CHAIN_FIELDS = ("ledger_hash", "previous_ledger_hash")


class ReplayRefusal(RuntimeError):
    """The trees do not share the base, so no append-only replay is honest."""


@dataclass(frozen=True)
class ReplayResult:
    replayed_rows: int
    per_surface: dict[str, int] = field(default_factory=dict)


def append_only_suffix(
    rows: list[dict[str, Any]],
    *,
    base_row_count: int,
    base_tail_hash: str | None,
) -> list[dict[str, Any]]:
    """The rows this tree added beyond the base — or a refusal.

    ``base_row_count == 0`` means the base held nothing for this surface, so
    everything present is suffix and there is no prefix to prove.
    """
    if base_row_count < 0:
        raise ReplayRefusal(f"replay_base_row_count_negative: {base_row_count}")
    if base_row_count == 0:
        return list(rows)
    if len(rows) < base_row_count:
        # Rows were REMOVED. Append-only replay has no honest answer for a
        # truncation: the missing rows are not in the suffix and not in the
        # base either, so any result would be a tree neither lane held.
        raise ReplayRefusal(
            f"replay_prefix_truncated: file holds {len(rows)} rows, base recorded "
            f"{base_row_count}"
        )
    anchor = rows[base_row_count - 1].get("ledger_hash")
    if anchor != base_tail_hash:
        raise ReplayRefusal(
            "replay_prefix_diverged: the row at the base's last index carries "
            f"{anchor!r}, base recorded {base_tail_hash!r}; these trees do not share "
            "the base prefix, so this is a rewrite rather than a race"
        )
    return list(rows[base_row_count:])


def _payload(row: dict[str, Any]) -> dict[str, Any]:
    """A row without the two fields the chain owns — its logical content."""
    return {k: v for k, v in row.items() if k not in _CHAIN_FIELDS}


def _drop_already_replayed(
    winner_suffix: list[dict[str, Any]],
    loser_suffix: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Nothing to do when the winner's suffix already ENDS WITH the loser's.

    Replay is not idempotent by construction, and it took a failing test to
    make that visible: after a successful replay the winner holds the loser's
    rows, but the loser's own file is unchanged, so a second call against the
    SAME base extracts the same suffix and appends it again. The base advances
    only when the lane re-snapshots and re-publishes, so a retry between those
    two points would duplicate every replayed row.

    The guard is a TAIL match on logical content, not a set-membership test.
    Two lanes can legitimately emit rows that look alike, and a membership test
    would drop those; requiring the winner's suffix to end with the loser's
    ENTIRE suffix, in order, describes only the state a prior replay produces.
    In practice the rows carry per-cycle identifiers, so even the tail match is
    far stronger than it needs to be — but it is the shape that cannot discard
    a row a second lane genuinely wrote.
    """
    if not loser_suffix or len(winner_suffix) < len(loser_suffix):
        return loser_suffix
    tail = winner_suffix[-len(loser_suffix) :]
    if [_payload(row) for row in tail] == [_payload(row) for row in loser_suffix]:
        return []
    return loser_suffix


def replay_append_only_suffixes(
    *,
    surfaces: dict[str, dict[str, Any]],
) -> ReplayResult:
    """Append the loser's suffix onto the winner's file, for every surface.

    ``surfaces`` maps a declared surface name to
    ``{winner_path, loser_path, base_row_count, base_tail_hash}``.

    ALL-OR-NOTHING. Every surface's suffix is extracted and every prefix proven
    BEFORE a single row is written. A replay that refused halfway would leave a
    tree neither lane ever held and no snapshot would describe it — which is the
    absorbing state this whole wave exists to make unreachable.
    """
    planned: list[tuple[str, Path, list[dict[str, Any]]]] = []
    for name, spec in surfaces.items():
        winner_path = Path(spec["winner_path"])
        loser_path = Path(spec["loser_path"])
        base_row_count = int(spec["base_row_count"])
        base_tail_hash = spec.get("base_tail_hash")

        winner_rows = read_jsonl(winner_path) if winner_path.exists() else []
        loser_rows = read_jsonl(loser_path) if loser_path.exists() else []

        # Both sides, against the same base. The winner is not exempt.
        winner_suffix = append_only_suffix(
            winner_rows, base_row_count=base_row_count, base_tail_hash=base_tail_hash
        )
        suffix = append_only_suffix(
            loser_rows, base_row_count=base_row_count, base_tail_hash=base_tail_hash
        )
        suffix = _drop_already_replayed(winner_suffix, suffix)
        if suffix:
            planned.append((name, winner_path, suffix))

    per_surface: dict[str, int] = {}
    total = 0
    for name, winner_path, suffix in planned:
        for row in suffix:
            # `name` may be a glob fan-out key (`surface:relative/path`); the
            # declared-surface gate speaks manifest names (ORPHAN-HIGH-555).
            append_declared_jsonl(winner_path, _payload(row), expected_surface=surface_key_name(name))
        per_surface[name] = len(suffix)
        total += len(suffix)
    return ReplayResult(replayed_rows=total, per_surface=per_surface)


__all__ = [
    "ReplayRefusal",
    "ReplayResult",
    "append_only_suffix",
    "replay_append_only_suffixes",
]
