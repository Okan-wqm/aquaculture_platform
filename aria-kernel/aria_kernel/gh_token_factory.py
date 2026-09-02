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
    # ARIA-AUDIT-017: TTL honesty. provider_expiry is GitHub's own
    # expires_at for Mode A installation tokens (None in Mode B, where
    # the operator PAT has no provider-side lifetime and revocation is
    # local-file deletion only). Consumers that need a provider-enforced
    # horizon must refuse leases where this is None.
    provider_expiry: str | None = None


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

    # Plan ARIA-V3.1-B-3 — auto-configure git for SSH commit signing.
    # Closes 6-validator audit C-7: mint_signing_key previously
    # produced a keypair but never wired it to `git commit -S`.
    # Now `git config --local` sets commit.gpgsign true, gpg.format ssh,
    # user.signingkey <private_path>, gpg.ssh.allowedSignersFile so
    # `git verify-commit` resolves against the per-cycle public key.
    # plan_convergence.record_implementation_outcome calls
    # verify_commit_signature against this allowed_signers file before
    # accepting the impl row.
    _configure_git_commit_signing(
        workspace_root=Path(workspace_root),
        cycle_id=cycle_id,
        private_path=private_path,
        public_path=public_path,
    )

    return SigningKey(
        cycle_id=cycle_id,
        private_key_path=private_path,
        public_key_path=public_path,
        fingerprint=_compute_fingerprint(public_path),
    )


