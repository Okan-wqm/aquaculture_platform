"""ORPHAN-HIGH-798 (compact half) — shrink the state branch's bloated ledgers.

The write-time fix (PR-1) stopped NEW bloat; this module shrinks EXISTING
data. The push was refused because raw-findings.jsonl hit 57.84MB and
runs.jsonl hit 94.5MB — both over GitHub's 50MB recommendation.

What it does (per surface, all lossless via archives):
- runs.jsonl: strips evidence_validation.evidence_envelopes and read_paths
  from rows older than --retain-days (keeps counts + artifact_ref)
- raw-findings.jsonl: keeps one row per (tool_id, finding_fingerprint) —
  the newest — and strips inline finding objects from rows older than
  --retain-days (keeps finding_summary + artifact_ref). ARIA-HIGH-185:
  every cycle re-records the same finding universe (~3k rows, ~5MB), so
  without the collapse the ledger grew one universe per cycle until the
  publish's evidence budget (80MiB across counted surfaces) refused the
  commit; the readers resolve a fingerprint to one row and none of them
  needs the older copies. ARIA-HIGH-239: a run the collapse would empty
  keeps its newest row, so no run that reports raw findings is left with
  no pointer to them (``raw_pointer_missing``).
- memory is NEVER compacted (ARIA-HIGH-263): a surface the manifest flags
  ``memory`` (beliefs, learning events, reflections, the knowledge graph) is
  refused by the one function that rewrites ledgers here. Collapsing beliefs
  to the latest row per id and dropping learning events past --retain-days
  archived what ARIA learned into ``archives/``, which no memory reader reads.

Stripped data is written to archives/<surface>-compact-<timestamp>.jsonl.gz
so nothing is lost. Ledgers are re-chained via rewrite_declared_jsonl.

COMPACTION DELETES NO FILE (ARIA-HIGH-274). Its wall-clock hot-cycle strip
and mtime-aged FATES strip let ``aria/state`` grow ~45-70 MiB a day; every
publish now evicts old cycles to the ``<branch>-cold`` store
(``evict_to_cold``), so evidence leaves the hot tree and is never deleted.

THE STRIPPED ARTIFACTS ARE ATTESTED TOO (ARIA-HIGH-117). Pruning a hot
cycle and dropping its index rows leaves ``runs.jsonl`` refs and
``raw-findings.jsonl`` pointers naming artifacts that are gone — by
design, the compact archive keeps the rows. But the verifier had no way
to tell that from a lost artifact and refused the whole store (3,898
issues on the 2026-09-13 tip; the executor lane could not publish
``aria/state`` at all). ``run-artifacts/compacted.jsonl`` is the ledger
of every artifact compaction stripped, written inside the index
compaction's own transaction and backfilled from the compact archives
for a store stripped before the ledger existed, so the next maintenance
run heals it by construction. ``verify_runtime_artifacts`` reads a ref
into an attested artifact as ``compacted``; an absent artifact no row
names is still missing.

THE WINDOW IN FORCE IS THE ARCHIVE'S OWN. Whether a dropped index row was
retention's to remove is decided against the ``--retain-days`` of the
compaction that WROTE its archive, never against this run's input: a
supported operator dispatch with a shorter window must not re-judge a
row that was a loss when it was archived. That window is recorded on the
``state_compacted`` governance row the writing run appended — a row
names its archive (``artifact_index_archive``); the rows that predate
the name are paired to their archive by clock. An archive no row vouches
for is attested from NOT AT ALL, so its artifacts stay visibly missing
rather than laundered under a guessed window.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import (StateTransaction, append_declared_jsonl_rows, load_declared_jsonl,
                     rewrite_declared_jsonl, state_transaction)
from .runtime_artifacts import COLD_POINTERS_SURFACE, cold_pointers
from .state_manifest import (memory_surfaces, resolve_surface_path, surface_by_name,
                             surface_for_relative_path)
from .state_snapshot import SNAPSHOT_MAX_SURFACE_BLOB_BYTES
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now

# The governance event compaction records.
COMPACTED_EVENT = "state_compacted"
# The count of artifacts the compaction ledger attested this run carries
# on the same governance row.
ATTESTED_ARTIFACTS_KEY = "compacted_artifacts_attested"
# The compact archive of dropped index rows this run wrote (None when it
# dropped none), on the same governance row: the binding a later run
# follows to the ``retain_days`` that was in force when the archive was
# written. A row that carries this key names its archive exactly; a row
# without it predates the key and is paired to its archive by clock.
ARCHIVE_KEY = "artifact_index_archive"

# How a ledger row came to be: written by the compaction that dropped the
# index row, or reconstructed from a compact archive an earlier compaction
# left behind before the ledger existed.
ATTESTED_BY_COMPACTION = "compaction"
ATTESTED_BY_BACKFILL = "archive_backfill"

_ARCHIVE_STAMP = re.compile(r"^artifact_index-compact-(\d{8}T\d{6})Z\.jsonl\.gz$")

# ARIA-MEDIUM-230 — the ledgers compaction shrinks, in the order it shrinks
# them, and the size at which a publish compacts them before it snapshots.
# Half the publish cap: a compacted ledger is a fraction of its trigger
# (raw findings collapse to one row per fingerprint — 34,500 rows on the
# 2026-09-26 tip were 3,253 findings), so there is a whole trigger's worth
# of cycles between a compaction and the cap. ARIA-HIGH-263 — the names are
# the manifest's own surface names, so `_compact_ledgers` can refuse a
# memory surface by the manifest's flag; beliefs and learning events left.
COMPACTABLE_SURFACES: tuple[str, ...] = ("runs", "raw_findings")
COMPACTION_TRIGGER_BYTES = SNAPSHOT_MAX_SURFACE_BLOB_BYTES // 2
PUBLISH_COMPACTION_RETAIN_DAYS = 7


class SurfaceBoundError(RuntimeError):
    """A compactable ledger is still over the publish cap after compaction."""


def compact_state(
    *,
    base_dir: str | Path | None = None,
    retain_days: int = 7,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Compact the state branch's large ledgers in-place.

    Returns a summary dict with per-surface before/after stats.
    When dry_run is True, reports what WOULD be compacted but writes nothing.
    """
    # An explicit absolute directory is taken as it is: ensure_tools_dir
    # write-initialises a root (identity file, index refresh, a bootstrap
    # governance row) and compaction must not do that to the restored
    # checkout the maintenance lane hands it. The root still has to be a
    # BOUND tools root — every surface below is read and rewritten through
    # the manifest (load_declared_jsonl / rewrite_declared_jsonl), which
    # refuses a directory without repo_identity.json.
    if base_dir and Path(base_dir).is_absolute() and Path(base_dir).is_dir():
        root = Path(base_dir)
    else:
        root = ensure_tools_dir(base_dir)
    cutoff = datetime.now(timezone.utc) - timedelta(days=retain_days)
    results: dict[str, Any] = {
        "dry_run": dry_run,
        "cutoff": cutoff.isoformat(),
        "surfaces": _compact_ledgers(root, COMPACTABLE_SURFACES, cutoff, dry_run),
    }

    # ORPHAN-CRITICAL-805 — the index has to follow the files it describes.
    # Deleting a cycle's artifacts and leaving its index rows behind makes
    # verify_artifacts report `run_artifact_missing` forever, which turns
    # every future cycle's runtime_status into integrity_failed no matter
    # how the night actually went. ARIA-HIGH-117 — and the run refs and
    # raw pointers that still name the dropped artifacts are attested on
    # the compaction ledger in the same transaction.
    now = datetime.now(timezone.utc)
    dropped_rows, attested, fresh_archive = _compact_artifact_index(
        root, now=now, retain_days=retain_days, dry_run=dry_run,
    )
    results["artifact_index_rows_dropped"] = dropped_rows
    results[ATTESTED_ARTIFACTS_KEY] = attested
    results[ARCHIVE_KEY] = fresh_archive

    if not dry_run:
        append_tools_governance(
            root,
            COMPACTED_EVENT,
            {
                "retain_days": retain_days,
                "surfaces": {
                    name: {"before": s["before_bytes"], "after": s["after_bytes"]}
                    for name, s in results["surfaces"].items()
                },
                ATTESTED_ARTIFACTS_KEY: results[ATTESTED_ARTIFACTS_KEY],
                ARCHIVE_KEY: results[ARCHIVE_KEY],
            },
        )
    return results


