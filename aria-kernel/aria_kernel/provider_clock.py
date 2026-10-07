"""The provider-available clock: elapsed time minus the time no provider could serve.

WHY (ARIA-HIGH-365). Every bound that retires waiting work measured wall
time: the 72 h plan-stall abandonment (B1), the 24 h implementation orphan
reap (B2), the request anchor TTL (B3), the watchdog's 600 s stall finding.
Each asks "has this work been neglected for too long?", and during a provider
outage the answer is no — nobody could have done it. Measured: plans ABANDONED
with ``stalled:provider_quota_unavailable:anthropic``; 37 of 43 requests that
aged out on 2026-08-21..25 had seen only provider-class releases; 38 requests
lost to outages in all. The clock below makes the neglect question the one the
timers ask: :func:`provider_available_age` is wall time minus the intervals in
which the providers the work is routed to were all in an open outage
(``provider_outage_ledger``).

WHICH providers. A role's work is routed to the HEAD of its ladder
(``runtime_profiles.provider_routing``, ARIA-HIGH-161 made the ladder start at
the declared provider); the failover rungs serve it only when this host has
them configured, which no ledger row records (``provider_not_configured`` and
``cli_unavailable`` are admission-time host facts, never outages). Measured on
the production store: every B1/B3 death above had the head out and no rung
serving. Counting the rungs as available would keep the clock running through
exactly those outages.

Pausing on the head alone is wrong when a rung DID serve the work, and a
serving rung does not reset any of these clocks (the plan-stall stamp is the
plan ledger's, not the claim ledger's — PR #1835 review HIGH-1). So the head
pause is gated on causality by the callers (``outage_causality``): a timer
pauses only for work still WAITING on a provider — a stall whose cause is in
the harness fault domain, or a request that never left PENDING/REQUEUED. A
request a rung answered and that then died for its own reason (an
``agent_refused`` escalation) is measured on the wall clock.

WHICH outages count at all (review HIGH-2). Only a provider on a configured
routing ladder holds an outage open for a clock: an outage of a provider no
role routes to is never restored by a spawn (nothing spawns it) and would
freeze every reader that asks about it. Readers name their providers
explicitly — the heads of the roles whose work they measure — with
``every`` (all must be out: the timers) or ``any`` (one is enough: the
observers that only decline to blame, the watchdog and the cool-off).

The bound on pausing is ``provider_outage_ledger.escalate_prolonged_outages``: an
outage open 30 days is put to the operator, never answered by a timer.

ONE FACT, TWO READERS (ARIA-HIGH-364 alignment). Every detection writes
through ``provider_cooldown.record_provider_cooldown``, which writes the
cooldown row AND opens the outage interval. Admission (ARIA-HIGH-364's
``provider_outage.provider_outage``) reads the cooldown rows: "may a request
run now?" is a back-off question, answered by ``until``. This clock reads the
interval rows: "was the provider out?" needs the restore evidence, because a
back-off that ran out is not a provider that came back. No second
outage-active predicate lives here; admission's is ARIA-HIGH-364's.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from .provider_outage_ledger import OutageInterval, outage_intervals


def role_head_providers(roles: Iterable[str]) -> frozenset[str]:
    """The provider each role's work is routed to first (every seat of a per-agent role)."""
    from .runtime_profiles import load_provider_routing

    routing = load_provider_routing()
    heads: set[str] = set()
    for role in roles:
        entry = routing.roles.get(role)
        names = ([entry] if isinstance(entry, str) else list(entry.values()) if entry is not None
                 else list(routing.ladders))
        for name in names:
            ladder = [p for p in routing.ladders[name] if p not in routing.suspended_providers]
            if ladder:
                heads.add(ladder[0])
    return frozenset(heads)


def routed_providers() -> frozenset[str]:
    """Every provider some configured routing ladder names (suspended ones removed)."""
    from .runtime_profiles import load_provider_routing

    routing = load_provider_routing()
    return frozenset(p for ladder in routing.ladders.values() for p in ladder
                     if p not in routing.suspended_providers)


def planning_heads() -> frozenset[str]:
    """The providers heading the planning-round roles: whose outage can leave a plan unanswered."""
    from .plan_round_scope import PLANNING_ROUND_ROLES

    return role_head_providers(PLANNING_ROUND_ROLES)


