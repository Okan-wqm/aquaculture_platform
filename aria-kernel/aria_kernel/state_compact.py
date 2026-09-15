"""ORPHAN-HIGH-798 (compact half) — shrink the state branch's bloated ledgers.

The write-time fix (PR-1) stopped NEW bloat; this module shrinks EXISTING
data. The push was refused because raw-findings.jsonl hit 57.84MB and
runs.jsonl hit 94.5MB — both over GitHub's 50MB recommendation.

What it does (per surface, all lossless via archives):
- runs.jsonl: strips evidence_validation.evidence_envelopes and read_paths
  from rows older than --retain-days (keeps counts + artifact_ref)
- raw-findings.jsonl: strips inline finding objects from rows older than
  --retain-days (keeps finding_summary + artifact_ref)
- memory/beliefs.jsonl: collapses to latest row per belief_id
- memory/learning-events.jsonl: keeps rows newer than --retain-days

Stripped data is written to archives/<surface>-compact-<timestamp>.jsonl.gz
so nothing is lost. Ledgers are re-chained via rewrite_declared_jsonl.

THE PRUNE IS ATTESTED, NOT ACKNOWLEDGED. Hot-artifact directories and
discovery FATES are removed outright (retention, not slimming), and every
file under them is a declared surface the published snapshot claims. The
next publish therefore sees ``surfaces_lost`` — the continuity gate that
exists to catch amnesia. Until this module recorded what it pruned, the
only way past that gate was ``ARIA_STATE_BOOTSTRAP_ACK``, an operator
acknowledgement that names a one-off fresh start and that the bootstrap
runbook says must never live in a workflow. So the ``state_compacted``
governance row now carries ``pruned_paths`` — the exact tools-relative
paths and directory prefixes this run removed — and ``publish_state``
accepts a loss iff a compaction row appended since the published tip
names it. Policy-driven forgetting is then proven by the process that
did it, and the ack keeps its one meaning.

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
import json
import os
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import StateTransaction, load_declared_jsonl, rewrite_declared_jsonl, state_transaction
from .state_manifest import resolve_surface_path, surface_by_name
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now

# The governance event compaction records, and the field inside it that a
# later publish reads as the attestation for the surfaces it prunes.
COMPACTED_EVENT = "state_compacted"
PRUNED_PATHS_KEY = "pruned_paths"
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
    results: dict[str, Any] = {"dry_run": dry_run, "cutoff": cutoff.isoformat(), "surfaces": {}}

    for surface_name, compactor in [
        ("runs", _compact_runs),
        ("raw_findings", _compact_raw_findings),
        ("beliefs", _compact_beliefs),
        ("learning_events", _compact_learning_events),
    ]:
        path = _surface_path(root, surface_name)
        if not path.exists():
            continue
        before_bytes = path.stat().st_size
        before_rows = sum(1 for _ in path.open(encoding="utf-8"))
        kept_rows, stripped_rows = compactor(path, root, cutoff, dry_run)
        after_bytes = 0 if dry_run else path.stat().st_size
        after_rows = 0 if dry_run else sum(1 for _ in path.open(encoding="utf-8"))
        results["surfaces"][surface_name] = {
            "before_bytes": before_bytes,
            "after_bytes": after_bytes,
            "before_rows": before_rows,
            "after_rows": after_rows,
            "kept_rows": kept_rows,
            "stripped_rows": stripped_rows,
        }

    # Non-ledger surfaces the maintenance lane historically stripped in a
    # workflow-inline copy of this compactor. That copy diverged (silent
    # skip of malformed lines, rewrites without re-chaining) and was
    # retired; the cleanup moved HERE so one implementation serves both
    # the CLI and the lane (ARIA-AUDIT-001).
    now = datetime.now(timezone.utc)
    pruned_hot_dirs = _strip_hot_artifacts(root, cutoff, dry_run)
    results["hot_artifacts_removed"] = len(pruned_hot_dirs)
    # ORPHAN-CRITICAL-805 — the index has to follow the files it describes.
    # Deleting a cycle's artifacts and leaving its index rows behind makes
    # verify_artifacts report `run_artifact_missing` forever, which turns
    # every future cycle's runtime_status into integrity_failed no matter
    # how the night actually went. ARIA-HIGH-117 — and the run refs and
    # raw pointers that still name the dropped artifacts are attested on
    # the compaction ledger in the same transaction.
    dropped_rows, attested, fresh_archive = _compact_artifact_index(
        root, now=now, retain_days=retain_days, pruned_hot_dirs=pruned_hot_dirs, dry_run=dry_run,
    )
    results["artifact_index_rows_dropped"] = dropped_rows
    results[ATTESTED_ARTIFACTS_KEY] = attested
    results[ARCHIVE_KEY] = fresh_archive
    pruned_fates = _strip_discovery_fates(root, now, dry_run)
    results["fates_removed"] = len(pruned_fates)
    # Directory prefixes end with "/" so a reader can tell "everything
    # under this cycle" from "exactly this file" without a second field.
    results[PRUNED_PATHS_KEY] = sorted(
        [f"{path}/" for path in pruned_hot_dirs] + list(pruned_fates)
    )

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
                PRUNED_PATHS_KEY: results[PRUNED_PATHS_KEY],
                ATTESTED_ARTIFACTS_KEY: results[ATTESTED_ARTIFACTS_KEY],
                ARCHIVE_KEY: results[ARCHIVE_KEY],
            },
        )
    return results


def attested_pruned_paths(
    root: str | Path,
    *,
    governance_rows_since: int,
) -> tuple[str, ...]:
    """Every tools-relative path or ``dir/`` prefix a compaction attested.

    Read from the governance rows appended at index ``governance_rows_since``
    and later — the published snapshot's ``row_count`` for the governance
    ledger, i.e. exactly the rows this run added on top of the tip. Older
    rows attest prunes the tip already reflects, so reading them would add
    nothing; a stale tip whose claimed row_count lags (a non-kernel commit)
    yields a superset, which only re-attests paths that are already gone.
    """
    path = Path(root) / "governance.jsonl"
    if not path.exists() or governance_rows_since < 0:
        return ()
    rows = load_declared_jsonl(path, expected_surface="tools_governance")
    attested: set[str] = set()
    for row in rows[governance_rows_since:]:
        if row.get("kind") != COMPACTED_EVENT:
            continue
        details = row.get("details")
        pruned = details.get(PRUNED_PATHS_KEY) if isinstance(details, dict) else None
        if isinstance(pruned, list):
            attested.update(item for item in pruned if isinstance(item, str) and item)
    return tuple(sorted(attested))


def prune_attested(relative_path: str, attested: tuple[str, ...] | list[str]) -> bool:
    """Whether one tools-relative surface path is covered by an attestation."""
    for entry in attested:
        if entry.endswith("/"):
            if relative_path.startswith(entry):
                return True
        elif relative_path == entry:
            return True
    return False


def _surface_path(root: Path, surface: str) -> Path:
    mapping = {
        "runs": root / "runs.jsonl",
        "raw_findings": root / "raw-findings.jsonl",
        "beliefs": root / "memory" / "beliefs.jsonl",
        "learning_events": root / "memory" / "learning-events.jsonl",
    }
    return mapping[surface]


# Discovery FATES age out on a fixed 30-day clock, independent of
# --retain-days: they are per-run scratch, and the maintenance contract
# this kernelized never tied them to the ledger retention window.
DISCOVERY_FATES_RETAIN_DAYS = 30


def _cycle_timestamp(name: str) -> datetime | None:
    """Parse the UTC stamp out of a hot-artifact cycle directory name.

    Cycle IDs carry their own clock: ``cyc-20260822T153253Z-auto``.
    """
    if not name.startswith("cyc-"):
        return None
    try:
        return datetime.strptime(name[4:19], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _strip_hot_artifacts(root: Path, cutoff: datetime, dry_run: bool) -> list[str]:
    """Remove hot-artifact cycle directories older than the cutoff.

    The single biggest state-branch contributor (old cycles'
    tool_run.json files). A name that does not carry a parseable cycle
    stamp falls back to mtime, matching the retired workflow contract.
    Returns the tools-relative directories removed — the attestation the
    publish gate matches lost surfaces against by prefix.
    """
    hot = root / "run-artifacts" / "hot"
    if not hot.is_dir():
        return []
    removed: list[str] = []
    for item in sorted(hot.iterdir()):
        if not item.is_dir():
            continue
        stamp = _cycle_timestamp(item.name)
        if stamp is None:
            try:
                stamp = datetime.fromtimestamp(item.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
        if stamp < cutoff:
            if not dry_run:
                shutil.rmtree(item, ignore_errors=True)
            removed.append(item.relative_to(root).as_posix())
    return removed


def _compact_artifact_index(
    root: Path,
    *,
    now: datetime,
    retain_days: int,
    pruned_hot_dirs: list[str],
    dry_run: bool,
) -> tuple[int, int, str | None]:
    """Drop index rows whose artifact file is no longer on disk, and attest
    on the compaction ledger every artifact the retention policy stripped.

    Returns ``(index rows dropped, artifacts attested, archive written)``
    — the archive is the tools-relative path of this run's compact archive
    of dropped rows, or None when it dropped none.

    WHY this exists (ORPHAN-CRITICAL-805). `_strip_hot_artifacts` rmtree's
    whole cycle directories, and nothing updated
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

    ARIA-HIGH-117 — presence decides what leaves the INDEX; the retention
    policy decides what the LEDGER attests. A dropped row whose cycle is
    older than the window this compaction applied (or whose hot directory
    this very run removed) is attested as compacted; a dropped row inside
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
    # In a real run the hot sweep has already removed these directories; a
    # dry run leaves them in place, so "would be absent" is the same
    # question asked of the sweep's answer rather than of the disk.
    pruned_prefixes = tuple(f"{prefix}/" for prefix in pruned_hot_dirs)
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for row in rows:
        uri = str(row.get("current_uri") or "")
        # A row with no uri cannot name a file and cannot be verified; it is
        # already an issue in verify_artifacts, so it goes with the rest.
        if uri and (root / uri).is_file() and not uri.startswith(pruned_prefixes):
            kept.append(row)
        else:
            dropped.append(row)
    earlier_archives = _compact_archives(root)
    windows = _archive_windows(root, earlier_archives) if earlier_archives else {}
    if dry_run:
        attestable = _compaction_attestations(
            root, existing_ids=_attested_artifact_ids(root), now=now, retain_days=retain_days,
            pruned_hot_dirs=pruned_hot_dirs, windows=windows, pending=dropped,
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
            pruned_hot_dirs=pruned_hot_dirs, windows=windows, fresh_archive=fresh_archive,
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
    pruned_hot_dirs: list[str],
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
        pruned_hot_dirs=pruned_hot_dirs, windows=windows, fresh_archive=fresh_archive,
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
    pruned_hot_dirs: list[str],
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
    prefixes = tuple(f"{prefix}/" for prefix in pruned_hot_dirs)
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
        # This run's own prune is authoritative for the directories it
        # removed; the stamp rule covers rows stranded by earlier prunes.
        pruned = prefixes if origin == ATTESTED_BY_COMPACTION else ()
        for row in archived:
            artifact_id = str(row.get("artifact_id") or "")
            uri = str(row.get("current_uri") or "")
            if not artifact_id or not uri or artifact_id in attested:
                continue
            # Present again (a restore rehydrated it) is verified by its
            # bytes, not attested; a dry run's pending prune counts as gone.
            if (root / uri).is_file() and not uri.startswith(prefixes):
                continue
            if not _retention_removed(row, uri, cutoff=cutoff, pruned_prefixes=pruned):
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


def _retention_removed(
    row: dict[str, Any], uri: str, *, cutoff: datetime, pruned_prefixes: tuple[str, ...],
) -> bool:
    """Was this artifact retention's to remove — by prune, or by age?"""
    if any(uri.startswith(prefix) for prefix in pruned_prefixes):
        return True
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


def _strip_discovery_fates(root: Path, now: datetime, dry_run: bool) -> list[str]:
    """Remove discovery FATES.json files older than the fixed 30-day clock.

    Returns the tools-relative paths removed, for the same attestation.
    """
    cutoff = now - timedelta(days=DISCOVERY_FATES_RETAIN_DAYS)
    disc = root / "discovery"
    if not disc.is_dir():
        return []
    removed: list[str] = []
    for fates in sorted(disc.rglob("FATES.json")):
        try:
            if datetime.fromtimestamp(fates.stat().st_mtime, tz=timezone.utc) < cutoff:
                if not dry_run:
                    fates.unlink()
                removed.append(fates.relative_to(root).as_posix())
        except OSError:
            continue
    return removed


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
    kept: list[dict[str, Any]] = []
    stripped_rows: list[dict[str, Any]] = []
    stripped = 0
    for row in rows:
        recorded = _parse_ts(row.get("recorded_at"))
        if recorded is not None and recorded < cutoff and "finding" in row:
            stripped_rows.append(copy.deepcopy(row))
            finding = row.pop("finding")
            if "finding_summary" not in row and isinstance(finding, dict):
                row["finding_summary"] = {
                    "rule": str(finding.get("rule") or ""),
                    "id": str(finding.get("id") or ""),
                }
            stripped += 1
        kept.append(row)
    if dry_run or stripped == 0:
        return len(kept), stripped
    _archive_stripped(root, "raw_findings", stripped_rows)
    rewrite_declared_jsonl(path, kept, expected_surface="raw_findings", migration_id=f"compact_raw_findings_{utc_now()}")
    return len(kept), stripped


def _compact_beliefs(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="memory_beliefs")
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        bid = str(row.get("belief_id") or "")
        if bid:
            latest[bid] = row
    kept = list(latest.values())
    stripped = len(rows) - len(kept)
    if dry_run or stripped == 0:
        return len(kept), stripped
    kept_ids = {id(k) for k in kept}
    _archive_stripped(root, "beliefs", [r for r in rows if id(r) not in kept_ids])
    rewrite_declared_jsonl(path, kept, expected_surface="memory_beliefs", migration_id=f"compact_beliefs_{utc_now()}")
    return len(kept), stripped


def _compact_learning_events(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="memory_learning_events")
    kept = [row for row in rows if (_parse_ts(row.get("recorded_at")) or datetime.now(timezone.utc)) >= cutoff]
    stripped = len(rows) - len(kept)
    if dry_run or stripped == 0:
        return len(kept), stripped
    kept_ids = {id(k) for k in kept}
    _archive_stripped(root, "learning_events", [r for r in rows if id(r) not in kept_ids])
    rewrite_declared_jsonl(path, kept, expected_surface="memory_learning_events", migration_id=f"compact_learning_{utc_now()}")
    return len(kept), stripped


def _archive_stripped(root: Path, surface: str, stripped_rows: list[dict[str, Any]]) -> str:
    """Archive exactly the rows compaction removed or slimmed, pristine.

    Returns the archive's tools-relative path — the compaction ledger names
    the archive that holds each dropped index row.

    The archive is the "nothing is lost" half of the compaction contract:
    every row it receives must carry the data the live ledger lost. That
    is why callers pass pre-mutation copies for in-place slimming (runs,
    raw_findings) and the untouched dropped rows for whole-row removal
    (beliefs, learning_events) — never a list that aliases `kept`, whose
    rows were slimmed before this function could see them.
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
    "COMPACTED_EVENT",
    "PRUNED_PATHS_KEY",
    "attested_pruned_paths",
    "compact_state",
    "prune_attested",
)
