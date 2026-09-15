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

import json
import os
import re
import shutil
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import Any


@dataclass(frozen=True)
class GitSigningWiring:
    """ARIA-HIGH-114 — the mint's receipt for the checkout's signing config.

    ``configured`` is True only when every one of ``_SIGNING_CONFIG_KEYS``
    was written to ``scope`` (``--local`` on a main checkout, ``--worktree``
    on a linked worktree). Otherwise ``reason`` names why not, in the
    closed vocabulary ``not_a_checkout`` (the workspace root is not inside
    a git checkout), ``git_unavailable`` (git did not answer), and
    ``worktree_scope_unavailable:<why>`` (a linked worktree whose
    repository cannot carry per-worktree config). The receipt is the
    difference between "silently unsigned" and "refused by name".
    """

    configured: bool
    scope: str | None
    reason: str | None


@dataclass(frozen=True)
class SigningCheckout:
    """ARIA-HIGH-114 — where one workspace's signing transaction lives.

    ``git_dir`` is the checkout's PRIVATE git directory as ``checkout_root``
    reads it from the ``.git`` marker: ``<ws>/.git`` for a main checkout,
    ``<common>/worktrees/<name>`` for a linked worktree.
    The allowed-signers file and the config snapshots live there — a
    directory the lane's pre-clean never wipes in either shape, and one
    that exists for the per-request worktrees the executor drain adds,
    where ``<ws>/.git`` is a FILE and the old ``is_dir()`` test skipped
    the whole wiring without a word.

    ``config_scope`` is the ``git config`` scope the transaction writes
    to. On a main checkout that is ``--local``. On a linked worktree
    ``--local`` is the config every worktree of the repository shares —
    the operator's own checkout and every other lane's tree — and a
    per-cycle signing key installed there signs everybody's commits and
    is restored by whichever cycle revokes first; so a linked worktree
    writes ``--worktree`` (``config.worktree`` inside ``git_dir``), which
    git honours once ``extensions.worktreeConfig`` is on.
    """

    workspace_root: Path
    git_dir: Path
    config_scope: str

    @property
    def linked(self) -> bool:
        return self.config_scope == _CONFIG_SCOPE_WORKTREE


# Public: the executor's identity seam (`implementation_identity`) accepts a
# mint only in the per-worktree scope, and names the other by this constant.
CONFIG_SCOPE_LOCAL: str = "--local"
CONFIG_SCOPE_WORKTREE: str = "--worktree"
_CONFIG_SCOPE_LOCAL: str = CONFIG_SCOPE_LOCAL
_CONFIG_SCOPE_WORKTREE: str = CONFIG_SCOPE_WORKTREE
_WORKTREE_CONFIG_EXTENSION: str = "extensions.worktreeConfig"


def signing_checkout(workspace_root: Path) -> SigningCheckout | None:
    """The checkout rooted at ``workspace_root``, or ``None`` when it is not
    one (an archive checkout, a bare fixture directory).

    Read through ``checkout_root`` — the one parser for every walker that
    asks where a checkout begins: ``.git`` as a directory or as the
    ``gitdir:`` pointer file ``git worktree add`` writes, the per-worktree
    git dir it names, and the ``commondir`` that tells a linked worktree
    from a main checkout. No git process is spawned here, so "git did not
    answer" can only arise at the ``git config`` calls, where it is
    UNDECIDED (the restore) or best-effort (the mint) — never "not a
    checkout".

    Public: it is the same reading the mint, the restore and the revoke
    use, and the executor's identity seam (``implementation_identity``)
    reads it BEFORE minting, so a workspace whose config scope would be
    the shared ``--local`` is refused without a single config write
    (ARIA-HIGH-115 round 2: the refusal used to come after the mint had
    already replaced ``user.signingkey`` in the config every worktree of
    the repository shares).
    """
    from .checkout_root import resolve_git_common_directory, resolve_git_directory

    git_dir = resolve_git_directory(workspace_root / ".git")
    if git_dir is None:
        return None
    common_dir = resolve_git_common_directory(git_dir)
    if common_dir is None:
        return None
    return SigningCheckout(
        workspace_root=workspace_root,
        git_dir=git_dir,
        config_scope=_CONFIG_SCOPE_WORKTREE if git_dir != common_dir else _CONFIG_SCOPE_LOCAL,
    )