def _compact_ledgers(
    root: Path,
    names: tuple[str, ...] | list[str],
    cutoff: datetime,
    dry_run: bool,
) -> dict[str, Any]:
    """Run the named ledger compactors — exactly those — and report each.

    The one place compaction rewrites a ledger, so the one place a memory
    surface is refused (ARIA-HIGH-263): the manifest's ``memory`` flag is
    read here, before anything is written, and a compactor someone adds for
    a memory surface cannot run. A name with no compactor is refused too —
    the caller asked for a rewrite this module does not own.
    """
    memory = sorted(set(names) & {surface.name for surface in memory_surfaces()})
    if memory:
        raise ValueError(f"memory_surface_not_compactable:{','.join(memory)}")
    unknown = sorted(set(names) - set(COMPACTABLE_SURFACES))
    if unknown:
        raise ValueError(f"surface_not_compactable:{','.join(unknown)}")
    compactors = {"runs": _compact_runs, "raw_findings": _compact_raw_findings}
    stats: dict[str, Any] = {}
    for surface_name in (name for name in COMPACTABLE_SURFACES if name in names):
        path = _surface_path(root, surface_name)
        if not path.exists():
            continue
        before_bytes = path.stat().st_size
        before_rows = sum(1 for _ in path.open(encoding="utf-8"))
        kept_rows, stripped_rows = compactors[surface_name](path, root, cutoff, dry_run)
        after_bytes = 0 if dry_run else path.stat().st_size
        after_rows = 0 if dry_run else sum(1 for _ in path.open(encoding="utf-8"))
        stats[surface_name] = {
            "before_bytes": before_bytes,
            "after_bytes": after_bytes,
            "before_rows": before_rows,
            "after_rows": after_rows,
            "kept_rows": kept_rows,
            "stripped_rows": stripped_rows,
        }
    return stats


