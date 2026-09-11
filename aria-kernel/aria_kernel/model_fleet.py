"""ARIA's provider fleet and the mixed-model dispatch policy.

Operator requirement (2026-08-29): agents must NOT all run on one model.
When two or more providers are available, roles are deliberately STRIPED
across them so judges and discussants actually talk ACROSS models — the
two-distinct-model anchor exists precisely to reward that. When only one
provider is up (a subscription can be absent at any time, ARIA-HIGH-023),
every role runs on it: homogeneity under scarcity is honest, and the
cross-provider failover ladder keeps the lane alive rather than mocked.

Provider identity is ENVIRONMENT-PROVEN, never claimed: each provider has
a cheap, side-effect-free availability probe, and the assignment is a pure
function of the probe results plus the role order. No network calls happen
here — probing "is the credential present" is an env/PATH fact; whether the
credential WORKS is the runtime's own auth-failure contract (and, since
ARIA-HIGH-023, its cross-provider fallback).
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from dataclasses import dataclass
from dataclasses import asdict as _asdict
import hashlib as _hashlib
import json as _json
import time as _time
from typing import Any as _Any, Callable as _Callable

from .agent_runtime_profile import AgentRuntimeProfile as _AgentRuntimeProfile
from .genesis_policy import _AdaptiveRuntimePolicy


@dataclass(frozen=True)
class Provider:
    """One dispatchable vendor runtime."""

    key: str
    """Stable provider id ('anthropic', 'zai', 'openai')."""

    default_model: str
    """The model this provider's roles run on when the caller pins nothing."""

    credential_env: str | None
    """The env var whose presence proves the credential is configured.

    None means the provider authenticates through a managed session on the
    host (the Claude Code CLI login) — availability then reduces to the CLI
    being installed, which is the honest cheap signal; a dead session is
    the runtime's auth-failure path, not this module's guess.
    """

    runtime_hint: str
    """Which executor runtime serves this provider ('claude' | 'codex')."""


# The fleet, in preference order for mixed assignment (strongest-authoring
# vendor first for the FIRST role; the policy STRIPES, it does not rank —
# ranking is MODEL_TIER_ORDER's job for write protection).
_FLEET: tuple[Provider, ...] = (
    Provider(
        key="anthropic",
        default_model="opus",
        credential_env=None,
        runtime_hint="claude",
    ),
    Provider(
        key="zai",
        default_model="glm-5.3",
        credential_env="ARIA_ZAI_API_KEY",
        runtime_hint="claude",
    ),
    Provider(
        key="openai",
        default_model="gpt-5.2-codex",
        credential_env="OPENAI_API_KEY",
        runtime_hint="codex",
    ),
)

# Codex runs on a ChatGPT-managed subscription session (~/.codex/auth.json)
# by default — an API key is NOT required (operator decision 2026-08-29:
# subscription auth, like the Claude runtime's managed login). The cheap
# availability signal is the session file's existence under the EFFECTIVE
# user's codex home; OPENAI_API_KEY remains the alternative credential.
_CODEX_AUTH_FILE = "auth.json"
_MODEL_PROVIDER_ALIASES: dict[str, str] = {"gpt-6-astra": "openai"}


def _codex_session_present(env: dict[str, str]) -> bool:
    """The ChatGPT-login session file exists under the effective codex home.

    Fail-closed: absence means the runner user has not logged in — the
    remedy is `codex login` as that user, never a silent provider claim.
    """
    home = env.get("CODEX_HOME") or (
        Path(env.get("HOME") or Path.home()) / ".codex"
    )
    return (Path(home) / _CODEX_AUTH_FILE).is_file()


def available_providers(environ: dict[str, str] | None = None) -> list[Provider]:
    """Providers whose cheap availability signals hold, in fleet order.

    Fail-closed in the "absent" direction only: a missing credential env or
    a missing runtime binary removes the provider from consideration. A
    PRESENT credential that turns out dead is not this function's business
    — the dispatch will hit the runtime's typed auth failure and the
    cross-provider ladder (ARIA-HIGH-023) handles it.
    """
    env = dict(os.environ if environ is None else environ)
    # Binary probes honor the CALLER'S PATH (the passed environ when given):
    # a test isolating PATH must be able to make the runtimes invisible.
    search_path = env.get("PATH", os.environ.get("PATH"))
    out: list[Provider] = []
    for provider in _FLEET:
        if provider.runtime_hint == "codex":
            codex_on_path = shutil.which("codex", path=search_path) is not None
            has_credential = _codex_session_present(env) or bool(
                env.get(provider.credential_env or "", "").strip()
            )
            if codex_on_path and has_credential:
                out.append(provider)
            continue
        if provider.credential_env is None:
            # Managed Claude session: the CLI binary is the availability
            # fact this module can see without side effects.
            if shutil.which("claude", path=search_path) is not None:
                out.append(provider)
            continue
        if bool(env.get(provider.credential_env, "").strip()):
            if shutil.which("claude", path=search_path) is not None:
                out.append(provider)
    return out


