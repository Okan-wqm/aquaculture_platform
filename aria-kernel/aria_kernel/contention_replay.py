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
import hashlib
from pathlib import Path
import re
from typing import Any

from .ledger import (
    LedgerIntegrityError,
    StateTransaction,
    _load_jsonl_stored_verified,
    _load_jsonl_stored_verified_text,
    _make_replay_transport_row,
    _replay_logical_payload_from_stored,
    _replay_payload_sha256,
    _replay_transport_metadata,
    append_declared_jsonl,
    state_transaction,
)
from .state_manifest import (
    normalize_surface_relative_path,
    surface_by_name,
    surface_for_path,
    surface_for_relative_path,
    surface_key_name,
)

# The two fields the chain owns. A replayed row is re-chained onto its new
# predecessor, so these are recomputed rather than carried: a copied
# `ledger_hash` would describe a predecessor the row no longer has, producing a
# file that looks valid to a naive reader and fails the real verifier.
_CHAIN_FIELDS = ("ledger_hash", "previous_ledger_hash")
_LEDGER_EVENT_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_REPLAY_TRANSACTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_DUAL_CHAIN_SURFACES = frozenset({
    "kg_conventions",
    "kg_anti_patterns",
    "kg_pressure_source_effectiveness",
    "kg_duel_ratings",
    "kg_embeddings",
})
_ProducerIdentity = tuple[str, str | None, str, dict[str, Any]]


class ReplayRefusal(RuntimeError):
    """The trees do not share the base, so no append-only replay is honest."""


@dataclass(frozen=True)
class ReplayResult:
    replayed_rows: int
    per_surface: dict[str, int] = field(default_factory=dict)
    deduplicated_per_surface: dict[str, int] = field(default_factory=dict)


def _declared_surface_instance(
    path: Path,
    *,
    expected_surface: str,
) -> str | None:
    try:
        match = surface_for_path(path)
    except ValueError as exc:
        raise ReplayRefusal("replay_surface_instance_ambiguous") from exc
    if match is None:
        return None
    surface, root = match
    if surface.name != expected_surface:
        raise ReplayRefusal("replay_surface_instance_mismatch")
    try:
        relative = path.resolve().relative_to(root.resolve()).as_posix()
        return normalize_surface_relative_path(relative)
    except (ValueError, OSError) as exc:
        raise ReplayRefusal("replay_surface_instance_invalid") from exc


def _validate_surface_specs(
    surfaces: dict[str, dict[str, Any]],
) -> dict[str, str]:
    instances: dict[str, str] = {}
    seen_paths: dict[Path, tuple[str, str]] = {}
    for name, spec in surfaces.items():
        winner_path = Path(spec["winner_path"]).resolve()
        loser_path = Path(spec["loser_path"]).resolve()
        for role, path in (("winner", winner_path), ("loser", loser_path)):
            previous = seen_paths.get(path)
            if previous is not None:
                raise ReplayRefusal(
                    "replay_surface_path_alias:"
                    f"{previous[0]}:{previous[1]}:{name}:{role}"
                )
            seen_paths[path] = (name, role)

    for name, spec in surfaces.items():
        expected_surface = surface_key_name(name)
        winner_path = Path(spec["winner_path"]).resolve()
        loser_path = Path(spec["loser_path"]).resolve()
        candidates: list[str] = []
        if ":" in name:
            try:
                candidates.append(
                    normalize_surface_relative_path(name.split(":", 1)[1])
                )
            except ValueError as exc:
                raise ReplayRefusal("replay_surface_instance_invalid") from exc
        supplied = spec.get("relative_path")
        if supplied is not None:
            try:
                candidates.append(normalize_surface_relative_path(supplied))
            except ValueError as exc:
                raise ReplayRefusal("replay_surface_instance_invalid") from exc
        for path in (winner_path, loser_path):
            concrete = _declared_surface_instance(
                path,
                expected_surface=expected_surface,
            )
            if concrete is not None:
                candidates.append(concrete)
        if not candidates:
            declared = surface_by_name(expected_surface)
            if "*" in declared.path_pattern:
                raise ReplayRefusal("replay_surface_instance_unbound")
            candidates.append(
                normalize_surface_relative_path(declared.path_pattern)
            )
        if len(set(candidates)) != 1:
            raise ReplayRefusal("replay_surface_instance_mismatch")
        instance = candidates[0]
        try:
            owner = surface_for_relative_path(instance)
        except ValueError as exc:
            raise ReplayRefusal("replay_surface_instance_ambiguous") from exc
        if owner is None or owner.name != expected_surface:
            raise ReplayRefusal("replay_surface_instance_mismatch")
        instances[name] = instance
    return instances


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


