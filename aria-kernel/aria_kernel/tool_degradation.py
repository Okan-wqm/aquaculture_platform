"""A degraded tool is recorded every cycle and escalated when it stays that way.

WHY. Once a non-ok tool run no longer fails the night (``cycle_runtime_status``,
ARIA-HIGH-098), the failure mode inverts: a tool that never comes back could
be tolerated forever, one ``tool_run_degraded`` row per cycle in a ledger
nobody is paged by. ``tool_health`` already prices the tool — an
``evidence_error`` or ``schema_error`` run quarantines it on the spot, two
``budget_exceeded`` in seven days move it to CALIBRATE — but a tool that
crashes, times out or finds its environment missing every night stays in
the roster and stays dark, and a QUARANTINED tool leaves the roster and
stays out until an operator releases it: dark either way.

WHAT. After the tools phase, ``record_cycle_degradation`` appends one
``tool_run_degraded`` governance row per degraded tool — every non-ok run
of this cycle, and every QUARANTINED tool that sat this cycle out
(``tool_sit_out``) — carrying the class
(``cycle_runtime_status.tool_run_degradation_class``, or ``quarantined``)
and the tool's trailing streak of degraded cycles: its sat-out cycles read
off ``cycles.jsonl`` on top of its trailing degraded runs read off
``runs.jsonl``. When that streak reaches
``TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK`` it opens a HUMAN_REQUIRED record
naming the tool, the class and the cycles. The record id carries the first
cycle of the streak, so one streak escalates once (``record_human_required``
is idempotent per id) and a tool that recovers and breaks again escalates
again. The context kind ``tool_degradation`` is not in
``human_required_adjudication.ADJUDICABLE_CONTEXT_KINDS``, so the record
stays with the operator: a permanently broken adapter is a fact about the
adapter's code, which no panel can vote away.

The CYCLE's verdict is untouched by a sat-out tool: ``runtime_status`` reads
the runs of this cycle, and a tool that did not run did nothing wrong
tonight. The tool's standing is a tool fact, recorded here and read by
``doctor`` through ``degradation_report`` for its ``tools`` organ.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .cycle_runtime_status import RUNTIME_OK, tool_run_degradation_class
from .runs_reader import read_runs_rows
from .tool_health import runs_path
from .tool_registry import append_tools_governance, ensure_tools_dir, get_tool, list_tools, parse_utc_stamp
from .tool_sit_out import (
    QUARANTINED_CLASS,
    QUARANTINED_STATUS,
    is_quarantined,
    quarantine_reason,
    released_after,
    sat_out_cycles,
)

# The number of CONSECUTIVE degraded cycles of one tool that reach an
# operator. One is weather: the finding doc's own reading of the 2026-09-04
# budget miss is "a calibration/pressure signal, retry or re-budget", and
# ``tool_health`` records it as such. Two is where the kernel's self-healing
# already acts (``auto_calibrate_reason``: budget above cap twice in seven
# days → CALIBRATE), so the second night is the one the kernel gets to fix
# on its own. A third consecutive dark cycle means neither weather nor
# calibration explains it — the tool has been out for a whole unattended
# weekend — and a human is the only reader left who can change the adapter.
# For a QUARANTINED tool the same three nights apply: the kernel has no
# release path of its own, so the third night it sits out is the third
# night nobody was told the roster is one adapter short.
TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK = 3
HUMAN_REQUIRED_KIND = "tool_degradation"
GOVERNANCE_KIND = "tool_run_degraded"


def _cycle_verdicts(rows: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    """(cycle_id, latest run in that cycle) in ledger order.

    One run per cycle is the shape ``cycle._phase_tools`` produces; a cycle
    re-run by an operator can hold two, and the later one is the cycle's
    verdict — the earlier was superseded, not averaged.
    """
    latest: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for row in rows:
        cycle_id = str(row.get("cycle_id") or "")
        if not cycle_id:
            continue
        if cycle_id not in latest:
            order.append(cycle_id)
        latest[cycle_id] = row
    return [(cycle_id, latest[cycle_id]) for cycle_id in order]


def _tool_cycle_verdicts(tool_id: str, base_dir: str | Path | None) -> list[tuple[str, dict[str, Any]]]:
    path = runs_path(base_dir)
    if not path.exists():
        return []
    rows = list(read_runs_rows(path, tool_id=tool_id, base_dir=Path(ensure_tools_dir(base_dir))))
    return _cycle_verdicts(rows)


def _since_last_release(
    tool_id: str,
    verdicts: list[tuple[str, dict[str, Any]]],
    base_dir: str | Path | None,
) -> list[tuple[str, dict[str, Any]]]:
    """Only the cycle verdicts after the tool's last operator release.

    ``tool_sit_out.released_after`` dates the release off the quarantine
    ledger; a run that cannot be dated relative to it is left out rather
    than counted, because a streak an operator record is opened for must
    not begin on a night the operator already answered.
    """
    stamped = {
        cycle_id: parse_utc_stamp(str(run.get("recorded_at") or ""))
        for cycle_id, run in verdicts
    }
    boundary = released_after(tool_id, [at for at in stamped.values() if at is not None], base_dir)
    if boundary is None:
        return verdicts
    return [
        (cycle_id, run)
        for cycle_id, run in verdicts
        if stamped[cycle_id] is not None and stamped[cycle_id] > boundary
    ]


def _trailing_degraded_runs(verdicts: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """The trailing degraded run cycles, newest first; empty when the last run was ok."""
    streak: list[dict[str, Any]] = []
    for cycle_id, run in reversed(verdicts):
        degradation_class = tool_run_degradation_class(run)
        if degradation_class is None:
            break
        streak.append({"cycle_id": cycle_id, "degradation_class": degradation_class, "run_id": run.get("run_id")})
    return streak


def trailing_degraded_cycles(tool: dict[str, Any], base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """The tool's trailing degraded cycles, newest first, each with its class.

    A QUARANTINED tool's sat-out cycles come first (class ``quarantined``),
    then the degraded runs that led up to the quarantine; the streak ends at
    the tool's last ok run, or at its last operator release
    (``_since_last_release``) — the release is the intervention the record
    asked for, and the tool earns a fresh count from there whether the next
    run is ok or not.
    """
    tool_id = str(tool.get("tool_id") or "")
    verdicts = _since_last_release(tool_id, _tool_cycle_verdicts(tool_id, base_dir), base_dir)
    streak = [
        {"cycle_id": cycle_id, "degradation_class": QUARANTINED_CLASS, "run_id": None}
        for cycle_id in sat_out_cycles(tool, ran_in_cycles={cycle_id for cycle_id, _ in verdicts}, base_dir=base_dir)
    ]
    streak.extend(_trailing_degraded_runs(verdicts))
    return streak


def consecutive_degraded_cycles(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
) -> list[str]:
    """The tool's trailing degraded cycle ids, newest first; empty when its last cycle was ok."""
    return [entry["cycle_id"] for entry in trailing_degraded_cycles(get_tool(tool_id, base_dir), base_dir)]


