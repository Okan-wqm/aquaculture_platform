"""The native fleet admission — one dispatch's whole-fleet decision.

Owns the per-dispatch walk over `model_fleet._FLEET`: each provider is
refused without a probe on a fact the fleet or the ledger already holds, or
probed to a three-valued DECISION within the liveness bound
(`status_probe`), priced through the one reservation road, and either
admitted, skipped or named as the provider that halted the ladder.
`AdmissionOutcome` is the closed vocabulary the executor branches on and the
attempt row records. Split out of `model_fleet` (2026-09-12, ARIA-HIGH-107)
so the fleet declaration stays a declaration and the decision has one home.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from dataclasses import dataclass
from dataclasses import asdict as _asdict
from enum import Enum as _Enum
import hashlib as _hashlib
import json as _json
from typing import Any as _Any, Callable as _Callable, Mapping as _Mapping

from .agent_runtime_profile import AgentRuntimeProfile as _AgentRuntimeProfile
from .genesis_policy import _AdaptiveRuntimePolicy
from .model_fleet import (
    _FLEET,
    _RUNTIME_BINARIES,
    Provider,
    _credential_named,
    provider_for_model,
    provider_model,
)
from .status_probe import (
    AdmissionClock,
    ProbeRecord,
    StatusDecision,
    _RuntimeStatusObservation,
    observe_until_decided,
    status_probe_liveness_seconds,
)


# The status reason a provider row carries when it is refused WITHOUT a
# probe: the reason is a fleet/policy fact, not something the vendor said.
READONLY_RUNTIME_STATUS_REASON = "provider_readonly_runtime"
COOLDOWN_STATUS_REASON = "provider_quota_cooldown"


class AdmissionOutcome(str, _Enum):
    """What ONE native admission concluded for the whole fleet, by name.

    A `str` enum so the row the executor records carries the word itself.
    """

    ADMITTED = "admitted"
    """At least one route is eligible; the first in fleet order runs."""

    PROVIDER_UNDECIDED = "provider_undecided"
    """The first provider still in contention stayed UNDECIDED after the
    liveness bound. Nothing is admitted: a stalled probe is not an auth
    fact, so the ladder does not move past it (operator decision
    2026-09-12). The executor releases under a harness-class reason with
    no attempt burned and the request is retried on a later tick."""

    PROVIDER_CONTROL_UNAVAILABLE = "provider_control_unavailable"
    """The first provider still in contention was NOT refused by its vendor
    but this host could not bind the controls its route runs under (no
    usable write containment for the managed Claude spawn, no managed
    Codex context, no reachable limiter bus). A host fault is not an auth
    reason either (operator decision 2026-09-12: read-only roles fail over
    across vendors for AUTH reasons only), so the ladder halts here by
    name instead of running the next vendor on a broken host. Same
    release shape as `PROVIDER_UNDECIDED`: harness-class, no attempt."""

    NO_ELIGIBLE_PROVIDER = "no_eligible_provider"
    """Every provider was DECIDED and none is eligible (refused, cooled,
    absent, not configured, or a read-only runtime for a writer)."""


# The outcomes that name the provider whose row stopped the ladder. Kept as
# the one set the type checks against, so a fourth halting outcome cannot
# be added without saying which provider it names.
HALTING_OUTCOMES: frozenset[AdmissionOutcome] = frozenset({
    AdmissionOutcome.PROVIDER_UNDECIDED, AdmissionOutcome.PROVIDER_CONTROL_UNAVAILABLE,
})


@dataclass(frozen=True)
class _NativeRuntimeAdmission:
    configuration_digest: str
    candidate_observations: tuple[dict[str, _Any], ...]
    eligible_routes: tuple[dict[str, str], ...]
    outcome: AdmissionOutcome
    halting_provider: str | None
    """The provider whose row halted the ladder — undecided after its bound
    (`PROVIDER_UNDECIDED`) or unbindable on this host
    (`PROVIDER_CONTROL_UNAVAILABLE`); None for the other outcomes."""
    declared_provider: str = "anthropic"
    """ARIA-HIGH-161 — the provider the profile's own `model:` names
    (`declared_provider_for_profile`). The ladder starts here; the first
    eligible route is this provider's whenever it is available."""

    def __post_init__(self) -> None:
        # The outcomes and the routes they carry cannot disagree: an
        # admission that names a halting provider AND offers a route is
        # exactly the laundering this type exists to make unbuildable.
        admitted = bool(self.eligible_routes)
        if (self.outcome is AdmissionOutcome.ADMITTED) != admitted:
            raise ValueError(f"native_admission_outcome_contradicts_routes:{self.outcome.value}:{len(self.eligible_routes)}")
        if (self.outcome in HALTING_OUTCOMES) != (self.halting_provider is not None):
            raise ValueError(f"native_admission_halting_provider_contradicts_outcome:{self.outcome.value}")

    def as_row(self) -> dict[str, _Any]:
        """The whole fleet decision as plain ledger fields."""
        return {
            "configuration_digest": self.configuration_digest,
            "candidate_observations": list(self.candidate_observations),
            "eligible_routes": list(self.eligible_routes),
            "outcome": self.outcome.value,
            "halting_provider": self.halting_provider,
            "declared_provider": self.declared_provider,
        }


