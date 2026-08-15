"""Which mission gets the one WIP slot, and why the others did not.

PLAN Wave 2 PR 1.6. The mission layer already knows how many slots exist
(``DEFAULT_WIP_CAP``), who holds one (``active_wip_missions``) and how to
refuse when they are taken (``assert_wip_available``). What it could not do is
CHOOSE: given a free slot and a queue of open missions, nothing decided which
one ARIA works on next. Without that, "persistent missions" is a ledger of
things nobody starts.

TWO RULES SHAPE EVERY DECISION HERE.

*Every outcome is named.* `select_next_mission` never returns a bare ``None``.
"No mission selected" splits into reasons an operator can act on — the queue
is empty, the slot is held (by whom), everything is waiting (until when) — and
each mission NOT chosen is returned with the reason it was passed over. A
scheduler that announces its pick without accounting for the rest is a
decision that cannot be audited, and this session spent its day on statuses
nobody chose.

*The ranking is total and deterministic.* Same ledger, same answer, on any
runner. Ties are broken all the way down to the mission id, so "the scheduler
picked differently today" is always a fact about the missions and never about
the machine.

WHAT THIS DELIBERATELY DOES NOT REUSE. `plan_synthesizer._SOURCE_PRIORITY`
ranks ``operator_feedback|failing_ci|orphan_finding|f_finding|git_diff`` — plan
CANDIDATE sources. Missions carry ``pressure|finding|shadow_run_summary|
capability_gap`` (`task.py`). The two vocabularies share a shape and not a
meaning, and importing one into the other is precisely the defect
ORPHAN-HIGH-552 turned out to be: one field name, two meanings, and a
"normalisation" that silently rewrote the wrong thing. So the mission ranking
is stated over the vocabulary missions actually carry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .mission import (
    ACTIVE_WIP_STATES,
    DEFAULT_WIP_CAP,
    TERMINAL_STATES,
    WAITING_STATES,
    active_wip_missions,
    list_open_missions,
)
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now

SCHEDULER_SCHEMA = "aria/mission-schedule/v1"

# Rank over the source vocabulary MISSIONS carry (`task.py`), lowest first.
# `capability_gap` outranks the rest because a missing capability blocks
# whatever asked for it: work that unblocks work comes first. `pressure` is
# last because it is the broadest and least specific signal — everything
# eventually shows up as pressure, so letting it lead would let the vaguest
# evidence set the agenda.
SOURCE_RANK: dict[str, int] = {
    "capability_gap": 0,
    "finding": 1,
    "shadow_run_summary": 2,
    "pressure": 3,
    # Charter §5 service-hardening missions: below the reactive sources by
    # design — a confirmed gap or finding outranks proactive hardening, and
    # hardening outranks nothing at all (_UNRANKED_SOURCE).
    "service_hardening": 4,
}
_UNRANKED_SOURCE = 90

# Reasons a mission was not chosen. A closed vocabulary, because "why not"
# is the half of the decision an operator actually debugs.
SKIP_TERMINAL = "terminal"
SKIP_HOLDS_SLOT = "already_holds_the_slot"
SKIP_WAITING_EXTERNAL = "waiting_on_something_outside_aria"
SKIP_WAITING_UNTIL = "waiting_until"
SKIP_NOT_SELECTED = "outranked"

# Reasons nothing was selected. Distinct on purpose: an empty queue, a busy
# slot and a fully-blocked queue are three different mornings.
NO_OPEN_MISSIONS = "no_open_missions"
WIP_SLOT_HELD = "wip_slot_held"
ALL_MISSIONS_WAITING = "all_open_missions_waiting"
SELECTED = "selected"


@dataclass(frozen=True)
class SkippedMission:
    mission_id: str
    reason: str
    detail: str = ""

    def as_row(self) -> dict[str, Any]:
        row: dict[str, Any] = {"mission_id": self.mission_id, "reason": self.reason}
        if self.detail:
            row["detail"] = self.detail
        return row


@dataclass(frozen=True)
class SchedulerDecision:
    """The whole decision, including the part that chose nothing."""

    outcome: str
    selected: dict[str, Any] | None = None
    skipped: tuple[SkippedMission, ...] = ()
    considered: int = 0
    wip_cap: int = DEFAULT_WIP_CAP
    decided_at: str = ""

    def as_event(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "schema": SCHEDULER_SCHEMA,
            "outcome": self.outcome,
            "selected_mission_id": (self.selected or {}).get("mission_id"),
            "selected_state": (self.selected or {}).get("state"),
            "considered": self.considered,
            "wip_cap": self.wip_cap,
            "skipped": [row.as_row() for row in self.skipped],
            "decided_at": self.decided_at,
        }


def _parse_instant(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _wake_holds(mission: dict[str, Any], now: datetime) -> str:
    """The ISO instant this mission is waiting for, or '' if it is free.

    An UNPARSEABLE `not_before` reads as free rather than as blocked. A
    timestamp nobody can read must not be able to park a mission forever —
    that is the shape where a typo becomes a permanent silent hold, and the
    mission is visible in the queue either way.
    """
    wake = mission.get("wake_condition")
    if not isinstance(wake, dict):
        return ""
    not_before = _parse_instant(wake.get("not_before"))
    if not_before is None or not_before <= now:
        return ""
    return wake["not_before"]


def _rank(mission: dict[str, Any]) -> tuple[int, int, str, str]:
    """Total order. Every component is a fact about the mission.

    1. explicit ``priority`` (lower first); absent sorts after every stated one
    2. source rank over the mission vocabulary
    3. ``opened_at`` — oldest first
    4. ``mission_id`` — the last tiebreak

    ON WHAT AGE ACTUALLY BUYS. ``utc_now()`` has SECOND resolution (measured),
    and `adopt_task_candidates` opens a whole batch inside one loop, so batch
    members routinely carry an identical ``opened_at`` and are separated by
    the id — a content hash, which is arbitrary with respect to age. So the
    honest guarantee is not "oldest first" but: **the order is total,
    deterministic and reproducible**, with age as a coarse key and identity as
    the final tiebreak. A genuinely older mission (a different second) does
    win; same-second missions get a stable order rather than a fair one.

    That distinction is worth stating because the first draft of this
    docstring claimed anti-starvation, and the test that was supposed to prove
    it was a tautology comparing a value against itself. Writing the real
    assertion is what produced the measurement.
    """
    priority = mission.get("priority")
    priority_key = priority if isinstance(priority, int) else 1_000_000
    source_key = SOURCE_RANK.get(str(mission.get("source_kind") or ""), _UNRANKED_SOURCE)
    return (
        priority_key,
        source_key,
        str(mission.get("opened_at") or ""),
        str(mission.get("mission_id") or ""),
    )


def _thompson_source_draws(root: Path, decided_at: str) -> dict[str, float]:
    """One seeded Beta draw per source_kind, from the effectiveness ledger.

    Reward = cycles_merged / cycles_minted (a merge is the only outcome that
    proves a source's work was worth the slot). Missing or unreadable ledger
    → {} and the caller falls back to the static rank; the scheduler must
    never fail on its own tiebreaker.
    """
    try:
        from .calibrated_intelligence import deterministic_seed, thompson_rank
        from .knowledge_graph import rank_pressure_sources

        rows = rank_pressure_sources(workspace_root=root.parent)
        if not rows:
            return {}
        ranked = thompson_rank(
            [
                {
                    "key": str(row.get("source_type")),
                    "successes": int(row.get("cycles_merged", 0) or 0),
                    "trials": int(row.get("cycles_minted", 0) or 0),
                }
                for row in rows
            ],
            seed=deterministic_seed("mission_scheduler", decided_at[:10]),
        )
        return {row["key"]: row["draw"] for row in ranked}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def select_next_mission(
    *,
    base_dir: str | Path | None = None,
    now: str | None = None,
    wip_cap: int = DEFAULT_WIP_CAP,
    record: bool = True,
) -> SchedulerDecision:
    """Choose the mission that gets the slot, and account for the rest."""
    root = ensure_tools_dir(base_dir)
    decided_at = now or utc_now()
    instant = _parse_instant(decided_at) or datetime.now(timezone.utc)
    missions = list_open_missions(base_dir=root)
    holders = active_wip_missions(base_dir=root)

    skipped: list[SkippedMission] = []
    eligible: list[dict[str, Any]] = []
    for mission in missions:
        state = str(mission.get("state") or "")
        mission_id = str(mission.get("mission_id") or "")
        if state in TERMINAL_STATES:
            skipped.append(SkippedMission(mission_id, SKIP_TERMINAL, state))
            continue
        if state in ACTIVE_WIP_STATES:
            skipped.append(SkippedMission(mission_id, SKIP_HOLDS_SLOT, state))
            continue
        waiting_until = _wake_holds(mission, instant)
        if waiting_until:
            skipped.append(SkippedMission(mission_id, SKIP_WAITING_UNTIL, waiting_until))
            continue
        if state in WAITING_STATES:
            # Its wake condition is what returns it to the queue; selecting it
            # now would spin on the thing it is waiting for. The ACTIVE_WIP
            # comment states the other half of this rule: a mission waiting on
            # a human must not hold the slot either.
            skipped.append(SkippedMission(mission_id, SKIP_WAITING_EXTERNAL, state))
            continue
        eligible.append(mission)

    def decide(outcome: str, selected: dict[str, Any] | None = None) -> SchedulerDecision:
        decision = SchedulerDecision(
            outcome=outcome,
            selected=selected,
            skipped=tuple(skipped),
            considered=len(missions),
            wip_cap=wip_cap,
            decided_at=decided_at,
        )
        if record:
            append_tools_governance(root, "mission_schedule_decided", decision.as_event())
        return decision

    if not missions:
        return decide(NO_OPEN_MISSIONS)
    if len(holders) >= wip_cap:
        # Named with the holder, because "the slot is busy" without saying who
        # sends an operator hunting for what is already on the screen.
        for holder in holders:
            detail = f"{holder.get('state')} since {holder.get('updated_at')}"
            skipped.append(
                SkippedMission(str(holder.get("mission_id") or ""), WIP_SLOT_HELD, detail)
            )
        return decide(WIP_SLOT_HELD)
    if not eligible:
        return decide(ALL_MISSIONS_WAITING)

    # ORPHAN-HIGH-627 — Thompson sampling replaces the static source-rank
    # tiebreak when the effectiveness ledger has history: within the same
    # operator priority, each source_kind draws from its own merged/minted
    # posterior and the draw order allocates the slot. Exploration is the
    # point — a source with no history draws from the uninformative prior
    # and sometimes wins, so the scheduler cannot starve what it has never
    # tried. Seeded by the decision DAY, never wall-clock: a replayed
    # decision ranks identically. Static SOURCE_RANK remains the fallback
    # (no ledger, or a source the ledger has never seen).
    source_draws = _thompson_source_draws(root, decided_at)
    if source_draws:
        eligible.sort(
            key=lambda m: (
                _rank(m)[0],
                -source_draws.get(
                    str(m.get("source_kind") or ""),
                    -float(_rank(m)[1]),
                ),
                _rank(m)[2],
                _rank(m)[3],
            )
        )
    else:
        eligible.sort(key=_rank)
    winner, *rest = eligible
    for mission in rest:
        skipped.append(SkippedMission(str(mission.get("mission_id") or ""), SKIP_NOT_SELECTED))
    return decide(SELECTED, winner)


__all__ = [
    "ALL_MISSIONS_WAITING",
    "NO_OPEN_MISSIONS",
    "SCHEDULER_SCHEMA",
    "SELECTED",
    "SOURCE_RANK",
    "SchedulerDecision",
    "SkippedMission",
    "WIP_SLOT_HELD",
    "select_next_mission",
]