def human_required_request_id(tool_id: str, streak_newest_first: list[str]) -> str:
    """Stable within one streak, new for the next: keyed on the streak's first cycle."""
    return f"tool-degraded:{tool_id}:{streak_newest_first[-1]}"


def sat_out_record(tool: dict[str, Any], base_dir: str | Path | None = None) -> dict[str, Any]:
    """The degradation record for a QUARANTINED tool that did not run this cycle.

    Same shape as ``cycle_runtime_status.degraded_tool_records`` produces
    for a non-ok run, with no run to name and the quarantine's own reason
    carried so the governance row and the operator record say WHY the tool
    is out, not only that it is. The reason comes from the same anchor the
    streak is dated from (``tool_sit_out.standing_quarantine``): on the
    production path the nightly manifest re-sync has dropped the registry
    row's ``last_transition`` by night 2, and a record that read only the
    row said ``QUARANTINED (None)`` to the operator from then on.
    """
    return {
        "tool_id": tool.get("tool_id"),
        "run_id": None,
        "status": None,
        "artifact_status": None,
        "degradation_class": QUARANTINED_CLASS,
        "integrity_class": False,
        "quarantine_reason": quarantine_reason(tool, base_dir),
    }


# The lifecycle statuses whose degradation is a live fact: the roster the
# cycle dispatches (``cycle._phase_tools``: ACTIVE / SHADOW / CALIBRATE) and
# the tools waiting for an operator's release. A DRAFT or SANDBOX tool has
# not been dispatched; an ARCHIVED tool never runs again — archiving is the
# exit the escalation reason itself names, and a standing that outlived it
# kept the doctor's tools organ FAIL forever (the scheduler notifying
# ``doctor_unhealthy`` every tick, ``self_improvement`` opening a mission)
# after the operator had done exactly what the record asked.
DEGRADATION_STANDING_STATUSES: frozenset[str] = frozenset({"ACTIVE", "SHADOW", "CALIBRATE", QUARANTINED_STATUS})


def has_degradation_standing(tool: dict[str, Any]) -> bool:
    """Whether the tool's degradation streak is a live fact for the organ and the escalation."""
    return str(tool.get("status") or "") in DEGRADATION_STANDING_STATUSES


def _escalation_reason(record: dict[str, Any], streak: list[str], cycle_id: str) -> str:
    tool_id = record.get("tool_id")
    if record.get("degradation_class") == QUARANTINED_CLASS:
        return (
            f"tool {tool_id} has been QUARANTINED ({record.get('quarantine_reason')}) for "
            f"{len(streak)} consecutive cycles since {streak[-1]}, latest {cycle_id}; it runs "
            "again only after an operator releases it (unquarantine_tool: QUARANTINED -> "
            "CALIBRATE with a root-cause note and a fixture update) or archives it"
        )
    return (
        f"tool {tool_id} degraded ({record.get('degradation_class')}) in "
        f"{len(streak)} consecutive cycles, latest {cycle_id}; the kernel's "
        "own calibration did not bring it back"
    )