def compact_surfaces(
    root: str | Path,
    surfaces: tuple[str, ...] | list[str],
    *,
    retain_days: int = PUBLISH_COMPACTION_RETAIN_DAYS,
) -> dict[str, Any]:
    """ARIA-HIGH-263 — compact exactly ``surfaces``, and nothing else.

    The publish preamble's compactor. It used to run ``compact_state`` over
    the whole root whenever ANY ledger crossed the trigger, so a raw-findings
    ledger at 32 MiB rewrote memory, stripped hot artifacts and pruned FATES
    as a side effect of every publish. A bound is about one oversized ledger;
    it rewrites that ledger and records the compaction on the governance row
    every compaction appends — no attested artifacts and an
    explicit ``None`` archive, so ``_archive_windows`` never pairs this row by
    clock with an index archive it did not write.
    """
    root_path = Path(root)
    cutoff = datetime.now(timezone.utc) - timedelta(days=retain_days)
    stats = _compact_ledgers(root_path, tuple(surfaces), cutoff, False)
    append_tools_governance(
        root_path,
        COMPACTED_EVENT,
        {
            "retain_days": retain_days,
            "surfaces": {
                name: {"before": s["before_bytes"], "after": s["after_bytes"]}
                for name, s in stats.items()
            },
            ATTESTED_ARTIFACTS_KEY: 0,
            ARCHIVE_KEY: None,
        },
    )
    return {"dry_run": False, "cutoff": cutoff.isoformat(), "surfaces": stats}


def bound_compactable_surfaces(
    root: str | Path,
    *,
    retain_days: int = PUBLISH_COMPACTION_RETAIN_DAYS,
) -> dict[str, Any]:
    """ARIA-MEDIUM-230 — compact before a publish, and refuse what stays too big.

    The publish preamble (``state_store.prepare_publishable_snapshot``) calls
    this before it builds the snapshot, so every publisher — the nightly, the
    executor lane, the maintenance lane, the contention replay — bounds the
    ledgers it is about to push. It replaces the cycle-end trigger, which
    could not bound anything the night it was needed: it ran only when
    ``run_cycle`` reached its last line (a cycle killed at its time limit
    never did), it resolved a relative root against the working directory,
    and it caught every exception into a state key nothing read. The
    2026-09-21..26 nightlies each restored a 57.5 MB ``raw-findings.jsonl``
    of 34,500 rows for 3,253 findings, added a cycle's rows, and had the
    publish refused as ``state_commit_surface_too_large:raw_findings``.

    Each compactable surface over ``COMPACTION_TRIGGER_BYTES`` is compacted,
    and only those (``compact_surfaces``, ARIA-HIGH-263): no other ledger,
    memory above all, is rewritten as a side effect of bounding one. A
    compaction failure propagates — the caller refuses the publish by name.
    A surface still over ``SNAPSHOT_MAX_SURFACE_BLOB_BYTES`` afterwards
    raises :class:`SurfaceBoundError` naming it and its size: a publish that
    cannot be bounded stops here, not at the remote.
    """
    root_path = Path(root)
    sizes = {name: _surface_size(root_path, name) for name in COMPACTABLE_SURFACES}
    oversized = sorted(name for name, size in sizes.items() if size > COMPACTION_TRIGGER_BYTES)
    result: dict[str, Any] | None = None
    if oversized:
        result = compact_surfaces(root_path, oversized, retain_days=retain_days)
        sizes = {name: _surface_size(root_path, name) for name in COMPACTABLE_SURFACES}
    over_cap = sorted(name for name, size in sizes.items() if size > SNAPSHOT_MAX_SURFACE_BLOB_BYTES)
    if over_cap:
        raise SurfaceBoundError(
            "compactable_surface_over_publish_cap:"
            + ",".join(f"{name}={sizes[name]}>{SNAPSHOT_MAX_SURFACE_BLOB_BYTES}" for name in over_cap)
        )
    return {
        "status": "compacted" if oversized else "not_needed",
        "oversized": oversized,
        "sizes": sizes,
        "trigger_bytes": COMPACTION_TRIGGER_BYTES,
        "cap_bytes": SNAPSHOT_MAX_SURFACE_BLOB_BYTES,
        "result": result,
    }


def _surface_size(root: Path, surface: str) -> int:
    path = _surface_path(root, surface)
    return path.stat().st_size if path.exists() else 0