def replay_logical_payload(row: dict[str, Any]) -> dict[str, Any]:
    """Return producer content without the current ledger chain fields.

    Shared verified readers unwrap replay transport before invoking ordinary
    consumers, including state replay verification.  Raw envelope access is
    deliberately confined to this module's contention internals.
    """

    return {
        key: value
        for key, value in row.items()
        if key not in _CHAIN_FIELDS
    }


def _validate_transaction_identity(value: str | None) -> str:
    if not isinstance(value, str) or not _REPLAY_TRANSACTION_ID.fullmatch(value):
        raise ReplayRefusal("replay_transaction_identity_missing")
    return value


def _transport_metadata(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> dict[str, Any] | None:
    try:
        return _replay_transport_metadata(
            row,
            expected_surface=expected_surface,
        )
    except LedgerIntegrityError as exc:
        raise ReplayRefusal(str(exc)) from exc


def _producer_event_identity(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> str:
    origin = _transport_metadata(row, expected_surface=expected_surface)
    candidate = (
        origin["producer_event_id"]
        if origin is not None
        else row.get("ledger_hash")
    )
    if not isinstance(candidate, str) or not _LEDGER_EVENT_ID.fullmatch(candidate):
        raise ReplayRefusal("replay_producer_event_identity_missing")
    return candidate


def _producer_previous_ledger_hash(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> str | None:
    origin = _transport_metadata(row, expected_surface=expected_surface)
    candidate = (
        origin["producer_previous_ledger_hash"]
        if origin is not None
        else row.get("previous_ledger_hash")
    )
    if candidate is None:
        return None
    if not isinstance(candidate, str) or not _LEDGER_EVENT_ID.fullmatch(candidate):
        raise ReplayRefusal("replay_producer_previous_identity_invalid")
    return candidate


def _logical_payload(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> dict[str, Any]:
    try:
        return _replay_logical_payload_from_stored(
            row,
            expected_surface=expected_surface,
        )
    except LedgerIntegrityError as exc:
        raise ReplayRefusal(str(exc)) from exc


def _transport_row(
    row: dict[str, Any],
    *,
    expected_surface: str,
    surface_instance: str,
    replay_transaction_id: str,
) -> dict[str, Any]:
    try:
        return _make_replay_transport_row(
            _logical_payload(row, expected_surface=expected_surface),
            expected_surface=expected_surface,
            surface_instance=surface_instance,
            producer_event_id=_producer_event_identity(
                row,
                expected_surface=expected_surface,
            ),
            producer_previous_ledger_hash=_producer_previous_ledger_hash(
                row,
                expected_surface=expected_surface,
            ),
            replay_transaction_id=replay_transaction_id,
        )
    except LedgerIntegrityError as exc:
        raise ReplayRefusal(str(exc)) from exc


def _replay_identity(
    metadata: dict[str, Any],
) -> tuple[str, str, str | None, str, dict[str, Any]]:
    return (
        metadata["replay_transaction_id"],
        metadata["producer_event_id"],
        metadata["producer_previous_ledger_hash"],
        metadata["payload_sha256"],
        metadata["producer_payload"],
    )


def _producer_identity(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> _ProducerIdentity:
    payload = _logical_payload(row, expected_surface=expected_surface)
    return (
        _producer_event_identity(row, expected_surface=expected_surface),
        _producer_previous_ledger_hash(row, expected_surface=expected_surface),
        _replay_payload_sha256(payload),
        payload,
    )


def _producer_identity_map(
    rows: list[dict[str, Any]],
    *,
    expected_surface: str,
) -> dict[str, tuple[int, _ProducerIdentity]]:
    identities: dict[str, tuple[int, _ProducerIdentity]] = {}
    for position, row in enumerate(rows):
        identity = _producer_identity(row, expected_surface=expected_surface)
        if identity[0] in identities:
            raise ReplayRefusal("replay_producer_event_identity_ambiguous")
        identities[identity[0]] = (position, identity)
    return identities


def _drop_existing_producer_events(
    winner_identities: dict[
        str,
        tuple[int, _ProducerIdentity],
    ],
    loser_suffix: list[dict[str, Any]],
    *,
    expected_surface: str,
) -> tuple[list[dict[str, Any]], int]:
    matches: list[tuple[int, int]] = []
    for loser_position, row in enumerate(loser_suffix):
        identity = _producer_identity(row, expected_surface=expected_surface)
        winner_match = winner_identities.get(identity[0])
        if winner_match is None:
            continue
        winner_position, winner_identity = winner_match
        if winner_identity != identity:
            raise ReplayRefusal("replay_producer_event_payload_mismatch")
        matches.append((loser_position, winner_position))
    if not matches:
        return loser_suffix, 0
    if len(matches) == len(loser_suffix):
        winner_positions = [winner for _loser, winner in matches]
        if winner_positions != list(
            range(winner_positions[0], winner_positions[0] + len(matches))
        ):
            raise ReplayRefusal("replay_producer_event_ordering_ambiguous")
        return [], len(matches)
    prefix_length = len(matches)
    if matches != [(position, position) for position in range(prefix_length)]:
        raise ReplayRefusal("replay_producer_event_ordering_ambiguous")
    # Both lanes independently extended the recorded base by this exact
    # contiguous producer prefix. Treat that prefix as an implicit longer
    # common base; replaying it again would make one source identity ambiguous.
    return loser_suffix[prefix_length:], prefix_length


def _drop_already_replayed(
    winner_suffix: list[dict[str, Any]],
    loser_suffix: list[dict[str, Any]],
    *,
    winner_identities: dict[str, tuple[int, _ProducerIdentity]],
    expected_surface: str,
    surface_instance: str,
    replay_transaction_id: str,
) -> list[dict[str, Any]]:
    """Drop one complete occurrence durably marked as this replay operation.

    Replay is not idempotent by construction, and it took a failing test to
    make that visible: after a successful replay the winner holds the loser's
    rows, but the loser's own file is unchanged, so a second call against the
    SAME base extracts the same suffix and appends it again. The base advances
    only when the lane re-snapshots and re-publishes, so a retry between those
    two points would duplicate every replayed row.

    Payload equality is not identity: two producers can append the same event
    content after different predecessors. A prior replay is proven only by the
    producer's original chained event id, this durable recovery transaction id,
    and the exact logical payload digest carried on every replayed row. The
    occurrence need not remain at the tail because an ordinary writer can
    append after a crashed replay releases its locks and before recovery retry.
    Any partial, reordered, or conflicting occurrence fails closed.
    """
    if not loser_suffix:
        return []
    expected = [
        _replay_identity(_transport_row(
            loser_row,
            expected_surface=expected_surface,
            surface_instance=surface_instance,
            replay_transaction_id=replay_transaction_id,
        ))
        for loser_row in loser_suffix
    ]
    expected_by_event = {
        identity[1]: identity
        for identity in expected
    }
    relevant: list[
        tuple[int, tuple[str, str, str | None, str, dict[str, Any]]]
    ] = []
    for index, winner_row in enumerate(winner_suffix):
        winner_origin = _transport_metadata(
            winner_row,
            expected_surface=expected_surface,
        )
        if (
            winner_origin is None
            or winner_origin["replay_transaction_id"]
            != replay_transaction_id
        ):
            continue
        identity = _replay_identity(winner_origin)
        expected_identity = expected_by_event.get(identity[1])
        if expected_identity is None:
            raise ReplayRefusal("replay_event_identity_ambiguous")
        if identity != expected_identity:
            raise ReplayRefusal("replay_event_payload_mismatch")
        relevant.append((index, identity))

    if not relevant:
        return loser_suffix
    relevant_by_event = {
        identity[1]: (position, identity)
        for position, identity in relevant
    }
    expected_replayed: list[
        tuple[str, str, str | None, str, dict[str, Any]]
    ] = []
    for identity in expected:
        replayed_match = relevant_by_event.get(identity[1])
        if replayed_match is not None:
            expected_replayed.append(identity)
            continue
        winner_match = winner_identities.get(identity[1])
        producer_identity = (
            identity[1],
            identity[2],
            identity[3],
            identity[4],
        )
        if winner_match is None or winner_match[1] != producer_identity:
            raise ReplayRefusal("replay_event_identity_partial")
    positions = [position for position, _identity in relevant]
    identities = [identity for _position, identity in relevant]
    if (
        identities != expected_replayed
        or positions != list(range(positions[0], positions[0] + len(relevant)))
    ):
        raise ReplayRefusal("replay_event_ordering_ambiguous")
    return []


def replay_append_only_suffixes(
    *,
    surfaces: dict[str, dict[str, Any]],
    transaction: StateTransaction | None = None,
    replay_transaction_id: str | None = None,
) -> ReplayResult:
    """Append the loser's suffix onto the winner's file, for every surface.

    ``surfaces`` maps a declared surface name to
    ``{winner_path, loser_path, base_row_count, base_tail_hash}``.

    ALL-OR-NOTHING. Every surface's suffix is extracted and every prefix proven
    BEFORE a single row is written. A replay that refused halfway would leave a
    tree neither lane ever held and no snapshot would describe it — which is the
    absorbing state this whole wave exists to make unreachable.
    """
    transaction_id = _validate_transaction_identity(replay_transaction_id)
    surface_instances = _validate_surface_specs(surfaces)
    if transaction is None:
        # The public convenience path must own the same lock window as an
        # encompassing state-store transaction.  Lock both sides before the
        # idempotency plan is derived: locking only each eventual append lets
        # two retries both observe an empty winner suffix and then serialize
        # two identical transport rows.
        replay_paths = {
            Path(spec[path_key])
            for spec in surfaces.values()
            for path_key in ("winner_path", "loser_path")
        }
        if not replay_paths:
            return ReplayResult(replayed_rows=0, per_surface={})
        with state_transaction(replay_paths) as owned_transaction:
            return replay_append_only_suffixes(
                surfaces=surfaces,
                transaction=owned_transaction,
                replay_transaction_id=transaction_id,
            )

    planned: list[tuple[str, Path, list[dict[str, Any]]]] = []
    deduplicated_per_surface: dict[str, int] = {}
    for name, spec in surfaces.items():
        expected_surface = surface_key_name(name)
        surface_instance = surface_instances[name]
        winner_path = Path(spec["winner_path"])
        loser_path = Path(spec["loser_path"])
        base_row_count = int(spec["base_row_count"])
        base_tail_hash = spec.get("base_tail_hash")

        try:
            winner_rows = (
                _load_jsonl_stored_verified(
                    winner_path,
                    expected_surface=expected_surface,
                    expected_surface_instance=surface_instance,
                )
                if winner_path.exists()
                else []
            )
            loser_content = spec.get("loser_attested_content")
            if loser_content is None:
                loser_rows = (
                    _load_jsonl_stored_verified(
                        loser_path,
                        expected_surface=expected_surface,
                        expected_surface_instance=surface_instance,
                    )
                    if loser_path.exists()
                    else []
                )
            else:
                expected_size = spec.get("loser_expected_size")
                expected_sha256 = spec.get("loser_expected_sha256")
                if (
                    not isinstance(loser_content, (bytes, bytearray))
                    or not isinstance(expected_size, int)
                    or isinstance(expected_size, bool)
                    or expected_size < 0
                    or not isinstance(expected_sha256, str)
                    or len(expected_sha256) != 64
                    or len(loser_content) != expected_size
                    or hashlib.sha256(loser_content).hexdigest()
                    != expected_sha256
                ):
                    raise ReplayRefusal("replay_loser_attestation_mismatch")
                try:
                    loser_text = loser_content.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise ReplayRefusal("replay_loser_encoding_invalid") from exc
                loser_rows = _load_jsonl_stored_verified_text(
                    loser_text,
                    source=loser_path,
                    expected_surface=expected_surface,
                    expected_surface_instance=surface_instance,
                )
        except LedgerIntegrityError as exc:
            raise ReplayRefusal(str(exc)) from exc

        # Both sides, against the same base. The winner is not exempt.
        winner_suffix = append_only_suffix(
            winner_rows, base_row_count=base_row_count, base_tail_hash=base_tail_hash
        )
        suffix = append_only_suffix(
            loser_rows, base_row_count=base_row_count, base_tail_hash=base_tail_hash
        )
        winner_identities = _producer_identity_map(
            winner_suffix,
            expected_surface=expected_surface,
        )
        _producer_identity_map(
            suffix,
            expected_surface=expected_surface,
        )
        suffix = _drop_already_replayed(
            winner_suffix,
            suffix,
            winner_identities=winner_identities,
            expected_surface=expected_surface,
            surface_instance=surface_instance,
            replay_transaction_id=transaction_id,
        )
        suffix, deduplicated = _drop_existing_producer_events(
            winner_identities,
            suffix,
            expected_surface=expected_surface,
        )
        if deduplicated:
            deduplicated_per_surface[name] = deduplicated
        if name in _DUAL_CHAIN_SURFACES and winner_suffix and suffix:
            raise ReplayRefusal(
                f"dual_chain_semantic_merge_required:{name}"
            )
        if suffix:
            planned.append((name, winner_path, suffix))

    per_surface: dict[str, int] = {}
    total = 0
    for name, winner_path, suffix in planned:
        for row in suffix:
            # `name` may be a glob fan-out key (`surface:relative/path`); the
            # declared-surface gate speaks manifest names (ORPHAN-HIGH-555).
            expected_surface = surface_key_name(name)
            payload = _transport_row(
                row,
                expected_surface=expected_surface,
                surface_instance=surface_instances[name],
                replay_transaction_id=transaction_id,
            )
            if transaction is None:
                append_declared_jsonl(
                    winner_path,
                    payload,
                    expected_surface=expected_surface,
                )
            else:
                transaction.append_declared_jsonl(
                    winner_path,
                    payload,
                    expected_surface=expected_surface,
                )
        per_surface[name] = len(suffix)
        total += len(suffix)
    return ReplayResult(
        replayed_rows=total,
        per_surface=per_surface,
        deduplicated_per_surface=deduplicated_per_surface,
    )


__all__ = [
    "ReplayRefusal",
    "ReplayResult",
    "append_only_suffix",
    "replay_logical_payload",
    "replay_append_only_suffixes",
]
