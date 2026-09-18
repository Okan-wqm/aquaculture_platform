"""Plan 032 Faz 032d — scoped delivery credentials, held by the executor for the request.

WHY: Faz 032b BUILDS the spawn environment instead of copying the runner's,
and drops every secret-shaped name that the profile did not declare. That
closed the credential leak — and it also closed the implementer's only way
to `git push origin aria-impl-<hex>` / `aria-kernel pr create`, because the
agent used to ride the runner's ambient ``GH_TOKEN``. Nothing consumed the
per-cycle installation lease ``gh_token_factory`` minted (the docstring
promised a credentials file the sandbox would read; no reader existed).
Faz 032d's answer placed the token in the spawn's environment so the agent
could push and open the PR from inside its sandbox — a design that could
never work: the store those kernel commands write is not mounted in the
sandbox (ARIA-HIGH-123), and kernel authority exercised inside the agent's
sandbox is unsound regardless of the mount (ARIA-HIGH-124).

WHAT: for a profile with ``external_writes: true`` — today exactly the
implementer — the executor's DELIVERY mints the scoped lease WHERE IT IS
CONSUMED (ARIA-HIGH-124 round 6: ``implementation_delivery``, stage
``credential``, after the contained gate, through
``hold_delivery_credentials``) and applies its environment — ``GH_TOKEN``
plus an env-only git credential helper (``GIT_CONFIG_*`` → ``gh auth
git-credential``) — to the ONE ``git push`` and the ONE ``gh pr create`` it
runs itself, outside the sandbox, revoking it the moment the PR is open.
Before the spawn the executor only ADMITS the lane (``admit_delivery_credentials``:
one lease minted and revoked at once, ``consumer: executor_admission``), so
a lane that cannot mint — no GH App, no PAT, a refused installation — is
released harness-class before a turn is spent. The token never enters the
spawn's environment: no command inside the sandbox may push or open a PR
(``command_policy``: `kernel_authority`), so nothing inside has a reader
for it. Every other profile gets nothing. The governance ledger records
NAMES, mode, TTL, the consumer and the provider's own expiry — never the
value.

WHEN THE TOKEN IS MINTED (round 6): inside the window it is consumed in.
Until round 6 the ONE lease was minted before the spawn and first consumed
after the spawn (≤ the CLI cap), the publication, the identity/scope/result
decisions and the contained gate — ``IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS``
after the mint at the canonical ceiling — while a GitHub App installation
token lives exactly one hour whatever the mint asks
(``gh_token_factory.PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS``): in Mode A
every implementation whose spawn and suite ran past ~55 minutes pushed with
a dead token, was refused ``push_failed:rc=128``, escalated as the REQUEST's
fault and left a published branch its requeue collided on. The delivery's
lease now covers exactly ``DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS`` — the
push and the PR opener at their bounds — which fits the provider's hour by
construction (pinned), and ``issue_delivery_credentials`` refuses by name a
lease whose ``provider_expiry`` cannot cover the window it is asked to
cover (``provider_expiry_short``), revoking what it minted. The mint and the
revoke are priced (``DELIVERY_CREDENTIAL_WORST_CASE_SECONDS``) into the
delivery's worst case and the implementation child's.

WHERE THE TOKEN FILE LIVES (ARIA-HIGH-124 round 5): in a private 0700
directory of the executor's, made by the hold for the request OUTSIDE the
workspace (``private_token_dir``) and removed with the revoke — never under
``<workspace>/aria-debts/keys/`` — and only for the instant between the
mint's write and the hold's read: the value is then held in memory (the
``env`` the push and the ``gh`` subprocess take it from) and the file is
unlinked, so nothing on disk carries the token while the agent's suite runs
and a killed executor leaves no token file behind. The mint used to write it
in the keys dir, and the
executor's validation sandbox (the read-only git shape, which carried no
keys mask) bound the workspace with that file inside: the agent's committed
``package.json`` script, run by the apply gate as the executor's own uid,
read the 0600 token file and the gate recorded its bytes on the
validation-runs ledger (reproduced through the real executor child under
real bwrap). The workspace binds are the sandboxes' to make; a credential
that is not under the workspace is not a file any of them can bind, and
``gh_token_factory.mint_installation_token`` refuses a directory that is
not private by name (``TokenDirectoryUnusable``) before it fetches a token.
A hold whose private directory cannot be made outside the workspace (the
process temp dir resolves INTO it) is refused
``delivery_credential_unavailable:token_dir_inside_workspace`` — never a
silent fall-back to the keys dir.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from contextlib import contextmanager
from typing import Iterator

from .gh_token_factory import (
    INSTALLATION_TOKEN_MINT_TIMEOUT_SECONDS,
    INSTALLATION_TOKEN_REVOKE_TIMEOUT_SECONDS,
    PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS,
    InstallationTokenLease,
    TokenDirectoryUnusable,
    mint_installation_token,
    revoke_installation_token,
)
from .pr_manager import GH_PR_CREATE_TIMEOUT_SECONDS
from .state_store import GIT_TIMEOUT_SECONDS as _GIT_TIMEOUT_SECONDS
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
# The window the delivery's credential must be alive for (round 6): the ONE
# `git push` at the store's git cap and the ONE `gh pr create` at its bound,
# run back to back by `implementation_delivery.deliver_implementation`
# INSIDE the hold. The lease is minted at the window's start, so its life
# is this — never the spawn, the publication or the gate before it.
DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS = _GIT_TIMEOUT_SECONDS + GH_PR_CREATE_TIMEOUT_SECONDS
# The hold's own wall clock beside the consumption: the mint (one bounded
# HTTPS call in Mode A) and the revoke (one bounded `gh api` DELETE). The
# delivery prices one of these (its mint) and the implementation child
# prices another (the pre-spawn admission).
DELIVERY_CREDENTIAL_WORST_CASE_SECONDS = (
    INSTALLATION_TOKEN_MINT_TIMEOUT_SECONDS + INSTALLATION_TOKEN_REVOKE_TIMEOUT_SECONDS
)
MIN_DELIVERY_TTL_SECONDS = 300
# The local TTL a lease is minted with: what the holder means to keep it
# for — the consumption window — never a claim about the provider (the
# provider's horizon is `provider_expiry`, read off the lease).
DEFAULT_DELIVERY_TTL_SECONDS = DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS
# No local TTL may claim more than the provider gives.
MAX_DELIVERY_TTL_SECONDS = PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS

DELIVERY_CREDENTIAL_ISSUED_EVENT = "delivery_credential_issued"
# Who reads the credential (round 6): the executor's own delivery step —
# the push and the PR opener, inside the hold — or nobody: the pre-spawn
# ADMISSION mints and revokes at once to prove the lane can mint before a
# turn is spent. Never a spawn.
DELIVERY_CREDENTIAL_CONSUMER = "executor_delivery"
DELIVERY_CREDENTIAL_ADMISSION_CONSUMER = "executor_admission"
DELIVERY_CREDENTIAL_CONSUMERS: tuple[str, ...] = (
    DELIVERY_CREDENTIAL_ADMISSION_CONSUMER, DELIVERY_CREDENTIAL_CONSUMER,
)
DELIVERY_CREDENTIAL_ADMITTED_EVENT = "delivery_credential_admitted"
DELIVERY_CREDENTIAL_REVOKED_EVENT = "delivery_credential_revoked"
DELIVERY_CREDENTIAL_REFUSED_EVENT = "delivery_credential_refused"
# The prefix of the private directory the hold makes for the token file
# (ARIA-HIGH-124 round 5): `tempfile.mkdtemp` creates it 0700 under the
# process temp dir, which no sandbox binds (the sandboxes mount their own
# /tmp tmpfs) and which is refused by name when it resolves into the
# workspace.
PRIVATE_TOKEN_DIR_PREFIX = "aria-delivery-credential-"
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
    # ARIA-HIGH-124 (round 5) — the private 0700 directory the token file
    # lives in, outside the workspace; None when the caller minted into
    # the workspace keys dir (a lane without a sandbox). The revoke removes
    # it with the file.
    token_dir: Path | None = None

    @property
    def env_names(self) -> tuple[str, ...]:
        return tuple(sorted(self.env))


@dataclass(frozen=True)
class DeliveryCredentialAdmission:
    """What the pre-spawn admission proved (round 6): the lane minted a
    lease in ``mode`` whose provider horizon (``provider_expiry``, None
    without one) covered the consumption window; the lease itself is gone."""

    mode: str
    provider_expiry: str | None


def provider_horizon_refusal(
    provider_expiry: str | None, *, covers_seconds: int, now: float | None = None,
) -> str | None:
    """Why a lease whose provider expires it at ``provider_expiry`` cannot
    be alive for ``covers_seconds`` from ``now``, or None (round 6). No
    provider horizon (Mode B's PAT, the dry-run sentinel) binds nothing —
    nothing at the provider expires those. A horizon that cannot be read
    is refused by name: the provider's contract is an ISO 8601 instant, and
    a lease whose expiry the holder cannot read is one it cannot rely on."""
    if provider_expiry is None:
        return None
    text = str(provider_expiry).strip()
    try:
        expires = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return f"provider_expiry_unreadable:{text[:40]!r}"
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    current = time.time() if now is None else now
    remaining = int(expires.timestamp() - current)
    if remaining < covers_seconds:
        return f"provider_expiry_short:expires_at={text}:covers={covers_seconds}s:remaining={remaining}s"
    return None


def private_token_dir(*, workspace_root: str | Path) -> Path:
    """A fresh 0700 directory of this process, OUTSIDE ``workspace_root``,
    for the delivery token file (ARIA-HIGH-124 round 5). Raises
    :class:`DeliveryCredentialError` (``token_dir_inside_workspace``) when
    the process temp dir resolves into the workspace — the shape a runner
    that points ``TMPDIR`` at its checkout would produce — so the token is
    never written where a sandbox binds. The mint verifies the same
    property again (``gh_token_factory._verify_private_token_dir``)."""
    workspace = Path(workspace_root).resolve()
    made = Path(tempfile.mkdtemp(prefix=PRIVATE_TOKEN_DIR_PREFIX)).resolve()
    if made == workspace or made.is_relative_to(workspace):
        shutil.rmtree(made, ignore_errors=True)
        raise DeliveryCredentialError(f"delivery_credential_unavailable:token_dir_inside_workspace:{made}")
    return made


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
        remaining = int(deadline_epoch - (now if now is not None else time.time()))
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
    token_dir: str | Path | None = None,
    covers_seconds: int = DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
    consumer: str = DELIVERY_CREDENTIAL_CONSUMER,
    revoke: Callable[..., Any] | None = None,
) -> DeliveryCredential | None:
    """Mint the scoped credential for an ``external_writes`` profile.

    Returns ``None`` for every profile that has no external-write grant —
    the spawn env then carries no GitHub credential at all. Raises
    :class:`DeliveryCredentialError` (after a ``delivery_credential_refused``
    governance row) when the grant exists but the lease cannot be minted:
    a write lane without its credential must be released, not run blind.
    ``token_dir`` is the private directory the token file is written to
    (round 5; the hold makes one with :func:`private_token_dir`) — the
    mint refuses a directory that is not private, and the refusal is a
    credential refusal like every other. ``covers_seconds`` (round 6) is
    the window the caller will hold the credential through, from now: a
    lease whose ``provider_expiry`` cannot cover it is REVOKED and refused
    ``provider_expiry_short`` by name (``provider_horizon_refusal``) — a
    credential that dies inside its own consumption window is no
    credential; the local TTL is that window, clamped. ``consumer`` names
    who reads the lease (``DELIVERY_CREDENTIAL_CONSUMERS``): the
    delivery's push and PR opener, or the pre-spawn admission that reads
    nothing.
    """
    if profile is None or not bool(getattr(profile, "external_writes", False)):
        return None
    if consumer not in DELIVERY_CREDENTIAL_CONSUMERS:
        raise ValueError(f"unknown delivery credential consumer {consumer!r}")
    if int(covers_seconds) <= 0:
        raise ValueError("covers_seconds must be positive")
    lease_id = delivery_cycle_id(cycle_id, request_id)
    ttl = clamp_ttl(ttl_seconds if ttl_seconds else int(covers_seconds), deadline_epoch=deadline_epoch)
    profile_id = getattr(profile, "profile_id", None)
    minter = mint or mint_installation_token
    try:
        lease = minter(cycle_id=lease_id, workspace_root=workspace_root, ttl_seconds=ttl, token_dir=token_dir)
        token = Path(lease.token_file).read_text(encoding="utf-8").strip()
        # (round 5) the token is HELD IN MEMORY from here: the file has no
        # reader left (the push and the `gh` subprocess take the value from
        # `env`; the revoke's unlink tolerates its absence), so it is
        # consumed at once — an executor killed mid-hold leaves an empty
        # private directory behind, never a token file (in PAT-fallback
        # mode that file is the operator's long-lived PAT).
        Path(lease.token_file).unlink()
    except Exception as exc:  # noqa: BLE001 — every failure class is a refusal
        _governance(base_dir, DELIVERY_CREDENTIAL_REFUSED_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id, "consumer": consumer,
            "error_class": type(exc).__name__, "error_message": str(exc)[:300],
        })
        detail = f":{exc}" if isinstance(exc, TokenDirectoryUnusable) else ""
        raise DeliveryCredentialError(f"delivery_credential_unavailable:{type(exc).__name__}{detail}") from exc
    if not token:
        _governance(base_dir, DELIVERY_CREDENTIAL_REFUSED_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id, "consumer": consumer,
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
    private_dir = Path(token_dir).resolve() if token_dir is not None else None
    credential = DeliveryCredential(lease=lease, mode=mode, env=env, ttl_seconds=ttl, token_dir=private_dir)
    # (round 6) the provider's horizon against the window this credential
    # is for: a token that dies before the last subprocess it serves would
    # end is revoked here — with its own value, in memory — and refused by
    # name; nothing downstream ever holds it.
    horizon = provider_horizon_refusal(lease.provider_expiry, covers_seconds=int(covers_seconds))
    if horizon is not None:
        revoked = revoke_delivery_credentials(
            credential, request_id=request_id, base_dir=base_dir, revoke=revoke, recorded=False,
        )
        _governance(base_dir, DELIVERY_CREDENTIAL_REFUSED_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id, "consumer": consumer,
            "mode": mode, "error_class": "ProviderHorizonShort", "error_message": horizon[:300],
            "provider_expiry": lease.provider_expiry, "covers_seconds": int(covers_seconds),
            "revoke_outcome": revoked["outcome"],
        })
        raise DeliveryCredentialError(f"delivery_credential_unavailable:{horizon}")
    _governance(base_dir, DELIVERY_CREDENTIAL_ISSUED_EVENT, {
        "request_id": request_id, "cycle_id": lease_id, "profile_id": profile_id,
        "mode": mode, "ttl_seconds": ttl, "env_names": sorted(env),
        "provider_expiry": lease.provider_expiry, "consumer": consumer,
        # (round 6) WHEN — the lease's own mint instant (sub-second) — and
        # for how long the holder needs it alive, so a reader can put the
        # mint beside the gate's recorded runs and the push's receipt.
        "minted_at_utc": lease.minted_at_utc, "covers_seconds": int(covers_seconds),
        # (round 5) WHERE the file is, as a fact the ledger reader can
        # check against the workspace: a path, never the value.
        "token_file_outside_workspace": not Path(lease.token_file).resolve().is_relative_to(Path(workspace_root).resolve()),
    })
    if mode == "pat_fallback":
        _governance(base_dir, INSTALLATION_TOKEN_FALLBACK_EVENT, {
            "request_id": request_id, "cycle_id": lease_id, "consumer": "delivery_credentials",
        })
    return credential


def revoke_delivery_credentials(
    credential: DeliveryCredential,
    *,
    request_id: str,
    base_dir: str | Path | None,
    revoke: Callable[..., Any] | None = None,
    recorded: bool = True,
) -> dict[str, str]:
    """Best-effort revocation + token-file removal; recorded unless the
    caller folds the outcome into its own row (``recorded=False``: the
    issue's horizon refusal). The revoke runs under the lease's OWN token
    (round 6, ``environment``): ``DELETE /installation/token`` revokes the
    token it is called with, and the value lives only in ``credential.env``."""
    revoker = revoke or revoke_installation_token
    try:
        returned = revoker(lease=credential.lease, environment=credential.env)
        outcome = returned if isinstance(returned, str) and returned else "revoked"
    except Exception as exc:  # noqa: BLE001 — revocation never raises past the spawn
        outcome = f"revoke_failed:{type(exc).__name__}"
    try:
        Path(credential.lease.token_file).unlink(missing_ok=True)
    except OSError:
        outcome = f"{outcome};token_file_unlink_failed"
    if credential.token_dir is not None:
        # (round 5) the private directory goes with the file; a directory
        # that will not go is named, never left silently.
        try:
            shutil.rmtree(credential.token_dir)
        except FileNotFoundError:
            pass
        except OSError:
            outcome = f"{outcome};token_dir_remove_failed"
    if recorded:
        _governance(base_dir, DELIVERY_CREDENTIAL_REVOKED_EVENT, {
            "request_id": request_id, "cycle_id": credential.lease.cycle_id,
            "mode": credential.mode, "outcome": outcome,
        })
    return {"outcome": outcome}


@contextmanager
def hold_delivery_credentials(
    *,
    profile: Any,
    request_id: str,
    cycle_id: Any,
    workspace_root: str | Path,
    base_dir: str | Path | None,
    deadline_epoch: float | None = None,
    covers_seconds: int = DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
    consumer: str = DELIVERY_CREDENTIAL_CONSUMER,
) -> Iterator[DeliveryCredential | None]:
    """Mint the scoped credential for the body and revoke it on every exit.

    ARIA-HIGH-124 — the executor's hold, entered WHERE THE CREDENTIAL IS
    CONSUMED (round 6): ``implementation_delivery.deliver_implementation``
    enters it after the contained gate, around exactly the push and the PR
    opener (``covers_seconds`` = ``DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS``),
    and it is revoked however that body exits; the pre-spawn admission
    (``admit_delivery_credentials``) enters it with an empty body. Yields
    None for a profile without the external-write grant. The token is
    minted into a private directory of this process outside the workspace
    (round 5, :func:`private_token_dir`), read into memory and unlinked at
    once; the directory is removed with the revoke; a profile without the
    grant makes no directory.
    """
    if profile is None or not bool(getattr(profile, "external_writes", False)):
        yield None
        return
    token_dir = private_token_dir(workspace_root=workspace_root)
    try:
        credential = issue_delivery_credentials(
            profile=profile, request_id=request_id, cycle_id=cycle_id, workspace_root=workspace_root,
            base_dir=base_dir, deadline_epoch=deadline_epoch, token_dir=token_dir,
            covers_seconds=covers_seconds, consumer=consumer,
        )
    except BaseException:
        shutil.rmtree(token_dir, ignore_errors=True)
        raise
    assert credential is not None
    try:
        yield credential
    finally:
        revoke_delivery_credentials(credential, request_id=request_id, base_dir=base_dir)


def admit_delivery_credentials(
    *,
    profile: Any,
    request_id: str,
    cycle_id: Any,
    workspace_root: str | Path,
    base_dir: str | Path | None,
    deadline_epoch: float | None = None,
) -> DeliveryCredentialAdmission | None:
    """Prove, BEFORE a turn is spent, that this lane can mint the delivery
    credential (round 6): one lease minted through the same hold the
    delivery uses — the same mode resolution, the same private directory,
    the same provider-horizon check against the consumption window — and
    revoked at once, its value read by nobody (``consumer:
    executor_admission``). A lane that cannot mint (no GH App, no PAT, a
    refused installation, an App permission not granted) raises
    :class:`DeliveryCredentialError` here, so the executor releases the
    claim harness-class with no spawn; the lease the delivery consumes is
    minted later, inside its own window. Returns None for a profile
    without the grant; records ``delivery_credential_admitted``."""
    with hold_delivery_credentials(
        profile=profile, request_id=request_id, cycle_id=cycle_id, workspace_root=workspace_root,
        base_dir=base_dir, deadline_epoch=deadline_epoch, consumer=DELIVERY_CREDENTIAL_ADMISSION_CONSUMER,
    ) as credential:
        if credential is None:
            return None
        admission = DeliveryCredentialAdmission(mode=credential.mode, provider_expiry=credential.lease.provider_expiry)
    _governance(base_dir, DELIVERY_CREDENTIAL_ADMITTED_EVENT, {
        "request_id": request_id, "cycle_id": delivery_cycle_id(cycle_id, request_id),
        "profile_id": getattr(profile, "profile_id", None), "mode": admission.mode,
        "provider_expiry": admission.provider_expiry, "covers_seconds": DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
    })
    return admission


def prune_stale_delivery_credential_dirs(
    *, temp_root: str | Path | None = None, now: float | None = None,
) -> dict[str, Any]:
    """Remove the private token directories a killed executor left behind
    (round 6). A hold lives at most the consumption window plus its mint
    and revoke; a directory older than the provider's hour
    (``MAX_DELIVERY_TTL_SECONDS``, by mtime) belongs to no live hold and
    goes — WITH whatever it holds: an executor killed between the mint's
    write and the hold's read leaves the token file (in PAT mode the
    operator's PAT) inside, which is exactly what must not linger. A
    younger directory is a live hold's and is left alone. The same class
    as the broker-socket sweeps the orchestrator runs at startup."""
    root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    current = time.time() if now is None else now
    swept: list[str] = []
    live: list[str] = []
    errors: list[str] = []
    for entry in sorted(root.glob(f"{PRIVATE_TOKEN_DIR_PREFIX}*")):
        if not entry.is_dir():
            continue
        try:
            age = current - entry.stat().st_mtime
        except OSError as exc:
            errors.append(f"{entry.name}:{type(exc).__name__}")
            continue
        if age < MAX_DELIVERY_TTL_SECONDS:
            live.append(entry.name)
            continue
        try:
            shutil.rmtree(entry)
        except OSError as exc:
            errors.append(f"{entry.name}:{type(exc).__name__}")
        else:
            swept.append(entry.name)
    return {"scanned": len(swept) + len(live) + len(errors), "swept": swept, "live": live, "errors": errors}


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
    "DELIVERY_CREDENTIAL_ADMISSION_CONSUMER",
    "DELIVERY_CREDENTIAL_ADMITTED_EVENT",
    "DELIVERY_CREDENTIAL_CONSUMER",
    "DELIVERY_CREDENTIAL_CONSUMERS",
    "DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS",
    "DELIVERY_CREDENTIAL_ISSUED_EVENT",
    "DELIVERY_CREDENTIAL_MODES",
    "DELIVERY_CREDENTIAL_REFUSED_EVENT",
    "DELIVERY_CREDENTIAL_REVOKED_EVENT",
    "DELIVERY_CREDENTIAL_WORST_CASE_SECONDS",
    "DELIVERY_TOKEN_ENV_NAME",
    "DeliveryCredential",
    "DeliveryCredentialAdmission",
    "DeliveryCredentialError",
    "GIT_CREDENTIAL_HELPER_ENV",
    "INSTALLATION_TOKEN_FALLBACK_EVENT",
    "MAX_DELIVERY_TTL_SECONDS",
    "MIN_DELIVERY_TTL_SECONDS",
    "PRIVATE_TOKEN_DIR_PREFIX",
    "admit_delivery_credentials",
    "clamp_ttl",
    "delivery_cycle_id",
    "hold_delivery_credentials",
    "issue_delivery_credentials",
    "private_token_dir",
    "provider_horizon_refusal",
    "prune_stale_delivery_credential_dirs",
    "request_id_from_env",
    "revoke_delivery_credentials",
]
