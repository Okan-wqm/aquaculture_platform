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
"""
from __future__ import annotations

from collections.abc import Mapping
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


def provider_outage(
    role: str, cooled: Mapping[str, Mapping[str, str]], *, now: datetime, target_agent: str | None = None,
) -> ProviderOutage | None:
    """The outage for ``role`` under ``cooled`` (a ``cooled_providers`` reading), or None.

    A cooldown whose ``until`` has passed by ``now`` cools nothing, so a
    reading taken earlier in the cycle stays honest as windows end. A role
    whose ladder is empty (every provider suspended) is in an outage too: no
    provider would take its request.
    """
    providers = role_providers(role, target_agent=target_agent)
    standing: dict[str, datetime] = {}
    for provider in providers:
        until = parse_utc_stamp(str((cooled.get(provider) or {}).get("until") or ""))
        if until is None or until <= now:
            return None
        standing[provider] = until
    first_back = min(standing.values()) if standing else None
    return ProviderOutage(
        role=role, providers=providers,
        until=first_back.replace(microsecond=0).isoformat() if first_back else None,
    )


__all__ = ["ProviderOutage", "cooled_providers", "provider_outage", "role_providers"]
