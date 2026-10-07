"""ARIA-HIGH-364 — the cycle's request-admission summary, as the daily report reads it.

The reflection row carries ``request_admission`` (this module's summary of
``agent-invocations/admissions.jsonl`` for the cycle) and the daily report
renders it as ``## Request Admission``: the drain the door measured, the
budget it derived, and per role what was admitted (by class) and refused.
A cycle that asked the door nothing reports that, not an empty section.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .request_admission import ADMISSIONS_SURFACE, admissions_path


def admission_cycle_summary(root: Path, cycle_id: str) -> dict[str, Any] | None:
    """The cycle's snapshot and per-role decisions, or None when the cycle asked nothing."""
    from .ledger import load_declared_jsonl

    path = admissions_path(root)
    if not path.exists():
        return None
    rows = [row for row in load_declared_jsonl(path, expected_surface=ADMISSIONS_SURFACE)
            if row.get("cycle_key") == cycle_id]
    if not rows:
        return None
    snapshot = next((dict(row.get("capacity") or {}) for row in rows if row.get("row_type") == "snapshot"), None)
    by_role: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("row_type") != "decision":
            continue
        entry = by_role.setdefault(str(row.get("role")), {
            "admitted_critical_path": 0, "admitted_discretionary": 0, "throttled": [],
        })
        if row.get("admitted"):
            entry[f"admitted_{row.get('purpose_class')}"] += int(row.get("count") or 0)
        else:
            entry["throttled"].append({"producer": row.get("producer"), "reason": row.get("reason")})
    return {"schema_version": 1, "cycle_id": cycle_id, "snapshot": snapshot, "by_role": by_role}


def render_request_admission_section(reflection: dict[str, Any]) -> list[str]:
    summary = reflection.get("request_admission")
    lines = ["", "## Request Admission", ""]
    if not isinstance(summary, dict):
        return [*lines, "- (no agent request was asked for this cycle)", ""]
    snap = summary.get("snapshot") or {}
    if "fault" in snap:
        lines.append(f"- Drain capacity unmeasurable: {snap['fault']}")
    elif snap:
        lines.extend([
            f"- Claimable backlog: {snap.get('backlog')} / budget {snap.get('budget')} "
            f"(max(floor {snap.get('backlog_floor')}, {snap.get('backlog_days_of_drain')} days x drain))",
            f"- Drain: {snap.get('drain_per_day')}/day ({snap.get('drained_in_window')} in "
            f"{snap.get('drain_window_days')} days); last drain {snap.get('last_drain_at')}",
            f"- Executor draining: {snap.get('executor_live')}; cooled providers: "
            f"{sorted(snap.get('cooled_providers') or {}) or 'none'}",
        ])
    else:
        lines.append("- No discretionary request was asked; critical-path mints only")
    lines.extend(["", "| Role | Admitted (critical path) | Admitted (discretionary) | Throttled |",
                  "| --- | ---: | ---: | --- |"])
    for role, entry in sorted((summary.get("by_role") or {}).items()):
        refused = ", ".join(f"{t.get('producer')}: {t.get('reason')}" for t in entry.get("throttled") or [])
        lines.append(f"| {role} | {entry.get('admitted_critical_path', 0)} | "
                     f"{entry.get('admitted_discretionary', 0)} | {refused or '-'} |")
    return [*lines, ""]


__all__ = ["admission_cycle_summary", "render_request_admission_section"]
