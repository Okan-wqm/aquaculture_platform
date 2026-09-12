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
from typing import Any as _Any, Callable as _Callable, Mapping as _Mapping

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
    """Which executor runtime serves this provider ('claude' | 'codex' | 'zai').

    'claude' and 'codex' are the vendors' managed-subscription CLIs; 'zai' is
    the kernel's own HTTP transport (tools/aria-poc/zai_runtime.py). The
    operator policy of 2026-09-11 admits Z.ai ONLY through that transport and
    never as a credential handed to either CLI, so no provider may name a CLI
    runtime together with a Z.ai credential.
    """

    admits_writes: bool
    """Whether this provider's runtime can host a WRITE-SCOPE profile.

    The managed Claude CLI runs under the write-containment sandbox and can
    edit a bound workspace; the Codex route runs `--sandbox read-only` and
    the Z.ai transport is a single chat completion — neither can execute an
    implementer or a worker. This row is the one place that fact lives: the
    native admission refuses a read-only runtime for a write-capable profile
    by name (`provider_readonly_runtime`), and the auth failover ladder in
    claude_runtime skips such a rung for the same profile. Operator decision
    2026-09-12: a write-scope request whose provider is exhausted waits for
    that provider; it is never handed to a runtime that cannot write.
    """

    credential_file_env: str | None = None
    """The env var naming a root-only FILE that holds the credential.

    The file boundary is the preferred one on a host (no value in the process
    environment, nothing for an env dump or a child to copy); `credential_env`
    remains for CI-secret injection. Presence of either is the cheap signal.
    """

    model_env: str | None = None
    """An operator override of `default_model` for this provider, if any."""


# The fleet, in preference order for mixed assignment (strongest-authoring
# vendor first for the FIRST role; the policy STRIPES, it does not rank —
# ranking is MODEL_TIER_ORDER's job for write protection).
_FLEET: tuple[Provider, ...] = (
    Provider(
        key="anthropic",
        default_model="opus",
        credential_env=None,
        runtime_hint="claude",
        admits_writes=True,
    ),
    Provider(
        key="zai",
        default_model="glm-5.3",
        credential_env="ARIA_ZAI_API_KEY",
        runtime_hint="zai",
        admits_writes=False,
        credential_file_env="ARIA_ZAI_API_KEY_FILE",
        model_env="ARIA_ZAI_MODEL",
    ),
    Provider(
        key="openai",
        default_model="gpt-5.2-codex",
        credential_env="OPENAI_API_KEY",
        runtime_hint="codex",
        admits_writes=False,
    ),
)

# Codex runs on a ChatGPT-managed subscription session (~/.codex/auth.json)
# by default — an API key is NOT required (operator decision 2026-08-29:
# subscription auth, like the Claude runtime's managed login). The cheap
# availability signal is the session file's existence under the EFFECTIVE
# user's codex home; OPENAI_API_KEY remains the alternative credential.
_CODEX_AUTH_FILE = "auth.json"
_MODEL_PROVIDER_ALIASES: dict[str, str] = {"gpt-6-astra": "openai"}


# The CLI a runtime hint spawns, or None for the kernel's own transport.
_RUNTIME_BINARIES: dict[str, str | None] = {"claude": "claude", "codex": "codex", "zai": None}


def _credential_named(provider: Provider, env: dict[str, str]) -> bool:
    """A credential boundary is NAMED for the provider: a file path or a value.

    Presence only, in either boundary; whether it works is the runtime's
    probe. Both at once is not "more configured" — the runtime refuses that
    as ambiguous — but it is still named, so availability says yes and the
    probe says why not.
    """
    if provider.credential_file_env and env.get(provider.credential_file_env, "").strip():
        return True
    return bool(provider.credential_env and env.get(provider.credential_env, "").strip())


def provider_model(provider: Provider, env: dict[str, str]) -> str:
    """The model a provider's routes run on: the operator override, else the default."""
    if provider.model_env:
        override = env.get(provider.model_env, "").strip()
        if override:
            return override
    return provider.default_model


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
        if provider.runtime_hint == "zai":
            # The kernel's own transport: no binary to find. A named
            # credential boundary is the whole cheap signal.
            if _credential_named(provider, env):
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
    env = dict(os.environ if environ is None else environ)
    assignment: dict[str, str] = {}
    for index, role in enumerate(roles):
        assignment[role] = provider_model(providers[index % len(providers)], env)
    return assignment


def zai_provider() -> Provider:
    """The Z.ai fleet row — the SSoT the HTTP transport binds its variable names to."""
    return next(provider for provider in _FLEET if provider.key == "zai")


def provider_for_model(model: str) -> str | None:
    """The provider key a model belongs to, or None when unlisted."""
    for provider in _FLEET:
        if model == provider.default_model:
            return provider.key
    return _MODEL_PROVIDER_ALIASES.get(model)


