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
  role is in an outage on this host). An unreadable cooldown or outage ledger
  is not an outage: the night runs, and each request's admission refuses the
  malformed row by name, as the planner hook already decides.
* :func:`hold_if_every_provider_is_out` — at a checkpoint, the hold: ONE
  ``autonomy_state`` row (phase ``provider_outage_hold``, status ``held``)
  naming the checkpoint, the cooled providers and when the first returns, and
  ONE notice (``cycle_held``). The orchestrator then exits with the clean exit
  ``EXIT_PROVIDER_OUTAGE_HOLD``: no failure, no retry, no breaker count, and
  the doctor's exit streak reads it as clean. The one deterministic duty a
  cycle carried for an outage still runs on a held night: the 30-day bound on
  the provider-available clock (``escalate_prolonged_outages``), so a hold
  that never ends still reaches the operator as one item.

WHAT "OUT" MEANS FOR A NIGHT (review of ARIA-HIGH-579, major). A cooldown is
the probe BACK-OFF of an outage (ARIA-HIGH-366): it says when to ask again,
not whether the provider came back. Z.ai's quota refusal states no reset, so
its back-off is the policy 900 s doubling to ``MAX_REPROBE_SECONDS`` (3600 s),
while the cycle cron (17:13) fires 15 hours after the executor drain (02:29)
that met the refusal. Read from the back-off alone, every real total outage
looked like Z.ai serving by the cron: the night ran its whole cycle and
minted a round request nobody could serve. A night carries no request, so it
is not the lane a lapsed back-off cues to ask again; the lanes that ask are
the ones carrying a request (the chained and 02:29 drains' native admission,
which re-probes and renews the back-off or admits; the served spawn closes
the outage, ``record_provider_restored``). So for the night a provider is out
when it is cooled, or when its outage is still open, its back-off was the
policy's own (a reset the vendor STATED and that has passed is the vendor's
word that the quota is back, and the night's spawns test it), and a waiting
request will carry its re-probe (:func:`_awaiting_reprobe`). With nothing
waiting, nothing would ever ask again and a hold would never end though the
quota came back; then the night runs, and what it mints is the request the
next drain re-probes with. Per-request callers keep reading the back-off.

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
A cycle held mid-night (after a spawning lane) has already run its cycle
step, so it still runs its deterministic reflection, as the failed exits do
(ARIA-HIGH-420): the daily report is written and the cycle's schedulable
pressures are queued for the next night instead of being dropped.
The clocks that measure waiting for a model are already paused by the
outage intervals (``provider_clock``, ARIA-HIGH-365/367). The workflow's
deterministic observation steps (doctor, self_improve, deliver, integrity,
publish) run after the cycle step as on every night; they spawn no agent.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .orchestrator_exit_history import EXIT_PROVIDER_OUTAGE_HOLD
from .provider_outage import FleetOutage, cooled_providers, fleet_outage, host_providers, role_providers
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


# The derived request states a drain selects (`agent_invocations.next_pending_request`).
_WAITING_STATES = frozenset({"PENDING", "REQUEUED"})


def _awaiting_reprobe(
    base_dir: str | Path, cooled: Mapping[str, Any], *, now: datetime,
) -> frozenset[str]:
    """Providers out for the night on an open outage whose lapsed back-off a waiting request will re-probe."""
    from .provider_cooldown import latest_provider_cooldowns
    from .provider_outage_ledger import open_outages

    lapsed = {interval.provider for interval in open_outages(base_dir)} - set(cooled)
    if not lapsed:
        return frozenset()
    latest = latest_provider_cooldowns(base_dir)
    # A reset the vendor stated, now passed, is its word that the quota is back.
    candidates = {provider for provider in lapsed
                  if (latest.get(provider) or {}).get("until_source") != "stated_reset"}
    return frozenset(candidates & _reprobe_carried(base_dir, candidates, now=now)) if candidates else frozenset()


def _reprobe_carried(base_dir: str | Path, providers: set[str], *, now: datetime) -> set[str]:
    """Which of ``providers`` some waiting request's ladder names (its admission will re-probe them)."""
    from .agent_invocations import derive_request_states
    from .ledger import load_segments
    from .tool_registry import ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    states = derive_request_states(base_dir=root, now=now)
    carried: set[str] = set()
    for request in load_segments(root, "agent_invocation_requests"):
        if states.get(str(request.get("request_id"))) not in _WAITING_STATES:
            continue
        try:
            ladder = role_providers(str(request.get("role") or ""),
                                    target_agent=str(request.get("target_agent") or "") or None)
        except GovernanceError:
            continue  # an unrouted role is refused by its admission, which probes nothing
        carried |= providers.intersection(ladder)
        if carried == providers:
            break
    return carried


def night_outage(base_dir: str | Path, *, now: datetime | None = None) -> FleetOutage | None:
    """The fleet outage standing at ``now`` for a night, or None (an unreadable ledger is None)."""
    moment = now or datetime.now(timezone.utc)
    try:
        cooled = cooled_providers(base_dir, now=moment)
        return fleet_outage(cooled, now=moment, present=host_providers(),
                            awaiting_reprobe=_awaiting_reprobe(base_dir, cooled, now=moment))
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
              f"out: {', '.join(outage.providers) or 'none'}\n"
              f"awaiting a drain's re-probe: {', '.join(outage.awaiting_reprobe) or 'none'}\n"
              f"first provider back: {outage.until or 'no stated reset'}\n"
              "nothing was minted, claimed or charged after this point; the next night continues"),
    )
    return details


__all__ = [
    "CHECKPOINTS", "CHECKPOINT_AFTER_PLANNER_DISPATCH", "CHECKPOINT_AFTER_WORKER_DISPATCH",
    "CHECKPOINT_CYCLE_START", "HOLD_NOTICE_KIND", "HOLD_NOTICE_TITLE", "HOLD_PHASE", "HOLD_STATUS",
    "hold_if_every_provider_is_out", "night_outage",
]