def native_admission_budget_seconds(policy: _AdaptiveRuntimePolicy) -> float:
    """The wall-clock bound of one native admission: one full probe liveness
    bound (attempts × `recheck_timeout_seconds` + backoffs) per fleet member.

    Derived from `status_probe.status_probe_liveness_seconds`, never a
    second constant: the policy field keeps its meaning as the per-ATTEMPT
    cap and the admission bound follows the attempt count and pauses the
    probe module declares.
    """
    return status_probe_liveness_seconds(policy.recheck_timeout_seconds) * len(_FLEET)


def declared_provider_for_profile(profile: _AgentRuntimeProfile) -> str:
    """The fleet member the profile's own ``model:`` frontmatter names.

    ARIA-HIGH-161 — a model outside the fleet's vocabulary (or an unset one)
    is the managed Anthropic route, exactly as the route builder treats it.
    """
    return provider_for_model(profile.model) or "anthropic"


def fleet_ladder_for(declared_provider: str) -> tuple[Provider, ...]:
    """The fleet in the order this profile's admission walks it.

    ARIA-HIGH-161 — measured on the first production executor after the
    chain restart (run 35444645590, 2026-09-19): the ladder walked
    ``_FLEET`` in its fixed preference order, so an adversarial judge whose
    frontmatter declares ``glm-5.3`` was admitted on ``anthropic/opus`` (the
    fleet's first member) whenever the managed Claude session was logged in.
    The claude wrapper then ran the Z.ai transport as a failover rung and
    released the finished verdict as ``usage_unavailable``: every night, the
    same judge, the same release, at requeue budget zero. Two distinct
    models — the anchor grade's whole point — could never form.

    The declared provider leads; the rest keep the fleet's preference order
    as the AUTH failover ladder they already were. Halting semantics are
    unchanged: an undecided or unbindable first member still halts.
    """
    leading = tuple(provider for provider in _FLEET if provider.key == declared_provider)
    trailing = tuple(provider for provider in _FLEET if provider.key != declared_provider)
    return leading + trailing


