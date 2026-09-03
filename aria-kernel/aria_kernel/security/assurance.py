"""Plan 033 Faz 033c — the Assurance / Coverage Ledger.

WHY: for a fleet the question is not "did we find a bug" but "is every applicable
control on every asset tested with fresh evidence". This ledger records, per
(asset, control, profile_digest, pack_digest), a CLOSED status; coverage is folded
against the APPLICABLE cell set (not a Cartesian product), and an open vulnerability
is never counted as clean. Fleet-grade = not_tested → 0 and unknown → 0.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now

ASSURANCE_SURFACE = "security_assurance"
ASSURANCE_RELPATH: tuple[str, ...] = ("security", "assurance.jsonl")
ASSURANCE_STATUSES = (
    "NOT_TESTED", "TESTED_NO_VIOLATION", "VULNERABILITY_CONFIRMED",
    "INCONCLUSIVE", "STALE", "NOT_APPLICABLE", "HUMAN_REQUIRED",
)
# statuses that mean "we do NOT have a fresh clean answer here"
UNKNOWN_STATUSES = ("INCONCLUSIVE", "STALE", "HUMAN_REQUIRED")
DEFAULT_FRESHNESS_SECONDS = 7 * 24 * 3600


@dataclass(frozen=True)
class AssuranceCell:
    asset_id: str
    control_id: str


def applicable_cells(*, profile_row: dict[str, Any], pack_manifests: list[Any]) -> list[AssuranceCell]:
    """The (asset, control) set the APPLICABLE packs actually produce — the coverage
    denominator. Asset = a repo service; control = an applicable pack rule id."""
    services = []
    for c in profile_row.get("claims", []):
        if c.get("key") == "services":
            services = list(c.get("value") or [])
    cells: list[AssuranceCell] = []
    for manifest in pack_manifests:
        if not getattr(manifest, "applicable", False):
            continue
        for rule_id in getattr(manifest, "rule_ids", ()):
            control = f"{manifest.name}/{rule_id}"
            for service in services:
                cells.append(AssuranceCell(asset_id=f"service:{service}", control_id=control))
    return cells


def record_assurance(
    *, asset_id: str, control_id: str, status: str, profile_digest: str, pack_digest: str,
    evidence_ref: str | None = None, base_dir: str | Path | None = None, now: datetime | None = None,
) -> dict[str, Any]:
    if status not in ASSURANCE_STATUSES:
        raise ValueError(f"unknown assurance status {status!r}; closed set {ASSURANCE_STATUSES}")
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*ASSURANCE_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "schema_version": 1, "recorded_at": (now or datetime.now(timezone.utc)).isoformat() if now else utc_now(),
        "asset_id": asset_id, "control_id": control_id, "status": status,
        "profile_digest": profile_digest, "pack_digest": pack_digest, "evidence_ref": evidence_ref,
    }
    return append_declared_jsonl(path, row, expected_surface=ASSURANCE_SURFACE)


def _rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    path = ensure_tools_dir(base_dir).joinpath(*ASSURANCE_RELPATH)
    return load_declared_jsonl(path, expected_surface=ASSURANCE_SURFACE) if path.exists() else []


def _latest_by_cell(rows: list[dict[str, Any]], *, profile_digest: str) -> dict[tuple[str, str], dict[str, Any]]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if row.get("profile_digest") != profile_digest:
            continue
        latest[(str(row.get("asset_id")), str(row.get("control_id")))] = row
    return latest


def _is_fresh(row: dict[str, Any], *, now: datetime, freshness_seconds: int) -> bool:
    try:
        stamp = datetime.fromisoformat(str(row.get("recorded_at")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    return (now - stamp).total_seconds() <= freshness_seconds


def compute_coverage(
    *, profile_row: dict[str, Any], pack_manifests: list[Any], base_dir: str | Path | None = None,
    now: datetime | None = None, freshness_seconds: int = DEFAULT_FRESHNESS_SECONDS,
) -> dict[str, Any]:
    """Fold the ledger against the applicable cell set. Honest: a fresh clean answer is
    the only thing that counts toward clean_required_coverage; a stale answer is unknown."""
    stamp = now or datetime.now(timezone.utc)
    profile_digest = str(profile_row.get("profile_digest") or "unknown")
    cells = applicable_cells(profile_row=profile_row, pack_manifests=pack_manifests)
    latest = _latest_by_cell(_rows(base_dir), profile_digest=profile_digest)
    by_status: dict[str, int] = {s: 0 for s in ASSURANCE_STATUSES}
    tested = clean = 0
    for cell in cells:
        row = latest.get((cell.asset_id, cell.control_id))
        if row is None:
            status = "NOT_TESTED"
        else:
            status = str(row.get("status"))
            if status not in ASSURANCE_STATUSES:
                status = "INCONCLUSIVE"
            # a once-clean cell whose evidence is no longer fresh reads STALE, not clean
            if status == "TESTED_NO_VIOLATION" and not _is_fresh(row, now=stamp, freshness_seconds=freshness_seconds):
                status = "STALE"
        by_status[status] += 1
        if status not in ("NOT_TESTED", "NOT_APPLICABLE"):
            tested += 1
        if status == "TESTED_NO_VIOLATION":
            clean += 1
    total = len(cells)
    required = total - by_status["NOT_APPLICABLE"]
    not_tested = by_status["NOT_TESTED"]
    unknown = sum(by_status[s] for s in UNKNOWN_STATUSES)
    confirmed = by_status["VULNERABILITY_CONFIRMED"]
    ready = required > 0 and not_tested == 0 and unknown == 0 and confirmed == 0
    return {
        "profile_digest": profile_digest, "total_cells": total, "required_cells": required,
        "by_status": by_status, "tested_coverage": round(tested / total, 4) if total else 0.0,
        "clean_required_coverage": round(clean / required, 4) if required else 0.0,
        "not_tested": not_tested, "unknown": unknown, "vulnerability_confirmed": confirmed,
        "ready": ready,
        "gaps": ([f"not_tested={not_tested}"] if not_tested else []) + ([f"unknown={unknown}"] if unknown else [])
                + ([f"confirmed={confirmed}"] if confirmed else []),
    }


__all__ = [
    "ASSURANCE_RELPATH", "ASSURANCE_STATUSES", "ASSURANCE_SURFACE", "DEFAULT_FRESHNESS_SECONDS",
    "UNKNOWN_STATUSES", "AssuranceCell", "applicable_cells", "compute_coverage", "record_assurance",
]
