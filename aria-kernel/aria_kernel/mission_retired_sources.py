"""Missions whose producer no longer exists are closed, not carried.

WHY. A mission advances only when its producer re-observes it: `open_mission`
heals a contract-less row on re-open, the scheduler ranks it, a wake event
un-sticks it. When the producer is retired (`mission.RETIRED_SOURCE_KINDS`),
none of that can ever happen again, and the mission becomes a permanent
resident of `mission_closure_violation` and of the scheduler's "considered"
list — dead weight that reads as open work. Measured on the live store
2026-09-12 (origin/aria/state `tools/missions/mission-events.jsonl`): six
``shadow_run_summary`` missions opened 2026-08-10/11, every one still
DISCOVERED with ``next_action: null``, every one among the 14 rows of the
standing closure violation, none touched since.

WHAT. One sweep, run by the mission-ingest phase before adoption. It closes a
retired-source mission ONLY when closing it abandons nothing — the mission
must be in a pre-WIP mainline state (`PRE_WIP_STATES`: no branch, no worker,
no PR by construction) AND contract-less (no ``next_action`` / no
``wake_condition``): that pair is exactly "the only heal path is the
producer's re-adoption, and the producer is gone". Every other retired-source
mission is DECLINED with a disclosed reason from `SWEEP_DECLINE_REASONS`, a
closed table over the non-terminal states:

  * ``operator_held``     — HUMAN_REQUIRED: a human parked it; an unattended
                            writer does not close a human's question.
  * ``work_in_progress``  — `ACTIVE_WIP_STATES`: a branch, a worker or a PR is
                            live; superseding it abandons that work. The first
                            revision of this sweep did exactly that (verified
                            IMPLEMENTING -> SUPERSEDED in a scratch store).
  * ``outcome_observing`` — the change merged and its outcome is being
                            watched; closing it discards the observation.
  * ``wake_pending``      — a machine-owned waiting state: the wake condition
                            names a live path (CI status, PR state, a timer,
                            evidence) that does not go through the producer.
  * ``contracted``        — pre-WIP but carrying a closure contract: the
                            scheduler can advance it, so it is not unhealable.

`sweep_verdict` is total over `MISSION_STATES` minus `TERMINAL_STATES` and
refuses an unknown state, so a state added to the vocabulary without a row
here fails loudly instead of being swept by default
(`tests/test_mission_retired_sources.py` pins the exhaustiveness).

The sweep is idempotent by construction: a superseded mission is terminal and
`list_open_missions` no longer returns it. Its governance row is a standing
fact disclosed ONCE (`append_tools_governance_once`) — a declined mission
that sits in HUMAN_REQUIRED for a month is one row, not thirty.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .mission import (
    ACTIVE_WIP_STATES,
    MAINLINE_STATES,
    MISSION_STATES,
    OPERATOR_HELD_STATES,
    RETIRED_SOURCE_KINDS,
    TERMINAL_STATES,
    WAITING_STATES,
    has_closure_contract,
    list_open_missions,
    transition_mission,
)
from .tool_registry import GovernanceError, append_tools_governance_once, ensure_tools_dir

RETIRED_PRODUCER_REASON = "producer_retired"
GOVERNANCE_KIND = "mission_superseded_producer_retired"

# The mainline states BEFORE the first WIP state and AFTER the last one —
# derived from the two vocabularies rather than copied, so widening
# `ACTIVE_WIP_STATES` moves both boundaries without a second edit.
PRE_WIP_STATES: frozenset[str] = frozenset(
    MAINLINE_STATES[: MAINLINE_STATES.index(ACTIVE_WIP_STATES[0])]
)
POST_WIP_STATES: frozenset[str] = frozenset(
    MAINLINE_STATES[MAINLINE_STATES.index(ACTIVE_WIP_STATES[-1]) + 1 :]
)

DECLINE_OPERATOR_HELD = "operator_held"
DECLINE_WORK_IN_PROGRESS = "work_in_progress"
DECLINE_OUTCOME_OBSERVING = "outcome_observing"
DECLINE_WAKE_PENDING = "wake_pending"
DECLINE_CONTRACTED = "contracted"
SWEEP_DECLINE_REASONS: tuple[str, ...] = (
    DECLINE_OPERATOR_HELD,
    DECLINE_WORK_IN_PROGRESS,
    DECLINE_OUTCOME_OBSERVING,
    DECLINE_WAKE_PENDING,
    DECLINE_CONTRACTED,
)


def sweep_verdict(mission: dict[str, Any]) -> str | None:
    """``None`` when the sweep may supersede ``mission``; else the decline reason.

    Total over every non-terminal state (see the module docstring); a state
    outside the vocabulary, or a terminal one, is a caller error — the sweep
    only ever sees `list_open_missions`.
    """
    state = str(mission.get("state") or "")
    if state not in MISSION_STATES or state in TERMINAL_STATES:
        raise GovernanceError(f"sweep_verdict: not an open mission state: {state!r}")
    if state in OPERATOR_HELD_STATES:
        return DECLINE_OPERATOR_HELD
    if state in ACTIVE_WIP_STATES:
        return DECLINE_WORK_IN_PROGRESS
    if state in WAITING_STATES:
        return DECLINE_WAKE_PENDING
    if state in POST_WIP_STATES:
        return DECLINE_OUTCOME_OBSERVING
    if state not in PRE_WIP_STATES:
        raise GovernanceError(f"sweep_verdict: unclassified mission state {state!r}")
    if has_closure_contract(mission):
        return DECLINE_CONTRACTED
    return None


def supersede_retired_source_missions(
    *, base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    superseded: list[dict[str, str]] = []
    declined: list[dict[str, str]] = []
    for mission in list_open_missions(base_dir=root):
        source_kind = str(mission.get("source_kind") or "")
        if source_kind not in RETIRED_SOURCE_KINDS:
            continue
        entry = {
            "mission_id": mission["mission_id"],
            "source_kind": source_kind,
            "source_id": str(mission.get("source_id") or ""),
            "state": mission["state"],
        }
        verdict = sweep_verdict(mission)
        if verdict is not None:
            declined.append({**entry, "reason": verdict})
            continue
        transition_mission(
            mission_id=mission["mission_id"],
            to_state="SUPERSEDED",
            reason_code=RETIRED_PRODUCER_REASON,
            # One step per mission: the idempotency key is derived from it,
            # so a re-run against an un-superseded copy of the ledger folds
            # into the same event instead of writing a second one.
            step_id=f"producer-retired:{source_kind}",
            base_dir=root,
        )
        superseded.append(entry)
    declined_by_reason: dict[str, int] = {}
    for entry in declined:
        declined_by_reason[entry["reason"]] = declined_by_reason.get(entry["reason"], 0) + 1
    if superseded or declined:
        append_tools_governance_once(
            root,
            GOVERNANCE_KIND,
            {
                "schema_version": 1,
                "retired_source_kinds": sorted(RETIRED_SOURCE_KINDS),
                "superseded": superseded,
                "declined": declined,
            },
            # The claim is WHAT was closed and what was declined and why —
            # never when: a night that re-declines the same parked mission
            # has nothing new to say.
            claim_keys=("retired_source_kinds", "superseded", "declined"),
        )
    return {
        "schema_version": 1,
        "superseded": len(superseded),
        "declined": len(declined),
        "declined_by_reason": declined_by_reason,
        "mission_ids": [entry["mission_id"] for entry in superseded],
    }


__all__ = [
    "GOVERNANCE_KIND",
    "POST_WIP_STATES",
    "PRE_WIP_STATES",
    "RETIRED_PRODUCER_REASON",
    "SWEEP_DECLINE_REASONS",
    "supersede_retired_source_missions",
    "sweep_verdict",
]
