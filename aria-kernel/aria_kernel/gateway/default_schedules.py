"""The schedule table exists by construction — the daemon seeds it, an operator edits it.

WHY: `add_schedule` was reachable only through `aria_kernel schedule add`. The
gateway daemon ran on the runner host on 2026-09-07/08 with an EMPTY table —
no `gateway/schedules.jsonl`, zero `gateway_schedule_changed` rows — so the
`self_improve`, `economy`, `doctor` and `deliver` actions never fired once.
A lane whose only trigger is a human remembering a command is a lane that is
off: the ORPHAN-694 class (mechanism present, caller absent), confirmed live
2026-09-12.

WHAT: `DEFAULT_SCHEDULES` is the kernel-owned table of actions that run
unattended; `OPERATOR_ONLY_ACTIONS` names every other `SCHEDULE_ACTIONS`
member with the reason it must NOT be seeded here (each one already has a
cadence owner — a workflow cron, a systemd timer, the tick itself, the
auto-cycle). The two sets partition the closed vocabulary; the invariant in
`tests/test_gateway_default_schedules.py` fails the moment an action joins
`SCHEDULE_ACTIONS` without choosing a side.

OWNERSHIP AFTER SEEDING. The table is a BOOTSTRAP, the ledger is the SSoT:
a default is seeded once (keyed on "an `add` row for this name ever existed",
whoever wrote it), so an operator's `remove` is never resurrected, a `pause`
survives every restart, and a re-`add` with another cron is kept. A default
whose code cadence no longer matches the ledger is reported as `drift` — the
kernel does not silently rewrite what an operator (or an earlier kernel)
chose. The daemon calls `ensure_default_schedules` once per start; the
ensured event is written only when something was seeded, so a restart of a
seeded store records nothing.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..ledger import load_declared_jsonl
from ..tool_registry import append_tools_governance, ensure_tools_dir
from .scheduler import SCHEDULES_SURFACE, add_schedule, fold_schedules, schedules_path

# Recorded as the `add` row's operator_ref so the ledger says who seeded it.
KERNEL_DEFAULT_OPERATOR_REF = "kernel:default_schedules"
DEFAULT_SCHEDULES_ENSURED_EVENT = "gateway_default_schedules_ensured"


@dataclass(frozen=True)
class DefaultSchedule:
    name: str
    action: str
    cron: str
    # WHY this entry runs unattended — a default without a reason is a cron
    # line nobody can review.
    reason: str


# Cadences, and why each sits where it does. `self-improve` (05:45) and
# `economy` (05:50) run in the early-UTC window AFTER the nightly cycle
# (17:13 UTC, aria-auto-cycle.yml) and its chained drain have finished and
# BEFORE the daily report (06:00 UTC, aria-daily-report.yml) reads the store,
# so what the report shows reflects the night that just ran. `deliver`
# (06:30) is not a report input — it NOTIFIES the delivery-closure summary
# to the configured channels — so it runs after the report, once the same
# night's store is settled. `doctor` runs every 30 minutes because a dead
# daemon or a tripped breaker is worth noticing within the half hour, not
# once a day.
DEFAULT_SCHEDULES: tuple[DefaultSchedule, ...] = (
    DefaultSchedule(
        "doctor", "doctor", "*/30 * * * *",
        "no workflow or timer runs the doctor unattended; the organ readout plus the "
        "doctor_unhealthy notification is how a dead daemon or a tripped breaker is noticed",
    ),
    DefaultSchedule(
        "self-improve", "self_improve", "45 5 * * *",
        "Plan 032 Faz 032i: measured signals (doctor fails, funnel stalls, delivery SLO gaps, "
        "MCP quarantines, capability gaps) become self_improvement missions; the next cycle's "
        "mission selection (17:13 UTC) then considers them",
    ),
    DefaultSchedule(
        "economy", "economy", "50 5 * * *",
        "token-per-accepted-result stats become effort recommendations the executor asks "
        "before every spawn (token_economy.effective_effort); a recommendation older than "
        "7 days expires, so it must be refreshed daily",
    ),
    DefaultSchedule(
        "deliver", "deliver", "30 6 * * *",
        "the delivery-closure summary is notified once per day (keyed on the date); nothing "
        "else reads compute_delivery_closure to a channel",
    ),
)

# Every SCHEDULE_ACTIONS member that is NOT a default, with the reason it must
# not be seeded by this daemon. Each one has a cadence owner elsewhere; a
# second trigger here would double-fire it.
OPERATOR_ONLY_ACTIONS: dict[str, str] = {
    "cycle": (
        "aria-auto-cycle.yml owns the cadence (on.schedule 13 17 * * *, the operator's evening "
        "window, decision 2026-08-27); a daemon default would dispatch a second nightly cycle"
    ),
    "drain": (
        "aria-agent-executor.yml is chained by workflow_run after every cycle (ORPHAN-724) and keeps "
        "its own safety-net cron; a daemon default would race the chained drain"
    ),
    "daily_report": "aria-daily-report.yml owns the cadence (on.schedule 0 6 * * *)",
    "telemetry_export": (
        "aria-telemetry.timer (systemd, every 5 min) is the export cadence; this action is the "
        "offline re-export for `schedule run`"
    ),
    "inbox_drain": (
        "every scheduler tick drains the inbox before running due schedules "
        "(tick(drain_inbox_first=True)); the action exists for `schedule run --action inbox_drain`"
    ),
    "experiment_night": (
        "cycle._phase_experiment_night runs the night lane inside every auto-cycle; a daemon "
        "default would run a second night lane on the same day"
    ),
}


def _names_ever_added(base_dir: str | Path | None) -> set[str]:
    """Every schedule name that ever received an `add` row — the seed-once key.

    Read from the raw ledger, not the fold: a removed schedule is absent from
    the fold, and re-seeding it would undo the operator's removal.
    """
    path = schedules_path(base_dir)
    if not path.exists():
        return set()
    return {
        str(row.get("name") or "")
        for row in load_declared_jsonl(path, expected_surface=SCHEDULES_SURFACE)
        if row.get("event") == "add"
    }


def ensure_default_schedules(*, base_dir: str | Path | None) -> dict[str, Any]:
    """Seed every default the ledger has never seen; report the rest.

    Returns ``{seeded, present, operator_owned, drift}``:
    * ``seeded`` — defaults added by this call (each is an `add` row plus one
      `gateway_schedule_changed` governance row, exactly as an operator add);
    * ``present`` — defaults already in the folded table at the default cadence;
    * ``operator_owned`` — names the ledger has seen that are no longer in the
      table (removed) — left alone;
    * ``drift`` — names in the table whose action or cron differs from the
      code default — reported, never rewritten.
    """
    root = ensure_tools_dir(base_dir)
    ever_added = _names_ever_added(root)
    table = fold_schedules(root)
    seeded: list[str] = []
    present: list[str] = []
    operator_owned: list[str] = []
    drift: list[dict[str, Any]] = []
    for schedule in DEFAULT_SCHEDULES:
        if schedule.name not in ever_added:
            add_schedule(name=schedule.name, action=schedule.action, cron=schedule.cron, base_dir=root,
                         operator_ref=KERNEL_DEFAULT_OPERATOR_REF)
            seeded.append(schedule.name)
            continue
        current = table.get(schedule.name)
        if current is None:
            operator_owned.append(schedule.name)
        elif (current.action, current.cron) != (schedule.action, schedule.cron):
            drift.append({"name": schedule.name, "default": {"action": schedule.action, "cron": schedule.cron},
                          "ledger": {"action": current.action, "cron": current.cron}})
        else:
            present.append(schedule.name)
    result = {"seeded": seeded, "present": present, "operator_owned": operator_owned, "drift": drift}
    if seeded:
        # Once per seeding, never per poll: a restart of a seeded store
        # reaches this line with an empty `seeded` and writes nothing.
        append_tools_governance(root, DEFAULT_SCHEDULES_ENSURED_EVENT, result)
    return result


__all__ = ["DEFAULT_SCHEDULES", "DEFAULT_SCHEDULES_ENSURED_EVENT", "DefaultSchedule", "KERNEL_DEFAULT_OPERATOR_REF",
           "OPERATOR_ONLY_ACTIONS", "ensure_default_schedules"]
