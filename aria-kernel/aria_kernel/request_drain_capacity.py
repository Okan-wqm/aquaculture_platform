"""ARIA-HIGH-364 — the executor's drain capacity, measured from the request ledger.

WHY. Measured 2026-10-06 on the runner's store: ARIA minted about 66 agent
requests a day and the executor drained about 28. Of 1,866 request rows, 836
died ANCHOR_STALE, 606 were never claimed and 373 were accepted; 325 were
minted between 09-27 and 10-04 while the executor workflow was disabled. No
producer knew either number, so every producer minted into the hole. The
admission door (``request_admission``) asks this module two questions, and
both answers come from the ledgers the executor itself writes — never from
a constant guess and never from the GitHub API:

* how fast does the queue drain? — requests that got a result row inside a
  trailing window, per day;
* is anything draining it at all? — the newest result or claim, against the
  oldest request that is still waiting to be claimed.

WHAT. ``measure_drain_capacity`` loads the three request ledgers ONCE and
derives every state with the batch ``derive_request_states`` (ARIA-HIGH-358:
the per-request form costs 0.96 s a row on that store). The knobs are policy
(``genesis_policy`` block ``request_admission``, bounds below), read the way
``cycle_guard`` reads the ``rhythm`` block.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .tool_registry import bound_workspace_root, parse_utc_stamp

POLICY_KEY = "request_admission"

# Calibrated against the 2026-10-06 measurement (28 drained/day, a 7-day
# request anchor in aria-config). Each key is documented beside its default in
# data/genesis_policy_default.json; the bounds below refuse a value by name.
REQUEST_ADMISSION_DEFAULTS: dict[str, float | int] = {
    # Discretionary minting stops once the claimable backlog would exceed this
    # many days of measured drain. 2 days at 28/day caps the backlog at 56: a
    # request admitted at the cap is reached in ~2 days, well inside the 7-day
    # anchor, with room for the never-throttled plan steps the executor takes
    # first. The 606 never-claimed rows of 10-06 were 21 days of drain.
    "backlog_days_of_drain": 2.0,
    # The trailing window the drain rate is averaged over: one week smooths
    # the nightly cadence (cron 02:29 plus a drain after every cycle).
    "drain_window_days": 7,
    # No result and no claim for this long, while a claimable request has
    # waited this long, means no executor is draining. The executor runs at
    # least daily, so 36 h tolerates one late or failed night and stops the
    # second: the 09-27..10-04 outage would have stopped minting on 09-28.
    "executor_liveness_hours": 36.0,
    # The budget when the measured drain is below it (a fresh store, or a
    # week with nothing to drain). Without a floor, zero drain gives zero
    # budget, nothing discretionary is ever minted, and the drain can never
    # be measured: the door would deadlock itself. 32 is the per-role judge
    # ceiling the judgment pipeline already ran under (Y2, ORPHAN-704).
    "backlog_floor": 32,
    # New plans started per cycle ahead of the budget, while the executor
    # drains and a provider can run the challenger (request_admission
    # SEED_QUOTA_PRODUCERS): panels and judges run earlier in the cycle and
    # would otherwise take every unit of headroom, every night.
    "plan_seeds_per_cycle": 1,
}
REQUEST_ADMISSION_BOUNDS: dict[str, tuple[type, float, float]] = {
    "backlog_days_of_drain": (float, 0.25, 7.0),
    "drain_window_days": (int, 1, 30),
    "executor_liveness_hours": (float, 6.0, 168.0),
    # Minimum 1: a floor of 0 with no measured drain is a budget of 0, and
    # nothing discretionary could ever be minted to measure a drain with.
    "backlog_floor": (int, 1, 1000),
    "plan_seeds_per_cycle": (int, 1, 10),
}
POLICY_INVALID_KIND = "request_admission_policy_invalid"

# The derived states the executor's selection takes (``next_pending_request``):
# the backlog the budget bounds is what is still waiting to be claimed.
CLAIMABLE_STATES = frozenset({"PENDING", "REQUEUED"})


@dataclass(frozen=True)
class AdmissionPolicy:
    backlog_days_of_drain: float
    drain_window_days: int
    executor_liveness_hours: float
    backlog_floor: int
    plan_seeds_per_cycle: int


def request_admission_policy(root: Path) -> AdmissionPolicy:
    """The policy block, merged over the defaults; an out-of-bounds value falls back.

    Review of #1833 (MEDIUM-6): refusing the whole block stopped every
    discretionary mint under ``drain_capacity_unmeasurable`` for one bad
    value, with nothing naming it. A value outside its bounds takes the
    shipped default and is disclosed ONCE on governance per (key, value)
    (``append_tools_governance_once``), so the operator sees what to fix and
    the door keeps measuring.
    """
    from .genesis_policy import load_policy
    from .tool_registry import append_tools_governance_once

    block: dict[str, Any] = dict(REQUEST_ADMISSION_DEFAULTS)
    raw = load_policy(bound_workspace_root(root)).get(POLICY_KEY)
    if isinstance(raw, dict):
        block.update({key: raw[key] for key in REQUEST_ADMISSION_DEFAULTS if key in raw})
    for key, (kind, low, high) in REQUEST_ADMISSION_BOUNDS.items():
        value = block[key]
        typed = isinstance(value, int if kind is int else (int, float)) and not isinstance(value, bool)
        if not typed or not low <= value <= high:
            block[key] = REQUEST_ADMISSION_DEFAULTS[key]
            append_tools_governance_once(root, POLICY_INVALID_KIND, {
                "key": f"{POLICY_KEY}.{key}", "value": repr(value),
                "bounds": f"{kind.__name__} in [{low}, {high}]", "applied_default": block[key],
            }, claim_keys=("key", "value"))
    return AdmissionPolicy(
        backlog_days_of_drain=float(block["backlog_days_of_drain"]),
        drain_window_days=int(block["drain_window_days"]),
        executor_liveness_hours=float(block["executor_liveness_hours"]),
        backlog_floor=int(block["backlog_floor"]),
        plan_seeds_per_cycle=int(block["plan_seeds_per_cycle"]),
    )


@dataclass(frozen=True)
class DrainCapacity:
    """One measurement of the queue, taken once per cycle by the door."""

    measured_at: str
    backlog: int
    oldest_claimable_at: str | None
    drained_in_window: int
    drain_window_days: int
    drain_per_day: float
    last_drain_at: str | None
    executor_live: bool
    backlog_days_of_drain: float
    backlog_floor: int
    plan_seeds_per_cycle: int
    budget: float

    def to_row(self) -> dict[str, Any]:
        return asdict(self)


def _stamp(moment: datetime) -> str:
    return moment.replace(microsecond=0).isoformat()


def _claim_time(row: dict[str, Any]) -> datetime | None:
    from .agent_invocations import _claim_event_time

    moment, raw = _claim_event_time(row)
    return moment if raw is not None else None


def _request_ledgers(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """The request, result and claim ledgers, loaded once and shared with the state fold."""
    from .agent_invocations import _claims_path
    from .ledger import load_declared_jsonl, load_segments

    return (
        load_segments(root, "agent_invocation_requests"),
        load_declared_jsonl(root / "agent-invocations" / "results.jsonl", expected_surface="agent_invocation_results"),
        load_declared_jsonl(_claims_path(root), expected_surface="agent_invocation_claims"),
    )


def measure_drain_capacity(root: Path, *, now: datetime, policy: AdmissionPolicy) -> DrainCapacity:
    """Backlog, drain rate and executor liveness from ONE load of the request ledgers.

    * backlog — requests whose derived state is claimable (PENDING/REQUEUED)
      and whose age is inside the anchor window; an older one is ANCHOR_STALE
      the moment anything looks at it (``sweep_expired_anchors``).
    * drain — distinct requests with a result row submitted inside the
      trailing window, divided by the window: what the executor actually
      finished, accepted or rejected.
    * liveness — dead only when the newest result or ``claimed`` event is
      older than ``executor_liveness_hours`` (or absent) AND a claimable
      request has waited that long. An idle executor with nothing to drain
      is not dead; reading it so would stop minting until something drained,
      which nothing would.
    """
    from .agent_invocations import _anchor_max_age_seconds, derive_request_states

    requests, results, claims = _request_ledgers(root)
    states = derive_request_states(base_dir=root, now=now, _ledgers=(requests, results, claims))
    anchor_horizon = now - timedelta(seconds=_anchor_max_age_seconds(root))
    claimable: list[datetime] = []
    for row in requests:
        if states.get(str(row.get("request_id") or "")) not in CLAIMABLE_STATES:
            continue
        created = parse_utc_stamp(str(row.get("created_at") or ""))
        if created is None or created < anchor_horizon:
            continue
        claimable.append(created)
    window_start = now - timedelta(days=policy.drain_window_days)
    drained: set[str] = set()
    drain_times: list[datetime] = []
    for row in results:
        submitted = parse_utc_stamp(str(row.get("submitted_at") or ""))
        if submitted is None:
            continue
        drain_times.append(submitted)
        if window_start <= submitted <= now and row.get("request_id"):
            drained.add(str(row["request_id"]))
    drain_times.extend(
        moment for row in claims if row.get("event") == "claimed"
        for moment in (_claim_time(row),) if moment is not None
    )
    last_drain = max(drain_times) if drain_times else None
    liveness = timedelta(hours=policy.executor_liveness_hours)
    oldest = min(claimable) if claimable else None
    waiting_too_long = oldest is not None and now - oldest > liveness
    silent_too_long = last_drain is None or now - last_drain > liveness
    drain_per_day = len(drained) / policy.drain_window_days
    return DrainCapacity(
        measured_at=_stamp(now),
        backlog=len(claimable),
        oldest_claimable_at=_stamp(oldest) if oldest else None,
        drained_in_window=len(drained),
        drain_window_days=policy.drain_window_days,
        drain_per_day=round(drain_per_day, 3),
        last_drain_at=_stamp(last_drain) if last_drain else None,
        executor_live=not (waiting_too_long and silent_too_long),
        backlog_days_of_drain=policy.backlog_days_of_drain,
        backlog_floor=policy.backlog_floor,
        plan_seeds_per_cycle=policy.plan_seeds_per_cycle,
        budget=round(max(float(policy.backlog_floor), policy.backlog_days_of_drain * drain_per_day), 3),
    )


__all__ = [
    "CLAIMABLE_STATES",
    "POLICY_INVALID_KIND",
    "POLICY_KEY",
    "REQUEST_ADMISSION_BOUNDS",
    "REQUEST_ADMISSION_DEFAULTS",
    "AdmissionPolicy",
    "DrainCapacity",
    "measure_drain_capacity",
    "request_admission_policy",
]
