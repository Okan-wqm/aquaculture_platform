"""ARIA-HIGH-579 — a night holds where it stands while every provider is out of quota.

WHY. The operator's decision of 2026-10-17: capacity is paced by pausing and
resuming, not by buying more. When the quota runs out, ARIA holds where it is
and starts no cycle over; when the quota returns, it continues from where it
stopped, and no work is lost. The per-request half existed (ARIA-HIGH-364: a
request whose every provider is cooled waits; the planner hook claims nothing
for it; discretionary mints are refused ``provider_unavailable``). The night
did not: the nightly cron ran the whole orchestration whatever the quota
state. Measured on production-shaped stores with Anthropic and Z.ai both
cooled, through ``autonomy run`` (2026-10-18, before this module): the night
recorded an ordinary completed ``ok`` cycle; it re-booked the adopted plan in
the funnel as minted and rejected (ten such nights read as a stalled funnel
to the doctor), wrote learning rows and a reflection, polled the planner
daemon's whole iteration budget, and, where the adopted plan had no request
in flight, minted its next round request although no provider could serve
it. Nothing said the night was an outage night.

WHAT. One question and one record, both here:

* :func:`night_outage` — "is every provider out?", asked through the one
  owner of that predicate (``provider_outage.fleet_outage``: every routed
  role is in an outage on this host). An unreadable cooldown ledger is not an
  outage: the night runs, and each request's admission refuses the malformed
  row by name, as the planner hook already decides.
* :func:`hold_if_every_provider_is_out` — at a checkpoint, the hold: ONE
  ``autonomy_state`` row (phase ``provider_outage_hold``, status ``held``)
  naming the checkpoint, the cooled providers and when the first returns, and
  ONE notice (``cycle_held``). The orchestrator then exits with the clean exit
  ``EXIT_PROVIDER_OUTAGE_HOLD``: no failure, no retry, no breaker count, and
  the doctor's exit streak reads it as clean. The one deterministic duty a
  cycle carried for an outage still runs on a held night: the 30-day bound on
  the provider-available clock (``escalate_prolonged_outages``), so a hold
  that never ends still reaches the operator as one item.

WHERE THE NIGHT ASKS. A cooldown is written only by a spawn's exhaustion arm
(the executor child, the worker hook, a native admission probe), and the
night's only spawning lanes are the planner and worker drains. So the night
asks at its start (``CHECKPOINT_CYCLE_START``: nothing runs, nothing is
minted, claimed or spent) and after each spawning lane
(``CHECKPOINT_AFTER_PLANNER_DISPATCH``, ``CHECKPOINT_AFTER_WORKER_DISPATCH``):
a quota spent mid-night holds every model phase behind it. The request the
spawn was serving is released by the child under
``provider_quota_unavailable:<provider>``, which charges the request nothing
(``release_reason``); this module adds no release of its own.

WHAT A HELD NIGHT KEEPS. Nothing is re-minted or rebuilt: a pending request,
a plan mid-convergence and a queued item are left exactly as they stand, and
the next night with any provider continues them through the ordinary phases.
The clocks that measure waiting for a model are already paused by the
outage intervals (``provider_clock``, ARIA-HIGH-365/367). The workflow's
deterministic observation steps (doctor, self_improve, deliver, integrity,
publish) run after the cycle step as on every night; they spawn no agent.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .orchestrator_exit_history import EXIT_PROVIDER_OUTAGE_HOLD
from .provider_outage import FleetOutage, cooled_providers, fleet_outage, host_providers
from .tool_registry import GovernanceError

HOLD_PHASE = EXIT_PROVIDER_OUTAGE_HOLD
HOLD_STATUS = "held"
HOLD_NOTICE_KIND = "cycle_held"
# Fixed: the issue channel keeps one issue per title (ARIA-HIGH-415); what
# varies rides the body.
HOLD_NOTICE_TITLE = "ARIA cycle held: every provider is out"
CHECKPOINT_CYCLE_START = "cycle_start"
CHECKPOINT_AFTER_PLANNER_DISPATCH = "after_planner_dispatch"
CHECKPOINT_AFTER_WORKER_DISPATCH = "after_worker_dispatch"
CHECKPOINTS: tuple[str, ...] = (
    CHECKPOINT_CYCLE_START, CHECKPOINT_AFTER_PLANNER_DISPATCH, CHECKPOINT_AFTER_WORKER_DISPATCH,
)


def night_outage(base_dir: str | Path, *, now: datetime | None = None) -> FleetOutage | None:
    """The fleet outage standing at ``now``, or None (an unreadable cooldown ledger is None)."""
    moment = now or datetime.now(timezone.utc)
    try:
        cooled = cooled_providers(base_dir, now=moment)
        return fleet_outage(cooled, now=moment, present=host_providers())
    except (GovernanceError, OSError, ValueError):
        return None


def hold_if_every_provider_is_out(
    base_dir: str | Path, *, cycle_id: str | None, checkpoint: str, profile: str | None, daemon_id: str,
) -> dict[str, Any] | None:
    """Record the night's hold at ``checkpoint`` when every provider is out; None when one serves."""
    if checkpoint not in CHECKPOINTS:
        raise ValueError(f"provider_hold_checkpoint_unknown:{checkpoint}")
    outage = night_outage(base_dir)
    if outage is None:
        return None
    from .autonomy_state import AutonomyStateReducer
    from .notify import notify_best_effort
    from .provider_outage_ledger import escalate_prolonged_outages

    details: dict[str, Any] = {
        "checkpoint": checkpoint,
        **outage.to_row(),
        "daemon_id": daemon_id,
        "prolonged_provider_outages": escalate_prolonged_outages(base_dir),
    }
    AutonomyStateReducer.transition(
        base_dir, cycle_id=cycle_id, phase=HOLD_PHASE, status=HOLD_STATUS, profile=profile, details=details,
    )
    notify_best_effort(
        kind=HOLD_NOTICE_KIND, key=f"{cycle_id or 'night'}:{checkpoint}", base_dir=base_dir,
        title=HOLD_NOTICE_TITLE,
        body=(f"checkpoint: {checkpoint}\ncycle: {cycle_id or 'none started'}\n"
              f"cooled: {', '.join(outage.providers) or 'none'}\n"
              f"first provider back: {outage.until or 'no stated reset'}\n"
              "nothing was minted, claimed or charged after this point; the next night continues"),
    )
    return details


__all__ = [
    "CHECKPOINTS", "CHECKPOINT_AFTER_PLANNER_DISPATCH", "CHECKPOINT_AFTER_WORKER_DISPATCH",
    "CHECKPOINT_CYCLE_START", "HOLD_NOTICE_KIND", "HOLD_NOTICE_TITLE", "HOLD_PHASE", "HOLD_STATUS",
    "hold_if_every_provider_is_out", "night_outage",
]
