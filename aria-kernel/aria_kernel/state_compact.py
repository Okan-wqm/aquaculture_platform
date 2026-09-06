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

Stripped data is written to archives/<surface>-compact-<sha256>.jsonl.gz
so nothing is lost. Ledgers are re-chained via rewrite_declared_jsonl.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import StateTransaction, load_declared_jsonl, state_transaction
from .tool_registry import GovernanceError, append_tools_governance, tools_dir, utc_now


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
        root = tools_dir(base_dir)
    from .runtime_artifacts import verify_artifacts

    verdict = verify_artifacts(base_dir=root)
    if not verdict["valid"]:
        raise GovernanceError("state_compaction_artifact_integrity_failed:" + json.dumps(verdict["issues"], sort_keys=True))
    from .runtime_artifacts import ARTIFACT_PROJECTION_PATHS

    cutoff = datetime.now(timezone.utc) - timedelta(days=retain_days)
    results: dict[str, Any] = {"dry_run": dry_run, "cutoff": cutoff.isoformat(), "surfaces": {}}
    compactors = [
        ("runs", "runs", _compact_runs),
        ("raw_findings", "raw_findings", _compact_raw_findings),
        ("beliefs", "memory_beliefs", _compact_beliefs),
        ("learning_events", "memory_learning_events", _compact_learning_events),
    ]
    paths = [_surface_path(root, name) for name, _expected, _compactor in compactors]
    paths.extend(root / relative for relative in ARTIFACT_PROJECTION_PATHS.values())
    paths.extend([root / "retention/events.jsonl", root / "governance.jsonl"])
    # All source reads, selection, durable archives, receipts and rewrites
    # share the declared lock closure. A normal concurrent append therefore
    # lands before selection or after the rewrite and cannot disappear.
    # Dry-run acquires no sidecar-creating locks and writes no bytes.
    boundary = nullcontext(None) if dry_run else state_transaction(paths)
    with boundary as transaction:
        if transaction is not None:
            verdict = verify_artifacts(base_dir=root)
            if not verdict["valid"]:
                raise GovernanceError("state_compaction_artifact_integrity_failed:" + json.dumps(verdict["issues"], sort_keys=True))
        for name, expected, compactor in compactors:
            path = _surface_path(root, name)
            if not path.exists():
                continue
            before_bytes = path.stat().st_size
            rows = (
                transaction.load_declared_jsonl(path, expected_surface=expected)
                if transaction is not None
                else load_declared_jsonl(path, expected_surface=expected)
            )
            kept, stripped = compactor(rows, cutoff)
            if stripped and transaction is not None:
                _archive_stripped(root, name, stripped, transaction=transaction)
                transaction.rewrite_declared_jsonl(
                    path, kept, expected_surface=expected,
                    migration_id=f"compact_{name}_{utc_now()}",
                )
            results["surfaces"][name] = {
                "before_bytes": before_bytes,
                "after_bytes": 0 if dry_run else path.stat().st_size,
                "before_rows": len(rows), "after_rows": len(kept),
                "kept_rows": len(kept), "stripped_rows": len(stripped),
            }
        # Artifact lifecycle changes belong to runtime retention. Original
        # URIs remain mandatory and deletion is disabled by policy.
        results["hot_artifacts_removed"] = 0
        results["artifact_index_rows_dropped"] = 0
        results["fates_removed"] = 0
        if transaction is not None:
            append_tools_governance(root, "state_compacted", {
                "retain_days": retain_days,
                "surfaces": {
                    name: {"before": stats["before_bytes"], "after": stats["after_bytes"]}
                    for name, stats in results["surfaces"].items()
                },
            }, transaction=transaction)
    return results


def _surface_path(root: Path, surface: str) -> Path:
    mapping = {
        "runs": root / "runs.jsonl",
        "raw_findings": root / "raw-findings.jsonl",
        "beliefs": root / "memory" / "beliefs.jsonl",
        "learning_events": root / "memory" / "learning-events.jsonl",
    }
    return mapping[surface]


def _compact_runs(rows: list[dict[str, Any]], cutoff: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    kept: list[dict[str, Any]] = []
    stripped_rows: list[dict[str, Any]] = []
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
            if isinstance(rp, list) and len(rp) > 20:
                row["read_paths_count"] = len(rp)
                row["read_paths"] = rp[:5]
        kept.append(row)
    return kept, stripped_rows


def _compact_raw_findings(rows: list[dict[str, Any]], cutoff: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    kept: list[dict[str, Any]] = []
    stripped_rows: list[dict[str, Any]] = []
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
        kept.append(row)
    return kept, stripped_rows


def _compact_beliefs(rows: list[dict[str, Any]], cutoff: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        bid = str(row.get("belief_id") or "")
        if bid:
            latest[bid] = row
    kept = list(latest.values())
    kept_ids = {id(row) for row in kept}
    return kept, [row for row in rows if id(row) not in kept_ids]


def _compact_learning_events(rows: list[dict[str, Any]], cutoff: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    kept = [row for row in rows if (_parse_ts(row.get("recorded_at")) or datetime.now(timezone.utc)) >= cutoff]
    kept_ids = {id(row) for row in kept}
    return kept, [row for row in rows if id(row) not in kept_ids]


def _archive_stripped(
    root: Path, surface: str, stripped_rows: list[dict[str, Any]], *, transaction: StateTransaction,
) -> None:
    """Archive exactly the rows compaction removed or slimmed, pristine.

    The archive is the "nothing is lost" half of the compaction contract:
    every row it receives must carry the data the live ledger lost. That
    is why callers pass pre-mutation copies for in-place slimming (runs,
    raw_findings) and the untouched dropped rows for whole-row removal
    (beliefs, learning_events) — never a list that aliases `kept`, whose
    rows were slimmed before this function could see them.
    """
    from .runtime_artifacts import _atomic_write_bytes

    content = "".join(json.dumps(row, sort_keys=True) + "\n" for row in stripped_rows).encode("utf-8")
    compressed = gzip.compress(content, mtime=0)
    digest = hashlib.sha256(compressed).hexdigest()
    archive_path = root / "archives" / f"{surface}-compact-{digest}.jsonl.gz"
    if archive_path.exists():
        if archive_path.read_bytes() != compressed:
            raise GovernanceError("compaction_archive_hash_mismatch")
    else:
        _atomic_write_bytes(archive_path, compressed)
    observed = archive_path.read_bytes()
    if hashlib.sha256(observed).hexdigest() != digest or gzip.decompress(observed) != content:
        raise GovernanceError("compaction_archive_hash_mismatch")
    transaction.append_declared_jsonl(root / "retention/events.jsonl", {
        "event": "ledger_compacted", "surface": surface,
        "archive_path": archive_path.relative_to(root).as_posix(),
        "archive_sha256": "sha256:" + digest,
        "source_sha256": "sha256:" + hashlib.sha256(content).hexdigest(),
        "count": len(stripped_rows), "reason": "state_compaction",
        "verification_status": "verified", "recorded_at": utc_now(),
    }, expected_surface="retention_events")


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


__all__ = ("compact_state",)