# The provider whose runtime dispatches a tier the fleet does not list by
# name (`sonnet`, `haiku`, `fable`): the managed Anthropic session. One
# constant, read by every route resolver, so the convention cannot drift
# between the executors and the kernel's own dispatch hooks.
DEFAULT_DISPATCHING_PROVIDER = "anthropic"


def dispatching_provider_for_model(model: str | None) -> str:
    """The provider a dispatch on `model` runs through — never None.

    `provider_for_model` answers "which fleet row lists this model"; this
    answers the routing question the executors, the dispatch-failure
    classifier and the worker dispatch hook all ask: which provider's
    quota, credential and cooldown does a spawn on this tier live under.
    Unlisted tiers are the managed Anthropic session's.
    """
    return provider_for_model(str(model or "")) or DEFAULT_DISPATCHING_PROVIDER


def provider_admits_writes(provider_key: str) -> bool:
    """Whether the named provider's runtime can host a write-scope profile.

    Fail-closed: a provider the fleet does not list admits nothing, so a
    typo or a future row cannot silently become a write-capable route.
    """
    return any(provider.key == provider_key and provider.admits_writes for provider in _FLEET)


# The status reason a provider row carries when it is refused WITHOUT a
# probe: the reason is a fleet/policy fact, not something the vendor said.
READONLY_RUNTIME_STATUS_REASON = "provider_readonly_runtime"
COOLDOWN_STATUS_REASON = "provider_quota_cooldown"


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
    credential_source: str = "unknown"
    """Which boundary supplied the credential ('managed_session', 'file', 'env'). Never a value."""


@dataclass(frozen=True)
class _NativeRuntimeAdmission:
    configuration_digest: str
    candidate_observations: tuple[dict[str, _Any], ...]
    eligible_routes: tuple[dict[str, str], ...]


def native_admission_budget_seconds(policy: _AdaptiveRuntimePolicy) -> float:
    """The wall-clock bound of one native admission: one recheck per fleet member."""
    return float(policy.recheck_timeout_seconds) * len(_FLEET)


def _native_runtime_admission(
    *,
    repo_root: Path,
    profile: _AgentRuntimeProfile,
    policy: _AdaptiveRuntimePolicy,
    environ: dict[str, str],
    observe_status: _Callable[[Provider, float], _RuntimeStatusObservation],
    cooled_providers: _Mapping[str, _Mapping[str, _Any]],
) -> _NativeRuntimeAdmission:
    """Prepare native route observations; the runtime supplies its status transport.

    Legacy marker discovery is deliberately not a native auth prerequisite.
    Neither a status exit nor a price alone establishes control admission.

    Every fleet member is offered one full `recheck_timeout_seconds` for its
    own status observation: the budget is per probe, and the admission as a
    whole is bounded by that budget times the fleet's size. A first probe
    that stalls to its limit (a swapped-out CLI on a loaded host) is its own
    `status_timeout`; the providers behind it are still asked. The fleet
    owns this arithmetic so no caller can hand the whole fleet a single
    probe's budget and starve the last member into `status_deadline_elapsed`.

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
    deadline_monotonic = _time.monotonic() + native_admission_budget_seconds(policy)
    from .budget import price_spawn_reservation
    from .genesis_policy import _runtime_monetary_admission

    configuration = _json.dumps(
        {"schema_version": 1, "policy_digest": policy.policy_digest,
         "resolved_profile": _asdict(profile)}, sort_keys=True, separators=(",", ":"),
    )
    observations: list[dict[str, _Any]] = []
    eligible: list[dict[str, str]] = []
    search_path = environ.get("PATH", os.defpath)
    for provider in _FLEET:
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
        remaining = min(float(policy.recheck_timeout_seconds), deadline_monotonic - _time.monotonic())
        cooldown = cooled_providers.get(provider.key)
        if profile.write_capable and not provider.admits_writes:
            status = _RuntimeStatusObservation(
                "unknown", reason=READONLY_RUNTIME_STATUS_REASON,
                control_status="unavailable", control_reason=READONLY_RUNTIME_STATUS_REASON,
            )
        elif cooldown is not None:
            status = _RuntimeStatusObservation(
                "unknown", quota_observation="unavailable", reason=COOLDOWN_STATUS_REASON,
            )
        elif binary is not None and shutil.which(binary, path=search_path) is None:
            status = _RuntimeStatusObservation("unavailable", reason="cli_unavailable")
        elif provider.key == "zai" and not _credential_named(provider, environ):
            status = _RuntimeStatusObservation("unavailable", reason="provider_not_configured")
        elif remaining <= 0:
            status = _RuntimeStatusObservation("unknown", reason="status_deadline_elapsed")
        else:
            status = observe_status(provider, remaining)
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
        if (status.auth_observation == "available" and monetary_available
                and status.quota_observation != "unavailable"
                and status.control_status == "available"):
            eligible.append(route)
    return _NativeRuntimeAdmission(
        configuration_digest="sha256:" + _hashlib.sha256(configuration.encode()).hexdigest(),
        candidate_observations=tuple(observations), eligible_routes=tuple(eligible),
    )