def _worktree_config_scope_available(checkout: SigningCheckout) -> str | None:
    """Make ``--worktree`` mean what the transaction needs it to mean.

    Without ``extensions.worktreeConfig`` git treats ``--worktree`` as
    ``--local`` — the shared config, silently. The extension is a
    repository-format declaration ("worktrees carry their own config"),
    written once to the common config and left on: turning it off again
    would orphan every ``config.worktree`` written under it. Git's own
    rule for enabling it is that ``core.worktree`` and a true
    ``core.bare`` must first move into the main worktree's
    ``config.worktree``; a repository carrying either is refused by name
    rather than re-shaped here. Returns ``None`` when the scope is usable,
    else the reason.
    """
    if not checkout.linked:
        return None
    ws = checkout.workspace_root
    current = _git_config_at(ws, _CONFIG_SCOPE_LOCAL, "--get", _WORKTREE_CONFIG_EXTENSION)
    if current.returncode == 0 and current.stdout.strip().lower() == "true":
        return None
    if _git_config_at(ws, _CONFIG_SCOPE_LOCAL, "--get", "core.worktree").returncode == 0:
        return "core.worktree is set in the common config"
    bare = _git_config_at(ws, _CONFIG_SCOPE_LOCAL, "--get", "core.bare")
    if bare.returncode == 0 and bare.stdout.strip().lower() == "true":
        return "core.bare is true in the common config"
    enabled = _git_config_at(ws, _CONFIG_SCOPE_LOCAL, _WORKTREE_CONFIG_EXTENSION, "true")
    if enabled.returncode != 0:
        return f"git config {_WORKTREE_CONFIG_EXTENSION} failed rc={enabled.returncode}"
    return None


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
    # ARIA-HIGH-114 — what the mint did to the checkout's git signing
    # config. ``None`` on an idempotent re-mint (the first mint wired it);
    # otherwise the receipt, so the executor child that holds the
    # implementer's identity (``implementation_identity``, ARIA-HIGH-115)
    # refuses to run an implementer whose commits the merge gate could never
    # verify instead of learning that at ``git verify-commit`` after the run.
    git_signing: GitSigningWiring | None = None


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
    is the ONLY way aria-implementer receives a token. Plan 032 Faz 032d
    (`delivery_credentials`) is its sole consumer: the token rides ONE
    spawn's built environment as ``GH_TOKEN`` for a profile that declares
    ``external_writes`` — never argv, never a file the agent can read —
    and is revoked when that spawn ends. The earlier "credentials file the
    sandbox reads on demand" design had no reader and is superseded.
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

# The permission set a Mode A installation token is minted with when the
# caller names none: the implementer's delivery scope (pull_requests:write +
# contents:write on its own branch) plus administration:read, which the
# readiness claim's branch-protection probe needs (ARIA-MEDIUM-021) and which
# doubles as the tripwire that the operator ticked Administration: read-only
# on the App (a permission the App was not granted fails the mint, HTTP 422).
DEFAULT_INSTALLATION_TOKEN_PERMISSIONS: Mapping[str, str] = MappingProxyType({
    "pull_requests": "write",
    "contents": "write",
    "administration": "read",
})
# A token that may only READ the repository's runner roster
# (GET /repos/{owner}/{repo}/actions/runners): what the hosted runner
# preflight mints. A GitHub-hosted job never holds a write scope on the
# repository it merely asks about.
RUNNER_STATUS_PERMISSIONS: Mapping[str, str] = MappingProxyType({"administration": "read"})
_PERMISSION_LEVELS: frozenset[str] = frozenset({"read", "write"})


def _validate_permissions(permissions: Mapping[str, str]) -> dict[str, str]:
    """The exact permission object the mint sends — never empty, every
    level one GitHub defines. A typo here would mint a token with a
    permission GitHub rejects (HTTP 422) or, worse, none at all."""
    if not isinstance(permissions, Mapping) or not permissions:
        raise ValueError("mint_installation_token: permissions must name at least one scope")
    for scope, level in permissions.items():
        if not isinstance(scope, str) or not scope.strip():
            raise ValueError("mint_installation_token: permission scope must be a non-empty string")
        if level not in _PERMISSION_LEVELS:
            raise ValueError(
                f"mint_installation_token: permission level for {scope!r} must be one of "
                f"{sorted(_PERMISSION_LEVELS)}, got {level!r}"
            )
    return dict(permissions)


def _validate_cycle_id(cycle_id: str) -> None:
    if not isinstance(cycle_id, str) or not _CYCLE_ID_RE.match(cycle_id):
        raise ValueError(
            f"cycle_id must match {_CYCLE_ID_RE.pattern!r}; got {cycle_id!r}"
        )


def _resolve_workspace_root(workspace_root: str | Path) -> Path:
    """The ONE place the factory turns a caller's workspace root into a path.

    Every public entry point (mint, revoke, prune, token mint) resolves
    through here first, so every path the factory writes or compares —
    the key files, the ``user.signingkey`` value, the allowed-signers
    file, the config snapshot — is derived from one absolute,
    symlink-free root. The ownership check in
    ``_restore_git_commit_signing`` and the inheritance check in
    ``_inherit_crashed_cycle_snapshot`` compare ``user.signingkey`` as a
    STRING against the private path; a mint called with a relative root
    and a revoke or prune called with the absolute one named the same key
    two ways, the check failed, and ``user.signingkey`` was left dangling
    (B7 round 2). Resolving once makes the two spellings impossible.
    """
    return Path(workspace_root).resolve()


