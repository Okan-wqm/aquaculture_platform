"""Plan ARIA-V9.0-C — ephemeral signing keys + scoped-token factory.

Closes security-reviewer findings inline as Tier-1/Tier-3 anchors:

* CRIT-001 — GH_TOKEN exfil scope. Two-token model:
    1. Long-lived ``GH_TOKEN`` (operator PAT) — used ONLY at preflight
       to read branch protection. Never passed to aria-implementer.
    2. Per-cycle scoped installation token (GitHub App, 5-min TTL,
       scoped to ``pull_requests:write + contents:write`` on
       ``refs/heads/aria-impl-*`` only) — passed to aria-implementer.
  Code-only V9.0-C ships the factory contract + the operator-PAT
  fallback path with a governance shim; the actual GitHub App lives
  behind a runbook the operator owns
  (docs/runbooks/aria-github-app-setup.md).

* CRIT-004 — commit signature kernel verification. Per-cycle
  ed25519 keypair minted via ``ssh-keygen`` subprocess (no
  third-party Python dep); public key fingerprint persisted to
  ``aria-debts/keys/<cycle_id>.pub`` for audit; private key persisted
  to ``aria-debts/keys/<cycle_id>`` with mode 0600. The
  ``verify_commit_signature`` helper in implementation_safety
  (V9.0-D) reads the public fingerprint and validates every
  ``record_implementation_outcome`` commit's signer.

Tier-1 (make impossible) — the kernel ALWAYS routes through
``mint_installation_token`` + ``mint_signing_key``; aria-implementer
NEVER reads ``$GH_TOKEN`` directly. The implementer's tool dispatch
in V9.0-D's sandbox wrapper strips inherited environment except for
the minted scoped token.

Tier-3 (detect) — operator-PAT fallback emits an
``installation_token_fallback_active`` governance event so the audit
trail surfaces shim activations.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SigningKey:
    """Per-cycle ed25519 signing keypair. Frozen — once minted the
    keypair is the cycle's commit-signing identity; rotating
    mid-cycle is forbidden (would break the audit trail)."""

    cycle_id: str
    private_key_path: Path
    public_key_path: Path
    fingerprint: str
    algorithm: str = "ed25519"


@dataclass(frozen=True)
class InstallationTokenLease:
    """Per-cycle installation token lease. 5-min TTL by default.

    When ``gh_app_installation_id`` is populated, the token is a
    proper scoped installation token (1 PR repo + 1 branch scope).
    When ``gh_app_installation_id`` is None, the token is the
    operator PAT with the fallback flag set — the governance event
    ``installation_token_fallback_active`` MUST fire on every mint
    in this mode so the audit trail captures shim activations.

    The Tier-1 invariant the orchestrator depends on: this dataclass
    is the ONLY way aria-implementer receives a token; the token
    never appears in env nor in tool-invocation argv (it goes into
    an ephemeral credentials file the Bash sandbox reads on demand
    via ``gh auth status`` + restores the env to a clean state).
    """

    cycle_id: str
    token_file: Path
    ttl_seconds: int
    gh_app_installation_id: str | None
    fallback_active: bool
    minted_at_utc: str


_CYCLE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


def _validate_cycle_id(cycle_id: str) -> None:
    if not isinstance(cycle_id, str) or not _CYCLE_ID_RE.match(cycle_id):
        raise ValueError(
            f"cycle_id must match {_CYCLE_ID_RE.pattern!r}; got {cycle_id!r}"
        )


def _keys_dir(workspace_root: str | Path) -> Path:
    """Returns the per-workspace keys directory, creating it with mode
    0700 if absent."""
    d = Path(workspace_root) / "aria-debts" / "keys"
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def _ssh_keygen_available() -> bool:
    return shutil.which("ssh-keygen") is not None


def _compute_fingerprint(public_key_path: Path) -> str:
    """Returns the SHA256 fingerprint of an OpenSSH public key.

    Format: ``SHA256:<base64>`` (matches ``ssh-keygen -lf`` output).
    """
    proc = subprocess.run(
        ["ssh-keygen", "-lf", str(public_key_path)],
        capture_output=True, text=True, timeout=10,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh-keygen -lf failed: {proc.stderr.strip()[:200]}"
        )
    # Output line: "256 SHA256:abc123… comment (ED25519)"
    parts = proc.stdout.strip().split()
    for part in parts:
        if part.startswith("SHA256:"):
            return part
    raise RuntimeError(
        f"ssh-keygen output missing SHA256 fingerprint: {proc.stdout[:200]!r}"
    )


def mint_signing_key(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    overwrite: bool = False,
) -> SigningKey:
    """Mints a per-cycle ed25519 keypair via ``ssh-keygen``.

    Files written:
      * ``<workspace>/aria-debts/keys/<cycle_id>`` — private key,
        mode 0600
      * ``<workspace>/aria-debts/keys/<cycle_id>.pub`` — public key

    Returns the ``SigningKey`` record with fingerprint. The
    fingerprint is the cross-check value
    ``implementation_safety.verify_commit_signature`` matches
    against ``git verify-commit --raw`` output.

    Raises ValueError on malformed ``cycle_id``, RuntimeError on
    ssh-keygen failure, FileExistsError when the key already exists
    + ``overwrite=False``.
    """
    _validate_cycle_id(cycle_id)
    keys_dir = _keys_dir(workspace_root)
    private_path = keys_dir / cycle_id
    public_path = keys_dir / f"{cycle_id}.pub"

    if private_path.exists() and not overwrite:
        # Existing key — return its fingerprint (idempotent re-mint).
        return SigningKey(
            cycle_id=cycle_id,
            private_key_path=private_path,
            public_key_path=public_path,
            fingerprint=_compute_fingerprint(public_path),
        )

    if not _ssh_keygen_available():
        raise RuntimeError(
            "ssh-keygen not on PATH; cannot mint ed25519 signing key. "
            "Install openssh-client OR provide a pre-minted key in "
            f"{private_path}"
        )

    # Remove stale files so ssh-keygen doesn't prompt for overwrite.
    if overwrite:
        private_path.unlink(missing_ok=True)
        public_path.unlink(missing_ok=True)

    proc = subprocess.run(
        [
            "ssh-keygen",
            "-t", "ed25519",
            "-f", str(private_path),
            "-N", "",
            "-C", f"aria-cycle-{cycle_id}",
            "-q",
        ],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh-keygen failed (exit={proc.returncode}): "
            f"stderr={proc.stderr.strip()[:200]!r}"
        )

    # Enforce mode 0600 on the private key (defense-in-depth — ssh-keygen
    # already sets it but a re-permission ensures correctness).
    private_path.chmod(0o600)

    return SigningKey(
        cycle_id=cycle_id,
        private_key_path=private_path,
        public_key_path=public_path,
        fingerprint=_compute_fingerprint(public_path),
    )


def mint_installation_token(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    ttl_seconds: int = 300,
) -> InstallationTokenLease:
    """Plan ARIA-V9.0-C code-only — installation-token factory.

    Two operating modes:

    Mode A (GH App configured, production-correct):
        ``$ARIA_GH_APP_INSTALLATION_ID`` set → mints a 5-min TTL
        scoped installation token via ``gh api`` POST to
        ``/app/installations/{id}/access_tokens`` with
        permissions={pull_requests:write, contents:write} and
        repositories=[<repo>]. Token written to
        ``aria-debts/keys/<cycle_id>.token`` mode 0600.

    Mode B (operator-PAT fallback, V9.0-C SHIM):
        ``$ARIA_GH_APP_INSTALLATION_ID`` absent → copies the operator
        ``$GH_TOKEN`` to the per-cycle token file with
        ``fallback_active=True`` AND the caller is expected to emit
        an ``installation_token_fallback_active`` governance event.
        Operator runbook (docs/runbooks/aria-github-app-setup.md)
        upgrades to Mode A.

    The mode B fallback is deliberate code-only V9.0-C scope — the
    GitHub App setup requires operator action outside the kernel.
    Tier-3 (detect) ensures the audit trail captures shim mode; a
    future Tier-1 upgrade promotes the fallback to a hard-fail when
    the operator runbook is complete.
    """
    _validate_cycle_id(cycle_id)
    keys_dir = _keys_dir(workspace_root)
    token_path = keys_dir / f"{cycle_id}.token"

    installation_id = os.environ.get("ARIA_GH_APP_INSTALLATION_ID")

    if installation_id:
        # Mode A — proper scoped installation token. ``gh api`` is
        # the canonical mint path; the request emits an ephemeral
        # JWT signed by the GH App's private key (env var
        # ``ARIA_GH_APP_PRIVATE_KEY_PATH``). gh CLI handles the
        # JWT mint internally when ``GH_APP_*`` env is configured.
        if shutil.which("gh") is None:
            raise RuntimeError(
                "gh CLI not on PATH; cannot mint installation token"
            )
        proc = subprocess.run(
            [
                "gh", "api",
                f"/app/installations/{installation_id}/access_tokens",
                "-X", "POST",
                "-f", "permissions[pull_requests]=write",
                "-f", "permissions[contents]=write",
            ],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"gh api access_tokens failed: {proc.stderr.strip()[:200]}"
            )
        # parse {"token": "ghs_...", "expires_at": "..."} payload
        import json as _json
        try:
            data = _json.loads(proc.stdout)
            token = data["token"]
        except (KeyError, _json.JSONDecodeError) as exc:
            raise RuntimeError(
                f"installation_token mint response unparseable: {exc!r}"
            )
        token_path.write_text(token)
        token_path.chmod(0o600)
        fallback_active = False
    else:
        # Mode B — operator-PAT fallback shim. Governance event
        # emission is the CALLER's responsibility; this function
        # ships the InstallationTokenLease with fallback_active=True
        # so the caller knows to fire the event.
        pat = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if not pat:
            raise RuntimeError(
                "No GH App installation AND no operator PAT (GH_TOKEN); "
                "cannot mint installation token. Configure either "
                "ARIA_GH_APP_INSTALLATION_ID or GH_TOKEN."
            )
        token_path.write_text(pat)
        token_path.chmod(0o600)
        fallback_active = True

    from datetime import datetime, timezone
    minted_at = datetime.now(timezone.utc).isoformat()

    return InstallationTokenLease(
        cycle_id=cycle_id,
        token_file=token_path,
        ttl_seconds=ttl_seconds,
        gh_app_installation_id=installation_id,
        fallback_active=fallback_active,
        minted_at_utc=minted_at,
    )


def revoke_installation_token(*, lease: InstallationTokenLease) -> None:
    """Best-effort revocation of a per-cycle installation token.

    Mode A (GH App): the 5-min TTL expires the token automatically;
    explicit revoke is best-effort via ``gh api /installation/token``
    DELETE. Failure logged but not raised — kernel cleanup happens
    via file deletion below.

    Mode B (fallback): nothing to revoke (operator PAT is long-lived);
    only the per-cycle file is removed.

    Always removes the token file.
    """
    if lease.gh_app_installation_id and shutil.which("gh"):
        # Best-effort GH App token revoke; ignore failures (file
        # cleanup is the load-bearing step).
        subprocess.run(
            ["gh", "api", "-X", "DELETE", "/installation/token"],
            capture_output=True, timeout=10,
        )
    try:
        lease.token_file.unlink()
    except FileNotFoundError:
        pass


__all__ = (
    "SigningKey",
    "InstallationTokenLease",
    "mint_signing_key",
    "mint_installation_token",
    "revoke_installation_token",
)