def _merge(spans: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    merged: list[tuple[datetime, datetime]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _intersect(a: list[tuple[datetime, datetime]], b: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    out: list[tuple[datetime, datetime]] = []
    i = j = 0
    while i < len(a) and j < len(b):
        start, end = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if start < end:
            out.append((start, end))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


class ProviderClock:
    """The store's outage intervals, read at most once and asked many questions.

    :func:`provider_clock` returns one bound to a store that reads the
    governance ledger on its FIRST question, not at construction: a timer asks
    only after wall time already exceeded its bound (available time can never
    exceed wall time), so the selection path that builds one per poll pays
    nothing until some request is actually old. ``ProviderClock(())`` is a
    store that never saw an outage, on which every answer equals wall time.
    """

    def __init__(self, intervals: tuple[OutageInterval, ...] | None = None, *,
                 base_dir: str | Path | None = None) -> None:
        self._intervals = intervals
        self._base_dir = base_dir

    @property
    def intervals(self) -> tuple[OutageInterval, ...]:
        if self._intervals is None:
            self._intervals = outage_intervals(self._base_dir)
        return self._intervals

    def _spans(self, provider: str, until: datetime) -> list[tuple[datetime, datetime]]:
        return _merge([(i.opened_at, i.closed_at or until) for i in self.intervals
                       if i.provider == provider and i.provider in routed_providers()])

    def _down(self, providers: frozenset[str], until: datetime, *, every: bool) -> list[tuple[datetime, datetime]]:
        """Spans in which every (``every``) or any provider in ``providers`` was in outage."""
        if not providers:
            return []
        spans = [self._spans(provider, until) for provider in sorted(providers)]
        if not every:
            return _merge([span for provider_spans in spans for span in provider_spans])
        result = spans[0]
        for provider_spans in spans[1:]:
            result = _intersect(result, provider_spans)
        return result

    def _covered(self, start: datetime, end: datetime, providers: frozenset[str], *, every: bool) -> timedelta:
        total = timedelta(0)
        for span_start, span_end in self._down(providers, end, every=every):
            lo, hi = max(span_start, start), min(span_end, end)
            if lo < hi:
                total += hi - lo
        return total

    def covered(self, start: datetime, end: datetime, providers: frozenset[str]) -> timedelta:
        """How much of ``[start, end]`` EVERY provider in ``providers`` spent in outage."""
        return self._covered(start, end, providers, every=True)

    def covered_any(self, start: datetime, end: datetime, providers: frozenset[str]) -> timedelta:
        """How much of ``[start, end]`` ANY provider in ``providers`` spent in outage."""
        return self._covered(start, end, providers, every=False)

    def overlapping(self, start: datetime, end: datetime, providers: frozenset[str]) -> list[OutageInterval]:
        """The outage intervals of ``providers`` that overlap ``[start, end]``, by opening."""
        return sorted((i for i in self.intervals if i.provider in providers and i.provider in routed_providers()
                       and i.opened_at < end and (i.closed_at is None or i.closed_at > start)),
                      key=lambda i: i.opened_at)

    def available_age(self, since: datetime, now: datetime, providers: frozenset[str]) -> timedelta:
        """``now - since`` minus the time every provider in ``providers`` was out."""
        return (now - since) - self.covered(since, now, providers)

    def outage_active(self, providers: frozenset[str], now: datetime) -> bool:
        return any(start <= now < end for start, end in self._down(providers, now + timedelta(seconds=1), every=True))


def provider_clock(base_dir: str | Path | None) -> ProviderClock:
    return ProviderClock(base_dir=base_dir)


def _providers(roles: Iterable[str] | None, providers: Iterable[str] | None) -> frozenset[str]:
    if (roles is None) == (providers is None):
        raise ValueError("provider_clock_needs_exactly_one_of_roles_or_providers")
    return frozenset(providers) if providers is not None else role_head_providers(roles or ())


def provider_available_age(
    since: datetime, now: datetime, *, roles: Iterable[str] | None = None,
    providers: Iterable[str] | None = None, base_dir: str | Path | None,
) -> timedelta:
    """``now - since`` minus the time every provider heading ``roles`` (or in ``providers``) was down."""
    return provider_clock(base_dir).available_age(since, now, _providers(roles, providers))


__all__ = [
    "ProviderClock", "planning_heads", "provider_available_age", "provider_clock",
    "role_head_providers", "routed_providers",
]
