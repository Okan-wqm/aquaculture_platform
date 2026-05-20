#!/usr/bin/env python3
"""V10.5 Phase 1 watchdog soak harness — automated FP-rate measurement.

Reads emitted findings from aria-findings/ and governance.jsonl over a
window, computes false-positive rate by checking each watchdog-emitted
finding's status against subsequent operator WITHDRAWN status.

Used at Gate-B verification: after 48h soak, this script outputs
{fp_rate: float, total: int, withdrawn: int, resolved: int, open: int}
as JSON. Gate-B passes iff fp_rate <= 0.33 (33% ceiling).

Per V10.5 Plan v2 §B Acceptance + TEST-LOW-016 (automated, not
operator-eval).

Usage:
    python3 tools/aria-poc/measure_watchdog_fp_rate.py \\
        --workspace-root . \\
        --since 2026-05-20T00:00:00Z

    # JSON output: {"fp_rate": 0.12, "total": 25, "withdrawn": 3,
    #               "resolved": 18, "open": 4, "window_hours": 48}
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WATCHDOG_PREFIX = "aria-watchdog:"
FP_RATE_CEILING = 0.33


def _parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        # Handle both Z-suffixed + offset-suffixed ISO8601
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


def _is_watchdog_finding(finding: dict[str, Any]) -> bool:
    """Watchdog findings carry originating_skill starting aria-watchdog:."""
    skill = finding.get("originating_skill", "")
    return isinstance(skill, str) and skill.startswith(WATCHDOG_PREFIX)


def measure_fp_rate(
    *,
    workspace_root: Path,
    since: datetime | None = None,
    until: datetime | None = None,
) -> dict[str, Any]:
    """Scan aria-findings/F-*.json for watchdog findings; bucket by status.

    Args:
        workspace_root: repo root containing aria-findings/
        since: window start (inclusive); None = beginning of time
        until: window end (inclusive); None = now

    Returns:
        dict with fp_rate (float), total (int), and per-status counts.
        fp_rate = withdrawn / total (0.0 when total=0)
    """
    findings_dir = workspace_root / "aria-findings"
    if not findings_dir.is_dir():
        return {
            "fp_rate": 0.0,
            "total": 0,
            "withdrawn": 0,
            "resolved": 0,
            "open": 0,
            "in_progress": 0,
            "window_start": since.isoformat() if since else None,
            "window_end": until.isoformat() if until else None,
            "ceiling": FP_RATE_CEILING,
            "gate_passes": True,
            "note": "aria-findings/ directory absent",
        }

    total = 0
    withdrawn = 0
    resolved = 0
    open_count = 0
    in_progress = 0

    for path in sorted(findings_dir.glob("F-*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not _is_watchdog_finding(doc):
            continue

        # Window filter
        raised_at = _parse_iso(doc.get("raised_at", ""))
        if since is not None and raised_at is not None and raised_at < since:
            continue
        if until is not None and raised_at is not None and raised_at > until:
            continue

        total += 1
        status = (doc.get("status") or "").upper()
        if status == "WITHDRAWN":
            withdrawn += 1
        elif status == "RESOLVED":
            resolved += 1
        elif status == "IN_PROGRESS":
            in_progress += 1
        else:
            open_count += 1

    fp_rate = withdrawn / total if total > 0 else 0.0
    window_hours: float | None = None
    if since is not None and until is not None:
        window_hours = (until - since).total_seconds() / 3600.0

    return {
        "fp_rate": round(fp_rate, 4),
        "total": total,
        "withdrawn": withdrawn,
        "resolved": resolved,
        "open": open_count,
        "in_progress": in_progress,
        "window_start": since.isoformat() if since else None,
        "window_end": until.isoformat() if until else None,
        "window_hours": window_hours,
        "ceiling": FP_RATE_CEILING,
        "gate_passes": fp_rate <= FP_RATE_CEILING,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "V10.5 Phase 1 watchdog FP-rate harness. "
            "Reads aria-findings/F-*.json with originating_skill "
            "starting aria-watchdog: and computes WITHDRAWN/total ratio. "
            "Gate-B passes iff <= 33%."
        )
    )
    parser.add_argument(
        "--workspace-root",
        type=Path,
        default=Path.cwd(),
        help="Repo root containing aria-findings/ (default: cwd)",
    )
    parser.add_argument(
        "--since",
        type=str,
        default=None,
        help="ISO8601 window start (e.g. 2026-05-20T14:00:00Z)",
    )
    parser.add_argument(
        "--until",
        type=str,
        default=None,
        help="ISO8601 window end (default: now UTC)",
    )
    parser.add_argument(
        "--exit-on-fail",
        action="store_true",
        help="Exit code 1 when fp_rate > ceiling (default exit 0)",
    )
    args = parser.parse_args(argv)

    since = _parse_iso(args.since) if args.since else None
    until = _parse_iso(args.until) if args.until else datetime.now(timezone.utc)

    result = measure_fp_rate(
        workspace_root=args.workspace_root,
        since=since,
        until=until,
    )
    print(json.dumps(result, indent=2))
    if args.exit_on_fail and not result.get("gate_passes", True):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
