from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import stat
import sys
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

from .file_lock import ExclusiveLockHandle, with_exclusive_lock
from .state_manifest import (
    normalize_surface_relative_path,
    surface_for_path,
    surface_for_relative_path,
)


__all__ = [
    "LedgerIntegrityError",
    "LedgerReadLimitError",
    "REPLAY_TRANSPORT_SCHEMA_PREFIX",
    "ROW_FORMAT_VERSION",
    "StateTransaction",
    "append_declared_jsonl",
    "append_jsonl",
    "canonical_json",
    "stamp_row_format",
    "file_hash",
    "load_index",
    "load_declared_jsonl",
    "load_jsonl",
    "load_jsonl_verified",
    "load_jsonl_verified_text",
    "json_nesting_within_limit",
    "is_replay_transport_row",
    "verify_jsonl_chunks",
    "read_jsonl",
    "read_jsonl_reverse_verified",
    "rewrite_declared_json",
    "rewrite_declared_jsonl",
    "rewrite_jsonl",
    "state_transaction",
    "tools_index_group_ledgers",
    "verify_index_hashes",
    "verify_jsonl",
    "write_index",
]


class LedgerIntegrityError(RuntimeError):
    pass


class LedgerReadLimitError(RuntimeError):
    """An immutable ledger exceeded an explicit evidence-read budget."""

    pass


def json_nesting_within_limit(content: str, *, max_depth: int = 128) -> bool:
    """Reject pathological JSON nesting before handing input to ``json``.

    CPython's decoder recursion limit is process-global and can change between
    hosts.  Evidence admission instead uses this deterministic lexical bound;
    the JSON decoder remains responsible for every other syntax check.
    Brackets inside strings are ignored, including escaped quotes.
    """
    stack: list[str] = []
    in_string = False
    escaped = False
    pairs = {"}": "{", "]": "["}
    for character in content:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            stack.append(character)
            if len(stack) > max_depth:
                return False
        elif character in "]}":
            if not stack or stack.pop() != pairs[character]:
                return False
    return not stack and not in_string


# ORPHAN-HIGH-552 — the row-format contract, defined ONCE.
#
# Two writers shared every governed ledger and disagreed about its format:
# the appender wrote rows without `schema_version`, and the tools migration
# restamped them to this version and re-chained from the first unstamped row
# onward. The migration runs on every restore (`tools_contract_version` reads
# `repo_identity.json`, which deliberately does not travel on `aria/state`),
# so each night's bind rewrote the rows the previous night appended and moved
# the surface's `tail_ledger_hash` — the one row `append_only_suffix` checks —
# making every cross-restore replay refuse with `replay_prefix_diverged`.
#
# The appender therefore stamps the contract's version itself, from the same
# definition the migration uses. An unstamped row on a declared surface stops
# being possible, and the migration's restamp becomes the identity.
ROW_FORMAT_VERSION = 2

# Contention replay is transport, not producer schema.  A replayed event is
# stored inside this exact envelope so the outer ledger can bind its new chain
# predecessor without adding a field to the producer's payload contract.
_REPLAY_TRANSPORT_SCHEMA = "aria/ledger-replay-transport/v2"
_REPLAY_TRANSPORT_SCHEMA_PREFIX = "aria/ledger-replay-transport/"
REPLAY_TRANSPORT_SCHEMA_PREFIX = _REPLAY_TRANSPORT_SCHEMA_PREFIX
_REPLAY_TRANSPORT_CORE_KEYS = frozenset({
    "$schema",
    "schema_version",
    "surface",
    "surface_instance",
    "producer_event_id",
    "replay_transaction_id",
    "payload_sha256",
    "producer_payload",
})
_REPLAY_TRANSPORT_STORED_KEYS = frozenset({
    *_REPLAY_TRANSPORT_CORE_KEYS,
    "producer_previous_ledger_hash",
    "previous_ledger_hash",
    "ledger_hash",
})
_LEDGER_EVENT_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_REPLAY_TRANSACTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CHAIN_FIELDS = frozenset({"ledger_hash", "previous_ledger_hash"})


def stamp_row_format(row: dict[str, Any]) -> dict[str, Any]:
    """Fill a SILENT row with the format version — never overwrite a spoken one.

    ``schema_version`` belongs to the surface's own payload contract whenever
    the writer states it: ``aria/cost-attribution/v1`` rows carry ``1``,
    mission events carry their contract's number, governance events carry
    ``2``. The ledger format only speaks when the writer said nothing — an
    absent field becomes ``ROW_FORMAT_VERSION``.

    The migration's old rule (``< 2 → 2``) could not tell "legacy row from
    before versioning existed" from "current row whose contract IS v1", and
    the live branch holds fifteen ledgers of the latter (measured 2026-08-05:
    zero rows with the field absent, explicit ``1`` across mission-events,
    plans/events, autonomy_state, agent-invocations, …). Bumping those on
    every restore bind was ORPHAN-HIGH-552 itself for those surfaces — a
    "normalisation" that rewrote correct rows nightly. Both the appender and
    ``migrate_tools_v1_to_v2`` call this one function; a second copy is how
    two formats came to share one file.
    """
    if "schema_version" in row:
        return row
    return {**row, "schema_version": ROW_FORMAT_VERSION}


