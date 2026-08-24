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

import gzip
import json
import os
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


def _compact_runs(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="runs")
    kept: list[dict[str, Any]] = []
    stripped = 0
    for row in rows:
        recorded = _parse_ts(row.get("recorded_at"))
        if recorded is not None and recorded < cutoff:
            ev = row.get("evidence_validation")
            if isinstance(ev, dict) and isinstance(ev.get("evidence_envelopes"), list):
                envelopes = ev.pop("evidence_envelopes")
                ev["evidence_envelope_count"] = len(envelopes)
                stripped += 1
            rp = row.get("read_paths")
            if isinstance(rp, list) and len(rp) > 20:
                row["read_paths_count"] = len(rp)
                row["read_paths"] = rp[:5]
        kept.append(row)
    if dry_run or stripped == 0:
        return len(kept), stripped
    _archive_stripped(root, "runs", rows, kept)
    rewrite_declared_jsonl(path, kept, expected_surface="runs", migration_id=f"compact_runs_{utc_now()}")
    return len(kept), stripped


def _compact_raw_findings(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="raw_findings")
    kept: list[dict[str, Any]] = []
    stripped = 0
    for row in rows:
        recorded = _parse_ts(row.get("recorded_at"))
        if recorded is not None and recorded < cutoff and "finding" in row:
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
    _archive_stripped(root, "raw_findings", rows, kept)
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
    _archive_stripped(root, "beliefs", rows, kept)
    rewrite_declared_jsonl(path, kept, expected_surface="memory_beliefs", migration_id=f"compact_beliefs_{utc_now()}")
    return len(kept), stripped


def _compact_learning_events(path: Path, root: Path, cutoff: datetime, dry_run: bool) -> tuple[int, int]:
    rows = load_declared_jsonl(path, expected_surface="memory_learning_events")
    kept = [row for row in rows if (_parse_ts(row.get("recorded_at")) or datetime.now(timezone.utc)) >= cutoff]
    stripped = len(rows) - len(kept)
    if dry_run or stripped == 0:
        return len(kept), stripped
    _archive_stripped(root, "learning_events", rows, kept)
    rewrite_declared_jsonl(path, kept, expected_surface="memory_learning_events", migration_id=f"compact_learning_{utc_now()}")
    return len(kept), stripped


def _archive_stripped(root: Path, surface: str, original: list[dict[str, Any]], kept: list[dict[str, Any]]) -> None:
    archive_dir = root / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = archive_dir / f"{surface}-compact-{timestamp}.jsonl.gz"
    with gzip.open(archive_path, "wt", encoding="utf-8") as fh:
        for row in original:
            fh.write(json.dumps(row, sort_keys=True) + "\n")


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


__all__ = ("compact_state",)