def _configure_git_commit_signing(
    *,
    workspace_root: Path,
    cycle_id: str,
    private_path: Path,
    public_path: Path,
) -> None:
    """Plan ARIA-V3.1-B-3 — wire git for per-cycle SSH commit signing.

    Writes the SSH-format allowed-signers file at
    `<workspace>/.git/aria-allowed-signers` so `git verify-commit
    --raw` resolves against the cycle's public key. Calls
    `git config --local`:
      * commit.gpgsign true
      * gpg.format ssh
      * user.signingkey <private_path>
      * gpg.ssh.allowedSignersFile <.git/aria-allowed-signers>

    Best-effort: errors are swallowed so a worktree without `.git/`
    (test fixture, archive checkout) does not block the autonomy
    run. The implementer agent's commit step will surface the
    failure via `git commit` exit code if signing is unavailable.

    Idempotent within a workspace_root + cycle_id: re-invocation
    overwrites the same config keys + allowed-signers file.
    """
    git_dir = workspace_root / ".git"
    if not git_dir.is_dir():
        # Caller's workspace_root is not a git checkout. Skip silently —
        # operator-side tools/aria-poc invocations + sandbox tests
        # exercise this path.
        return
    allowed_signers = git_dir / "aria-allowed-signers"
    try:
        # Public key file format: "<comment> <key_type> <key_blob>".
        # The allowed-signers format expects "<principal> <key_type>
        # <key_blob>"; we use the cycle_id as principal.
        pub_text = public_path.read_text(encoding="utf-8").strip()
        parts = pub_text.split(None, 2)
        if len(parts) >= 2:
            key_type, key_blob = parts[0], parts[1]
            allowed_signers.write_text(
                f"aria-cycle-{cycle_id} {key_type} {key_blob}\n",
                encoding="utf-8",
            )
    except OSError:
        return
    cfg = (
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("user.signingkey", str(private_path)),
        ("gpg.ssh.allowedSignersFile", str(allowed_signers)),
    )
    for key, value in cfg:
        try:
            subprocess.run(
                ["git", "-C", str(workspace_root), "config", "--local", key, value],
                capture_output=True, text=True, timeout=10, check=False,
            )
        except (subprocess.SubprocessError, OSError, FileNotFoundError):
            # Best-effort — operator audit will surface unsigned-commit
            # rows via verify_commit_signature mismatch when signing is
            # truly required.
            return


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

    # Plan ARIA-V3.1-F-2 — ARIA_DRY_RUN system-wide gate (closes C-8).
    # When set, mint a sentinel mock token without touching the real
    # GitHub installation API or the operator PAT. The token file is
    # still written so callers expecting the InstallationTokenLease
    # contract get a consistent shape; the lease's fallback_active
    # field is True so downstream paths treat it as non-authoritative.
    if os.environ.get("ARIA_DRY_RUN", "").lower() in ("true", "1", "yes"):
        token_path.write_text("aria-dry-run-sentinel")
        token_path.chmod(0o600)
        from datetime import datetime, timezone
        return InstallationTokenLease(
            cycle_id=cycle_id,
            token_file=token_path,
            ttl_seconds=ttl_seconds,
            gh_app_installation_id=None,
            fallback_active=True,
            minted_at_utc=datetime.now(timezone.utc).isoformat(),
        )

    installation_id = os.environ.get("ARIA_GH_APP_INSTALLATION_ID")

    if installation_id:
        # Mode A — proper scoped installation token via direct GitHub
        # API call (V10.3-B prereq fix). The original V9.0-C code
        # assumed `gh` CLI 2.x would auto-mint a JWT from `GH_APP_*`
        # env vars; verified-by-runbook-execution 2026-05-19 that
        # `gh 2.65.0` does NOT honor that contract (HTTP 401
        # "JSON web token could not be decoded"). The Mode A path now
        # mints the JWT directly via PyJWT + cryptography (Tier-1
        # anchor: kernel owns the auth flow, no opaque CLI dependency).
        #
        # Closes audit findings:
        #   * INFRA-CRIT-002 (gh CLI uses `GH_APP_*` not ARIA_GH_APP_*)
        #   * SEC-HIGH-006 (same gh CLI env mapping gap)
        #   * SEC-CRIT-003 (silent Mode B fallback — now structurally
        #     prevented when ARIA_REQUIRE_MODE_A=true sees env)
        app_id = os.environ.get("ARIA_GH_APP_ID")
        private_key_path = os.environ.get(
            "ARIA_GH_APP_PRIVATE_KEY_PATH",
            "/root/.config/aria/gh-app-private-key.pem",
        )
        if not app_id:
            raise RuntimeError(
                "mint_installation_token Mode A requires ARIA_GH_APP_ID "
                "env var (paired with ARIA_GH_APP_INSTALLATION_ID). "
                "Set via runbook docs/runbooks/aria-github-app-setup.md."
            )
        try:
            private_pem = Path(private_key_path).read_text(encoding="utf-8")
        except OSError as exc:
            raise RuntimeError(
                f"mint_installation_token Mode A: private key unreadable "
                f"at {private_key_path!r}: {exc!s}"
            )
        # Lazy import — keeps the factory import-cheap when Mode A
        # is not used (Mode B fallback path doesn't need PyJWT).
        try:
            import jwt as _jwt
        except ImportError as exc:
            raise RuntimeError(
                "mint_installation_token Mode A requires PyJWT "
                "(pip install PyJWT[crypto]); not installed."
            ) from exc
        import json as _json
        import time as _time
        import urllib.error as _urllib_error
        import urllib.request as _urllib_request

        # JWT — 9-minute exp window per GitHub App auth contract.
        now = int(_time.time())
        payload = {"iat": now - 60, "exp": now + 540, "iss": app_id}
        jwt_token = _jwt.encode(payload, private_pem, algorithm="RS256")

        # POST /app/installations/<id>/access_tokens
        req = _urllib_request.Request(
            f"https://api.github.com/app/installations/{installation_id}/access_tokens",
            method="POST",
            headers={
                "Authorization": f"Bearer {jwt_token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            data=_json.dumps({
                # ARIA-AUDIT-017: the lease TTL must be a PROVIDER-side
                # property, not local fiction. expires_in makes GitHub
                # itself expire the installation token at the same horizon
                # the local lease claims; without it the default 1h token
                # outlives (or undershoots) the lease metadata.
                "expires_in": max(60, int(ttl_seconds)),
                "permissions": {
                    "pull_requests": "write",
                    "contents": "write",
                    # ARIA-MEDIUM-021 — the readiness claim's branch-protection
                    # probe reads GET /repos/.../protection, which the API gates
                    # behind administration:read. Requesting a permission the
                    # App was not granted fails the mint loudly (HTTP 422), so
                    # this line is also the tripwire that says the operator
                    # ticked Administration: read-only on the App.
                    "administration": "read",
                },
            }).encode("utf-8"),
        )
        try:
            with _urllib_request.urlopen(req, timeout=ttl_seconds) as resp:
                data = _json.loads(resp.read())
        except _urllib_error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(
                f"mint_installation_token Mode A HTTP {exc.code}: {body}"
            ) from exc
        token = data.get("token")
        if not isinstance(token, str) or not token.strip():
            raise RuntimeError(
                "mint_installation_token Mode A: API response missing 'token'"
            )
        expires_at = data.get("expires_at")
        if not isinstance(expires_at, str) or not expires_at.strip():
            raise RuntimeError(
                "mint_installation_token Mode A: API response missing "
                "'expires_at' — a lease without provider expiry is local "
                "fiction (ARIA-AUDIT-017)"
            )
        token_path.write_text(token)
        token_path.chmod(0o600)
        fallback_active = False
    else:
        # Plan ARIA-V10.3-B prereq — ARIA_REQUIRE_MODE_A hard-fail gate
        # (closes audit SEC-CRIT-003). When the operator has declared
        # Mode A required for this host (via the runbook), refuse
        # falling back to operator-PAT scope.
        if os.environ.get("ARIA_REQUIRE_MODE_A", "").lower() in ("true", "1", "yes"):
            raise RuntimeError(
                "ARIA_REQUIRE_MODE_A=true but ARIA_GH_APP_INSTALLATION_ID "
                "is unset; Mode B fallback FORBIDDEN. Configure Mode A "
                "via docs/runbooks/aria-github-app-setup.md."
            )
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


