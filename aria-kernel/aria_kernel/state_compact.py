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
"""
from __future__ import annotations

import copy
import gzip
import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import load_declared_jsonl, rewrite_declared_jsonl
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now


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
    # Accept an explicit absolute path without requiring repo_identity.json:
    # the compact command runs on CLONED state (e.g. from the maintenance
    # lane) where the marker file may not exist. ensure_tools_dir is for
    # RUNTIME state resolution; compaction operates on whatever tree it
    # is given.
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
    results["hot_artifacts_removed"] = _strip_hot_artifacts(root, cutoff, dry_run)
    # ORPHAN-CRITICAL-805 — the index has to follow the files it describes.
    # Deleting a cycle's artifacts and leaving its index rows behind makes
    # verify_artifacts report `run_artifact_missing` forever, which turns
    # every future cycle's runtime_status into integrity_failed no matter
    # how the night actually went.
    results["artifact_index_rows_dropped"] = _compact_artifact_index(root, dry_run)
    results["fates_removed"] = _strip_discovery_fates(root, now, dry_run)

    if not dry_run:
        append_tools_governance(
            root,
            "state_compacted",
            {
                "retain_days": retain_days,
                "surfaces": {
                    name: {"before": s["before_bytes"], "after": s["after_bytes"]}
                    for name, s in results["surfaces"].items()
                },
            },
        )
    return results


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


def _strip_hot_artifacts(root: Path, cutoff: datetime, dry_run: bool) -> int:
    """Remove hot-artifact cycle directories older than the cutoff.

    The single biggest state-branch contributor (old cycles'
    tool_run.json files). A name that does not carry a parseable cycle
    stamp falls back to mtime, matching the retired workflow contract.
    """
    hot = root / "run-artifacts" / "hot"
    if not hot.is_dir():
        return 0
    removed = 0
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
            removed += 1
    return removed


def _compact_artifact_index(root: Path, dry_run: bool) -> int:
    """Drop index rows whose artifact file is no longer on disk.

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
    """
    from .runtime_artifacts import artifact_index_path, run_artifacts_root

    path = artifact_index_path(root)
    if not path.exists():
        return 0
    rows = load_declared_jsonl(path, expected_surface="runtime_artifact_index")
    artifacts_root = run_artifacts_root(root)
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for row in rows:
        uri = str(row.get("current_uri") or "")
        # A row with no uri cannot name a file and cannot be verified; it is
        # already an issue in verify_artifacts, so it goes with the rest.
        if uri and (artifacts_root.parent / uri).is_file():
            kept.append(row)
        else:
            dropped.append(row)
    if not dropped or dry_run:
        return len(dropped)
    _archive_stripped(root, "artifact_index", dropped)
    rewrite_declared_jsonl(
        path,
        kept,
        expected_surface="runtime_artifact_index",
        migration_id=f"compact_artifact_index_{utc_now()}",
    )
    return len(dropped)


def _strip_discovery_fates(root: Path, now: datetime, dry_run: bool) -> int:
    """Remove discovery FATES.json files older than the fixed 30-day clock."""
    cutoff = now - timedelta(days=DISCOVERY_FATES_RETAIN_DAYS)
    disc = root / "discovery"
    if not disc.is_dir():
        return 0
    removed = 0
    for fates in sorted(disc.rglob("FATES.json")):
        try:
            if datetime.fromtimestamp(fates.stat().st_mtime, tz=timezone.utc) < cutoff:
                if not dry_run:
                    fates.unlink()
                removed += 1
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


def _archive_stripped(root: Path, surface: str, stripped_rows: list[dict[str, Any]]) -> None:
    """Archive exactly the rows compaction removed or slimmed, pristine.

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


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


__all__ = ("compact_state",)