def _keys_dir(workspace_root: str | Path) -> Path:
    """Returns the per-workspace keys directory, creating it with mode
    0700 if absent. Resolves through ``_resolve_workspace_root``."""
    d = _resolve_workspace_root(workspace_root) / "aria-debts" / "keys"
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
    workspace_root = _resolve_workspace_root(workspace_root)
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
    git_signing = _configure_git_commit_signing(
        workspace_root=workspace_root,
        cycle_id=cycle_id,
        private_path=private_path,
        public_path=public_path,
    )

    return SigningKey(
        cycle_id=cycle_id,
        private_key_path=private_path,
        public_key_path=public_path,
        fingerprint=_compute_fingerprint(public_path),
        git_signing=git_signing,
    )


# B7 — the four LOCAL git config keys the mint writes. Each value is
# snapshotted before the first write and restored on revoke: a mint/revoke
# pair is a TRANSACTION on the checkout's config, never a net edit of it.
_SIGNING_CONFIG_KEYS: tuple[str, ...] = (
    "commit.gpgsign",
    "gpg.format",
    "user.signingkey",
    "gpg.ssh.allowedSignersFile",
)
# The config sections those keys live in, as (section, key-regexp) pairs.
# A section that did not exist before the mint is removed again on
# restore, so the file the operator had back is the file they get back —
# git leaves an empty ``[gpg "ssh"]`` header behind on some versions.
_SIGNING_CONFIG_SECTIONS: tuple[tuple[str, str], ...] = (
    ("commit", r"^commit\.[^.]+$"),
    ("gpg", r"^gpg\.[^.]+$"),
    ("gpg.ssh", r"^gpg\.ssh\."),
    ("user", r"^user\.[^.]+$"),
)
# The snapshot lives INSIDE ``.git/``, next to ``aria-allowed-signers`` —
# not next to the key in the gitignored ``aria-debts/keys/``. The
# production lane (``.github/workflows/aria-auto-cycle.yml``) runs
# ``git reset --hard && git clean -ffdx -e node_modules`` on the persistent
# self-hosted workspace at the start of EVERY run, and ``-x`` deletes
# gitignored paths: a cycle killed mid-window (OOM, a cancelled run — the
# autonomy CLI installs no SIGTERM handler) left its key AND a keys-dir
# snapshot for that pre-clean to wipe together, while ``.git/config`` —
# still pointing at the wiped key — survived. The startup prune then
# scanned an empty keys dir and restored nothing, the next mint found no
# snapshot to inherit and recorded the DANGLING kernel config as the state
# to return to, and its revoke "restored" exactly that: ``.git/config``
# permanently named a key that did not exist and a plain ``git commit``
# outside any mint window failed rc=128. ``.git/`` is the one place the
# pre-clean does not touch, so a snapshot there outlives every wipe the
# lane performs, and the config it describes can always be put back.
_SIGNING_CONFIG_SNAPSHOTS_DIRNAME: str = "aria-signing-config-snapshots"
_SIGNING_CONFIG_SNAPSHOT_SUFFIX: str = ".json"


def _signing_config_snapshots_dir(git_dir: Path) -> Path:
    """``<git_dir>/aria-signing-config-snapshots`` — checkout-resident
    state the lane's pre-clean never wipes (``SigningCheckout.git_dir``:
    ``.git/`` on a main checkout, the worktree's private directory under
    the common ``.git/worktrees/`` on a linked one). Not created here: the
    mint creates it (mode 0700) on first use, and a workspace that is not
    a checkout has no snapshots at all."""
    return git_dir / _SIGNING_CONFIG_SNAPSHOTS_DIRNAME


def _signing_config_snapshot_path(git_dir: Path, cycle_id: str) -> Path:
    """Where the mint records the config it is about to replace.

    One file per cycle. ``revoke_signing_key`` unwinds it on every path
    Python unwinds; ``prune_stale_signing_keys`` unwinds it on the crash
    path, where the process that minted never reached its ``finally`` —
    including the crash path where the pre-clean has since wiped the key
    files it belonged to.
    """
    return _signing_config_snapshots_dir(git_dir) / f"{cycle_id}{_SIGNING_CONFIG_SNAPSHOT_SUFFIX}"


def _git_config_at(workspace_root: Path, scope: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(workspace_root), "config", scope, *args],
        capture_output=True, text=True, timeout=10, check=False,
    )