def _stamped_for_surface(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Stamp only rows bound for a manifest-declared surface.

    The manifest is the boundary of the contract: an arbitrary JSONL path
    (test fixtures, scratch ledgers) is not ARIA's format to rewrite.
    """
    if surface_for_path(path) is None:
        return record
    return stamp_row_format(record)


# Plan 026R §A.1 — Module-level SSoT for indexed-ledger groups.
#
# Two integrity-index groups exist in the kernel today:
# * "tools" group: 4 ledgers at <tools_root>/{runs,health,cycles,governance}.jsonl
#   are tracked by <tools_root>/integrity_index.json.
# * "aria-memory" group: 8 ledgers at <workspace>/aria-memory/{unknowns,
#   missed_signals, external_feedback, pressure, pressure_state,
#   vocabulary_rejections, since_migration_events, governance}.jsonl are tracked
#   by <workspace>/aria-state/integrity_index.json.
#
# `governance.jsonl` appears in BOTH group definitions; routing is by parent-
# directory name (tools group routes when index is co-located with the ledger;
# aria-memory group routes when parent dir name is exactly "aria-memory"). The
# two paths refer to DIFFERENT on-disk files even though the basename collides.
#
# `_lock_requirements_for_path` is the SSoT consumer; future callers (write
# paths, AST invariant tests, verify paths) MUST route through it to determine
# whether an indexed-group lock is needed.
_TOOLS_GROUP_FILENAMES: dict[str, str] = {
    "runs.jsonl": "runs",
    "health.jsonl": "health",
    "cycles.jsonl": "cycles",
    "governance.jsonl": "governance",
}
_TOOLS_GROUP_OPTIONAL_FILENAMES: dict[str, str] = {
    "run-artifacts/artifact-index.jsonl": "runtime_artifact_index",
    "run-artifacts/manifest.jsonl": "runtime_artifact_manifest",
    "retention/events.jsonl": "runtime_retention_events",
    "observability/alerts.jsonl": "runtime_observability_alerts",
    "observability/artifact-inventory.jsonl": "runtime_artifact_inventory",
}
_TOOLS_GROUP_ALL_FILENAMES: dict[str, str] = {
    **_TOOLS_GROUP_FILENAMES,
    **_TOOLS_GROUP_OPTIONAL_FILENAMES,
}
_ARIA_MEMORY_GROUP_FILENAMES: dict[str, str] = {
    "unknowns.jsonl": "unknowns",
    "missed_signals.jsonl": "missed_signals",
    "external_feedback.jsonl": "external_feedback",
    "pressure.jsonl": "pressure",
    "pressure_state.jsonl": "pressure_state",
    "vocabulary_rejections.jsonl": "vocabulary_rejections",
    "since_migration_events.jsonl": "since_migration_events",
    "governance.jsonl": "governance",
}


@dataclass(frozen=True, slots=True)
class LockRequirement:
    """Plan 026R §A.1 — lock requirements for a given ledger path.

    `file_lock_path` is always the path itself (per-file lock on the JSONL
    file's side-car). `index_group_lock_path` is the integrity_index.json
    governing the group, or None when the path is not in any indexed group.
    `ledgers` maps the group's logical name (e.g. "runs") to its absolute
    file path; `None` when no group applies. The lock-order invariant is
    OUTER = `index_group_lock_path`, INNER = `file_lock_path`.
    """

    file_lock_path: Path
    index_group_lock_path: Path | None
    ledgers: dict[str, Path] | None


def _tools_group_root_for_path(path: Path) -> Path | None:
    for root in path.parents:
        if not (root / "integrity_index.json").exists():
            continue
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if relative in _TOOLS_GROUP_ALL_FILENAMES:
            return root
    return None


def tools_index_group_ledgers(root: Path) -> dict[str, Path]:
    """THE membership of the tools ``integrity_index.json`` — sole authority.

    Three parties act on this index and every one of them MUST consume
    this function, or the index eats itself: the grouped refresh
    (``_refresh_adjacent_index_grouped``) REPLACES ``ledger_hashes``
    with exactly this membership on every indexed append, so a full
    rewrite (``update_tools_index``) or a verifier
    (``integrity._index_issues``) working from any WIDER set writes or
    expects entries the next append silently discards — the
    replace-discard defect ORPHAN-HIGH-525 documents. Chain
    verification is the wider net on purpose: ``covered_tool_ledgers``
    derives every declared ledger surface from ``state_manifest`` and
    verifies each file's hash chain; THIS set is only "whose file-hash
    is maintained in the adjacent index on every append", kept small
    because each indexed append re-hashes every member.

    (``state_manifest``'s ``index_group`` column is NOT the authority —
    it has no runtime consumer and its values disagree with the live
    behaviour; its reconciliation is scheduled into the Wave-2 snapshot
    redesign that replaces this index wholesale.)
    """
    ledgers = {
        logical: root / relative
        for relative, logical in _TOOLS_GROUP_FILENAMES.items()
    }
    for relative, logical in _TOOLS_GROUP_OPTIONAL_FILENAMES.items():
        path = root / relative
        if path.exists():
            ledgers[logical] = path
    return ledgers


def _lock_requirements_for_path(path: Path) -> LockRequirement:
    """Plan 026R §A.1 SSoT — return required lock paths for a ledger path.

    Three cases:
    * Tools group member with adjacent `integrity_index.json` → both locks.
    * Aria-memory group member with sibling `aria-state/integrity_index.json`
      → both locks.
    * Anything else → file-lock only.

    Mirrors the routing predicate that the original `_refresh_adjacent_index`
    used (parent dir + sibling existence) so callers + AST invariants always
    derive the same answer.
    """
    tools_root = _tools_group_root_for_path(path)
    if tools_root is not None:
        return LockRequirement(
            file_lock_path=path,
            index_group_lock_path=tools_root / "integrity_index.json",
            ledgers=tools_index_group_ledgers(tools_root),
        )
    if (
        path.parent.name == "aria-memory"
        and path.name in _ARIA_MEMORY_GROUP_FILENAMES
        and (path.parent.parent / "aria-state" / "integrity_index.json").exists()
    ):
        return LockRequirement(
            file_lock_path=path,
            index_group_lock_path=path.parent.parent / "aria-state" / "integrity_index.json",
            ledgers={
                logical: path.parent / fname
                for fname, logical in _ARIA_MEMORY_GROUP_FILENAMES.items()
            },
        )
    return LockRequirement(
        file_lock_path=path,
        index_group_lock_path=None,
        ledgers=None,
    )


@dataclass(frozen=True, slots=True)
class StateTransaction:
    """Lock-bound ledger transaction helper.

    A transaction owns all lock paths returned by
    ``_transaction_lock_paths``. Callers can perform verified reads and
    append hash-chained rows without re-acquiring the same per-file lock.
    Raw secret material must still stay out of records; this primitive is
    an atomicity boundary, not an artifact-safety scrubber.
    """

    paths: frozenset[Path]
    verify_reads: bool = True
    lock_handles: tuple[ExclusiveLockHandle, ...] = ()

    def _canonical_path(self, path: str | Path) -> Path:
        resolved = Path(path).resolve()
        if resolved not in self.paths:
            raise LedgerIntegrityError(
                f"state_transaction_path_not_locked: {resolved.as_posix()}"
            )
        return resolved

    def load_jsonl(
        self,
        path: str | Path,
        *,
        verify: bool | None = None,
        allow_legacy: bool = False,
        legacy_reason: str | None = None,
        expires_at: str | None = None,
        test_fixture: bool = False,
    ) -> list[dict[str, Any]]:
        resolved = self._canonical_path(path)
        use_verify = self.verify_reads if verify is None else verify
        return load_jsonl(
            resolved,
            verify=use_verify,
            allow_legacy=allow_legacy,
            legacy_reason=legacy_reason,
            expires_at=expires_at,
            test_fixture=test_fixture,
        )

    def load_declared_jsonl(
        self,
        path: str | Path,
        *,
        expected_surface: str,
        verify: bool | None = None,
    ) -> list[dict[str, Any]]:
        resolved = self._canonical_path(path)
        use_verify = self.verify_reads if verify is None else verify
        return load_declared_jsonl(
            resolved,
            expected_surface=expected_surface,
            verify=use_verify,
        )

    def append_jsonl(
        self,
        path: str | Path,
        record: dict[str, Any],
        *,
        allow_legacy: bool = False,
        legacy_reason: str | None = None,
        expires_at: str | None = None,
        test_fixture: bool = False,
    ) -> dict[str, Any]:
        resolved = self._canonical_path(path)
        _assert_raw_jsonl_append_allowed(
            resolved,
            allow_legacy=allow_legacy,
            legacy_reason=legacy_reason,
            expires_at=expires_at,
            test_fixture=test_fixture,
        )
        return _append_jsonl_locked_body(
            resolved,
            record,
            held_file_lock_paths=self.paths,
        )

    def append_declared_jsonl(
        self,
        path: str | Path,
        record: dict[str, Any],
        *,
        expected_surface: str,
        bypass_profile_gate: bool = False,
    ) -> dict[str, Any]:
        resolved = self._canonical_path(path)
        _assert_declared_surface(
            resolved,
            expected_surface=expected_surface,
            enforce_write_profile=not bypass_profile_gate,
        )
        return _append_jsonl_locked_body(
            resolved,
            record,
            held_file_lock_paths=self.paths,
        )

    def rewrite_declared_json(
        self,
        path: str | Path,
        payload: dict[str, Any],
        *,
        expected_surface: str,
        bypass_profile_gate: bool = False,
    ) -> None:
        resolved = self._canonical_path(path)
        _assert_declared_surface(
            resolved,
            expected_surface=expected_surface,
            enforce_write_profile=not bypass_profile_gate,
        )
        _atomic_write_text(
            resolved,
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
        )

    def rewrite_jsonl(
        self,
        path: str | Path,
        rows: list[dict[str, Any]],
        *,
        allow_legacy: bool = False,
        legacy_reason: str | None = None,
        expires_at: str | None = None,
        test_fixture: bool = False,
    ) -> None:
        resolved = self._canonical_path(path)
        _assert_raw_jsonl_rewrite_allowed(
            resolved,
            allow_legacy=allow_legacy,
            legacy_reason=legacy_reason,
            expires_at=expires_at,
            test_fixture=test_fixture,
        )
        _rewrite_jsonl_unlocked(
            resolved,
            rows,
            held_file_lock_paths=self.paths,
        )

    def rewrite_declared_jsonl(
        self,
        path: str | Path,
        rows: list[dict[str, Any]],
        *,
        expected_surface: str,
        migration_id: str | None = None,
        bypass_profile_gate: bool = False,
    ) -> None:
        resolved = self._canonical_path(path)
        _assert_declared_surface(
            resolved,
            expected_surface=expected_surface,
            enforce_write_profile=not bypass_profile_gate,
        )
        if migration_id is not None and not str(migration_id).strip():
            raise LedgerIntegrityError("rewrite_declared_jsonl_migration_id_empty")
        _rewrite_jsonl_unlocked(
            resolved,
            rows,
            held_file_lock_paths=self.paths,
        )

    def write_index(
        self,
        index_path: str | Path,
        index: dict[str, Any],
        ledgers: dict[str, Path],
    ) -> None:
        resolved_index = self._canonical_path(index_path)
        resolved_ledgers = {
            name: self._canonical_path(path)
            for name, path in ledgers.items()
        }
        _write_index_unlocked(resolved_index, index, resolved_ledgers)

    def verify_index_hashes(
        self,
        index_path: str | Path,
        ledgers: dict[str, Path],
    ) -> dict[str, Any]:
        resolved_index = self._canonical_path(index_path)
        resolved_ledgers = {
            name: self._canonical_path(path)
            for name, path in ledgers.items()
        }
        return _verify_index_hashes_unlocked(resolved_index, resolved_ledgers)


def _state_group_lock_path(path: Path) -> Path | None:
    match = surface_for_path(path)
    if match is None:
        return None
    surface, base_dir = match
    return base_dir / "locks" / "state-groups" / f"{surface.lock_group}.lock"


def _transaction_group_lock_paths(
    paths: list[Path],
    *,
    group_lock_paths: tuple[Path, ...] | list[Path] | set[Path] = (),
) -> list[Path]:
    group_locks: set[Path] = {
        Path(path).resolve()
        for path in group_lock_paths
    }
    for path in paths:
        group_lock = _state_group_lock_path(path)
        if group_lock is not None:
            group_locks.add(group_lock.resolve())
    return sorted(group_locks, key=lambda path: path.as_posix())


def _transaction_lock_paths(
    paths: list[Path],
    *,
    group_lock_paths: tuple[Path, ...] | list[Path] | set[Path] = (),
) -> list[Path]:
    group_locks = set(
        _transaction_group_lock_paths(
            paths,
            group_lock_paths=group_lock_paths,
        )
    )
    index_locks: set[Path] = set()
    file_locks: set[Path] = set()
    for path in paths:
        req = _lock_requirements_for_path(path)
        if req.index_group_lock_path is not None:
            index_locks.add(req.index_group_lock_path.resolve())
        file_locks.add(req.file_lock_path.resolve())
    ordered: list[Path] = []
    seen: set[Path] = set()
    for bucket in (group_locks, index_locks, file_locks):
        for lock_path in sorted(bucket, key=lambda p: p.as_posix()):
            if lock_path in seen:
                continue
            seen.add(lock_path)
            ordered.append(lock_path)
    return ordered


@contextlib.contextmanager
def state_transaction(
    paths: list[str | Path] | tuple[str | Path, ...] | set[str | Path],
    *,
    verify_reads: bool = True,
    timeout_seconds: float | None = None,
    group_lock_paths: tuple[str | Path, ...] | list[str | Path] | set[str | Path] = (),
) -> Iterator[StateTransaction]:
    """Acquire ordered locks for one or more declared state surfaces.

    Lock order is deterministic across processes: manifest group locks,
    integrity-index locks, then concrete file locks, each sorted by
    absolute path.  Reads default to strict hash-chain verification.
    """
    concrete_paths = [Path(path).resolve() for path in paths]
    if not concrete_paths:
        raise LedgerIntegrityError("state_transaction_requires_paths")
    explicit_group_locks = tuple(Path(path).resolve() for path in group_lock_paths)
    ordered_group_locks = _transaction_group_lock_paths(
        concrete_paths,
        group_lock_paths=explicit_group_locks,
    )
    # Capture declared ownership before a possibly blocking acquisition.  A
    # checkout cleanup can remove the whole tools/workspace authority while a
    # writer waits on its state-group lock.  Re-resolving after the first
    # group lock is acquired prevents the writer from recreating directories
    # under the deleted worktree before discovering that its declared root no
    # longer exists.
    declared_bindings: dict[Path, tuple[str, Path]] = {}
    for concrete_path in concrete_paths:
        match = surface_for_path(concrete_path)
        if match is not None:
            surface, base_dir = match
            declared_bindings[concrete_path] = (
                surface.name,
                base_dir.resolve(),
            )
    lock_paths = _transaction_lock_paths(
        concrete_paths,
        group_lock_paths=explicit_group_locks,
    )
    lock_kwargs: dict[str, Any] = {}
    if timeout_seconds is not None:
        lock_kwargs["timeout_seconds"] = timeout_seconds

    def assert_declared_bindings_unchanged() -> None:
        for concrete_path, expected in declared_bindings.items():
            locked_match = surface_for_path(concrete_path)
            if locked_match is None:
                raise LedgerIntegrityError(
                    "state_transaction_declared_root_changed: "
                    f"path={concrete_path.as_posix()}"
                )
            locked_surface, locked_base = locked_match
            actual = (locked_surface.name, locked_base.resolve())
            if actual != expected:
                raise LedgerIntegrityError(
                    "state_transaction_declared_root_changed: "
                    f"path={concrete_path.as_posix()}"
                )

    with contextlib.ExitStack() as stack:
        lock_handles: list[ExclusiveLockHandle] = []
        for ordinal, lock_path in enumerate(lock_paths):
            try:
                lock_handles.append(
                    stack.enter_context(
                        with_exclusive_lock(lock_path, **lock_kwargs)
                    )
                )
            except OSError:
                # A cleanup may unlink the group sidecar while this waiter has
                # it open.  The lock helper correctly rejects that changed
                # inode.  If the declared authority vanished with it, expose
                # the semantic refusal; otherwise preserve the real I/O fault.
                if ordinal == 0 and ordered_group_locks and declared_bindings:
                    assert_declared_bindings_unchanged()
                raise
            if ordinal == 0 and ordered_group_locks and declared_bindings:
                assert_declared_bindings_unchanged()
        yield StateTransaction(
            frozenset(concrete_paths),
            verify_reads=verify_reads,
            lock_handles=tuple(lock_handles),
        )


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    if path.exists():
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _read_jsonl_stored(path: Path) -> list[dict[str, Any]]:
    """Private byte-shape reader for append/verification/replay internals."""

    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            records.append(json.loads(stripped))
        except (json.JSONDecodeError, RecursionError, ValueError) as exc:
            raise LedgerIntegrityError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
    return records


def read_jsonl(
    path: Path,
    *,
    expected_surface: str | None = None,
) -> list[dict[str, Any]]:
    """Read producer rows, unwrapping exact contention transport records.

    Legacy/hashless scratch JSONL keeps its historical best-effort behaviour.
    Once a transport envelope is present, however, the complete stored chain
    is verified before any producer payload is exposed: unwrapping bytes whose
    outer identity was not proven would let transport metadata become a schema
    bypass.
    """
    if not path.exists():
        return []
    content = path.read_text(encoding="utf-8")
    stored = _parse_jsonl_stored_text(path, content)
    if not any(
        isinstance(row, dict) and _is_replay_transport_candidate(row)
        for row in stored
    ):
        return stored
    result, rows = _verify_jsonl_from_text(
        path,
        content,
        expected_surface=expected_surface,
    )
    if not result.get("valid", False) or result.get("torn_tail_bytes"):
        raise LedgerIntegrityError(
            f"strict verification failed for {path.as_posix()}: "
            f"reason={result.get('reason') or 'immutable_torn_tail'} "
            f"line={result.get('line')}",
        )
    return rows


def read_jsonl_reverse_verified(
    path: Path,
    *,
    expected_surface: str,
    limit: int,
    max_line_bytes: int,
    max_rows: int,
    row_predicate: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    """Verify one physical chain while retaining only its newest logical rows.

    This is the bounded-memory counterpart to :func:`read_jsonl` for callers
    that need a newest-first tail. The descriptor is consumed once in forward
    chain order; no file-sized text or row list is materialized. Transport is
    unwrapped only after each outer hash link and producer identity verifies,
    and no retained payload is returned until EOF has been accepted.
    """
    if not path.exists():
        return []
    retained: deque[dict[str, Any]] = deque(maxlen=max(0, limit))

    def retain(logical: dict[str, Any]) -> None:
        if row_predicate is None or row_predicate(logical):
            retained.append(logical)

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        # A path can be swapped to a FIFO between discovery and this open.
        # Non-blocking open lets the post-open fstat reject it instead of
        # waiting forever for an attacker-controlled writer.
        flags |= os.O_NONBLOCK
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            file_stat = os.fstat(descriptor)
            if not stat.S_ISREG(file_stat.st_mode):
                raise LedgerIntegrityError(
                    f"strict verification failed for {path.as_posix()}: "
                    "reason=ledger_not_regular_file",
                )

            def chunks() -> Iterator[bytes]:
                while chunk := handle.read(65536):
                    yield chunk

            verify_jsonl_chunks(
                chunks(),
                source=path,
                expected_size=file_stat.st_size,
                max_line_bytes=max_line_bytes,
                max_rows=max_rows,
                expected_surface=expected_surface,
                on_row=retain,
            )
    finally:
        os.close(descriptor)
    return list(reversed(retained))


def load_jsonl(
    path: Path,
    *,
    verify: bool | None = False,
    allow_legacy: bool = False,
    legacy_reason: str | None = None,
    expires_at: str | None = None,
    test_fixture: bool = False,
) -> list[dict[str, Any]]:
    """Public ledger loader.

    Plan 026R §F.4 — opt-in strict-read kwarg.

    ``verify=True`` routes through ``load_jsonl_verified`` (full
    hash-chain validation: rejects missing ``ledger_hash``, chain
    mismatch, canonical drift, malformed JSON). ``verify=False``
    preserves legacy read-only semantics for cold-path consumers
    that explicitly want best-effort reads.

    Hot-path consumers (``cycle.py``, ``reflection.py``,
    ``autonomy_state.py``, ``autonomy_orchestrator.py``) MUST opt
    in by passing ``verify=True`` (or call ``load_jsonl_verified``
    directly). An AST invariant in
    ``tests/test_verify_on_read.py`` scans those modules and
    raises if any ``load_jsonl(`` callsite omits the kwarg.
    """
    resolved = Path(path).resolve()
    match = surface_for_path(resolved)
    if match is not None:
        surface, _base_dir = match
        if surface.enterprise_required and surface.strict_read and verify is not True:
            if not _raw_jsonl_legacy_allowed(
                allow_legacy=allow_legacy,
                legacy_reason=legacy_reason,
                expires_at=expires_at,
                test_fixture=test_fixture,
            ):
                # Enterprise strict surfaces are never returned through
                # best-effort reads. Legacy callsites keep working, but
                # the data path is verified until they are migrated to
                # load_declared_jsonl and covered by static invariants.
                verify = True
    if verify:
        return load_jsonl_verified(resolved)
    return read_jsonl(resolved)


def canonical_json(record: dict[str, Any]) -> str:
    """The kernel's ONE canonical JSON encoding for hashed payloads.

    Every hash the kernel chains — ledger row hashes, and the state
    snapshot's ``manifest_root`` — runs through this encoder, so two
    hashes of the same logical content can never disagree over key
    order or separator whitespace. Public because the snapshot builder
    is a second legitimate consumer; a private copy there would be a
    second canonicalizer, which is how hash contracts drift apart.
    """
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _parse_jsonl_stored_text(path: Path, content: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_no, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            records.append(json.loads(stripped))
        except (json.JSONDecodeError, RecursionError, ValueError) as exc:
            raise LedgerIntegrityError(
                f"Invalid JSONL at {path}:{line_no}: {exc}",
            ) from exc
    return records


def _is_replay_transport_candidate(row: dict[str, Any]) -> bool:
    schema = row.get("$schema")
    return (
        isinstance(schema, str)
        and schema.startswith(_REPLAY_TRANSPORT_SCHEMA_PREFIX)
    ) or {
        "producer_event_id",
        "replay_transaction_id",
        "producer_payload",
    }.issubset(row)


def is_replay_transport_row(row: dict[str, Any]) -> bool:
    """Whether a stored row claims the governed contention transport shape."""
    return _is_replay_transport_candidate(row)


def _surface_name_for_path(path: Path) -> str | None:
    try:
        match = surface_for_path(path.resolve())
    except ValueError as exc:
        raise LedgerIntegrityError(
            f"replay_transport_surface_ambiguous:{path.as_posix()}",
        ) from exc
    return match[0].name if match is not None else None


def _surface_instance_for_path(path: Path) -> str | None:
    try:
        match = surface_for_path(path.resolve())
    except ValueError as exc:
        raise LedgerIntegrityError(
            f"replay_transport_surface_ambiguous:{path.as_posix()}",
        ) from exc
    if match is None:
        return None
    _surface, root = match
    try:
        relative = path.resolve().relative_to(root.resolve()).as_posix()
        return normalize_surface_relative_path(relative)
    except (ValueError, OSError) as exc:
        raise LedgerIntegrityError(
            f"replay_transport_surface_instance_invalid:{path.as_posix()}",
        ) from exc


def _replay_payload_sha256(payload: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(
        canonical_json(payload).encode("utf-8"),
    ).hexdigest()


def _validated_replay_transport(
    row: dict[str, Any],
    *,
    expected_surface: str | None,
    expected_surface_instance: str | None = None,
) -> dict[str, Any] | None:
    if not _is_replay_transport_candidate(row):
        return None
    schema = row.get("$schema")
    schema_version = row.get("schema_version")
    if schema == _REPLAY_TRANSPORT_SCHEMA and schema_version == 2:
        expected_keys = _REPLAY_TRANSPORT_STORED_KEYS
    else:
        raise LedgerIntegrityError("replay_transport_version_invalid")
    if set(row) != expected_keys:
        raise LedgerIntegrityError("replay_transport_fields_invalid")
    if type(schema_version) is not int:
        raise LedgerIntegrityError("replay_transport_version_invalid")
    if not isinstance(expected_surface, str) or not expected_surface:
        raise LedgerIntegrityError("replay_transport_surface_unbound")
    if row.get("surface") != expected_surface:
        raise LedgerIntegrityError("replay_transport_surface_mismatch")
    surface_instance = row.get("surface_instance")
    if not isinstance(surface_instance, str):
        raise LedgerIntegrityError("replay_transport_surface_instance_invalid")
    try:
        normalized_instance = normalize_surface_relative_path(surface_instance)
        instance_owner = surface_for_relative_path(normalized_instance)
    except ValueError as exc:
        raise LedgerIntegrityError(
            "replay_transport_surface_instance_invalid"
        ) from exc
    if (
        normalized_instance != surface_instance
        or instance_owner is None
        or instance_owner.name != expected_surface
    ):
        raise LedgerIntegrityError("replay_transport_surface_instance_mismatch")
    if (
        expected_surface_instance is not None
        and surface_instance != expected_surface_instance
    ):
        raise LedgerIntegrityError("replay_transport_surface_instance_mismatch")
    producer_event_id = row.get("producer_event_id")
    replay_transaction_id = row.get("replay_transaction_id")
    if (
        not isinstance(producer_event_id, str)
        or _LEDGER_EVENT_ID.fullmatch(producer_event_id) is None
    ):
        raise LedgerIntegrityError("replay_transport_producer_identity_invalid")
    producer_previous = row.get("producer_previous_ledger_hash")
    if (
        producer_previous is not None
        and (
            not isinstance(producer_previous, str)
            or _LEDGER_EVENT_ID.fullmatch(producer_previous) is None
        )
    ):
        raise LedgerIntegrityError(
            "replay_transport_producer_previous_identity_invalid"
        )
    if (
        not isinstance(replay_transaction_id, str)
        or _REPLAY_TRANSACTION_ID.fullmatch(replay_transaction_id) is None
    ):
        raise LedgerIntegrityError("replay_transport_transaction_identity_invalid")
    payload = row.get("producer_payload")
    if not isinstance(payload, dict):
        raise LedgerIntegrityError("replay_transport_payload_not_object")
    if _CHAIN_FIELDS.intersection(payload):
        raise LedgerIntegrityError("replay_transport_payload_chain_fields_forbidden")
    if _is_replay_transport_candidate(payload):
        raise LedgerIntegrityError("replay_transport_nested_envelope_forbidden")
    if row.get("payload_sha256") != _replay_payload_sha256(payload):
        raise LedgerIntegrityError("replay_transport_payload_hash_mismatch")
    if producer_event_id != _record_hash(payload, producer_previous):
        raise LedgerIntegrityError("replay_transport_producer_identity_mismatch")
    ledger_hash = row.get("ledger_hash")
    previous_hash = row.get("previous_ledger_hash")
    if (
        not isinstance(ledger_hash, str)
        or _LEDGER_EVENT_ID.fullmatch(ledger_hash) is None
        or (
            previous_hash is not None
            and (
                not isinstance(previous_hash, str)
                or _LEDGER_EVENT_ID.fullmatch(previous_hash) is None
            )
        )
    ):
        raise LedgerIntegrityError("replay_transport_outer_chain_invalid")
    return row


def _unwrap_replay_transport_row(
    row: dict[str, Any],
    *,
    expected_surface: str | None,
    expected_surface_instance: str | None = None,
) -> dict[str, Any]:
    envelope = _validated_replay_transport(
        row,
        expected_surface=expected_surface,
        expected_surface_instance=expected_surface_instance,
    )
    if envelope is None:
        return dict(row)
    payload = dict(envelope["producer_payload"])
    payload["previous_ledger_hash"] = envelope["producer_previous_ledger_hash"]
    payload["ledger_hash"] = envelope["producer_event_id"]
    return payload


def _replay_transport_metadata(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> dict[str, Any] | None:
    envelope = _validated_replay_transport(
        row,
        expected_surface=expected_surface,
    )
    if envelope is None:
        return None
    return {
        "producer_event_id": envelope["producer_event_id"],
        "producer_previous_ledger_hash": envelope["producer_previous_ledger_hash"],
        "replay_transaction_id": envelope["replay_transaction_id"],
        "payload_sha256": envelope["payload_sha256"],
        "producer_payload": dict(envelope["producer_payload"]),
    }


def _replay_logical_payload_from_stored(
    row: dict[str, Any],
    *,
    expected_surface: str,
) -> dict[str, Any]:
    envelope = _validated_replay_transport(
        row,
        expected_surface=expected_surface,
    )
    if envelope is not None:
        return dict(envelope["producer_payload"])
    return {key: value for key, value in row.items() if key not in _CHAIN_FIELDS}


def _make_replay_transport_row(
    payload: dict[str, Any],
    *,
    expected_surface: str,
    surface_instance: str,
    producer_event_id: str,
    producer_previous_ledger_hash: str | None,
    replay_transaction_id: str,
) -> dict[str, Any]:
    if not isinstance(expected_surface, str) or not expected_surface:
        raise LedgerIntegrityError("replay_transport_surface_unbound")
    try:
        normalized_instance = normalize_surface_relative_path(surface_instance)
        instance_owner = surface_for_relative_path(normalized_instance)
    except ValueError as exc:
        raise LedgerIntegrityError(
            "replay_transport_surface_instance_invalid"
        ) from exc
    if (
        normalized_instance != surface_instance
        or instance_owner is None
        or instance_owner.name != expected_surface
    ):
        raise LedgerIntegrityError("replay_transport_surface_instance_mismatch")
    if _LEDGER_EVENT_ID.fullmatch(producer_event_id) is None:
        raise LedgerIntegrityError("replay_transport_producer_identity_invalid")
    if (
        producer_previous_ledger_hash is not None
        and _LEDGER_EVENT_ID.fullmatch(producer_previous_ledger_hash) is None
    ):
        raise LedgerIntegrityError(
            "replay_transport_producer_previous_identity_invalid"
        )
    if _REPLAY_TRANSACTION_ID.fullmatch(replay_transaction_id) is None:
        raise LedgerIntegrityError("replay_transport_transaction_identity_invalid")
    producer_payload = dict(payload)
    if _CHAIN_FIELDS.intersection(producer_payload):
        raise LedgerIntegrityError("replay_transport_payload_chain_fields_forbidden")
    if _is_replay_transport_candidate(producer_payload):
        raise LedgerIntegrityError("replay_transport_nested_envelope_forbidden")
    if producer_event_id != _record_hash(
        producer_payload,
        producer_previous_ledger_hash,
    ):
        raise LedgerIntegrityError("replay_transport_producer_identity_mismatch")
    return {
        "$schema": _REPLAY_TRANSPORT_SCHEMA,
        "schema_version": 2,
        "surface": expected_surface,
        "surface_instance": surface_instance,
        "producer_event_id": producer_event_id,
        "producer_previous_ledger_hash": producer_previous_ledger_hash,
        "replay_transaction_id": replay_transaction_id,
        "payload_sha256": _replay_payload_sha256(producer_payload),
        "producer_payload": producer_payload,
    }


def _record_hash(record: dict[str, Any], previous_hash: str | None = None) -> str:
    payload = dict(record)
    payload.pop("ledger_hash", None)
    payload.pop("previous_ledger_hash", None)
    raw = canonical_json({"previous_ledger_hash": previous_hash, "record": payload})
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def heal_torn_tail(path: Path) -> int:
    """Physically remove an incomplete trailing record. Returns bytes removed.

    ORPHAN-CRITICAL-561. Tolerating a torn tail on READ is not enough: the
    append path calls `read_jsonl`, which refuses unparseable content, and the
    chain would stay broken for every future writer. The tail has to go, once,
    under the lock the appender already holds.

    Truncation rather than rewrite: the verified prefix is left byte-identical,
    so no hash is recomputed and no row is touched. `torn_tail_length` is the
    single judge of what counts as torn — a complete-but-unparseable final
    line, or damage anywhere earlier, is left exactly where it is for the
    verifier to refuse.
    """
    if not path.exists():
        return 0
    content = path.read_text(encoding="utf-8")
    torn_bytes = torn_tail_length(content)
    if not torn_bytes:
        return 0
    fd = os.open(str(path), os.O_WRONLY)
    try:
        os.ftruncate(fd, len(content.encode("utf-8")) - len(content[-torn_bytes:].encode("utf-8")))
        os.fsync(fd)
    finally:
        os.close(fd)
    return torn_bytes


def _append_jsonl_locked_body(
    path: Path,
    record: dict[str, Any],
    *,
    held_file_lock_paths: frozenset[Path] | None = None,
) -> dict[str, Any]:
    record = _stamped_for_surface(path, record)
    path.parent.mkdir(parents=True, exist_ok=True)
    _verify_existing_declared_chain_before_append(path)
    # After the verifier accepted the file, heal what it accepted AROUND: the
    # verifier reads past a torn tail, `read_jsonl` below does not, and a
    # writer that appended after one would chain onto a row that is not there.
    heal_torn_tail(path)
    rows = _read_jsonl_stored(path)
    previous_hash = (
        str(rows[-1].get("ledger_hash"))
        if rows and rows[-1].get("ledger_hash")
        else None
    )
    stored = dict(record)
    stored["previous_ledger_hash"] = previous_hash
    stored["ledger_hash"] = _record_hash(stored, previous_hash)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(
            fd,
            (
                json.dumps(stored, sort_keys=True, separators=(",", ":"))
                + "\n"
            ).encode("utf-8"),
        )
        os.fsync(fd)
    finally:
        os.close(fd)
    _refresh_adjacent_index_grouped(
        path,
        held_file_lock_path=path,
        held_file_lock_paths=held_file_lock_paths,
    )
    return stored


def _append_jsonl_unlocked(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Plan 026R §A.1 — internal append helper.

    Caller MUST already hold the per-file lock on ``path`` AND — if
    ``_lock_requirements_for_path(path).index_group_lock_path is not None`` —
    also the index-group lock. The contract is enforced structurally via
    ``_lock_requirements_for_path`` (the public ``append_jsonl`` acquires
    both locks and then calls this helper) and by an AST invariant test
    that scans every callsite under ``aria-kernel/aria_kernel/``.

    Splitting the primitive solves the nested-lock problem for the four
    pre-existing CAS callsites (claim_request, submit_claim_result, plus
    worker_dispatch claim_assignment + release_claim_assignment) which
    already hold the per-file lock and would otherwise re-acquire it on
    every public ``append_jsonl`` call (POSIX flock non-reentrant across
    fds even within a single process under cross-process contention).

    The helper:
      1. Reads the tail to derive the previous hash chain link.
      2. Computes the row's canonical hash (Plan 024 §H-0 evidence chain).
      3. Writes the row + fsyncs the fd (durability — Plan 026R round-6).
      4. Refreshes the adjacent index in held-lock-aware mode (Planner-B
         design — siblings sorted, held file lock skipped to avoid the
         non-reentrant POSIX flock deadlock).

    NO ``prior_hash`` kwarg in v1: a stale prior hash supplied by a caller
    that read the tail outside the lock window would re-corrupt the chain.

    Stale-chain stripping (caught by A.2 strict verify on
    ``memory.py:322``-style ``row = dict(belief)`` re-appends): both
    ``previous_ledger_hash`` and ``ledger_hash`` are always unconditionally
    overwritten with the actual chain values. A caller that passes a row
    dict re-loaded from an earlier ledger entry (carrying its old chain
    hashes) cannot inject those stale values into the new chain link —
    the primitive is the sole authority over chain hash fields.
    """
    return _append_jsonl_locked_body(path, record)


def append_jsonl(
    path: Path,
    record: dict[str, Any],
    *,
    allow_legacy: bool = False,
    legacy_reason: str | None = None,
    expires_at: str | None = None,
    test_fixture: bool = False,
) -> dict[str, Any]:
    """Plan 026R §A.1 — public atomic append primitive.

    Acquires the lock(s) declared by ``_lock_requirements_for_path``:
    index-group lock OUTER, per-file lock INNER. Calls
    ``_append_jsonl_unlocked`` under both locks (CAS callsites that
    already hold the per-file lock use ``_append_jsonl_unlocked``
    directly to avoid POSIX flock re-acquisition).
    """
    resolved = Path(path).resolve()
    _assert_raw_jsonl_append_allowed(
        resolved,
        allow_legacy=allow_legacy,
        legacy_reason=legacy_reason,
        expires_at=expires_at,
        test_fixture=test_fixture,
    )
    with state_transaction([resolved]) as transaction:
        return transaction.append_jsonl(
            resolved,
            record,
            allow_legacy=allow_legacy,
            legacy_reason=legacy_reason,
            expires_at=expires_at,
            test_fixture=test_fixture,
        )


def _reraise_enospc_as_environment(exc: OSError) -> None:
    """E18-b (ORPHAN-695 sibling; lived 2026-08-13) — a full disk during a
    ledger APPEND is an ENVIRONMENT failure, not phase logic. Pre-E18-b
    only the read/verify path classified I/O faults; a mid-run ENOSPC on
    the write side still surfaced as an anonymous phase crash the operator
    had to diagnose from a stack trace. Named here, once, for every
    governed append."""
    import errno as _errno

    from .tool_registry import GovernanceError

    if exc.errno == _errno.ENOSPC:
        raise GovernanceError(
            f"environment_failure:disk_full: ledger append hit ENOSPC "
            f"({exc}); free disk and re-run — the rows already written are "
            f"intact, the chain refuses to advance on a torn write"
        ) from exc
    raise exc


def append_declared_jsonl(
    path: Path,
    record: dict[str, Any],
    *,
    expected_surface: str,
    bypass_profile_gate: bool = False,
) -> dict[str, Any]:
    """Append only when ``path`` is declared in ``state_manifest``.

    Enterprise-governed writers use this instead of the legacy
    ``append_jsonl`` primitive. The manifest check is intentionally before
    the profile gate: an unknown governed path is a configuration error and
    must fail closed rather than falling through to a broad profile label.
    """
    _assert_declared_surface(
        path,
        expected_surface=expected_surface,
        enforce_write_profile=not bypass_profile_gate,
    )
    resolved = Path(path).resolve()
    try:
        with state_transaction([resolved]) as transaction:
            return transaction.append_declared_jsonl(
                resolved,
                record,
                expected_surface=expected_surface,
                bypass_profile_gate=bypass_profile_gate,
            )
    except OSError as exc:
        _reraise_enospc_as_environment(exc)


def _assert_raw_jsonl_append_allowed(
    path: Path,
    *,
    allow_legacy: bool,
    legacy_reason: str | None,
    expires_at: str | None,
    test_fixture: bool,
) -> None:
    match = surface_for_path(path)
    if match is None:
        return
    surface, _base_dir = match
    if not surface.enterprise_required:
        return
    if _raw_jsonl_legacy_allowed(
        allow_legacy=allow_legacy,
        legacy_reason=legacy_reason,
        expires_at=expires_at,
        test_fixture=test_fixture,
    ):
        return
    raise LedgerIntegrityError(
        "raw_jsonl_declared_surface_rejected: "
        f"surface={surface.name!r} path={path.as_posix()} "
        "use append_declared_jsonl(..., expected_surface=...) or pass "
        "an explicit migration/test legacy context"
    )


def _raw_jsonl_legacy_allowed(
    *,
    allow_legacy: bool,
    legacy_reason: str | None,
    expires_at: str | None,
    test_fixture: bool,
) -> bool:
    if test_fixture:
        return True
    if not allow_legacy:
        return False
    if not legacy_reason or not legacy_reason.strip():
        return False
    if not expires_at or not expires_at.strip():
        return False
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc) > datetime.now(timezone.utc)


def rewrite_declared_json(
    path: Path,
    payload: dict[str, Any],
    *,
    expected_surface: str,
    bypass_profile_gate: bool = False,
) -> None:
    """Atomically rewrite a declared JSON surface under manifest authority."""
    _assert_declared_surface(
        path,
        expected_surface=expected_surface,
        enforce_write_profile=not bypass_profile_gate,
    )
    resolved = Path(path).resolve()
    with state_transaction([resolved]) as transaction:
        transaction.rewrite_declared_json(
            resolved,
            payload,
            expected_surface=expected_surface,
            bypass_profile_gate=bypass_profile_gate,
        )


def rewrite_declared_jsonl(
    path: Path,
    rows: list[dict[str, Any]],
    *,
    expected_surface: str,
    migration_id: str | None = None,
    bypass_profile_gate: bool = False,
) -> None:
    """Atomically rewrite a declared JSONL surface under manifest authority.

    This is the only governed rewrite path for enterprise state. The optional
    ``migration_id`` is intentionally explicit: full-ledger rewrites are
    migration/backfill events, not ordinary runtime writes.
    """
    _assert_declared_surface(
        path,
        expected_surface=expected_surface,
        enforce_write_profile=not bypass_profile_gate,
    )
    resolved = Path(path).resolve()
    with state_transaction([resolved]) as transaction:
        transaction.rewrite_declared_jsonl(
            resolved,
            rows,
            expected_surface=expected_surface,
            migration_id=migration_id,
            bypass_profile_gate=bypass_profile_gate,
        )


def load_declared_jsonl(
    path: Path,
    *,
    expected_surface: str,
    verify: bool = True,
) -> list[dict[str, Any]]:
    """Load a declared JSONL surface with strict verification by default."""
    surface, _base_dir = _assert_declared_surface(
        path,
        expected_surface=expected_surface,
        enforce_write_profile=False,
    )
    if surface.strict_read and not verify:
        raise LedgerIntegrityError(
            "declared_jsonl_strict_read_required: "
            f"surface={surface.name!r} path={Path(path).resolve().as_posix()}"
        )
    if verify:
        return load_jsonl_verified(
            Path(path).resolve(),
            expected_surface=expected_surface,
        )
    return read_jsonl(
        Path(path).resolve(),
        expected_surface=expected_surface,
    )


def _assert_declared_surface(
    path: str | Path,
    *,
    expected_surface: str,
    enforce_write_profile: bool,
) -> tuple[Any, Path]:
    match = surface_for_path(path)
    if match is None:
        raise LedgerIntegrityError(
            f"declared_jsonl_unknown_surface: {Path(path).resolve().as_posix()}"
        )
    surface, _base_dir = match
    if surface.name != expected_surface:
        raise LedgerIntegrityError(
            "declared_jsonl_surface_mismatch: "
            f"expected={expected_surface!r} actual={surface.name!r} "
            f"path={Path(path).resolve().as_posix()}"
        )
    if (
        enforce_write_profile
        and surface.root_kind == "tools"
        and surface.enterprise_required
        and surface.profile_surface
    ):
        from .runtime_profile import enforce_profile_for_write

        enforce_profile_for_write(surface.profile_surface, base_dir=_base_dir)
    return surface, _base_dir


def _verify_existing_declared_chain_before_append(path: Path) -> None:
    match = surface_for_path(path)
    if match is None:
        return
    surface, _base_dir = match
    if not surface.enterprise_required or not surface.strict_read:
        return
    if not path.exists() or path.stat().st_size == 0:
        return
    result = verify_jsonl(path)
    if not result.get("valid", False):
        raise LedgerIntegrityError(
            f"declared_jsonl_refuses_append_to_corrupt_chain: "
            f"surface={surface.name!r} path={path.resolve().as_posix()} "
            f"reason={result.get('reason')} line={result.get('line')}"
        )


def rewrite_jsonl(
    path: Path,
    rows: list[dict[str, Any]],
    *,
    allow_legacy: bool = False,
    legacy_reason: str | None = None,
    expires_at: str | None = None,
    test_fixture: bool = False,
) -> None:
    """Plan 026R §A.2 — safe rewrite under the same lock order as append.

    Acquires the (optional) index-group lock OUTER + per-file lock INNER,
    rewrites the entire ledger via ``_atomic_write_text`` (tmp + fsync +
    rename + parent-dir fsync — Planner-A durability discipline), then
    refreshes the adjacent index. Restores the hash chain from scratch
    (this is the intended migration / backfill primitive).
    """
    resolved = Path(path).resolve()
    _assert_raw_jsonl_rewrite_allowed(
        resolved,
        allow_legacy=allow_legacy,
        legacy_reason=legacy_reason,
        expires_at=expires_at,
        test_fixture=test_fixture,
    )
    with state_transaction([resolved]) as transaction:
        transaction.rewrite_jsonl(
            resolved,
            rows,
            allow_legacy=allow_legacy,
            legacy_reason=legacy_reason,
            expires_at=expires_at,
            test_fixture=test_fixture,
        )


def _rewrite_jsonl_locked(path: Path, rows: list[dict[str, Any]]) -> None:
    requirement = _lock_requirements_for_path(path)
    if requirement.index_group_lock_path is None:
        with with_exclusive_lock(requirement.file_lock_path):
            _rewrite_jsonl_unlocked(path, rows)
            return
    with with_exclusive_lock(requirement.index_group_lock_path):
        with with_exclusive_lock(requirement.file_lock_path):
            _rewrite_jsonl_unlocked(path, rows)


def _assert_raw_jsonl_rewrite_allowed(
    path: Path,
    *,
    allow_legacy: bool,
    legacy_reason: str | None,
    expires_at: str | None,
    test_fixture: bool,
) -> None:
    match = surface_for_path(path)
    if match is None:
        return
    surface, _base_dir = match
    if not surface.enterprise_required:
        return
    if _raw_jsonl_legacy_allowed(
        allow_legacy=allow_legacy,
        legacy_reason=legacy_reason,
        expires_at=expires_at,
        test_fixture=test_fixture,
    ):
        return
    raise LedgerIntegrityError(
        "raw_jsonl_declared_surface_rewrite_rejected: "
        f"surface={surface.name!r} path={path.as_posix()} "
        "use rewrite_declared_jsonl(..., expected_surface=...) or pass "
        "an explicit migration/test legacy context"
    )


def _rewrite_jsonl_unlocked(
    path: Path,
    rows: list[dict[str, Any]],
    *,
    held_file_lock_paths: frozenset[Path] | None = None,
) -> None:
    """Plan 026R §A.2 — internal rewrite under caller-held locks."""
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_hash: str | None = None
    lines = []
    for row in rows:
        stored = dict(row)
        stored["previous_ledger_hash"] = previous_hash
        stored["ledger_hash"] = _record_hash(stored, previous_hash)
        previous_hash = stored["ledger_hash"]
        lines.append(json.dumps(stored, sort_keys=True, separators=(",", ":")))
    _atomic_write_text(
        path, ("\n".join(lines) + "\n") if lines else "",
    )
    _refresh_adjacent_index_grouped(
        path,
        held_file_lock_path=path,
        held_file_lock_paths=held_file_lock_paths,
    )


def torn_tail_length(content: str) -> int:
    """Bytes of an INCOMPLETE trailing record, or 0 if the file ends cleanly.

    ORPHAN-CRITICAL-561. `_append_jsonl_locked_body` writes ``json + "\n"`` in
    ONE ``os.write``, so a record that reached disk is always newline
    terminated. A crash between the write and the fsync can truncate that
    buffer, and the newline is its LAST byte — therefore an unparseable final
    line with no trailing newline is a torn write, and one WITH a trailing
    newline is not: something else put garbage there, and that stays fatal.

    The discriminator is the writer's physics rather than a heuristic about
    where the damage looks like it is, which is what makes it safe to act on:
    a torn record was never acknowledged to any caller (the append returns
    only after the fsync), so discarding it loses nothing anyone was told
    existed. Tampering, corruption mid-file, and a hash mismatch on a COMPLETE
    row remain exactly as fatal as before.
    """
    if not content or content.endswith("\n"):
        return 0
    tail = content[content.rfind("\n") + 1 :]
    if not tail.strip():
        return 0
    try:
        json.loads(tail)
    except json.JSONDecodeError:
        return len(tail)
    # A complete JSON object that merely lacks its newline is NOT torn: the
    # writer emits the newline in the same call, so this file was written by
    # something else and must not be silently trimmed.
    return 0


def _verify_jsonl_from_text(
    path: Path,
    content: str,
    *,
    expected_surface: str | None = None,
    expected_surface_instance: str | None = None,
    unwrap_transport: bool = True,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    previous_hash: str | None = None
    bound_surface = expected_surface or _surface_name_for_path(path)
    bound_surface_instance = (
        expected_surface_instance or _surface_instance_for_path(path)
    )
    # The torn tail is removed from the text BEFORE verification, so the walk
    # below judges only records that actually completed. Reported, never
    # silent: `torn_tail_bytes` travels on the verdict so `integrity verify`
    # and its operators can see that a crash was healed here.
    torn_bytes = torn_tail_length(content)
    if torn_bytes:
        content = content[: len(content) - torn_bytes]
    try:
        for line_no, line in enumerate(content.splitlines(), start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                return (
                    {"path": path.as_posix(), "valid": False, "line": line_no, "reason": "row_not_object"},
                    rows,
                )
            expected = row.get("ledger_hash")
            if not expected:
                return (
                    {
                        "path": path.as_posix(),
                        "valid": False,
                        "line": line_no,
                        "reason": "ledger_hash_missing",
                    },
                    rows,
                )
            actual = _record_hash(row, previous_hash)
            if expected != actual:
                return (
                    {
                        "path": path.as_posix(),
                        "valid": False,
                        "line": line_no,
                        "reason": "ledger_hash_mismatch",
                        "expected": expected,
                        "actual": actual,
                    },
                    rows,
                )
            if row.get("previous_ledger_hash") != previous_hash:
                return (
                    {
                        "path": path.as_posix(),
                        "valid": False,
                        "line": line_no,
                        "reason": "previous_hash_mismatch",
                    },
                    rows,
                )
            try:
                logical = _unwrap_replay_transport_row(
                    row,
                    expected_surface=bound_surface,
                    expected_surface_instance=bound_surface_instance,
                )
            except LedgerIntegrityError as exc:
                return (
                    {
                        "path": path.as_posix(),
                        "valid": False,
                        "line": line_no,
                        "reason": str(exc),
                    },
                    rows,
                )
            rows.append(logical if unwrap_transport else dict(row))
            previous_hash = str(expected)
    except json.JSONDecodeError as exc:
        return (
            {"path": path.as_posix(), "valid": False, "line": exc.lineno, "reason": str(exc)},
            rows,
        )
    except OSError as exc:
        return ({"path": path.as_posix(), "valid": False, "reason": str(exc)}, rows)
    verdict: dict[str, Any] = {
        "path": path.as_posix(),
        "valid": True,
        "row_count": len(rows),
        "last_hash": previous_hash,
    }
    if torn_bytes:
        verdict["torn_tail_bytes"] = torn_bytes
    return (verdict, rows)


def verify_jsonl(path: Path) -> dict[str, Any]:
    """Plan 026R §A.2 — unconditional strict hash-chain verifier.

    For every non-empty row, ``ledger_hash`` MUST be present and MUST equal
    ``_record_hash(row, previous_hash)`` (canonical). ``previous_ledger_hash``
    MUST equal the prior row's ``ledger_hash`` (or None for the first row).

    Pre-§A.2 behaviour silently accepted hashless rows (``if expected:``
    skip). That conditional has been removed — hashless rows now mark the
    file invalid with ``reason="ledger_hash_missing"``. Hot-path consumers
    should use ``load_jsonl_verified`` to convert invalid results into a
    raised ``LedgerIntegrityError``.

    Backfill discipline: any hashless fixture under
    ``aria-kernel/tests/fixtures/`` is migrated by
    ``aria-kernel/scripts/backfill-ledger-hashes.py`` before this strict
    flip lands; production ledgers under ``aria-tools/`` are hash-chained
    via ``append_jsonl`` and are already strict-clean.
    """
    if not path.exists():
        return {"path": path.as_posix(), "valid": True, "row_count": 0, "missing": True}
    try:
        result, _rows = _verify_jsonl_from_text(path, path.read_text(encoding="utf-8"))
    except OSError as exc:
        # E18 (ORPHAN-672) — an I/O failure is an ENVIRONMENT fault, not
        # ledger corruption. On a full disk (errno 28, lived 2026-08-13)
        # this arm used to report the ledger as invalid, sending the
        # operator chasing phantom chain damage. reason_kind lets every
        # consumer tell the two apart without parsing errno strings.
        return {
            "path": path.as_posix(),
            "valid": False,
            "reason": str(exc),
            "reason_kind": "io_error",
            "errno": exc.errno,
        }
    return result


def load_jsonl_verified(
    path: Path,
    *,
    expected_surface: str | None = None,
) -> list[dict[str, Any]]:
    """Plan 026R §A.2 — strict load with full hash-chain verification.

    Runs ``verify_jsonl(path)`` and raises ``LedgerIntegrityError`` if the
    file fails strict verification (missing ledger_hash, chain mismatch,
    canonical drift, malformed JSON). On success, returns the loaded rows.

    Hot-path consumers (``cycle.py`` runs-loader, ``reflection.py`` runs +
    auto-merge + beliefs loaders) MUST use this primitive instead of
    plain ``load_jsonl`` so that an in-flight tamper or partial-write
    visible to a reader surfaces as a failure rather than a silent
    downstream miscount. Migration anchored by an AST invariant test.
    """
    if not path.exists():
        return []
    try:
        result, rows = _verify_jsonl_from_text(
            path,
            path.read_text(encoding="utf-8"),
            expected_surface=expected_surface,
        )
    except OSError as exc:
        # E18 (ORPHAN-672) — name the environment fault so a full-disk or
        # permission failure reads as what it is instead of chain damage.
        raise LedgerIntegrityError(
            f"strict verification failed for {path.as_posix()}: "
            f"reason_kind=io_error errno={exc.errno} reason={exc}"
        ) from exc
    if not result.get("valid", False):
        raise LedgerIntegrityError(
            f"strict verification failed for {path.as_posix()}: "
            f"reason={result.get('reason')} line={result.get('line')}"
        )
    return rows


def _load_jsonl_stored_verified(
    path: Path,
    *,
    expected_surface: str,
    expected_surface_instance: str | None = None,
) -> list[dict[str, Any]]:
    """Private strict loader retaining transport identity for replay only."""
    if not path.exists():
        return []
    try:
        result, rows = _verify_jsonl_from_text(
            path,
            path.read_text(encoding="utf-8"),
            expected_surface=expected_surface,
            expected_surface_instance=expected_surface_instance,
            unwrap_transport=False,
        )
    except OSError as exc:
        raise LedgerIntegrityError(
            f"strict verification failed for {path.as_posix()}: "
            f"reason_kind=io_error errno={exc.errno} reason={exc}",
        ) from exc
    if not result.get("valid", False):
        raise LedgerIntegrityError(
            f"strict verification failed for {path.as_posix()}: "
            f"reason={result.get('reason')} line={result.get('line')}",
        )
    return rows


def _load_jsonl_stored_verified_text(
    content: str,
    *,
    source: str | Path,
    expected_surface: str,
    expected_surface_instance: str,
) -> list[dict[str, Any]]:
    """Verify already-attested replay bytes while retaining transport rows."""
    source_path = Path(source)
    result, rows = _verify_jsonl_from_text(
        source_path,
        content,
        expected_surface=expected_surface,
        expected_surface_instance=expected_surface_instance,
        unwrap_transport=False,
    )
    if not result.get("valid", False) or result.get("torn_tail_bytes"):
        raise LedgerIntegrityError(
            f"strict verification failed for {source_path.as_posix()}: "
            f"reason={result.get('reason') or 'immutable_torn_tail'} "
            f"line={result.get('line')}",
        )
    return rows


def load_jsonl_verified_text(
    content: str,
    *,
    source: str | Path,
    expected_surface: str | None = None,
) -> list[dict[str, Any]]:
    """Strictly verify immutable JSONL content without a filesystem rewrite."""
    source_path = Path(source)
    result, rows = _verify_jsonl_from_text(
        source_path,
        content,
        expected_surface=expected_surface,
    )
    if not result.get("valid", False) or result.get("torn_tail_bytes"):
        raise LedgerIntegrityError(
            f"strict verification failed for {source_path.as_posix()}: "
            f"reason={result.get('reason') or 'immutable_torn_tail'} "
            f"line={result.get('line')}"
        )
    return rows


def verify_jsonl_chunks(
    chunks: Iterable[bytes],
    *,
    source: str | Path,
    expected_size: int,
    max_line_bytes: int,
    max_rows: int,
    expected_surface: str | None = None,
    expected_surface_instance: str | None = None,
    on_row: Callable[[dict[str, Any]], None] | None = None,
    grandfather_line_prefixes: int = 0,
    on_stored_row: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Strictly verify one immutable JSONL blob without materialising it.

    Git supplies immutable object bytes in arbitrary chunks. This reader
    bounds the only carry-over buffer (one line), verifies the canonical
    hash chain before exposing rows, and retains only the chain tip and
    counters. ``on_stored_row`` sees the transport envelope while ``on_row``
    sees its validated logical producer row.

    ``grandfather_line_prefixes`` (ARIA-HIGH-017) exempts the first N
    lines from ``max_line_bytes``: those rows are INHERITED — present in
    the previously published tip of the same ledger, written under an
    older policy — and an append-only hash chain cannot be retroactively
    shrunk. Row limits, chain verification, and every byte budget still
    apply to the whole file; only the per-line cap binds new appends.
    """
    source_path = Path(source)
    bound_surface = expected_surface or _surface_name_for_path(source_path)
    bound_surface_instance = (
        expected_surface_instance or _surface_instance_for_path(source_path)
    )
    digest = hashlib.sha256()
    pending = bytearray()
    previous_hash: str | None = None
    total = 0
    row_count = 0
    line_no = 0

    def consume(raw_line: bytes, *, terminated: bool) -> None:
        nonlocal previous_hash, row_count, line_no
        line_no += 1
        if len(raw_line) > max_line_bytes and line_no > grandfather_line_prefixes:
            raise LedgerReadLimitError(
                f"immutable_ledger_line_too_large:{source_path.as_posix()}:"
                f"line={line_no}",
            )
        content = raw_line[:-1] if terminated else raw_line
        if not content.strip():
            return
        try:
            text = content.decode("utf-8")
            if not json_nesting_within_limit(text):
                raise ValueError("json_nesting_limit_exceeded")
            row = json.loads(text)
        except UnicodeDecodeError as exc:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason=invalid_utf8 line={line_no}",
            ) from exc
        except (json.JSONDecodeError, RecursionError, ValueError) as exc:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason={exc} line={line_no}",
            ) from exc
        if not isinstance(row, dict):
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason=row_not_object line={line_no}",
            )
        row_count += 1
        if row_count > max_rows:
            raise LedgerReadLimitError(
                f"immutable_ledger_row_limit_exceeded:{source_path.as_posix()}",
            )
        expected = row.get("ledger_hash")
        if not expected:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason=ledger_hash_missing "
                f"line={line_no}",
            )
        actual = _record_hash(row, previous_hash)
        if expected != actual:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason=ledger_hash_mismatch "
                f"line={line_no}",
            )
        if row.get("previous_ledger_hash") != previous_hash:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason=previous_hash_mismatch "
                f"line={line_no}",
            )
        try:
            logical = _unwrap_replay_transport_row(
                row,
                expected_surface=bound_surface,
                expected_surface_instance=bound_surface_instance,
            )
        except LedgerIntegrityError as exc:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason={exc} line={line_no}",
            ) from exc
        previous_hash = str(expected)
        if on_stored_row is not None:
            on_stored_row(dict(row))
        if on_row is not None:
            on_row(logical)

    for chunk in chunks:
        if not isinstance(chunk, bytes):
            raise TypeError("immutable_ledger_chunk_must_be_bytes")
        total += len(chunk)
        if total > expected_size:
            raise LedgerIntegrityError(
                "strict verification failed for "
                f"{source_path.as_posix()}: reason=blob_size_changed",
            )
        digest.update(chunk)
        pending.extend(chunk)
        while True:
            newline = pending.find(b"\n")
            if newline < 0:
                break
            consume(bytes(pending[: newline + 1]), terminated=True)
            del pending[: newline + 1]
        if len(pending) > max_line_bytes and line_no + 1 > grandfather_line_prefixes:
            raise LedgerReadLimitError(
                f"immutable_ledger_line_too_large:{source_path.as_posix()}:"
                f"line={line_no + 1}",
            )
    if total != expected_size:
        raise LedgerIntegrityError(
            "strict verification failed for "
            f"{source_path.as_posix()}: reason=blob_size_changed",
        )
    if pending:
        consume(bytes(pending), terminated=False)
    return {
        "valid": True,
        "row_count": row_count,
        "last_hash": previous_hash,
        "sha256": digest.hexdigest(),
        "size_bytes": total,
    }


def load_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "ledger_hashes": {},
            "pressure_evidence_fingerprints_emitted": [],
            "schema_version": 2,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def verify_index_hashes(index_path: Path, ledgers: dict[str, Path]) -> dict[str, Any]:
    resolved_index = Path(index_path).resolve()
    resolved_ledgers = {
        name: Path(path).resolve()
        for name, path in ledgers.items()
    }
    with state_transaction([resolved_index, *resolved_ledgers.values()]) as transaction:
        return transaction.verify_index_hashes(resolved_index, resolved_ledgers)


def _verify_index_hashes_unlocked(
    index_path: Path,
    ledgers: dict[str, Path],
) -> dict[str, Any]:
    index = load_index(index_path)
    indexed_hashes = index.get("ledger_hashes", {})
    if not isinstance(indexed_hashes, dict):
        raise LedgerIntegrityError(
            f"Ledger integrity index is malformed at {index_path.as_posix()}: ledger_hashes must be an object"
        )
    for name in sorted(ledgers):
        if name not in indexed_hashes:
            raise LedgerIntegrityError(
                f"Ledger integrity index missing required ledger entry: {name}"
            )
    for name in sorted(indexed_hashes):
        if name not in ledgers:
            raise LedgerIntegrityError(
                f"Ledger integrity index contains unknown ledger entry: {name}"
            )
        expected_hash = indexed_hashes[name]
        actual_hash = file_hash(ledgers[name])
        if actual_hash != expected_hash:
            raise LedgerIntegrityError(
                f"Ledger integrity check failed for {name}: expected {expected_hash}, got {actual_hash}"
            )
    return index


def write_index(index_path: Path, index: dict[str, Any], ledgers: dict[str, Path]) -> None:
    """Plan 026R §A.1+§A.2 — write integrity_index.json atomically.

    Reads ``file_hash`` for each ledger in ``ledgers`` and persists the
    consolidated index. Acquires ``with_exclusive_lock(index_path)`` so
    every concurrent writer (including the index-group lock holders from
    the held-lock-aware refresh path) serialises on the index file's
    side-car lock — that prevents the fixed-tmp-name clobber race
    surfaced by ``test_concurrent_submit_race_5_subprocesses`` (5 procs
    each calling ``update_tools_index`` after their own append).

    Caller is still responsible for any per-ledger locks needed so the
    hashes are consistent snapshots; the held-lock-aware
    ``_refresh_adjacent_index_grouped`` is the canonical consumer for
    indexed-group appends. External callers (boot init, migrations) use
    this primitive standalone and pay the snapshot-consistency window.
    """
    resolved_index = Path(index_path).resolve()
    resolved_ledgers = {
        name: Path(path).resolve()
        for name, path in ledgers.items()
    }
    with state_transaction([resolved_index, *resolved_ledgers.values()]) as transaction:
        transaction.write_index(resolved_index, index, resolved_ledgers)


def _write_index_unlocked(
    index_path: Path,
    index: dict[str, Any],
    ledgers: dict[str, Path],
) -> None:
    """Write an integrity index while its transaction locks are held."""
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index.pop("pressure_keys_emitted", None)
    index["ledger_hashes"] = {name: file_hash(path) for name, path in ledgers.items()}
    index["schema_version"] = 2
    _atomic_write_text(index_path, json.dumps(index, indent=2, sort_keys=True) + "\n")


def _atomic_write_text(path: Path, content: str) -> None:
    """Plan 026R §A.1+§A.2 — atomic write with full fsync durability.

    Steps:
      1. Write to a per-call unique temp side-car (PID + monotonic_ns +
         4-byte random suffix). Pre-§A.2 the tmp filename was a fixed
         ``.<name>.tmp`` which let two concurrent writers (e.g. five
         subprocesses each running ``update_tools_index``) clobber each
         other's tmp file before the rename — the second
         ``tmp.replace(path)`` failed with FileNotFoundError because the
         first rename had already consumed the shared tmp inode. The
         unique-suffix tmp eliminates that race in the worst-case path
         where a caller bypasses the index-group lock; with the lock
         taken (the §A.2 ``write_index`` change), it is defense-in-depth
         against any future caller that forgets to lock.
      2. ``os.fsync(tmp_fd)`` BEFORE ``tmp.replace(path)`` so the new data
         is on stable storage before the inode swap.
      3. ``tmp.replace(path)`` (atomic rename on POSIX; ``MoveFileEx``
         with ``MOVEFILE_REPLACE_EXISTING`` semantics on Windows).
      4. ``os.fsync(parent_dir_fd)`` AFTER rename so the directory entry
         update is durable (ext4/xfs may otherwise lose the rename
         across crash). POSIX only — Windows skips (rename + close covers
         the durability story on NTFS).

    On any exception between tmp open and rename, the tmp file is
    unlinked best-effort so a half-written side-car does not accumulate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    import secrets
    import time as _time
    unique = f"{os.getpid()}.{_time.monotonic_ns()}.{secrets.token_hex(4)}"
    tmp = path.with_name(f".{path.name}.{unique}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        try:
            os.write(fd, content.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        tmp.replace(path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    if not sys.platform.startswith("win"):
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def _refresh_adjacent_index_grouped(
    path: Path,
    *,
    held_file_lock_path: Path,
    held_file_lock_paths: frozenset[Path] | None = None,
) -> None:
    """Plan 026R §A.1 — held-lock-aware index refresh.

    Caller MUST already hold (``index_group_lock_path``, ``held_file_lock_
    path``). For each SIBLING ledger in the group (i.e. every member
    EXCEPT ``held_file_lock_path`` to avoid POSIX flock re-acquisition
    deadlock), briefly acquires the sibling's per-file lock in **stable
    sorted order** (alphabetical by absolute path) and reads its
    ``file_hash``. For ``held_file_lock_path`` itself, reads ``file_hash``
    directly (already holding the lock). Writes the consolidated index
    via ``_atomic_write_text`` (Planner-A fsync discipline).

    Deadlock prevention:
    * Self-deadlock: skipping ``held_file_lock_path`` from the sibling
      iteration eliminates the non-reentrant ``fcntl.flock`` second
      acquisition.
    * Sibling deadlock: sorted-order acquisition ensures every actor that
      ever locks multiple siblings does so in the same global order; the
      lock graph is a DAG by construction. (In practice the index-group
      lock serialises group-internal appends so only one actor per group
      is in this code path at a time.)
    """
    requirement = _lock_requirements_for_path(path)
    if requirement.index_group_lock_path is None or requirement.ledgers is None:
        return
    index_path = requirement.index_group_lock_path
    if not index_path.exists():
        return

    held_resolved = {held_file_lock_path.resolve()}
    if held_file_lock_paths is not None:
        held_resolved.update(item.resolve() for item in held_file_lock_paths)
    ledger_hashes: dict[str, str] = {}
    sibling_paths: list[Path] = []

    for logical_name, ledger_path in requirement.ledgers.items():
        if ledger_path.resolve() in held_resolved:
            ledger_hashes[logical_name] = file_hash(ledger_path)
        else:
            sibling_paths.append(ledger_path)

    sibling_paths.sort(key=lambda p: str(p.resolve()))

    with contextlib.ExitStack() as stack:
        for sibling in sibling_paths:
            stack.enter_context(with_exclusive_lock(sibling))
            for logical_name, ledger_path in requirement.ledgers.items():
                if ledger_path.resolve() == sibling.resolve():
                    ledger_hashes[logical_name] = file_hash(ledger_path)
                    break

        current = load_index(index_path)
        current.pop("pressure_keys_emitted", None)
        current["ledger_hashes"] = ledger_hashes
        current["schema_version"] = 2
        _atomic_write_text(
            index_path,
            json.dumps(current, indent=2, sort_keys=True) + "\n",
        )


# Backward-compatibility alias: the previous helper is retained so any
# legacy callers that may have imported it directly continue to work,
# but it now routes through the held-lock-aware variant. New code MUST
# call `_refresh_adjacent_index_grouped` explicitly with the held lock.
def _refresh_adjacent_index(path: Path) -> None:
    _refresh_adjacent_index_grouped(path, held_file_lock_path=path)