def assign_mixed_models(
    roles: list[str],
    environ: dict[str, str] | None = None,
) -> dict[str, str]:
    """Assign each role a model so available providers are DELIBERATELY mixed.

    The stripe: role i goes to provider[i % n] over the available providers
    in fleet order. With ≥2 providers this guarantees adjacent roles (the
    judge pair, the challenger and its reviewer) land on DIFFERENT vendors —
    the property the two-distinct-model anchor rewards and single-vendor
    groupthink destroys. With exactly one provider every role maps to it:
    the requirement "karışsınlar" is conditional on availability, and under
    scarcity homogeneity is the honest assignment, not a degraded mock.
    """
    providers = available_providers(environ)
    if not providers:
        return {}
    assignment: dict[str, str] = {}
    for index, role in enumerate(roles):
        assignment[role] = providers[index % len(providers)].default_model
    return assignment


def provider_for_model(model: str) -> str | None:
    """The provider key a model belongs to, or None when unlisted."""
    for provider in _FLEET:
        if model == provider.default_model:
            return provider.key
    return _MODEL_PROVIDER_ALIASES.get(model)


@dataclass(frozen=True)
class _RuntimeStatusObservation:
    auth_observation: str
    quota_observation: str = "unknown"
    reason: str = "status_unavailable"
    command: tuple[str, ...] = ()
    exit_code: int | None = None
    control_status: str = "unknown"
    control_reason: str = "native_runtime_control_binding_unavailable"
    auth_method: str = "unknown"


@dataclass(frozen=True)
class _NativeRuntimeAdmission:
    configuration_digest: str
    candidate_observations: tuple[dict[str, _Any], ...]
    eligible_routes: tuple[dict[str, str], ...]


def _native_runtime_admission(
    *,
    repo_root: Path,
    profile: _AgentRuntimeProfile,
    policy: _AdaptiveRuntimePolicy,
    environ: dict[str, str],
    deadline_monotonic: float,
    observe_status: _Callable[[Provider, float], _RuntimeStatusObservation],
) -> _NativeRuntimeAdmission:
    """Prepare native route observations; the runtime supplies its status transport.

    Legacy marker discovery is deliberately not a native auth prerequisite.
    Neither a status exit nor a price alone establishes control admission.
    """
    from .budget import alias_pricing_prefix, price_tokens
    from .genesis_policy import _runtime_monetary_admission

    configuration = _json.dumps(
        {"schema_version": 1, "policy_digest": policy.policy_digest,
         "resolved_profile": _asdict(profile)}, sort_keys=True, separators=(",", ":"),
    )
    observations: list[dict[str, _Any]] = []
    eligible: list[dict[str, str]] = []
    search_path = environ.get("PATH", os.defpath)
    for provider in _FLEET:
        model = "gpt-6-astra" if provider.key == "openai" else provider.default_model
        effort = "ultra" if provider.key == "openai" else profile.effort
        route = {"provider": provider.key, "runtime": provider.runtime_hint,
                 "model": model, "effort": effort}
        binary = "codex" if provider.runtime_hint == "codex" else "claude"
        remaining = min(float(policy.recheck_timeout_seconds), deadline_monotonic - _time.monotonic())
        if shutil.which(binary, path=search_path) is None:
            status = _RuntimeStatusObservation("unavailable", reason="cli_unavailable")
        elif provider.key == "zai" and not environ.get(provider.credential_env or "", "").strip():
            status = _RuntimeStatusObservation("unavailable", reason="provider_not_configured")
        elif remaining <= 0:
            status = _RuntimeStatusObservation("unknown", reason="status_deadline_elapsed")
        else:
            status = observe_status(provider, remaining)
        price = price_tokens(model=alias_pricing_prefix(model), input_tokens=400_000, output_tokens=64_000)
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
            "quota_observation": status.quota_observation, "status_reason": status.reason,
            "status_command": list(status.command), "status_exit_code": status.exit_code,
            "pricing": pricing,
            "monetary_admission": monetary.mode,
            "monetary_reason": monetary.reason,
            "controls": {"status": status.control_status, "reason": status.control_reason},
        }
        observations.append(row)
        monetary_available = (monetary.subscription_applies if monetary.mode == "managed_subscription"
                              else price.source != "unknown")
        if (status.auth_observation == "available" and monetary_available
                and status.quota_observation != "unavailable"
                and status.control_status == "available"):
            eligible.append(route)
    return _NativeRuntimeAdmission(
        configuration_digest="sha256:" + _hashlib.sha256(configuration.encode()).hexdigest(),
        candidate_observations=tuple(observations), eligible_routes=tuple(eligible),
    )