def _native_runtime_admission(
    *,
    repo_root: Path,
    profile: _AgentRuntimeProfile,
    policy: _AdaptiveRuntimePolicy,
    environ: dict[str, str],
    observe_status: _Callable[[Provider, float], _RuntimeStatusObservation],
    cooled_providers: _Mapping[str, _Mapping[str, _Any]],
    clock: AdmissionClock | None = None,
) -> _NativeRuntimeAdmission:
    """Prepare native route observations; the runtime supplies its status transport.

    Legacy marker discovery is deliberately not a native auth prerequisite.
    Neither a status exit nor a price alone establishes control admission.

    Every fleet member is probed to a DECISION or to the liveness bound
    (`status_probe.observe_until_decided`): an undecided attempt — a stall,
    a transport error, an unreadable answer — is retried with backoff,
    each attempt capped by `recheck_timeout_seconds`, on ONE clock for the
    whole admission (`native_admission_budget_seconds`). A first probe that
    stalls to its bound (a swapped-out CLI on a loaded host) leaves the
    members behind it their own share; only what is genuinely gone is
    `status_deadline_elapsed`. The fleet owns this arithmetic so no caller
    can hand the whole fleet a single probe's budget.

    The ladder walks the fleet in the PROFILE's order — the provider its
    ``model:`` declares first, then the fleet's preference order as the
    failover rungs (`fleet_ladder_for`, ARIA-HIGH-161) — and moves past a
    provider ONLY on a DECIDED unavailable observation or a policy fact the row names
    (operator decision 2026-09-12: read-only roles fail over across vendors
    for AUTH reasons only). The first provider still in contention whose
    row is neither eligible nor decided-unavailable halts it, by the name
    of what stopped it: `provider_control_unavailable` when the vendor did
    not refuse but this host could not bind the route's controls
    (`control_status` "unavailable" — an attempted binding that failed; a
    metered-mode probe that never binds controls is "unknown" and is the
    policy's own ineligibility, not a host fault), `provider_undecided`
    when the probe stayed UNDECIDED after its bound. In both, no route is
    eligible and the executor lets the request wait for a later tick
    rather than burn an attempt on a later vendor. A later-ranked provider
    that is undecided or unbindable while an earlier one is eligible is
    skipped for this admission — its row says so — and never cooled. Every
    member is still observed, so the attempt row explains the whole fleet,
    not only the chosen route.

    Two refusals are decided here WITHOUT a probe, because they are facts the
    fleet and the ledger already hold, not questions for the vendor:

    * `provider_readonly_runtime` — the profile is write-capable and this
      provider's runtime cannot write (`Provider.admits_writes`). Probing it
      would only ever admit a route that fails at execution.
    * `provider_quota_cooldown` — the provider is under an active quota
      cooldown (`cooled_providers`, keyed by provider, read by the caller
      from `aria_kernel.provider_cooldown`, whose reader validates every
      field indexed here). The last run on it ended in
      credit exhaustion inside `provider_cooldown_seconds`; the status CLI
      cannot see quota (`quota_observation` is `unknown` from
      `claude auth status`), so the ledger is the only evidence. The row
      says so and carries the cooldown's `until`, and the next vendor in
      fleet order is admitted for the roles it can serve.
    """
    if clock is None:
        clock = AdmissionClock(
            attempt_cap_seconds=float(policy.recheck_timeout_seconds),
            liveness_seconds=native_admission_budget_seconds(policy),
        )
    from .budget import price_spawn_reservation
    from .genesis_policy import _runtime_monetary_admission

    configuration = _json.dumps(
        {"schema_version": 1, "policy_digest": policy.policy_digest,
         "resolved_profile": _asdict(profile)}, sort_keys=True, separators=(",", ":"),
    )
    observations: list[dict[str, _Any]] = []
    eligible: list[dict[str, str]] = []
    halted: tuple[AdmissionOutcome, str] | None = None
    search_path = environ.get("PATH", os.defpath)
    declared_provider = declared_provider_for_profile(profile)
    for provider in fleet_ladder_for(declared_provider):
        if provider.key == "openai":
            model = "gpt-6-astra"
        elif provider.key == "anthropic" and provider_for_model(profile.model) in (None, "anthropic"):
            # The managed Claude route runs the agent's own declared tier
            # (its frontmatter), exactly as the legacy spawn does; a foreign
            # tier in the frontmatter falls back to the fleet default.
            model = profile.model
        else:
            model = provider_model(provider, environ)
        effort = "ultra" if provider.key == "openai" else profile.effort
        route = {"provider": provider.key, "runtime": provider.runtime_hint,
                 "model": model, "effort": effort}
        binary = _RUNTIME_BINARIES.get(provider.runtime_hint, "claude")
        cooldown = cooled_providers.get(provider.key)
        probe = ProbeRecord.unprobed()
        if profile.write_capable and not provider.admits_writes:
            status = _RuntimeStatusObservation(
                "unknown", reason=READONLY_RUNTIME_STATUS_REASON,
                control_status="unavailable", control_reason=READONLY_RUNTIME_STATUS_REASON,
                decision=StatusDecision.UNAVAILABLE,
            )
        elif cooldown is not None:
            status = _RuntimeStatusObservation(
                "unknown", quota_observation="unavailable", reason=COOLDOWN_STATUS_REASON,
                decision=StatusDecision.UNAVAILABLE,
            )
        elif binary is not None and shutil.which(binary, path=search_path) is None:
            status = _RuntimeStatusObservation("unavailable", reason="cli_unavailable",
                                               decision=StatusDecision.UNAVAILABLE)
        elif provider.key == "zai" and not _credential_named(provider, environ):
            status = _RuntimeStatusObservation("unavailable", reason="provider_not_configured",
                                               decision=StatusDecision.UNAVAILABLE)
        else:
            status, probe = observe_until_decided(provider, observe_status, clock)
        # The reservation ceiling is budget's (SPAWN_RESERVATION_CEILING_TOKENS);
        # this row, the executor's spawn gate and the attempt ledger price
        # one alias through the one function, so the admission can never
        # quote a price the gate or the ledger would not.
        price = price_spawn_reservation(model=model)
        monetary = _runtime_monetary_admission(
            repo_root, provider=provider.key, runtime=provider.runtime_hint,
            auth_method=status.auth_method, expected_policy_digest=policy.policy_digest,
        )
        pricing = ({"status": "unavailable", "reason": "model_pricing_unknown"}
                   if price.source == "unknown" else
                   {"status": "available", "reason": price.source, "estimated_usd": price.usd,
                    "basis": "published_api_notional"})
        row = {
            **route, "auth_observation": status.auth_observation,
            "auth_method": status.auth_method,
            "credential_source": status.credential_source,
            "quota_observation": status.quota_observation, "status_reason": status.reason,
            "status_command": list(status.command), "status_exit_code": status.exit_code,
            # The decision kind and how it was reached (attempts, the reason
            # of every answer-less attempt, backoff slept): a reader can
            # tell a stalled probe from a refused login on the row itself.
            "decision": status.decision.value, "probe": probe.as_row(),
            "pricing": pricing,
            "monetary_admission": monetary.mode,
            "monetary_reason": monetary.reason,
            "controls": {"status": status.control_status, "reason": status.control_reason},
        }
        if cooldown is not None:
            # The evidence the refusal rests on, on the row itself: when the
            # cooldown ends and which run started it. Indexed without guards
            # on purpose: `cooled_providers` rows come from
            # `provider_cooldown.active_provider_cooldowns`, whose contract
            # refuses a row missing any of these fields by name before it
            # can reach this admission.
            row["quota_cooldown"] = {
                "until": cooldown["until"], "recorded_at": cooldown["recorded_at"],
                "request_id": cooldown["request_id"], "model": cooldown["model"],
            }
        observations.append(row)
        monetary_available = (monetary.subscription_applies if monetary.mode == "managed_subscription"
                              else price.source != "unknown")
        if (status.decision is StatusDecision.AVAILABLE and monetary_available
                and status.control_status == "available"):
            eligible.append(route)
        elif status.decision is not StatusDecision.UNAVAILABLE and not eligible and halted is None:
            # Not a decided refusal (which the ladder may pass), and the
            # first provider still in contention: what stopped it names the
            # outcome. A row behind an eligible route or an already-halted
            # ladder is observed for the record and decides nothing.
            if status.control_status == "unavailable":
                # This host could not bind the route's controls (the vendor
                # did not refuse; a containment or limiter binding was
                # attempted and failed). Not an auth reason: halt by name.
                halted = (AdmissionOutcome.PROVIDER_CONTROL_UNAVAILABLE, provider.key)
            elif status.decision is StatusDecision.UNDECIDED:
                # The probe never answered inside its bound: halt. Later
                # members are still observed, but nothing behind an
                # undecided probe is admitted.
                halted = (AdmissionOutcome.PROVIDER_UNDECIDED, provider.key)
            # Decided available with controls never bound ("unknown", the
            # metered policy's bare probe) or the monetary policy not
            # applying: the policy's own ineligibility, passed by name.
    if halted is not None:
        outcome, routes = halted[0], ()
    elif eligible:
        outcome, routes = AdmissionOutcome.ADMITTED, tuple(eligible)
    else:
        outcome, routes = AdmissionOutcome.NO_ELIGIBLE_PROVIDER, ()
    return _NativeRuntimeAdmission(
        configuration_digest="sha256:" + _hashlib.sha256(configuration.encode()).hexdigest(),
        candidate_observations=tuple(observations), eligible_routes=routes,
        outcome=outcome, halting_provider=halted[1] if halted is not None else None,
        declared_provider=declared_provider,
    )


__all__ = [
    "declared_provider_for_profile",
    "fleet_ladder_for",
    "COOLDOWN_STATUS_REASON",
    "HALTING_OUTCOMES",
    "READONLY_RUNTIME_STATUS_REASON",
    "AdmissionOutcome",
    "_NativeRuntimeAdmission",
    "_native_runtime_admission",
    "native_admission_budget_seconds",
]
