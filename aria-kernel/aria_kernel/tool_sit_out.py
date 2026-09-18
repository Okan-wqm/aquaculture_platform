"""A QUARANTINED tool sits out every cycle until an operator releases it — and each one is a degraded cycle.

WHY. ``tool_health.immediate_quarantine_reason`` quarantines an
``evidence_error`` / ``schema_error`` / ``scope_violation`` /
``tool_unhealthy`` run on the spot — the class trial eleven hit
(``cyc-20260912T221237Z-auto``, ``agent-harness-security-adapter``) — and
``cycle._phase_tools`` dispatches only ACTIVE / SHADOW / CALIBRATE tools, so
a quarantined tool never runs again until an operator releases it
(``tool_registry.unquarantine_tool``). Its run history therefore ends on the
quarantining run. A streak read off ``runs.jsonl`` alone froze at 1 for
exactly that class, ``TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK`` was
unreachable for the adapter the finding was raised on, and the only readout
was a doctor WARN nobody is paged by (ARIA-HIGH-098, verifier defect 2).

WHAT. The cycles a quarantined tool has sat out, read off ``cycles.jsonl``:
every cycle STARTED at or after the quarantine took effect, in which the
tool has no run. "Took effect" is the tool's ``last_transition`` into
QUARANTINED when the registry row still carries it; the quarantine
ledger's latest QUARANTINED row for the tool is the anchor otherwise —
and that "otherwise" is the production path, not an edge: the nightly
manifest re-sync (``cycle._phase_tool_manifest_sync`` →
``register_tool`` with the live status) replaces a shipped adapter's
registry row wholesale, keeping the status (``register_tool`` refuses
only a demotion) but dropping ``last_transition``. ``quarantine_tool``
stamps the ledger row with the transition's own ``at`` and reason, so
the date and the reason are read from one anchor
(``standing_quarantine``), never from the registry row alone.
``tool_degradation`` prepends the
sat-out cycles to the tool's trailing degraded run cycles, so the streak
keeps counting while the tool is out, the third dark night opens the
operator record keyed on the quarantining cycle, and an operator release
followed by an ok run clears it like every other recovery.

A release is itself the intervention the record asked for, so it ends the
streak it was asked about even when the tool breaks again: a quarantined
tool cannot run, so any run recorded after a quarantine row proves a
release between them (``released_after``), and the runs before that
release belong to a streak an operator already acted on. Without that
boundary a tool released and re-quarantined without an ok run in between
would keep the FIRST streak's record id — one the operator may already
have resolved — and the new three dark nights would open nothing.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .ledger import load_declared_jsonl
from .quarantine import quarantine_log_path
from .tool_registry import ensure_tools_dir, parse_utc_stamp

QUARANTINED_STATUS = "QUARANTINED"
# The degradation class a sat-out cycle is recorded under. Distinct from the
# run status that caused the quarantine: the row for the quarantining cycle
# carries that status; every later row says the tool was out of the roster.
QUARANTINED_CLASS = "quarantined"


def is_quarantined(tool: dict[str, Any]) -> bool:
    return tool.get("status") == QUARANTINED_STATUS


@dataclass(frozen=True)
class StandingQuarantine:
    """The tool's standing quarantine as one record: when it took effect and why."""

    at: datetime
    reason: str | None


def standing_quarantine(tool: dict[str, Any], base_dir: str | Path | None = None) -> StandingQuarantine | None:
    """The tool's STANDING quarantine, or None when it cannot be dated.

    ``last_transition`` first — the registry's own record of the
    transition, present until a manifest re-sync replaces the row. The
    quarantine ledger's latest QUARANTINED row for the tool is the anchor
    for a registry row that carries no dated transition; ``quarantine_tool``
    stamps the ledger row with the transition's own ``at`` and reason, so
    the two agree to the byte whichever one survives. A quarantine that cannot be dated
    yields no record: counting nights against an unknown start would be a
    guess written into an operator record.
    """
    if not is_quarantined(tool):
        return None
    transition = tool.get("last_transition")
    if isinstance(transition, dict) and transition.get("to") == QUARANTINED_STATUS:
        stamped = parse_utc_stamp(str(transition.get("at") or ""))
        if stamped is not None:
            reason = transition.get("reason")
            return StandingQuarantine(at=stamped, reason=str(reason) if reason else None)
    path = quarantine_log_path(base_dir)
    if not path.exists():
        return None
    latest: StandingQuarantine | None = None
    for row in load_declared_jsonl(path, expected_surface="quarantine_log"):
        if row.get("tool_id") != tool.get("tool_id") or row.get("status") != QUARANTINED_STATUS:
            continue
        stamped = parse_utc_stamp(str(row.get("at") or ""))
        if stamped is not None:
            reason = row.get("reason")
            latest = StandingQuarantine(at=stamped, reason=str(reason) if reason else None)
    return latest