def _git_config(workspace_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """One ``git config`` call in the scope the checkout's transaction owns
    (``SigningCheckout.config_scope``): ``--local`` on a main checkout,
    ``--worktree`` on a linked worktree. A workspace that is not a checkout
    falls through to ``--local`` and git answers rc=128 as before."""
    checkout = signing_checkout(workspace_root)
    scope = checkout.config_scope if checkout is not None else _CONFIG_SCOPE_LOCAL
    return _git_config_at(workspace_root, scope, *args)


def _snapshot_git_commit_signing(*, workspace_root: Path) -> dict[str, Any]:
    """Read the scoped values the mint will overwrite, and which sections exist."""
    keys: dict[str, str | None] = {}
    for key in _SIGNING_CONFIG_KEYS:
        current = _git_config(workspace_root, "--get", key)
        keys[key] = current.stdout.rstrip("\n") if current.returncode == 0 else None
    sections: dict[str, bool] = {}
    for section, pattern in _SIGNING_CONFIG_SECTIONS:
        sections[section] = _git_config(workspace_root, "--get-regexp", pattern).returncode == 0
    return {"keys": keys, "sections_present": sections}


def _inherit_crashed_cycle_snapshot(
    *, workspace_root: Path, git_dir: Path, cycle_id: str, snapshot: dict[str, Any],
) -> str | None:
    """B7 — a snapshot records the state before ANY kernel key, not the state
    the mint happened to find.

    The config the mint reads can be a CRASHED cycle's: that process never
    reached its ``finally``, so ``user.signingkey`` still names
    ``aria-debts/keys/<other>`` — a key still inside the prune's grace
    window, or one the lane's pre-clean has already wiped — while that
    cycle's own snapshot, the operator's config, is still on disk in
    ``.git/``. Recording the kernel's config as "the state to return to"
    makes the revoke hand the checkout back pointing at a key that is
    about to be pruned (or is already gone), and once the prune has
    discarded the crashed cycle's snapshot as foreign (its ownership check
    sees OUR key installed), nothing on disk knows what the operator had.
    Two crashed cycles in a row lose the operator's config outright; one
    crashed cycle leaves the checkout signing with a dead key until it
    ages out.

    So when the installed key is another cycle's from the same keys dir
    and that cycle's snapshot is readable, THIS cycle's snapshot is that
    one — the transaction start is inherited, and every snapshot is the
    operator's state by construction, however long the crash chain. The
    installed key's file need not exist for that: the comparison is on the
    path ``user.signingkey`` names, and the snapshot is read from
    ``.git/``, which outlives the key. The crashed cycle's own snapshot is
    left for the prune: its ownership check fails there (our key, or the
    restored operator key, is installed) and it is discarded, never
    replayed. Returns the inherited cycle id, or None when the installed
    key is not a kernel key or its snapshot is unreadable — the plain
    snapshot stands then.
    """
    installed = snapshot["keys"].get("user.signingkey")
    if not installed:
        return None
    installed_path = Path(installed)
    if installed_path.parent != workspace_root / "aria-debts" / "keys" or installed_path.name == cycle_id:
        return None
    try:
        inherited = json.loads(
            _signing_config_snapshot_path(git_dir, installed_path.name).read_text(encoding="utf-8"),
        )
        keys = dict(inherited["keys"])
        sections = dict(inherited["sections_present"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    snapshot["keys"] = keys
    snapshot["sections_present"] = sections
    snapshot["inherited_from_cycle_id"] = installed_path.name
    return installed_path.name


def _configure_git_commit_signing(
    *,
    workspace_root: Path,
    cycle_id: str,
    private_path: Path,
    public_path: Path,
) -> GitSigningWiring:
    """Plan ARIA-V3.1-B-3 — wire git for per-cycle SSH commit signing.

    Writes the SSH-format allowed-signers file at
    `<git_dir>/aria-allowed-signers` so `git verify-commit
    --raw` resolves against the cycle's public key. Calls
    `git config <scope>` (``SigningCheckout.config_scope``):
      * commit.gpgsign true
      * gpg.format ssh
      * user.signingkey <private_path>
      * gpg.ssh.allowedSignersFile <git_dir/aria-allowed-signers>

    ARIA-HIGH-114 — the checkout is what git says it is, not
    ``<workspace>/.git`` tested as a directory: in a linked worktree —
    the executor's per-request worktrees, a trial's task-source, every
    production shape — ``.git`` is a file, the old test skipped the whole
    wiring, every commit went unsigned and the merge gate's
    ``verify_commit_signature`` refused the run at its end. The receipt
    (``GitSigningWiring``) says what happened; the executor's identity seam
    (``implementation_identity``) refuses to run an implementer on a
    receipt that is not ``configured`` in ``--worktree`` scope.

    B7 — BEFORE the first write, the current local value of each of those
    keys (and whether its section exists at all) is recorded in
    ``.git/aria-signing-config-snapshots/<cycle_id>.json`` (mode 0600,
    directory 0700). ``_restore_git_commit_signing`` puts every one of them
    back on revoke, and ``prune_stale_signing_keys`` puts them back at the
    next orchestrator startup when the process that minted never revoked.
    The snapshot is checkout-resident on purpose: the production lane's
    pre-clean (``git clean -ffdx``) wipes the gitignored keys dir on every
    run but never ``.git/``, so the snapshot outlives the key it describes
    and the config can be put back whatever wiped the key
    (``_SIGNING_CONFIG_SNAPSHOTS_DIRNAME``).
    The post-CONVERGED knowledge seam mints under the default ``standard``
    profile, so an operator's own checkout — one that already signs with
    the operator's key — is a reachable workspace; a mint that overwrote
    ``user.signingkey`` and a revoke that merely unset it left that
    checkout with NO signing config, and every later commit went unsigned
    without a word. A snapshot that already exists is kept: it marks the
    start of the transaction, and an ``overwrite=True`` re-mint inside it
    must not record the kernel's own config as the state to return to.
    For the same reason a config that a CRASHED cycle left installed is
    not the state to return to either: the snapshot is inherited from that
    cycle's own (``_inherit_crashed_cycle_snapshot``), so it records the
    operator's config whatever the crash chain before this mint.

    Never raises: a workspace that is not a checkout (an archive
    checkout, the operator-side tools/aria-poc invocations, sandbox
    tests) answers ``not_a_checkout``, a git that does not answer
    ``git_unavailable``, and the mint itself still succeeds — the key is
    a knowledge signer whether or not git signs with it. Only the
    executor's implementation identity needs the wiring, and it reads the
    receipt.
    """
    checkout = signing_checkout(workspace_root)
    if checkout is None:
        return GitSigningWiring(configured=False, scope=None, reason="not_a_checkout")
    try:
        scope_refusal = _worktree_config_scope_available(checkout)
    except (OSError, subprocess.SubprocessError):
        return GitSigningWiring(configured=False, scope=None, reason="git_unavailable")
    if scope_refusal is not None:
        return GitSigningWiring(
            configured=False, scope=None, reason=f"worktree_scope_unavailable:{scope_refusal}",
        )
    git_dir = checkout.git_dir
    allowed_signers = git_dir / "aria-allowed-signers"
    snapshot_path = _signing_config_snapshot_path(git_dir, cycle_id)
    try:
        if not snapshot_path.exists():
            snapshot = {"cycle_id": cycle_id, **_snapshot_git_commit_signing(workspace_root=workspace_root)}
            _inherit_crashed_cycle_snapshot(
                workspace_root=workspace_root, git_dir=git_dir, cycle_id=cycle_id, snapshot=snapshot,
            )
            snapshot_path.parent.mkdir(mode=0o700, exist_ok=True)
            # Written whole or not at all: a process killed mid-write must
            # not leave a torn snapshot the restore cannot read.
            staging = snapshot_path.with_name(snapshot_path.name + ".tmp")
            staging.write_text(json.dumps(snapshot, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            staging.chmod(0o600)
            os.replace(staging, snapshot_path)
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
    except (OSError, subprocess.SubprocessError):
        return GitSigningWiring(configured=False, scope=checkout.config_scope, reason="git_unavailable")
    cfg = (
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("user.signingkey", str(private_path)),
        ("gpg.ssh.allowedSignersFile", str(allowed_signers)),
    )
    for key, value in cfg:
        try:
            written = _git_config(workspace_root, key, value)
        except (subprocess.SubprocessError, OSError):
            return GitSigningWiring(configured=False, scope=checkout.config_scope, reason="git_unavailable")
        if written.returncode != 0:
            return GitSigningWiring(
                configured=False, scope=checkout.config_scope,
                reason=f"git_config_failed:{key}:rc={written.returncode}",
            )
    return GitSigningWiring(configured=True, scope=checkout.config_scope, reason=None)


class SigningConfigRestore(str, Enum):
    """B7 — what ``_restore_git_commit_signing`` decided about one snapshot.

    Three of the four are DECISIONS: the snapshot has been consumed and is
    gone. ``UNDECIDED`` is the one the callers must not treat as a
    decision — the restore could not read the snapshot or git did not
    answer (``TimeoutExpired`` under a loaded host, an ``OSError`` on
    ``.git/``) and the snapshot is still on disk, ownership marker still
    set, for the next attempt to finish. The startup prune used to unlink
    a snapshot on every ``False``, so one timed-out ``git config`` left
    the checkout pointing at a key that no longer existed with nothing
    left on disk to put the operator's config back from.
    """

    RESTORED = "restored"
    """Ours; every key and section is back; snapshot and signers file removed."""
    FOREIGN = "foreign"
    """``user.signingkey`` names someone else's key; snapshot discarded, config untouched."""
    ABSENT = "absent"
    """Nothing to restore: no ``.git/`` or no snapshot for this cycle."""
    UNDECIDED = "undecided"
    """Could not act; the snapshot is kept for the next attempt."""


@dataclass(frozen=True)
class SigningConfigRestoreReceipt:
    """The restore's outcome and, when undecided, the public error class."""

    outcome: SigningConfigRestore
    error: str | None = None

    @property
    def decided(self) -> bool:
        return self.outcome is not SigningConfigRestore.UNDECIDED

    @property
    def restored(self) -> bool:
        return self.outcome is SigningConfigRestore.RESTORED


# The ownership marker. It is the LAST thing the restore releases: while it
# still names the cycle's key a retry passes the ownership check and redoes
# an idempotent restore, so a restore interrupted anywhere before the
# release is finished by the next attempt instead of being discarded.
_SIGNING_CONFIG_OWNERSHIP_KEY: str = "user.signingkey"
_SIGNING_CONFIG_OWNERSHIP_SECTION: str = "user"


def _restore_git_commit_signing(
    *,
    workspace_root: Path,
    cycle_id: str,
    private_path: Path,
) -> SigningConfigRestoreReceipt:
    """B7 — put back the git signing config the mint replaced, if it is ours.

    The inverse of ``_configure_git_commit_signing``: each of the four keys
    returns to the value the snapshot recorded (unset when it was absent),
    a section the mint created is removed again, and the cycle's
    allowed-signers file is unlinked. The result is the operator's config
    byte-for-byte, not a checkout with the kernel's keys merely unset.

    Ownership check first: the config is touched ONLY when
    ``user.signingkey`` still names THIS cycle's private path. Anyone who
    re-pointed the checkout during the cycle keeps what they set, and the
    abandoned snapshot is discarded so it cannot be replayed onto their
    config later (``FOREIGN``).

    Retry-safe: the ownership marker is released by the last git call.
    Every other key and section is restored before it, so an attempt
    that git or the filesystem interrupts returns ``UNDECIDED`` with the
    marker still set and the snapshot still on disk, and the next attempt
    (the next revoke or startup prune) passes the ownership check and
    finishes the same restore — setting a key to the value it already has
    and unsetting an absent one are no-ops. Never raises: no ``.git`` or
    no snapshot is ``ABSENT``; a git that does not answer is ``UNDECIDED``.
    """
    checkout = signing_checkout(workspace_root)
    if checkout is None:
        return SigningConfigRestoreReceipt(SigningConfigRestore.ABSENT)
    git_dir = checkout.git_dir
    snapshot_path = _signing_config_snapshot_path(git_dir, cycle_id)
    if not snapshot_path.is_file():
        return SigningConfigRestoreReceipt(SigningConfigRestore.ABSENT)
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        keys: Mapping[str, str | None] = snapshot["keys"]
        sections_present: Mapping[str, bool] = snapshot["sections_present"]
        current = _git_config(workspace_root, "--get", _SIGNING_CONFIG_OWNERSHIP_KEY)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        return SigningConfigRestoreReceipt(SigningConfigRestore.UNDECIDED, type(exc).__name__)
    if current.returncode != 0 or current.stdout.rstrip("\n") != str(private_path):
        snapshot_path.unlink(missing_ok=True)
        return SigningConfigRestoreReceipt(SigningConfigRestore.FOREIGN)
    try:
        for key in _SIGNING_CONFIG_KEYS:
            if key == _SIGNING_CONFIG_OWNERSHIP_KEY:
                continue
            value = keys.get(key)
            if value is None:
                _git_config(workspace_root, "--unset", key)
            else:
                _git_config(workspace_root, key, value)
        for section, pattern in _SIGNING_CONFIG_SECTIONS:
            if section == _SIGNING_CONFIG_OWNERSHIP_SECTION or sections_present.get(section):
                continue
            if _git_config(workspace_root, "--get-regexp", pattern).returncode != 0:
                _git_config(workspace_root, "--remove-section", section)
        # The marker, last. When the mint created the ``user`` section and
        # the cycle's key is the only thing in it, one ``--remove-section``
        # releases the marker and removes the header together; otherwise
        # the key alone returns to what the snapshot recorded.
        marker_value = keys.get(_SIGNING_CONFIG_OWNERSHIP_KEY)
        user_pattern = dict(_SIGNING_CONFIG_SECTIONS)[_SIGNING_CONFIG_OWNERSHIP_SECTION]
        user_keys = _git_config(workspace_root, "--get-regexp", user_pattern).stdout.split("\n")
        only_ours = [line for line in user_keys if line] == [
            f"{_SIGNING_CONFIG_OWNERSHIP_KEY} {private_path}",
        ]
        if marker_value is None and not sections_present.get(_SIGNING_CONFIG_OWNERSHIP_SECTION) and only_ours:
            _git_config(workspace_root, "--remove-section", _SIGNING_CONFIG_OWNERSHIP_SECTION)
        elif marker_value is None:
            _git_config(workspace_root, "--unset", _SIGNING_CONFIG_OWNERSHIP_KEY)
        else:
            _git_config(workspace_root, _SIGNING_CONFIG_OWNERSHIP_KEY, marker_value)
    except (subprocess.SubprocessError, OSError, AttributeError, TypeError) as exc:
        return SigningConfigRestoreReceipt(SigningConfigRestore.UNDECIDED, type(exc).__name__)
    allowed_signers = git_dir / "aria-allowed-signers"
    try:
        # Only the file this cycle wrote: its single line names the cycle.
        if allowed_signers.read_text(encoding="utf-8").startswith(f"aria-cycle-{cycle_id} "):
            allowed_signers.unlink()
    except OSError:
        pass
    snapshot_path.unlink(missing_ok=True)
    return SigningConfigRestoreReceipt(SigningConfigRestore.RESTORED)


def mint_installation_token(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    ttl_seconds: int = 300,
    permissions: Mapping[str, str] = DEFAULT_INSTALLATION_TOKEN_PERMISSIONS,
) -> InstallationTokenLease:
    """Plan ARIA-V9.0-C code-only — installation-token factory.

    Two operating modes:

    Mode A (GH App configured, production-correct):
        ``$ARIA_GH_APP_INSTALLATION_ID`` set → mints a 5-min TTL
        scoped installation token via a direct POST to
        ``/app/installations/{id}/access_tokens`` with exactly
        ``permissions`` (``DEFAULT_INSTALLATION_TOKEN_PERMISSIONS`` unless
        the caller narrows it — the hosted runner preflight passes
        ``RUNNER_STATUS_PERMISSIONS`` so a GitHub-hosted job never holds a
        write scope). Token written to ``aria-debts/keys/<cycle_id>.token``
        mode 0600.

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
    requested_permissions = _validate_permissions(permissions)
    keys_dir = _keys_dir(_resolve_workspace_root(workspace_root))
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
                # Exactly what the caller asked for (see the constants at the
                # top of this module for the two named sets and why each
                # permission is there).
                "permissions": requested_permissions,
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
    indefinitely. Every holder of a cycle key — the knowledge seam
    (`cycle_phases.knowledge_signer`) and the executor's implementation
    identity (`implementation_identity`) — calls this helper inside a
    `try/finally` so the keypair lifetime equals the phase it serves, not
    "until disk fills".

    Files removed (idempotent, best-effort):
      * `aria-debts/keys/<cycle_id>` — private key (mode 0600)
      * `aria-debts/keys/<cycle_id>.pub` — public key
      * `aria-debts/keys/<cycle_id>.token` — co-located installation
        token if revoke_installation_token wasn't called explicitly

    B7 — the local git signing config the mint replaced is RESTORED as
    well, from the snapshot the mint took, when the config still names
    this cycle's key (``_restore_git_commit_signing``): the checkout
    returns to the operator exactly as the operator left it, signing key
    and all, and a revoked key never leaves a dangling ``user.signingkey``
    behind.

    Returns a summary dict shaped for cycle_summary inclusion:
      ``{"removed": [...], "missing": [...], "git_signing_config_restored": bool,
      "git_signing_config_restore": "restored"|"foreign"|"absent"|"undecided"}``
      (+ ``git_signing_config_restore_error`` naming the exception class
      when undecided). An undecided restore keeps its snapshot; the
      startup prune finishes it.

    Tier-1 (Make impossible — once try/finally is wired, key cannot
    outlive the cycle). Tier-3 (Detect — `prune_stale_signing_keys`, run
    by the orchestrator at startup, catches orphans missed by try/finally
    crash paths and unwinds their config snapshots the same way).
    """
    _validate_cycle_id(cycle_id)
    workspace_root = _resolve_workspace_root(workspace_root)
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
    restore = _restore_git_commit_signing(
        workspace_root=workspace_root, cycle_id=cycle_id, private_path=targets[0],
    )
    return {
        "removed": removed,
        "missing": missing,
        "git_signing_config_restored": restore.restored,
        "git_signing_config_restore": restore.outcome.value,
        **({"git_signing_config_restore_error": restore.error} if restore.error else {}),
    }


def prune_stale_signing_keys(
    *,
    workspace_root: str | Path,
    max_age_seconds: float = 24 * 3600.0,
) -> dict[str, Any]:
    """Plan ARIA-V3.1-P-6 — orchestrator-startup pass for orphan keys.

    Closes 6-validator audit C-11 (R-V31-4) the orphan path: if a
    prior orchestrator process crashed BEFORE revoke_signing_key
    fired, the keypair remains on disk. ``run_autonomy_orchestrator``
    calls this at startup, next to the orphan-implementation reaper,
    with the default 24h grace window; key-dir entries older than the
    cutoff are unlinked + counted in the returned summary, and the
    orchestrator emits a ``keys_pruned`` governance row naming what was
    pruned. The post-CONVERGED knowledge seam mints under the default
    ``standard`` profile on every converged cycle, so the crash-path
    orphan window is a real one and this pass is its only net.

    B7 — the git config snapshot of every cycle whose PRIVATE KEY FILE no
    longer exists is unwound (``_restore_git_commit_signing``,
    ownership-checked) and removed. A snapshot without its key is an
    orphan by definition: the mint writes the key before the snapshot,
    the revoke that removes the key removes the snapshot with it, and
    nothing can sign with a key that is not there. That covers the key
    this pass has just pruned as stale AND the key the production lane's
    pre-clean wiped (``git clean -ffdx`` deletes the gitignored keys dir
    on every run; the snapshot lives in ``.git/`` precisely so it
    survives that wipe — ``_SIGNING_CONFIG_SNAPSHOTS_DIRNAME``). No age
    gate applies to a key-less snapshot; a snapshot whose key file is
    still present belongs to a cycle inside the grace window and is left
    alone. The checkout a crashed cycle left pointing at a key that no
    longer exists gets the operator's own signing config back, the way a
    clean revoke would have given it back. A crashed cycle whose config a
    LATER cycle already replaced fails the ownership check here and its
    snapshot is discarded — that later cycle inherited it at mint
    (``_inherit_crashed_cycle_snapshot``), so the operator's config is
    restored from whichever snapshot still owns the checkout.

    Returns ``{"scanned": N, "pruned": [key-dir filenames],
    "snapshots_unwound": [cycle_ids], "git_signing_config_restored":
    [cycle_ids], "errors": [...]}``. ``snapshots_unwound`` names every
    snapshot removed; ``git_signing_config_restored`` is the subset whose
    ownership check passed and whose config was put back. ``scanned``
    counts key-dir files and snapshots together.

    Best-effort: filesystem errors (permission, immutable) are
    accumulated in the `errors` list rather than raised, so a
    misconfigured workspace cannot block orchestrator startup. A snapshot
    whose restore is ``UNDECIDED`` (``SigningConfigRestore``) is NOT
    unlinked: it is the only copy of the operator's config, the ownership
    marker is still set, and the next startup finishes the restore. The
    receipt names it in ``errors`` as
    ``git_signing_config_restore_undecided:<ErrorClass>``.
    """
    workspace_root = _resolve_workspace_root(workspace_root)
    keys_dir = workspace_root / "aria-debts" / "keys"
    import time as _time
    now = _time.time()
    pruned: list[str] = []
    unwound: list[str] = []
    restored: list[str] = []
    errors: list[dict[str, str]] = []
    scanned = 0
    # Pass 1 — stale key-dir files, age-gated: a cycle still running in
    # another process keeps its key.
    if keys_dir.is_dir():
        for entry in sorted(keys_dir.iterdir()):
            if not entry.is_file():
                continue
            scanned += 1
            try:
                if now - entry.stat().st_mtime < max_age_seconds:
                    continue
                entry.unlink()
                pruned.append(entry.name)
            except OSError as exc:
                errors.append({"name": entry.name, "error": str(exc)[:200]})
    # Pass 2 — snapshots whose key is gone, whichever way it went. The
    # snapshots live in the checkout's private git dir.
    checkout = signing_checkout(workspace_root)
    snapshots_dir = _signing_config_snapshots_dir(checkout.git_dir) if checkout is not None else None
    if snapshots_dir is not None and snapshots_dir.is_dir():
        for entry in sorted(snapshots_dir.iterdir()):
            if not entry.is_file() or not entry.name.endswith(_SIGNING_CONFIG_SNAPSHOT_SUFFIX):
                continue
            scanned += 1
            cycle_id = entry.name[: -len(_SIGNING_CONFIG_SNAPSHOT_SUFFIX)]
            private_path = keys_dir / cycle_id
            try:
                if private_path.exists():
                    continue
                restore = _restore_git_commit_signing(
                    workspace_root=workspace_root, cycle_id=cycle_id, private_path=private_path,
                )
                if not restore.decided:
                    # The restore could not act (git did not answer, the
                    # snapshot did not read). The snapshot is the only
                    # copy of the operator's config: it stays for the next
                    # startup, and the receipt says so.
                    errors.append({
                        "name": entry.name,
                        "error": f"git_signing_config_restore_undecided:{restore.error}",
                    })
                    continue
                if restore.restored:
                    restored.append(cycle_id)
                entry.unlink(missing_ok=True)
                unwound.append(cycle_id)
            except OSError as exc:
                errors.append({"name": entry.name, "error": str(exc)[:200]})
    return {
        "scanned": scanned,
        "pruned": pruned,
        "snapshots_unwound": unwound,
        "git_signing_config_restored": restored,
        "errors": errors,
    }


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
    "CONFIG_SCOPE_LOCAL",
    "CONFIG_SCOPE_WORKTREE",
    "GitSigningWiring",
    "SigningCheckout",
    "SigningKey",
    "InstallationTokenLease",
    "mint_signing_key",
    "mint_installation_token",
    "prune_stale_signing_keys",
    "revoke_installation_token",
    "revoke_signing_key",
    "signing_checkout",
)
