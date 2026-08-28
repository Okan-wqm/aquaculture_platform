"""SI-4 — ARIA looks after the machine it lives on.

The runner's own disk, load and test-run debris were invisible to every
mechanism ARIA has. Measured on 2026-08-19: eight worktrees plus 8,430
stale `/tmp/aria-*` directories from red suite runs took the droplet from
43 GB free to 33 GB in one night, the production capacity lane went red
three times against its 35 GiB floor, and nothing in ARIA noticed — the
preflight only refuses to START a night below its floor (`preflight.
MIN_FREE_DISK_GB`), it never cleans and never tells anyone.

Two obligations live here, deliberately separated:

* the JANITOR removes what ARIA itself produced and no longer needs. It
  is conservative by construction: an age floor, an owned-prefix list,
  and never a running suite's scratch directory.
* the PROBE measures and, when the habitat is degraded, hands the fact
  to the mechanism that already turns external facts into work
  (`runtime_signal_bridge.ingest_runtime_signal`, the same entry the
  dataflow watchdog uses). It never deletes.

Cleaning is not a fix; it is hygiene. The probe is what makes the
underlying pressure visible so a real fix can be planned.
"""
from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ARIA's own scratch prefixes under the system temp dir. Anything not on
# this list is somebody else's file and the janitor never touches it —
# the blast radius is bounded by a literal, not by a heuristic.
OWNED_TEMP_PREFIXES: tuple[str, ...] = ("aria-", "aqua-")

# An hour is longer than any single kernel test and shorter than a night.
# Three hours is the same margin applied by hand on 2026-08-19 with no
# collateral damage; it stays the default so a suite that is merely slow
# is never robbed of its fixture.
DEFAULT_MIN_AGE_SECONDS: int = 3 * 60 * 60

# The production capacity lane refuses to act below 35 GiB and reserves
# 20 GiB for a deploy. ARIA's habitat threshold sits ABOVE the lane's
# floor on purpose: by the time the deploy lane is blocked the damage is
# already done, and the point of this probe is to be the earlier signal.
HABITAT_DEGRADED_FREE_GB: float = 40.0


@dataclass(frozen=True)
class SweepResult:
    """What a janitor pass did — reported, never silent."""

    removed: list[str] = field(default_factory=list)
    reclaimed_bytes: int = 0
    skipped_recent: int = 0
    failed: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "removed_count": len(self.removed),
            "removed": sorted(self.removed)[:20],
            "reclaimed_bytes": self.reclaimed_bytes,
            "skipped_recent": self.skipped_recent,
            "failed": sorted(self.failed)[:20],
        }


def _dir_size_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                continue
    return total


def sweep_stale_scratch(
    *,
    temp_root: str | Path = "/tmp",
    min_age_seconds: int = DEFAULT_MIN_AGE_SECONDS,
    now: float | None = None,
    dry_run: bool = False,
) -> SweepResult:
    """Remove ARIA's own abandoned scratch directories.

    A directory qualifies only when ALL of these hold: its name starts
    with an owned prefix, it sits directly under `temp_root` (no
    recursion — a nested match is somebody's structure, not our litter),
    and it has not been modified for `min_age_seconds`. Everything else
    is left alone and counted, so a pass that removes nothing still says
    what it saw.
    """
    root = Path(temp_root)
    stamp = time.time() if now is None else now
    removed: list[str] = []
    failed: list[str] = []
    skipped = 0
    reclaimed = 0
    if not root.is_dir():
        return SweepResult()
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.is_symlink():
            continue
        if not entry.name.startswith(OWNED_TEMP_PREFIXES):
            continue
        try:
            age = stamp - entry.lstat().st_mtime
        except OSError:
            failed.append(str(entry))
            continue
        if age < min_age_seconds:
            skipped += 1
            continue
        size = _dir_size_bytes(entry)
        if dry_run:
            removed.append(str(entry))
            reclaimed += size
            continue
        try:
            shutil.rmtree(entry)
        except OSError:
            failed.append(str(entry))
            continue
        removed.append(str(entry))
        reclaimed += size
    return SweepResult(
        removed=removed, reclaimed_bytes=reclaimed,
        skipped_recent=skipped, failed=failed,
    )


def probe_habitat(*, workspace_root: str | Path) -> dict[str, Any]:
    """Measure the habitat. Returns the facts; decides nothing."""
    try:
        usage = shutil.disk_usage(str(workspace_root))
        free_gb: float | None = usage.free / (1024 ** 3)
    except OSError:
        free_gb = None
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = -1.0
    return {
        "free_disk_gb": None if free_gb is None else round(free_gb, 2),
        "load_average": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "cpu_count": os.cpu_count() or 0,
        # An unprobeable disk is NOT degraded — the same honesty rule the
        # preflight applies: only a MEASURED shortage counts.
        "degraded": free_gb is not None and free_gb < HABITAT_DEGRADED_FREE_GB,
    }
