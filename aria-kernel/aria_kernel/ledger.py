from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .file_lock import with_exclusive_lock


__all__ = [
    "LedgerIntegrityError",
    "append_jsonl",
    "file_hash",
    "load_index",
    "load_jsonl",
    "load_jsonl_verified",
    "read_jsonl",
    "rewrite_jsonl",
    "verify_index_hashes",
    "verify_jsonl",
    "write_index",
]


class LedgerIntegrityError(RuntimeError):
    pass


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
    if (
        path.name in _TOOLS_GROUP_FILENAMES
        and (path.parent / "integrity_index.json").exists()
    ):
        return LockRequirement(
            file_lock_path=path,
            index_group_lock_path=path.parent / "integrity_index.json",
            ledgers={
                logical: path.parent / fname
                for fname, logical in _TOOLS_GROUP_FILENAMES.items()
            },
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


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    if path.exists():
        digest.update(path.read_bytes())
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            records.append(json.loads(stripped))
        except json.JSONDecodeError as exc:
            raise LedgerIntegrityError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
    return records


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return read_jsonl(path)


def _canonical_json(record: dict[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _record_hash(record: dict[str, Any], previous_hash: str | None = None) -> str:
    payload = dict(record)
    payload.pop("ledger_hash", None)
    payload.pop("previous_ledger_hash", None)
    raw = _canonical_json({"previous_ledger_hash": previous_hash, "record": payload})
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


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
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = read_jsonl(path)
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
    _refresh_adjacent_index_grouped(path, held_file_lock_path=path)
    return stored


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Plan 026R §A.1 — public atomic append primitive.

    Acquires the lock(s) declared by ``_lock_requirements_for_path``:
    index-group lock OUTER, per-file lock INNER. Calls
    ``_append_jsonl_unlocked`` under both locks (CAS callsites that
    already hold the per-file lock use ``_append_jsonl_unlocked``
    directly to avoid POSIX flock re-acquisition).
    """
    requirement = _lock_requirements_for_path(path)
    if requirement.index_group_lock_path is None:
        with with_exclusive_lock(requirement.file_lock_path):
            return _append_jsonl_unlocked(path, record)
    with with_exclusive_lock(requirement.index_group_lock_path):
        with with_exclusive_lock(requirement.file_lock_path):
            return _append_jsonl_unlocked(path, record)


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    """Plan 026R §A.2 — safe rewrite under the same lock order as append.

    Acquires the (optional) index-group lock OUTER + per-file lock INNER,
    rewrites the entire ledger via ``_atomic_write_text`` (tmp + fsync +
    rename + parent-dir fsync — Planner-A durability discipline), then
    refreshes the adjacent index. Restores the hash chain from scratch
    (this is the intended migration / backfill primitive).
    """
    requirement = _lock_requirements_for_path(path)
    if requirement.index_group_lock_path is None:
        with with_exclusive_lock(requirement.file_lock_path):
            _rewrite_jsonl_unlocked(path, rows)
            return
    with with_exclusive_lock(requirement.index_group_lock_path):
        with with_exclusive_lock(requirement.file_lock_path):
            _rewrite_jsonl_unlocked(path, rows)


def _rewrite_jsonl_unlocked(path: Path, rows: list[dict[str, Any]]) -> None:
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
    _refresh_adjacent_index_grouped(path, held_file_lock_path=path)


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
    rows: list[dict[str, Any]] = []
    previous_hash: str | None = None
    try:
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                return {"path": path.as_posix(), "valid": False, "line": line_no, "reason": "row_not_object"}
            rows.append(row)
            expected = row.get("ledger_hash")
            if not expected:
                return {
                    "path": path.as_posix(),
                    "valid": False,
                    "line": line_no,
                    "reason": "ledger_hash_missing",
                }
            actual = _record_hash(row, previous_hash)
            if expected != actual:
                return {
                    "path": path.as_posix(),
                    "valid": False,
                    "line": line_no,
                    "reason": "ledger_hash_mismatch",
                    "expected": expected,
                    "actual": actual,
                }
            if row.get("previous_ledger_hash") != previous_hash:
                return {
                    "path": path.as_posix(),
                    "valid": False,
                    "line": line_no,
                    "reason": "previous_hash_mismatch",
                }
            previous_hash = str(expected)
    except json.JSONDecodeError as exc:
        return {"path": path.as_posix(), "valid": False, "line": exc.lineno, "reason": str(exc)}
    except OSError as exc:
        return {"path": path.as_posix(), "valid": False, "reason": str(exc)}
    return {"path": path.as_posix(), "valid": True, "row_count": len(rows), "last_hash": previous_hash}


def load_jsonl_verified(path: Path) -> list[dict[str, Any]]:
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
    result = verify_jsonl(path)
    if not result.get("valid", False):
        raise LedgerIntegrityError(
            f"strict verification failed for {path.as_posix()}: "
            f"reason={result.get('reason')} line={result.get('line')}"
        )
    return read_jsonl(path)


def load_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "ledger_hashes": {},
            "pressure_evidence_fingerprints_emitted": [],
            "schema_version": 2,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def verify_index_hashes(index_path: Path, ledgers: dict[str, Path]) -> dict[str, Any]:
    index = load_index(index_path)
    for name, expected_hash in index.get("ledger_hashes", {}).items():
        ledger = ledgers.get(name)
        if ledger is None:
            continue
        actual_hash = file_hash(ledger)
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
    with with_exclusive_lock(index_path):
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

    held_resolved = held_file_lock_path.resolve()
    ledger_hashes: dict[str, str] = {}
    sibling_paths: list[Path] = []

    for logical_name, ledger_path in requirement.ledgers.items():
        if ledger_path.resolve() == held_resolved:
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
