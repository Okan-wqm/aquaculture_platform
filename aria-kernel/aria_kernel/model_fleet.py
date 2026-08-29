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
from dataclasses import dataclass


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

# Codex also runs on a ChatGPT-managed session (~/.codex auth) rather than
# an API key; the env is the cheap signal, the binary is the other one.
_CODEX_RUNTIME_PROBE_ENV_FALLBACK = "CODEX_HOME"


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
    search_path = env.get("PATH") or os.environ.get("PATH")
    out: list[Provider] = []
    for provider in _FLEET:
        if provider.runtime_hint == "codex":
            codex_on_path = shutil.which("codex", path=search_path) is not None
            has_credential = bool(env.get(provider.credential_env or "", "").strip()) or bool(
                env.get(_CODEX_RUNTIME_PROBE_ENV_FALLBACK, "").strip()
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
    return None