def record_cycle_degradation(
    *,
    cycle_id: str,
    degraded: list[dict[str, Any]],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record every degraded tool of this cycle; escalate the ones that stayed degraded.

    ``degraded`` is ``cycle_runtime_status.degraded_tool_records`` for the
    cycle's run summary — the tools that RAN and were not ok. Every
    QUARANTINED tool that has no record there sat the cycle out and is
    recorded as such. Returns what was recorded and what was escalated, so
    the phase result names both.
    """
    from .human_required import record_human_required

    root = ensure_tools_dir(base_dir)
    tools = {str(tool.get("tool_id") or ""): tool for tool in list_tools(base_dir=root)}
    records = [dict(record) for record in degraded if record.get("tool_id")]
    ran = {str(record["tool_id"]) for record in records}
    records.extend(
        sat_out_record(tool, root)
        for tool_id, tool in tools.items()
        if tool_id and tool_id not in ran and is_quarantined(tool)
    )
    recorded: list[dict[str, Any]] = []
    escalated: list[dict[str, Any]] = []
    for record in records:
        tool_id = str(record["tool_id"])
        tool = tools.get(tool_id) or get_tool(tool_id, root)
        streak = [entry["cycle_id"] for entry in trailing_degraded_cycles(tool, root)]
        row = {
            "cycle_id": cycle_id,
            "tool_id": tool_id,
            "run_id": record.get("run_id"),
            "status": record.get("status"),
            "degradation_class": record.get("degradation_class"),
            "artifact_status": record.get("artifact_status"),
            "consecutive_cycles": len(streak),
            "human_required_at": TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK,
        }
        if record.get("quarantine_reason"):
            row["quarantine_reason"] = record["quarantine_reason"]
        append_tools_governance(root, GOVERNANCE_KIND, row)
        recorded.append(row)
        if len(streak) < TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK:
            continue
        request_id = human_required_request_id(tool_id, streak)
        # A profile that refuses the human_required surface raises here and
        # the phase (``record_and_continue`` in the cycle table) records that
        # refusal as its outcome — the same containment every escalation
        # phase gets, not a second one written here.
        human = record_human_required(
            request_id=request_id,
            severity="HIGH",
            reason=_escalation_reason(record, streak, cycle_id),
            context={
                "kind": HUMAN_REQUIRED_KIND,
                "tool_id": tool_id,
                "degradation_class": record.get("degradation_class"),
                "quarantine_reason": record.get("quarantine_reason"),
                "consecutive_cycles": len(streak),
                "cycle_ids": list(streak),
                "latest_run_id": record.get("run_id"),
            },
            base_dir=root,
        )
        escalated.append({
            "tool_id": tool_id,
            "request_id": human.get("request_id"),
            "consecutive_cycles": len(streak),
            "degradation_class": record.get("degradation_class"),
        })
    return {"recorded": recorded, "escalated": escalated}


def degradation_report(base_dir: str | Path | None = None) -> dict[str, Any]:
    """Every tool with standing, for the doctor: degraded streaks and quarantines.

    A tool the cycle would not dispatch and that awaits no release
    (DRAFT, SANDBOX, ARCHIVED — ``has_degradation_standing``) is not
    reported: its last verdict is history, not a standing. The
    HUMAN_REQUIRED record an escalation opened stays with the operator to
    resolve; the organ clears when the tool is retired or released.
    """
    root = ensure_tools_dir(base_dir)
    degraded: list[dict[str, Any]] = []
    quarantined: list[str] = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or not has_degradation_standing(tool):
            continue
        if is_quarantined(tool):
            quarantined.append(tool_id)
        streak = trailing_degraded_cycles(tool, root)
        if not streak:
            continue
        degraded.append({
            "tool_id": tool_id,
            "degradation_class": streak[0]["degradation_class"],
            "consecutive_cycles": len(streak),
            "latest_cycle_id": streak[0]["cycle_id"],
            "human_required": len(streak) >= TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK,
        })
    return {
        "degraded": degraded,
        "quarantined": quarantined,
        "human_required_streak": TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK,
        "ok_status": RUNTIME_OK,
    }


__all__ = [
    "DEGRADATION_STANDING_STATUSES",
    "GOVERNANCE_KIND",
    "HUMAN_REQUIRED_KIND",
    "TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK",
    "consecutive_degraded_cycles",
    "degradation_report",
    "has_degradation_standing",
    "human_required_request_id",
    "record_cycle_degradation",
    "sat_out_record",
    "trailing_degraded_cycles",
]