def _surface_path(root: Path, surface: str) -> Path:
    mapping = {
        "runs": root / "runs.jsonl",
        "raw_findings": root / "raw-findings.jsonl",
    }
    return mapping[surface]


def _cycle_timestamp(name: str) -> datetime | None:
    """Parse the UTC stamp out of a cycle directory name.

    Cycle IDs carry their own clock: ``cyc-20260822T153253Z-auto``.
    """
    if not name.startswith("cyc-"):
        return None
    try:
        return datetime.strptime(name[4:19], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ---- ARIA-HIGH-274 — eviction to the cold store --------------------------
# How many of the newest cycles of each family stay hot, ordered by the
# stamp inside the cycle id — never by mtime (checkout time on a fresh
# worktree) or by the wall clock (a lane that does not run ages nothing).
COLD_EVICTION_KEEP_CYCLES = 3
COLD_EVICTION_FAMILIES: tuple[str, ...] = ("run-artifacts/hot", "discovery")
COLD_EVICTED_EVENT = "state_cold_evicted"


@dataclass(frozen=True)
class ColdStaging:
    """What a publish's pre-lock half put in the cold store: the cold commit
    holding every blob, and the pointer rows by tools-relative cycle dir."""

    commit: str
    cycles: dict[str, tuple[dict[str, Any], ...]]


def cold_eviction_candidates(root: Path) -> dict[str, list[tuple[str, Path]]]:
    """``{cycle dir: [(surface name, file), ...]}`` for every cycle outside the
    newest ``COLD_EVICTION_KEEP_CYCLES`` of its family whose every file is an
    ARTIFACT-class surface (a ledger never leaves the hot tree). Whole cycles
    only: ``runtime_artifacts._verify_cycle_files`` needs every file of one."""
    evictable: dict[str, list[tuple[str, Path]]] = {}
    for family in COLD_EVICTION_FAMILIES:
        base = root / family
        stamped = sorted(
            (stamp, item.name) for item in (base.iterdir() if base.is_dir() else ())
            if item.is_dir() and not item.is_symlink() and (stamp := _cycle_timestamp(item.name)) is not None
        )
        for _stamp, cycle_id in stamped[:-COLD_EVICTION_KEEP_CYCLES]:
            files = sorted(path for path in (base / cycle_id).rglob("*") if not path.is_dir())
            surfaces = [surface_for_relative_path(path.relative_to(root).as_posix()) for path in files]
            if files and all(
                path.is_file() and not path.is_symlink() and surface is not None and surface.state_class == "artifact"
                for path, surface in zip(files, surfaces)
            ):
                evictable[f"{family}/{cycle_id}"] = [
                    (surface.name, path) for path, surface in zip(files, surfaces) if surface is not None
                ]
    return evictable


def evict_to_cold(root: Path, staging: ColdStaging) -> dict[str, Any]:
    """The in-lock half of a publish's eviction: record, then unlink.

    A cycle is evicted only while it holds exactly the staged files and bytes
    (a replay onto a winner that evicted it finds it gone). Every pointer row
    is appended and fsynced BEFORE any unlink and never appended twice, so a
    crash between the two heals on the next publish."""
    known = cold_pointers(root)
    evicting: list[tuple[Path, tuple[dict[str, Any], ...]]] = []
    for cycle_dir, rows in sorted(staging.cycles.items()):
        directory = root / cycle_dir
        staged = {row["uri"]: row["sha256"] for row in rows}
        on_disk = sorted(
            path.relative_to(root).as_posix() for path in directory.rglob("*") if not path.is_dir()
        ) if directory.is_dir() else []
        if on_disk and on_disk == sorted(staged) and all(
            "sha256:" + hashlib.sha256((root / uri).read_bytes()).hexdigest() == staged[uri] for uri in on_disk
        ):
            evicting.append((directory, rows))
    by_month: dict[str, list[dict[str, Any]]] = {}
    for _directory, rows in evicting:
        for row in rows:
            if known.evicted(row["uri"], row["sha256"]) is None:
                # `cyc-YYYYMMDDT...`: the month is the cycle's own, never the clock's.
                by_month.setdefault(f"{row['cycle_id'][4:8]}-{row['cycle_id'][8:10]}", []).append(row)
    for month, rows in sorted(by_month.items()):
        ledger = root / "cold" / "pointers" / f"{month}.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl_rows(ledger, rows, expected_surface=COLD_POINTERS_SURFACE)
    for directory, _rows in evicting:
        shutil.rmtree(directory)
    count = sum(len(rows) for _directory, rows in evicting)
    freed = sum(int(row["size"]) for _directory, rows in evicting for row in rows)
    if count:
        append_tools_governance(root, COLD_EVICTED_EVENT, {"cold_commit": staging.commit, "count": count, "bytes": freed})
    return {
        "cold_commit": staging.commit,
        "evicted_files": count,
        "evicted_bytes": freed,
        "pointers_appended": sum(len(rows) for rows in by_month.values()),
    }


def _compact_artifact_index(
    root: Path,
    *,
    now: datetime,
    retain_days: int,
    dry_run: bool,
) -> tuple[int, int, str | None]:
    """Drop index rows whose artifact file is no longer on disk, and attest
    on the compaction ledger every artifact the retention policy stripped.

    Returns ``(index rows dropped, artifacts attested, archive written)``
    — the archive is the tools-relative path of this run's compact archive
    of dropped rows, or None when it dropped none.

    WHY this exists (ORPHAN-CRITICAL-805). The retired hot-artifact strip
    rmtree'd whole cycle directories, and nothing updated
    `run-artifacts/artifact-index.jsonl`. The index therefore grew without
    bound while the files were kept to a window, and `verify_artifacts`
    walks the INDEX: 158 rows across 19 pruned cycles against 18 files
    across 2 live ones, measured on the runner's store 2026-09-04. Every
    row it cannot open is a `run_artifact_missing` issue, the verdict comes
    back `valid: False`, and `cycle._runtime_status` reads that as
    `integrity_failed`. That is why the nightly cycle had not reported
    success since 2026-08-19 while its adapters were green: the failure
    described the store's bookkeeping, not the night's work.

    Presence on disk is the predicate rather than the retention cutoff,
    because it is the same question `verify_artifacts` asks. That also
    heals an index that a previous compaction already stranded, instead of
    only preventing the next one. Dropped rows go to the archive like every
    other surface: compaction's contract is that nothing is lost.

    ARIA-HIGH-274 — an artifact evicted to the cold store is present: its
    pointer names its bytes, so an eviction never rewrites the index.

    ARIA-HIGH-117 — presence decides what leaves the INDEX; the retention
    policy decides what the LEDGER attests. A dropped row whose cycle is
    older than the window this compaction applied is attested as compacted; a dropped row inside
    the window names an artifact that is absent for some other reason, and
    the verifier keeps reporting it — that is the lost artifact it exists
    to catch. The ledger row and the index rewrite share one transaction,
    so no reader can see the row gone and the attestation not yet there.

    The window each EARLIER archive is judged by is read from the
    governance ledger before the transaction opens (``_archive_windows``):
    governance is an input here, never written inside this transaction.
    """
    path = root / "run-artifacts" / "artifact-index.jsonl"
    ledger = _compaction_ledger_path(root)
    rows = load_declared_jsonl(path, expected_surface="runtime_artifact_index") if path.exists() else []
    cold = cold_pointers(root)
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for row in rows:
        uri = str(row.get("current_uri") or "")
        # A row with no uri cannot name a file and cannot be verified; it is
        # already an issue in verify_artifacts, so it goes with the rest.
        if uri and ((root / uri).is_file() or cold.evicted(uri, row.get("sha256")) is not None):
            kept.append(row)
        else:
            dropped.append(row)
    earlier_archives = _compact_archives(root)
    windows = _archive_windows(root, earlier_archives) if earlier_archives else {}
    if dry_run:
        attestable = _compaction_attestations(
            root, existing_ids=_attested_artifact_ids(root), now=now, retain_days=retain_days,
            windows=windows, pending=dropped,
        )
        return len(dropped), len(attestable), None
    if not dropped and not earlier_archives:
        # Nothing stripped now and nothing stripped before: no transaction
        # to open, no lock side-car to leave on a store that never compacted.
        return 0, 0, None
    with state_transaction([path, ledger] if path.exists() else [ledger]) as transaction:
        fresh_archive: str | None = None
        if dropped:
            fresh_archive = _archive_stripped(root, "artifact_index", dropped)
            transaction.rewrite_declared_jsonl(
                path,
                kept,
                expected_surface="runtime_artifact_index",
                migration_id=f"compact_artifact_index_{utc_now()}",
            )
        attested = _attest_compacted_artifacts(
            transaction, root, now=now, retain_days=retain_days,
            windows=windows, fresh_archive=fresh_archive,
        )
    return len(dropped), attested, fresh_archive


def _compaction_ledger_path(root: Path) -> Path:
    from .runtime_artifacts import COMPACTIONS_SURFACE

    return resolve_surface_path(root, surface_by_name(COMPACTIONS_SURFACE))


def _attested_artifact_ids(root: Path) -> set[str]:
    from .runtime_artifacts import COMPACTIONS_SURFACE

    ledger = _compaction_ledger_path(root)
    if not ledger.exists():
        return set()
    return {
        str(row.get("artifact_id") or "")
        for row in load_declared_jsonl(ledger, expected_surface=COMPACTIONS_SURFACE)
    }


def _attest_compacted_artifacts(
    transaction: StateTransaction,
    root: Path,
    *,
    now: datetime,
    retain_days: int,
    windows: dict[str, int],
    fresh_archive: str | None,
) -> int:
    """Append one ledger row per newly stripped artifact; idempotent.

    Reads EVERY ``artifact_index-compact-*.jsonl.gz`` archive, not only the
    one this run wrote: a store stripped before the ledger existed (the
    live store on 2026-09-13 — three compact archives, 176 dropped rows,
    no ledger) is healed by the next compaction, by construction, with no
    manual repair of ``aria/state``. A row already attested is skipped by
    artifact id, so re-running changes nothing.
    """
    from .runtime_artifacts import COMPACTIONS_SURFACE

    ledger = _compaction_ledger_path(root)
    existing: set[str] = set()
    if ledger.exists():
        existing = {
            str(row.get("artifact_id") or "")
            for row in transaction.load_declared_jsonl(ledger, expected_surface=COMPACTIONS_SURFACE)
        }
    attestations = _compaction_attestations(
        root, existing_ids=existing, now=now, retain_days=retain_days,
        windows=windows, fresh_archive=fresh_archive,
    )
    for row in attestations:
        transaction.append_declared_jsonl(ledger, row, expected_surface=COMPACTIONS_SURFACE)
    return len(attestations)


def _compaction_attestations(
    root: Path,
    *,
    existing_ids: set[str],
    now: datetime,
    retain_days: int,
    windows: dict[str, int],
    fresh_archive: str | None = None,
    pending: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """The ledger rows this compaction would append, in archive order.

    ``retain_days`` is THIS run's window and applies only to the archive
    this run wrote (``fresh_archive``) or would write (``pending``, the
    dry-run stand-in: the rows dropped from the index). Every earlier
    archive is judged by ``windows[archive]`` — the ``retain_days`` of
    the compaction that wrote it, read from governance — and an archive
    absent from ``windows`` is attested from not at all.
    """
    sources: list[tuple[str, datetime, list[dict[str, Any]], str]] = []
    for archive in _compact_archives(root):
        stamp = _archive_stamp(archive.name)
        if stamp is None:
            continue
        relative = archive.relative_to(root).as_posix()
        origin = ATTESTED_BY_COMPACTION if relative == fresh_archive else ATTESTED_BY_BACKFILL
        sources.append((relative, stamp, _read_archive_rows(archive), origin))
    if pending:
        sources.append(("archives/artifact_index-compact-pending.jsonl.gz", now, pending, ATTESTED_BY_COMPACTION))
    attested = set(existing_ids)
    rows: list[dict[str, Any]] = []
    compacted_at = utc_now()
    for relative, stamp, archived, origin in sources:
        # The window that was in force when the archive was written: an
        # artifact this old was retention's to remove at that moment. A
        # row inside that window names an artifact absent for some other
        # reason, and no later compaction may re-judge it as policy —
        # which is why the window is the WRITING compaction's, not ours.
        if origin == ATTESTED_BY_COMPACTION:
            window = retain_days
        elif relative in windows:
            window = windows[relative]
        else:
            continue
        cutoff = stamp - timedelta(days=window)
        for row in archived:
            artifact_id = str(row.get("artifact_id") or "")
            uri = str(row.get("current_uri") or "")
            if not artifact_id or not uri or artifact_id in attested:
                continue
            # Present again (a restore rehydrated it) is verified by its
            # bytes, not attested.
            if (root / uri).is_file():
                continue
            if not _retention_removed(row, cutoff=cutoff):
                continue
            attested.add(artifact_id)
            rows.append({
                "schema_version": 1,
                "artifact_id": artifact_id,
                "uri": uri,
                "sha256": str(row.get("sha256") or ""),
                "cycle_id": str(row.get("cycle_uid") or row.get("cycle_id") or ""),
                "run_id": row.get("run_id") if isinstance(row.get("run_id"), str) else None,
                "kind": str(row.get("kind") or ""),
                "compacted_at": compacted_at,
                "archive": relative,
                "retain_days": window,
                "retention_cutoff": cutoff.isoformat(),
                "attested_by": origin,
            })
    return rows


def _retention_removed(row: dict[str, Any], *, cutoff: datetime) -> bool:
    """Was this artifact retention's to remove — is it older than the window?"""
    stamp = _cycle_timestamp(str(row.get("cycle_uid") or row.get("cycle_id") or ""))
    if stamp is None:
        stamp = _parse_ts(row.get("created_at"))
    return stamp is not None and stamp < cutoff


def _compact_archives(root: Path) -> list[Path]:
    """Every compact archive of dropped index rows, oldest first."""
    return sorted((root / "archives").glob("artifact_index-compact-*.jsonl.gz"))


def _archive_windows(root: Path, archives: list[Path]) -> dict[str, int]:
    """The retention window in force when each compact archive was written.

    ``{archive tools-relative path: retain_days}`` for every archive a
    ``state_compacted`` governance row vouches for. The window was an input
    to the run that wrote the archive, and that run's governance row is the
    only place it was recorded:

    - a row that carries ``artifact_index_archive`` names its archive, and
      binds only that one — a row naming nothing (a run that dropped no
      rows) or another archive never speaks for this one;
    - a row without the key predates it (the nine rows on the live store
      when the ledger was introduced, each stamped to the second of its
      archive) and is paired by clock: the first such row stamped at or
      after the archive, provided it precedes the next archive — the row
      is appended seconds after the archive it describes, so one that
      lands past the next archive belongs to a later run.

    An archive neither rule pairs (a run that died between the archive
    and its governance row) has no window here; the caller attests
    nothing from it, and its artifacts stay visibly missing rather than
    judged under a guessed window.
    """
    named: dict[str, int] = {}
    by_clock: list[tuple[datetime, int]] = []
    governance = root / "governance.jsonl"
    rows = load_declared_jsonl(governance, expected_surface="tools_governance") if governance.exists() else []
    for row in rows:
        details = row.get("details")
        if row.get("kind") != COMPACTED_EVENT or not isinstance(details, dict):
            continue
        window = details.get("retain_days")
        if isinstance(window, bool) or not isinstance(window, int) or window < 0:
            continue
        if ARCHIVE_KEY in details:
            archive = details[ARCHIVE_KEY]
            if isinstance(archive, str) and archive:
                named.setdefault(archive, window)
            continue
        stamp = _parse_ts(row.get("ts"))
        if stamp is not None:
            by_clock.append((stamp, window))
    by_clock.sort(key=lambda item: item[0])
    stamped = [
        (archive.relative_to(root).as_posix(), stamp)
        for archive in archives
        if (stamp := _archive_stamp(archive.name)) is not None
    ]
    windows: dict[str, int] = {}
    for position, (relative, stamp) in enumerate(stamped):
        if relative in named:
            windows[relative] = named[relative]
            continue
        following = stamped[position + 1][1] if position + 1 < len(stamped) else None
        for row_stamp, window in by_clock:
            if row_stamp < stamp:
                continue
            if following is None or row_stamp < following:
                windows[relative] = window
            break
    return windows


def _archive_stamp(name: str) -> datetime | None:
    match = _ARCHIVE_STAMP.match(name)
    if match is None:
        return None
    return datetime.strptime(match.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)


def _read_archive_rows(archive: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with gzip.open(archive, "rt", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
    return rows


def _compact_runs(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="runs")
    kept: list[dict[str, Any]] = []
    stripped_rows: list[dict[str, Any]] = []
    stripped = 0
    for row in rows:
        recorded = _parse_ts(row.get("recorded_at"))
        if recorded is not None and recorded < cutoff:
            will_strip = False
            ev = row.get("evidence_validation")
            if isinstance(ev, dict) and isinstance(ev.get("evidence_envelopes"), list):
                will_strip = True
            rp = row.get("read_paths")
            if isinstance(rp, list) and len(rp) > 20:
                will_strip = True
            if will_strip:
                # The archive must carry the row as it was BEFORE slimming.
                # `row` is mutated in place below and `kept.append(row)`
                # aliases it, so any shallow copy taken after the first
                # mutation archives the slimmed row — the loss the
                # "nothing is lost" contract exists to prevent.
                stripped_rows.append(copy.deepcopy(row))
            if isinstance(ev, dict) and isinstance(ev.get("evidence_envelopes"), list):
                envelopes = ev.pop("evidence_envelopes")
                ev["evidence_envelope_count"] = len(envelopes)
                stripped += 1
            if isinstance(rp, list) and len(rp) > 20:
                row["read_paths_count"] = len(rp)
                row["read_paths"] = rp[:5]
        kept.append(row)
    if dry_run or stripped == 0:
        return len(kept), stripped
    _archive_stripped(root, "runs", stripped_rows)
    rewrite_declared_jsonl(path, kept, expected_surface="runs", migration_id=f"compact_runs_{utc_now()}")
    return len(kept), stripped


def _compact_raw_findings(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="raw_findings")
    surviving = _collapse_survivors(rows)
    kept: list[dict[str, Any]] = []
    archived_rows: list[dict[str, Any]] = []
    removed = 0
    for index, row in enumerate(rows):
        if _raw_finding_key(row) is not None and index not in surviving:
            archived_rows.append(copy.deepcopy(row))
            removed += 1
            continue
        recorded = _parse_ts(row.get("recorded_at"))
        if recorded is not None and recorded < cutoff and "finding" in row:
            archived_rows.append(copy.deepcopy(row))
            finding = row.pop("finding")
            if "finding_summary" not in row and isinstance(finding, dict):
                row["finding_summary"] = {
                    "rule": str(finding.get("rule") or ""),
                    "id": str(finding.get("id") or ""),
                }
            removed += 1
        kept.append(row)
    if dry_run or removed == 0:
        return len(kept), removed
    _archive_stripped(root, "raw_findings", archived_rows)
    rewrite_declared_jsonl(path, kept, expected_surface="raw_findings", migration_id=f"compact_raw_findings_{utc_now()}")
    return len(kept), removed


def _collapse_survivors(rows: list[dict[str, Any]]) -> set[int]:
    """Indexes of the fingerprinted raw-finding rows the collapse keeps.

    WHAT: the newest row per (tool_id, finding_fingerprint) — the
    ARIA-HIGH-185 collapse — plus, for every run the collapse would leave
    with no raw row at all, that run's newest row. Rows without a
    fingerprint are not decided here: the caller keeps them untouched.

    WHY the per-run floor (ARIA-HIGH-239). ``verify_runtime_artifacts``
    refuses a run that reports raw findings (``runner.raw_findings_count``)
    but has neither a raw row nor a readable artifact carrying them:
    ``raw_pointer_missing``. The fingerprint collapse alone empties every
    older run whose findings recur in a newer one, and once an earlier
    compaction has pruned that run's hot artifact nothing reaches its
    findings any more. So the kernel's own compaction produced a tree the
    kernel's own verifier refused — 55 runs on the 2026-09-27 aria/state
    tip, every ``aria-state-maintenance`` run since 2026-09-21 red, and
    every publish that bounds its surfaces by compacting refused as
    unverified. Keeping one row per run makes that output impossible by
    construction instead of relaxing the verifier: the kept row is a real
    pointer the run recorded, verified exactly as before, and the
    collapsed copies go to the archive like every other stripped row. The
    floor costs one thin row per run, bounded by ``runs.jsonl`` itself,
    not by how often a finding recurs.
    """
    newest_by_fingerprint: dict[tuple[str, str], int] = {}
    newest_by_run: dict[str, int] = {}
    for index, row in enumerate(rows):
        key = _raw_finding_key(row)
        if key is None:
            continue
        current = newest_by_fingerprint.get(key)
        if current is None or _raw_finding_recorded(rows[current]) <= _raw_finding_recorded(row):
            newest_by_fingerprint[key] = index
        run_id = str(row.get("run_id") or "")
        if run_id:
            latest = newest_by_run.get(run_id)
            if latest is None or _raw_finding_recorded(rows[latest]) <= _raw_finding_recorded(row):
                newest_by_run[run_id] = index
    surviving = set(newest_by_fingerprint.values())
    # A run is covered when any row of it stays: a surviving fingerprinted
    # row, or an unfingerprinted one (kept untouched by the caller).
    covered = {str(rows[index].get("run_id") or "") for index in surviving}
    covered.update(str(row.get("run_id") or "") for row in rows if _raw_finding_key(row) is None)
    surviving.update(index for run_id, index in newest_by_run.items() if run_id not in covered)
    return surviving


def _raw_finding_key(row: dict[str, Any]) -> tuple[str, str] | None:
    """The identity a raw-finding row keeps across cycles, or None for a
    row without a fingerprint (legacy rows stay untouched by the collapse)."""
    tool_id = str(row.get("tool_id") or "")
    fingerprint = str(row.get("finding_fingerprint") or "")
    if not tool_id or not fingerprint:
        return None
    return tool_id, fingerprint


def _raw_finding_recorded(row: dict[str, Any]) -> datetime:
    """Recording time for the newest-row choice; an unparseable time sorts
    oldest so a dated row always wins over an undated one."""
    return _parse_ts(row.get("recorded_at")) or datetime.min.replace(tzinfo=timezone.utc)


def _archive_stripped(root: Path, surface: str, stripped_rows: list[dict[str, Any]]) -> str:
    """Archive exactly the rows compaction removed or slimmed, pristine.

    Returns the archive's tools-relative path — the compaction ledger names
    the archive that holds each dropped index row.

    The archive is the "nothing is lost" half of the compaction contract:
    every row it receives must carry the data the live ledger lost. That
    is why callers pass pre-mutation copies for in-place slimming (runs,
    raw_findings) and the untouched dropped rows for whole-row removal
    (the raw-findings collapse, the artifact index) — never a list that
    aliases `kept`, whose rows were slimmed before this function could see
    them.
    """
    archive_dir = root / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = archive_dir / f"{surface}-compact-{timestamp}.jsonl.gz"
    with gzip.open(archive_path, "wt", encoding="utf-8") as fh:
        for row in stripped_rows:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
    return archive_path.relative_to(root).as_posix()


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


__all__ = (
    "ARCHIVE_KEY",
    "ATTESTED_ARTIFACTS_KEY",
    "ATTESTED_BY_BACKFILL",
    "ATTESTED_BY_COMPACTION",
    "COMPACTABLE_SURFACES",
    "COMPACTED_EVENT",
    "COMPACTION_TRIGGER_BYTES",
    "COLD_EVICTED_EVENT",
    "COLD_EVICTION_KEEP_CYCLES",
    "ColdStaging",
    "SurfaceBoundError",
    "bound_compactable_surfaces",
    "cold_eviction_candidates",
    "compact_state",
    "compact_surfaces",
    "evict_to_cold",
)
