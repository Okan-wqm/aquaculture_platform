"""Plan 032 Faz 032d — scoped delivery credentials for external-write spawns.

WHY: Faz 032b BUILDS the spawn environment instead of copying the runner's,
and drops every secret-shaped name that the profile did not declare. That
closed the credential leak — and it also closed the implementer's only way
to `git push origin aria-impl-<hex>` / `aria-kernel pr create`, because the
agent used to ride the runner's ambient ``GH_TOKEN``. Nothing consumed the
per-cycle installation lease ``gh_token_factory`` minted (the docstring
promised a credentials file the sandbox would read; no reader existed).

WHAT: for a profile with ``external_writes: true`` — today exactly the
implementer — the executor mints the scoped lease at spawn time, places the
token in the spawn env as ``GH_TOKEN`` together with an env-only git
credential helper (``GIT_CONFIG_*`` → ``gh auth git-credential``), and
revokes it when the spawn ends. Every other profile gets nothing. The
governance ledger records NAMES, mode and TTL — never the value.

This supersedes the "never in env" sentence of the lease docstring: the
token rides ONE spawn's environment, bounded by the profile flag, the
CommandPolicy (only the ``aria-impl-*`` push and the kernel's own PR CLI
are allowed commands) and the TTL. The alternative — the kernel pushing on
the agent's behalf after the fact — would have re-written the implementer
contract (apply gate runs after the push, before the PR) for no safety
gain the policy layers do not already provide.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .gh_token_factory import (
    InstallationTokenLease,
    mint_installation_token,
    revoke_installation_token,
)
from .tool_registry import append_tools_governance, ensure_tools_dir

DELIVERY_TOKEN_ENV_NAME = "GH_TOKEN"
# Env-only git configuration: no file under the synthetic HOME, nothing the
# agent can edit, gone with the process. `gh auth git-credential` reads the
# same GH_TOKEN, so push and PR-create share one scoped credential.
GIT_CREDENTIAL_HELPER_ENV: dict[str, str] = {
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "credential.helper",
    "GIT_CONFIG_VALUE_0": "!gh auth git-credential",
}
DRY_RUN_TOKEN_SENTINEL = "aria-dry-run-sentinel"
DELIVERY_CREDENTIAL_MODES: tuple[str, ...] = ("installation", "pat_fallback", "dry_run")
MIN_DELIVERY_TTL_SECONDS = 300
DEFAULT_DELIVERY_TTL_SECONDS = 3600
MAX_DELIVERY_TTL_SECONDS = 3600

DELIVERY_CREDENTIAL_ISSUED_EVENT = "delivery_credential_issued"
DELIVERY_CREDENTIAL_REVOKED_EVENT = "delivery_credential_revoked"
DELIVERY_CREDENTIAL_REFUSED_EVENT = "delivery_credential_refused"
# The lease contract (gh_token_factory) requires this kind on every PAT-mode mint.
INSTALLATION_TOKEN_FALLBACK_EVENT = "installation_token_fallback_active"

_CYCLE_ID_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


class DeliveryCredentialError(RuntimeError):
    """The scoped credential could not be issued; the spawn must not proceed."""


@dataclass(frozen=True)
class DeliveryCredential:
    lease: InstallationTokenLease
    mode: str
    env: dict[str, str]
    ttl_seconds: int

    @property
    def env_names(self) -> tuple[str, ...]:
        return tuple(sorted(self.env))


def delivery_cycle_id(cycle_id: Any, request_id: str) -> str:
    """A lease id the token factory accepts (``^[A-Za-z0-9_-]{6,64}$``)."""
    text = str(cycle_id or "").strip() or f"req-{request_id}"
    text = _CYCLE_ID_UNSAFE.sub("-", text)
    if len(text) < 6:
        text = f"{text}-req-{_CYCLE_ID_UNSAFE.sub('-', str(request_id))}"
    return text[:64].ljust(6, "0")


def clamp_ttl(ttl_seconds: int | None, *, deadline_epoch: float | None = None, now: float | None = None) -> int:
    """TTL bounded below by the factory floor and above by the job deadline."""
    ttl = int(ttl_seconds) if ttl_seconds else DEFAULT_DELIVERY_TTL_SECONDS
    if deadline_epoch is not None:
        remaining = int(deadline_epoch - (now if now is not None else __import__("time").time()))
        ttl = min(ttl, max(remaining, MIN_DELIVERY_TTL_SECONDS))
    return max(MIN_DELIVERY_TTL_SECONDS, min(MAX_DELIVERY_TTL_SECONDS, ttl))


def _governance(base_dir: str | Path | None, kind: str, details: dict[str, Any]) -> None:
    if base_dir is None:
        return
    append_tools_governance(ensure_tools_dir(base_dir), kind, details)


def issue_delivery_credentials(
    *,
    profile: Any,
    request_id: str,
    cycle_id: Any,
    workspace_root: str | Path,
    base_dir: str | Path | None,
    ttl_seconds: int | None = None,
    deadline_epoch: float | None = None,
    mint: Callable[..., InstallationTokenLease] | None = None,
) -> DeliveryCredential | None:
    """Mint the scoped credential for an ``external_writes`` profile.

    Returns ``None`` for every profile that has no external-write grant —
    the spawn env then carries no GitHub credential at all. Raises
    :class:`DeliveryCredentialError` (after a ``delivery_credential_refused``
    governance row) when the grant exists but the lease cannot be minted:
    a write lane without its credential must be released, not run blind.
    """
    if profile is None or not bool(getattr(profile, "external_writes", False)):
        return None
    lease_id = delivery_cycle_id(cycle_id, request_id)
    ttl = clamp_ttl(ttl_seconds, deadline_epoch=deadline_epoch)
    profile_id = getattr(profile, "profile_id", None)
    minter = mint or mint_installation_token
    try:
        lease = minter(cycle_id=lease_id, workspace_root=workspace_root, ttl_seconds=ttl)
        token = Path(lease.token_file).read_text(encoding="utf-8").strip()
    except Exception as exc:  # noqa: BLE001 — every failure class is a refusal
        _governance(base_dir, DELIVERY_CREDENTIAL_REFUSED_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id,
            "error_class": type(exc).__name__, "error_message": str(exc)[:300],
        })
        raise DeliveryCredentialError(f"delivery_credential_unavailable:{type(exc).__name__}") from exc
    if not token:
        _governance(base_dir, DELIVERY_CREDENTIAL_REFUSED_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id,
            "error_class": "EmptyToken", "error_message": "token file empty",
        })
        raise DeliveryCredentialError("delivery_credential_unavailable:EmptyToken")
    if token == DRY_RUN_TOKEN_SENTINEL:
        mode = "dry_run"
    elif lease.fallback_active:
        mode = "pat_fallback"
    else:
        mode = "installation"
    env = {DELIVERY_TOKEN_ENV_NAME: token, **GIT_CREDENTIAL_HELPER_ENV}
    _governance(base_dir, DELIVERY_CREDENTIAL_ISSUED_EVENT, {
        "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id,
        "mode": mode, "ttl_seconds": ttl, "env_names": sorted(env),
        "provider_expiry": lease.provider_expiry, "consumer": "claude_spawn_env",
    })
    if mode == "pat_fallback":
        _governance(base_dir, INSTALLATION_TOKEN_FALLBACK_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "consumer": "delivery_credentials",
        })
    return DeliveryCredential(lease=lease, mode=mode, env=env, ttl_seconds=ttl)


def revoke_delivery_credentials(
    credential: DeliveryCredential,
    *,
    request_id: str,
    base_dir: str | Path | None,
    revoke: Callable[..., None] | None = None,
) -> dict[str, str]:
    """Best-effort revocation + token-file removal; always recorded."""
    revoker = revoke or revoke_installation_token
    outcome = "revoked"
    try:
        revoker(lease=credential.lease)
    except Exception as exc:  # noqa: BLE001 — revocation never raises past the spawn
        outcome = f"revoke_failed:{type(exc).__name__}"
    try:
        Path(credential.lease.token_file).unlink(missing_ok=True)
    except OSError:
        outcome = f"{outcome};token_file_unlink_failed"
    _governance(base_dir, DELIVERY_CREDENTIAL_REVOKED_EVENT, {
        "request_id": request_id, "cycle_id": credential.lease.cycle_id,
        "mode": credential.mode, "outcome": outcome,
    })
    return {"outcome": outcome}


def request_id_from_env(fallback: str, *, environ: dict[str, str] | None = None) -> str:
    """The agent request an in-sandbox kernel CLI call belongs to.

    The executor exports ``ARIA_REQUEST_ID`` into the spawn env; kernel
    commands the agent runs (``pr push``, ``pr create``) key their
    intent/receipt rows on it so the request's recovery classification and
    the delivery-closure report see the effect. Outside a spawn the caller's
    fallback (``proposal:<id>``) keeps the legacy key.
    """
    env = os.environ if environ is None else environ
    value = str(env.get("ARIA_REQUEST_ID") or "").strip()
    return value or fallback


__all__ = [
    "DEFAULT_DELIVERY_TTL_SECONDS",
    "DELIVERY_CREDENTIAL_ISSUED_EVENT",
    "DELIVERY_CREDENTIAL_MODES",
    "DELIVERY_CREDENTIAL_REFUSED_EVENT",
    "DELIVERY_CREDENTIAL_REVOKED_EVENT",
    "DELIVERY_TOKEN_ENV_NAME",
    "DeliveryCredential",
    "DeliveryCredentialError",
    "GIT_CREDENTIAL_HELPER_ENV",
    "INSTALLATION_TOKEN_FALLBACK_EVENT",
    "MAX_DELIVERY_TTL_SECONDS",
    "MIN_DELIVERY_TTL_SECONDS",
    "clamp_ttl",
    "delivery_cycle_id",
    "issue_delivery_credentials",
    "request_id_from_env",
    "revoke_delivery_credentials",
]