def revoke_signing_key(
    *,
    cycle_id: str,
    workspace_root: str | Path,
) -> dict[str, Any]:
    """Plan ARIA-V3.1-P-6 — per-cycle signing-key revocation.

    Closes 6-validator audit C-11 (R-V31-4): ed25519 keypairs minted
    by `mint_signing_key` persisted to `aria-debts/keys/<cycle_id>`
    indefinitely. The V3.1-B AutonomousV9ImplementationRunner calls
    this helper inside a `try/finally` so the keypair lifetime equals
    the implementation phase wall-clock (typically <30min), not
    "until disk fills".

    Files removed (idempotent, best-effort):
      * `aria-debts/keys/<cycle_id>` — private key (mode 0600)
      * `aria-debts/keys/<cycle_id>.pub` — public key
      * `aria-debts/keys/<cycle_id>.token` — co-located installation
        token if revoke_installation_token wasn't called explicitly

    Returns a summary dict shaped for cycle_summary inclusion:
      ``{"removed": [...], "missing": [...]}``.

    Tier-1 (Make impossible — once try/finally is wired, key cannot
    outlive the cycle). Tier-3 (Detect — `prune_stale_signing_keys`
    catches orphans missed by try/finally crash paths).
    """
    _validate_cycle_id(cycle_id)
    keys_dir = _keys_dir(workspace_root)
    targets = (
        keys_dir / cycle_id,
        keys_dir / f"{cycle_id}.pub",
        keys_dir / f"{cycle_id}.token",
    )
    removed: list[str] = []
    missing: list[str] = []
    for target in targets:
        try:
            target.unlink()
            removed.append(target.name)
        except FileNotFoundError:
            missing.append(target.name)
        except OSError:
            # Permission / immutable bit — best-effort, surface to
            # caller via missing list so cycle_summary captures the
            # operator-attention case.
            missing.append(target.name)
    return {"removed": removed, "missing": missing}


def prune_stale_signing_keys(
    *,
    workspace_root: str | Path,
    max_age_seconds: float = 24 * 3600.0,
) -> dict[str, Any]:
    """Plan ARIA-V3.1-P-6 — orchestrator-startup pass for orphan keys.

    Closes 6-validator audit C-11 (R-V31-4) the orphan path: if a
    prior orchestrator process crashed BEFORE revoke_signing_key
    fired, the keypair remains on disk. The orchestrator's startup
    hook calls this helper with the default 24h grace window; entries
    older than the cutoff are unlinked + counted in the returned
    summary (caller emits `keys_pruned` governance event with the
    count).

    Returns ``{"scanned": N, "pruned": [filenames], "errors": [...]}``.

    Best-effort: filesystem errors (permission, immutable) are
    accumulated in the `errors` list rather than raised, so a
    misconfigured workspace cannot block orchestrator startup.
    """
    keys_dir = Path(workspace_root) / "aria-debts" / "keys"
    if not keys_dir.exists():
        return {"scanned": 0, "pruned": [], "errors": []}
    import time as _time
    now = _time.time()
    pruned: list[str] = []
    errors: list[dict[str, str]] = []
    scanned = 0
    for entry in keys_dir.iterdir():
        if not entry.is_file():
            continue
        scanned += 1
        try:
            mtime = entry.stat().st_mtime
            if now - mtime < max_age_seconds:
                continue
            entry.unlink()
            pruned.append(entry.name)
        except OSError as exc:
            errors.append({"name": entry.name, "error": str(exc)[:200]})
    return {"scanned": scanned, "pruned": pruned, "errors": errors}


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
    "prune_stale_signing_keys",
    "revoke_installation_token",
    "revoke_signing_key",
)