def quarantine_took_effect_at(tool: dict[str, Any], base_dir: str | Path | None = None) -> datetime | None:
    """When the tool's standing quarantine began (``standing_quarantine``), or None."""
    standing = standing_quarantine(tool, base_dir)
    return standing.at if standing is not None else None


def quarantine_reason(tool: dict[str, Any], base_dir: str | Path | None = None) -> str | None:
    """Why the tool's standing quarantine was imposed (``standing_quarantine``), or None."""
    standing = standing_quarantine(tool, base_dir)
    return standing.reason if standing is not None else None


def cycles_started_since(since: datetime, base_dir: str | Path | None = None) -> list[str]:
    """Cycle ids whose ``started`` row is stamped at or after ``since``, in ledger order.

    "At or after", not "after": ``utc_now`` stamps to the second, and a
    cycle that starts within the same second as the quarantine did start
    after it — the quarantine is written by the previous cycle's tools
    phase. The cycle that quarantined the tool is excluded by the caller on
    the tool's run in it, never by the clock.
    """
    path = ensure_tools_dir(base_dir) / "cycles.jsonl"
    if not path.exists():
        return []
    started: list[str] = []
    for row in load_declared_jsonl(path, expected_surface="cycles"):
        if row.get("event") != "started":
            continue
        cycle_id = str(row.get("cycle_id") or "")
        stamped = parse_utc_stamp(str(row.get("at") or ""))
        if not cycle_id or stamped is None or stamped < since:
            continue
        if cycle_id not in started:
            started.append(cycle_id)
    return started


def released_after(
    tool_id: str,
    run_recorded_at: list[datetime],
    base_dir: str | Path | None = None,
) -> datetime | None:
    """The latest quarantine of the tool that a later run proves was released, or None.

    A QUARANTINED tool is never dispatched, so a run recorded after a
    quarantine row can only follow a release. The streak reader counts
    runs after this boundary only: the runs before it were answered by
    the operator who released the tool.
    """
    path = quarantine_log_path(base_dir)
    if not path.exists() or not run_recorded_at:
        return None
    newest_run = max(run_recorded_at)
    boundary: datetime | None = None
    for row in load_declared_jsonl(path, expected_surface="quarantine_log"):
        if row.get("tool_id") != tool_id or row.get("status") != QUARANTINED_STATUS:
            continue
        stamped = parse_utc_stamp(str(row.get("at") or ""))
        if stamped is None or stamped >= newest_run:
            continue
        if boundary is None or stamped > boundary:
            boundary = stamped
    return boundary


def sat_out_cycles(
    tool: dict[str, Any],
    *,
    ran_in_cycles: set[str],
    base_dir: str | Path | None = None,
) -> list[str]:
    """The cycles the quarantined tool sat out, newest first; empty for any other tool.

    ``ran_in_cycles`` is the set of cycles the tool has a run in: a cycle
    the tool answered — including the one whose run quarantined it — is
    judged by that run, not counted as sat out.
    """
    since = quarantine_took_effect_at(tool, base_dir)
    if since is None:
        return []
    return [
        cycle_id
        for cycle_id in reversed(cycles_started_since(since, base_dir))
        if cycle_id not in ran_in_cycles
    ]


__all__ = [
    "QUARANTINED_CLASS",
    "QUARANTINED_STATUS",
    "StandingQuarantine",
    "cycles_started_since",
    "is_quarantined",
    "quarantine_reason",
    "quarantine_took_effect_at",
    "released_after",
    "sat_out_cycles",
    "standing_quarantine",
]
