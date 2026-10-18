"""ARIA-HIGH-364 — is every provider a role could run on cooled? A read, never a detector.

WHY. A request whose every provider is under an active cooldown cannot run:
the executor's native admission decides ``no_eligible_provider`` for it and
the request waits. During an outage the judge fan-out kept refilling its
per-role cap (``cycle._phase_judgment_pipeline``) and the planner daemon
claimed, released and wrote a governance row on every poll. Both read the
same two facts this module reads, and nothing else:

* ``provider_cooldown.active_provider_cooldowns`` — the newest unexpired
  ``provider_quota_cooldown`` row per provider (quota or auth exhaustion), as
  ``{provider: details}`` with ``details["until"]`` and ``details["reason"]``;
* ``runtime_profiles.load_provider_routing().ladder_for(role, target)`` — the
  providers a seat may run on, suspended ones removed.

Detection (which failures cool a provider, and for how long) belongs to
``provider_cooldown`` and is not widened here.

ARIA-HIGH-579 — :func:`fleet_outage` asks the same question for the whole
routing table: the nightly cycle holds in place (``provider_hold``) exactly
when every routed role is in an outage.
"""
from __future__ import annotations

import os
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, parse_utc_stamp


@dataclass(frozen=True)
class ProviderOutage:
    """Every provider the role can use is cooled; ``until`` is when the first one returns."""

    role: str
    providers: tuple[str, ...]
    until: str | None

    def to_row(self) -> dict[str, Any]:
        return {"role": self.role, "providers": list(self.providers), "until": self.until}


def role_providers(role: str, *, target_agent: str | None = None) -> tuple[str, ...]:
    """The providers a seat of ``role`` may run on (every target's ladder when none is named)."""
    from .runtime_profiles import load_provider_routing

    routing = load_provider_routing()
    entry = routing.roles.get(role)
    if entry is None:
        raise GovernanceError(f"provider_routing_role_unrouted:{role}")
    if target_agent is not None or isinstance(entry, str):
        return routing.ladder_for(role, target_agent or "")
    providers: list[str] = []
    for target in sorted(entry):
        providers.extend(p for p in routing.ladder_for(role, target) if p not in providers)
    return tuple(providers)


def cooled_providers(base_dir: str | Path | None, *, now: datetime) -> dict[str, dict[str, str]]:
    """``{provider: {"until", "reason"}}`` for every provider cooled at ``now``."""
    from .provider_cooldown import active_provider_cooldowns

    return {
        provider: {"until": str(details["until"]), "reason": str(details["reason"])}
        for provider, details in active_provider_cooldowns(base_dir, now=now).items()
    }


def host_providers(environ: Mapping[str, str] | None = None) -> frozenset[str]:
    """The providers THIS host can run: ``model_fleet.available_providers``'
    cheap signals (the claude CLI on PATH, the Z.ai credential boundary
    named, the codex session). The one presence reading every gate that
    decides a claim or a mint takes (ARIA-HIGH-434 review)."""
    from .model_fleet import available_providers

    return frozenset(provider.key for provider in available_providers(dict(os.environ if environ is None else environ)))


def provider_outage(
    role: str, cooled: Mapping[str, Mapping[str, str]], *, now: datetime, present: Collection[str],
    target_agent: str | None = None,
) -> ProviderOutage | None:
    """The outage for ``role`` under ``cooled`` (a ``cooled_providers`` reading), or None.

    A cooldown whose ``until`` has passed by ``now`` cools nothing, so a
    reading taken earlier in the cycle stays honest as windows end. A role
    whose ladder is empty (every provider suspended) is in an outage too: no
    provider would take its request.

    ARIA-HIGH-434 review — ``present`` is the host's providers
    (:func:`host_providers`): a rung that would take over from a cooled
    provider has to be one this host can run. The writer ladder gained a
    zai rung; on a host with no Z.ai key a cooled Anthropic left the
    implementer "not in an outage", so the planner hook claimed it every
    poll and the admission released it ``no_eligible_provider``. A ladder
    nothing has cooled is no outage whatever is absent: there is no event
    to wait out, and the admission names an absent provider itself.
    """
    providers = role_providers(role, target_agent=target_agent)
    standing: dict[str, datetime] = {}
    for provider in providers:
        until = parse_utc_stamp(str((cooled.get(provider) or {}).get("until") or ""))
        if until is not None and until > now:
            standing[provider] = until
        elif provider in present:
            return None
    if providers and not standing:
        return None
    first_back = min(standing.values()) if standing else None
    return ProviderOutage(
        role=role, providers=providers,
        until=first_back.replace(microsecond=0).isoformat() if first_back else None,
    )


@dataclass(frozen=True)
class FleetOutage:
    """Every routed role is in an outage: no seat of any role has a provider to run on.

    ``until`` is the first moment any role gets a provider back (the earliest
    role ``until``), or None when no role's outage ends on a clock (every rung
    absent from the host or suspended, behind a cooled one).
    """

    providers: tuple[str, ...]
    until: str | None

    def to_row(self) -> dict[str, Any]:
        return {"providers": list(self.providers), "until": self.until}


def fleet_outage(
    cooled: Mapping[str, Mapping[str, str]], *, now: datetime, present: Collection[str],
) -> FleetOutage | None:
    """ARIA-HIGH-579 — whether EVERY routed role is in an outage under ``cooled``, or None.

    The cycle-level question ("is every provider out?") asked through the
    per-role answer above, once per routed role, so the two can never
    disagree: a night holds exactly when no request of any role could be
    admitted. One role with a provider that can take it is no fleet outage;
    that night runs, and the per-request waits hold the roles that cannot.
    """
    from .runtime_profiles import load_provider_routing

    outages: list[ProviderOutage] = []
    for role in sorted(load_provider_routing().roles):
        outage = provider_outage(role, cooled, now=now, present=present)
        if outage is None:
            return None
        outages.append(outage)
    if not outages:
        return None
    providers = sorted({provider for outage in outages for provider in outage.providers
                        if provider in cooled})
    untils = [outage.until for outage in outages if outage.until is not None]
    return FleetOutage(providers=tuple(providers), until=min(untils) if untils else None)


__all__ = [
    "FleetOutage", "ProviderOutage", "cooled_providers", "fleet_outage", "host_providers", "provider_outage",
    "role_providers",
]
