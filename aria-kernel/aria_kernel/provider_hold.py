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
  malformed row by name, as the planner hook already decides — and the
  fail-open names itself (ONE ``hold_indeterminate`` notice per unreadable
  source), because a hold that was silently never even asked is a defect
  nobody sees.
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
word that the quota is back, and the night's spawns test it), and a request
the queue's own selection would hand out will carry its re-probe
(:func:`_awaiting_reprobe`, which asks the owner's eligibility fold
``agent_invocations.selection_skip`` — a request no drain would select, the
fold's shadow/moot/undispatchable/anchor refusals, carries nothing). With
nothing selectable, nothing would ever ask again and a hold would never end
though the quota came back; then the night runs, and what it mints is the
request the next drain re-probes with. Per-request callers keep reading the
back-off.

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
from .ledger import LedgerIntegrityError, LedgerReadLimitError, LedgerRowTooLargeError
from .provider_outage import FleetOutage, cooled_providers, fleet_outage, host_providers, role_providers
from .tool_registry import GovernanceError

HOLD_PHASE = EXIT_PROVIDER_OUTAGE_HOLD
HOLD_STATUS = "held"
HOLD_NOTICE_KIND = "cycle_held"
# Fixed: the issue channel keeps one issue per title (ARIA-HIGH-415); what
# varies rides the body.
HOLD_NOTICE_TITLE = "ARIA cycle held: every provider is out"
# ARIA-HIGH-579 (review) — the fail-open of an unreadable ledger, named. One
# title per unreadable SOURCE (at most the cooldown, outage and request
# ledgers and the routing table): the issue channel still keeps one issue per
# title, and the operator sees WHICH read failed, not only that one did.
HOLD_INDETERMINATE_NOTICE_KIND = "hold_indeterminate"
HOLD_INDETERMINATE_NOTICE_TITLE = "ARIA hold indeterminate: {source} could not be read"
CHECKPOINT_CYCLE_START = "cycle_start"
CHECKPOINT_AFTER_PLANNER_DISPATCH = "after_planner_dispatch"
CHECKPOINT_AFTER_WORKER_DISPATCH = "after_worker_dispatch"
CHECKPOINTS: tuple[str, ...] = (
    CHECKPOINT_CYCLE_START, CHECKPOINT_AFTER_PLANNER_DISPATCH, CHECKPOINT_AFTER_WORKER_DISPATCH,
)

# The read-failure taxonomy of the ledgers this module reads: a row refused
# by name (`GovernanceError`), an unreadable file (`OSError`, `ValueError`),
# and the ledger's own integrity bounds (`ledger`).
_UNREADABLE_ERRORS = (
    GovernanceError, OSError, ValueError, LedgerIntegrityError, LedgerReadLimitError, LedgerRowTooLargeError,
)
_UNREADABLE = object()


def _night_read(source: str, read: Any, *args: Any, **kwargs: Any) -> Any:
    """One guarded ledger read for the night's question: fail open, named.

    An unreadable ledger is not an outage — the night runs, and each
    request's admission refuses the malformed row by name — but silently so
    is a defect nobody sees (review of ARIA-HIGH-579): the fail-open records
    ONE ``hold_indeterminate`` notice naming the source, so an operator
    learns the hold was never even asked. The ledger's own RuntimeError
    taxonomy is caught with it: a hash-broken governance ledger used to
    raise past the hold's catch and take the whole checkpoint down.
    """
    try:
        return read(*args, **kwargs)
    except _UNREADABLE_ERRORS as exc:
        from .notify import notify_best_effort

        notify_best_effort(
            kind=HOLD_INDETERMINATE_NOTICE_KIND, base_dir=_indeterminate_base(args),
            title=HOLD_INDETERMINATE_NOTICE_TITLE.format(source=source),
            body=(f"source: {source}\nreason: {str(exc)[:400]}\n"
                  "the night's hold was not decided — this read failed, so the night runs and "
                  "each request's admission refuses the malformed row by name"),
        )
        return _UNREADABLE


def _indeterminate_base(args: tuple[Any, ...]) -> str | Path | None:
    """The ``base_dir`` a guarded read was aimed at (its first argument, when given)."""
    return args[0] if args and isinstance(args[0], (str, Path)) else None


# ARIA-HIGH-579 review — the night's carrier question is the queue owner's
# selection eligibility (`agent_invocations.selection_skip`), never a local
# copy of its state half: a request no drain would select (shadow, moot,
# undispatchable, anchor-refused) carries no re-probe, and counting it would
# stand a hold nothing can end.


def _awaiting_reprobe(
    base_dir: str | Path, cooled: Mapping[str, Any], *, now: datetime,
) -> frozenset[str] | Any:
    """Providers out for the night on an open outage whose lapsed back-off a
    selectable request will re-probe, or ``_UNREADABLE`` when a ledger the
    answer needs could not be read (the night fails open, named)."""
    from .provider_cooldown import latest_provider_cooldowns
    from .provider_outage_ledger import open_outages

    outages = _night_read("outage_ledger", open_outages, base_dir)
    if outages is _UNREADABLE:
        return _UNREADABLE
    lapsed = {interval.provider for interval in outages} - set(cooled)
    if not lapsed:
        return frozenset()
    latest = _night_read("cooldown_ledger", latest_provider_cooldowns, base_dir)
    if latest is _UNREADABLE:
        return _UNREADABLE
    # A reset the vendor stated, now passed, is its word that the quota is back.
    candidates = {provider for provider in lapsed
                  if (latest.get(provider) or {}).get("until_source") != "stated_reset"}
    if not candidates:
        return frozenset()
    return _night_read("request_ledger", _reprobe_carried, base_dir, candidates, now=now)


def _reprobe_carried(base_dir: str | Path, providers: set[str], *, now: datetime) -> set[str]:
    """Which of ``providers`` some selectable request's ladder names (its admission will re-probe them)."""
    from .agent_invocations import _anchor_repo_root, derive_request_states, selection_skip
    from .evidence_probe import GitProbeSession
    from .ledger import load_segments
    from .provider_clock import provider_clock
    from .tool_registry import ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    states = derive_request_states(base_dir=root, now=now)
    # The same one-session shape a selection uses (`next_pending_request`):
    # one probe clock for the whole question, and the night's read records
    # nothing (`may_record` False) — a refusal it sees is still a skip.
    repo_root = _anchor_repo_root(root)
    probes = GitProbeSession()
    clock = provider_clock(root)
    carried: set[str] = set()
    for request in load_segments(root, "agent_invocation_requests"):
        if selection_skip(root, request, states=states, repo_root=repo_root, probes=probes,
                          clock=clock, may_record=lambda: False, now=now) is not None:
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
    """The fleet outage standing at ``now`` for a night, or None.

    An unreadable ledger is not an outage: the night runs (each request's
    admission refuses the malformed row by name), and the fail-open names
    itself — one ``hold_indeterminate`` notice per unreadable source, so the
    silence that used to hide a broken store is itself observable.
    """
    moment = now or datetime.now(timezone.utc)
    cooled = _night_read("cooldown_ledger", cooled_providers, base_dir, now=moment)
    if cooled is _UNREADABLE:
        return None
    awaiting = _awaiting_reprobe(base_dir, cooled, now=moment)
    if awaiting is _UNREADABLE:
        return None
    outage = _night_read("routing", fleet_outage, cooled, now=moment, present=host_providers(),
                         awaiting_reprobe=awaiting)
    return None if outage is _UNREADABLE else outage


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
