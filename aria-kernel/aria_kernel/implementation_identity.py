"""ARIA-HIGH-115 — the implementer's signing identity, minted where the commit is made.

WHY this module exists
----------------------
The merge gate verifies every implementer commit against the cycle's signing
key, and the outcome recorder refuses an implementation result without the
key's fingerprint. The V9 runner used to mint that key inside its own run
and revoke it in ``finally`` — before the implementer had even been claimed.
The executor lane claims the request later, in a per-request worktree where
no key, no signing config and no fingerprint existed, and the agent was
asked to report a ``signer_key_fp`` it could not know. Every executor-lane
implementation result was therefore refused: with an empty fingerprint by
``record_implementation_outcome``, with a fabricated one by the bridge's
``git verify-commit``.

WHAT this module does
---------------------
It gives the executor child — the process whose cwd is the tree the agent
commits in — the identity's whole lifecycle, as one context manager:

* ``hold_implementation_identity`` mints the cycle key INSIDE the workspace
  the agent will commit in (``gh_token_factory.mint_signing_key``, which
  wires that checkout's git config so a plain ``git commit`` signs), reads
  the mint's receipt and refuses by name when the identity cannot be held
  there, registers the PUBLIC half in the knowledge-graph signer registry
  (``kg_signers``) before the agent starts, yields the fingerprint, and
  revokes the key — config restored — on every path out of the body.
* ``stamp_implementation_signer`` writes that fingerprint on the result
  envelope. The fingerprint is a kernel fact: a value the agent supplied is
  overwritten, and a differing one is recorded on governance
  (``implementation_signer_fp_overridden``), never trusted.

The refusal is a HARNESS-class release reason
(``IMPLEMENTATION_SIGNING_UNAVAILABLE_RELEASE_REASON``): none of its causes
says anything about the request, so the request goes back to PENDING with
its requeue budget intact, and the governance row of the same name carries
the cause (``ImplementationIdentityRefusal.reason``):

* ``not_a_checkout`` / ``shared_checkout_scope:--local`` — decided from the
  checkout's shape alone (``gh_token_factory.signing_checkout``: the
  ``.git`` marker and its ``commondir``, no git process), BEFORE the mint,
  so the refused path writes nothing: no key file, no config, no snapshot.
  A MAIN checkout's ``--local`` config is the config every worktree of the
  repository shares, so a per-request key installed there would sign the
  operator's and every other lane's commits for the window — and a mint
  that installed it before the refusal had already replaced the operator's
  ``user.signingkey`` in that shared config, with only the revoke's restore
  (UNDECIDED under a loaded host) between every worktree and a key the
  same call had just unlinked. An implementation is served only from a
  linked worktree (``--worktree`` scope); the drain's
  ``worktree_per_request`` is what provides one, and a lane without it is
  refused here rather than signing everybody;
* ``git_unavailable`` / ``worktree_scope_unavailable:<why>``
  / ``git_config_failed:<key>:rc=<n>`` / ``shared_checkout_scope:<scope>`` —
  the mint's own receipt (``gh_token_factory.GitSigningWiring``), read after
  the mint as the backstop for what the shape could not decide (git did not
  answer, the repository cannot carry per-worktree config, a config write
  refused, a scope the receipt reports other than the one the shape
  promised); the mint is unwound by the same revoke the body's exit uses;
* ``identity_already_held`` — the key file already existed, so the mint was
  the factory's idempotent re-mint and wired nothing: another holder (a
  knowledge signer in the same tree, a crashed run's leftover) owns this
  cycle's identity in this workspace, and an implementer that borrowed it
  would lose it to that holder's ``finally``;
* ``mint_failed:<ErrorClass>`` / ``register_failed:<ErrorClass>`` — the
  factory or the registry refused (no ``ssh-keygen`` on PATH, a malformed
  cycle id, a refused ledger write); an unregistrable key is revoked on
  the spot, because a fingerprint no later reader can resolve is not an
  identity;
* ``signing_agent_unavailable:<reason>`` / ``git_containment_refused:<reason>``
  (ARIA-HIGH-123) — the kernel could not hold the ssh-agent that signs for
  the sandbox (``signing_agent``), or the checkout cannot host a
  commit-capable sandbox (``git_containment``: a hooks dir git would not
  name, a git dir it could not prepare); the mint and the registration are
  unwound the same way.

ARIA-HIGH-123 — the key never enters the sandbox. The held identity carries
its SANDBOX shape (``ImplementationIdentity.containment``, a
``git_containment.GitContainment`` with ``SandboxSigning``): the sandbox
masks ``aria-debts/keys/``, shows the public half only, and binds the socket
of the ssh-agent this process holds for the window; git signs through it.
The agent's key lifetime is the window's remaining time (``signing_agent
.lifetime_until`` from ``ARIA_JOB_DEADLINE_EPOCH``), and the agent dies with
this process however it dies. The executor hands the containment to the
spawn and, after the spawn, publishes what the agent committed from the
worktree's quarantine (``git_containment.publish_quarantine``) — the shared
repository is written by the kernel, never by the sandbox.
"""
from __future__ import annotations

import os
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .git_containment import GitContainment, GitContainmentRefusal, SandboxSigning, derive_git_containment
from .release_reason import IMPLEMENTATION_SIGNING_UNAVAILABLE
from .signing_agent import SigningAgentUnavailable, hold_signing_agent, lifetime_until
from .turn_budget import JOB_DEADLINE_EPOCH_ENV, parse_deadline_epoch

# The release reason the executor hands the claim back with: the closed
# vocabulary's own spelling (``release_reason``), classified as a harness
# fault there and in ``agent_invocations.HARNESS_FAULT_RELEASE_REASONS``;
# the governance row of the same name names the cause.
IMPLEMENTATION_SIGNING_UNAVAILABLE_RELEASE_REASON: str = IMPLEMENTATION_SIGNING_UNAVAILABLE
# Recorded when the agent's envelope carried a ``signer_key_fp`` that is not
# the executor's: the value is replaced, and the replacement is on the ledger.
IMPLEMENTATION_SIGNER_FP_OVERRIDDEN_EVENT: str = "implementation_signer_fp_overridden"

# The failure modes ``mint_signing_key`` documents (the knowledge signer's
# list, for the same key): a malformed cycle id (ValueError), ssh-keygen
# absent or failing (RuntimeError), a key file that refuses (OSError) and a
# keygen that never returns (SubprocessError).
_MINT_FAILURE_CLASSES: tuple[type[BaseException], ...] = (
    ValueError, RuntimeError, OSError, subprocess.SubprocessError,
)


class ImplementationIdentityRefusal(Exception):
    """The identity cannot be held in this workspace; ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason

    @property
    def release_reason(self) -> str:
        return IMPLEMENTATION_SIGNING_UNAVAILABLE_RELEASE_REASON


@dataclass(frozen=True)
class ImplementationIdentity:
    """The held identity: its public fingerprint, where it is wired, and
    the sandbox shape that lets a contained spawn commit with it.

    The private key never leaves ``<workspace_root>/aria-debts/keys/`` and is
    not carried here; ``scope`` is the git config scope the mint wrote
    (``--worktree`` — the only scope this seam accepts). ``containment`` is
    the commit-capable git containment derived from the worktree
    (ARIA-HIGH-123): the spawn is wrapped with it, and inside it the keys
    dir is masked, the public key shown, and signing goes through the
    kernel-held agent's socket.
    """

    cycle_id: str
    workspace_root: Path
    fingerprint: str
    scope: str
    containment: GitContainment


def _registration_failure_classes() -> tuple[type[BaseException], ...]:
    """The failure modes ``register_convention_signer`` documents. Lazy, so
    this module stays import-cheap for the executor's cold start."""
    from .knowledge_graph import KnowledgeGraphSchemaError
    from .ledger import LedgerIntegrityError
    from .tool_registry import GovernanceError

    return (OSError, KnowledgeGraphSchemaError, LedgerIntegrityError, GovernanceError)


@contextmanager
def hold_implementation_identity(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path,
) -> Iterator[ImplementationIdentity]:
    """Mint, wire, register and hold the implementer's identity for the body.

    Raises ``ImplementationIdentityRefusal`` BEFORE yielding when the identity
    cannot be held here (see the module docstring for the closed vocabulary
    of reasons). The refusals the checkout's shape decides —
    ``not_a_checkout``, ``shared_checkout_scope:<scope>`` — are raised
    before the mint and write nothing; the ones the mint's receipt or the
    registry decides unwind the mint with the same revoke the body's exit
    uses. Revokes the key — and restores the checkout's signing config from
    the mint's snapshot — when the body exits, however it exits.
    """
    from .gh_token_factory import (
        CONFIG_SCOPE_WORKTREE,
        mint_signing_key,
        revoke_signing_key,
        signing_checkout,
    )
    from .knowledge_graph import register_convention_signer

    workspace = Path(workspace_root).resolve()
    # The scope is a property of the tree, not of the mint: read it from
    # the checkout's shape first, so a workspace whose signing config is
    # the shared ``--local`` one never sees a write. The mint's receipt
    # below re-reads the same shape through the same function and is the
    # backstop for what the shape alone cannot decide.
    checkout = signing_checkout(workspace)
    if checkout is None:
        raise ImplementationIdentityRefusal("not_a_checkout")
    if checkout.config_scope != CONFIG_SCOPE_WORKTREE:
        raise ImplementationIdentityRefusal(f"shared_checkout_scope:{checkout.config_scope}")
    try:
        key = mint_signing_key(cycle_id=cycle_id, workspace_root=workspace)
    except _MINT_FAILURE_CLASSES as exc:
        raise ImplementationIdentityRefusal(f"mint_failed:{type(exc).__name__}") from exc

    wiring = key.git_signing
    refusal: str | None = None
    if wiring is None:
        refusal = "identity_already_held"
    elif not wiring.configured:
        refusal = str(wiring.reason)
    elif wiring.scope != CONFIG_SCOPE_WORKTREE:
        refusal = f"shared_checkout_scope:{wiring.scope}"
    if refusal is not None:
        if wiring is not None:
            # This mint created the files (and possibly the config): unwind
            # them. An idempotent re-mint created nothing of ours to unwind.
            revoke_signing_key(cycle_id=cycle_id, workspace_root=workspace)
        raise ImplementationIdentityRefusal(refusal)

    try:
        # ARIA-HIGH-123 — the sandbox shape is decided BEFORE the registry
        # write, so a refusal here (no ssh-agent, a hooks dir git would not
        # name) leaves no `kg_signers` row for a key that never signed: the
        # registry is append-only. The agent that signs for the sandbox is
        # held by THIS process for the window; the sandbox gets its socket
        # and the public key, never the private file. It is stopped
        # (SIGTERM) on every exit, before the revoke unlinks the key.
        with hold_signing_agent(
            key.private_key_path, expected_fingerprint=key.fingerprint,
            # The key lives in the agent no longer than the job: past the
            # deadline the executor is killed, and an agent that outlived
            # the kill must hold nothing.
            lifetime_seconds=lifetime_until(parse_deadline_epoch(os.environ.get(JOB_DEADLINE_EPOCH_ENV))),
        ) as agent:
            containment = derive_git_containment(
                workspace, commit_capable=True,
                signing=SandboxSigning(
                    keys_dir=key.private_key_path.parent, public_key_path=key.public_key_path,
                    agent_socket=agent.socket_path,
                ),
            )
            assert containment is not None
            try:
                # The public key goes on the ledger BEFORE the agent runs:
                # the fingerprint the executor stamps on the result is one
                # the bridge can resolve to a real key after the worktree
                # and its files are gone. Registration is idempotent for the
                # same key.
                register_convention_signer(
                    cycle_id=cycle_id, signer_key_fp=key.fingerprint,
                    public_key=key.public_key_path.read_text(encoding="utf-8"),
                    base_dir=base_dir,
                )
            except _registration_failure_classes() as exc:
                raise ImplementationIdentityRefusal(f"register_failed:{type(exc).__name__}") from exc
            yield ImplementationIdentity(
                cycle_id=cycle_id, workspace_root=workspace,
                fingerprint=key.fingerprint, scope=str(wiring.scope), containment=containment,
            )
    except SigningAgentUnavailable as exc:
        raise ImplementationIdentityRefusal(f"signing_agent_unavailable:{exc.reason}") from exc
    except GitContainmentRefusal as exc:
        raise ImplementationIdentityRefusal(f"git_containment_refused:{exc.reason}") from exc
    finally:
        # The key cannot outlive the request: the same `finally` discipline
        # the knowledge signer keeps for the same key (V3.1-B-7). The
        # revoke is idempotent and reports an OS-level refusal in its
        # return value rather than raising past the executor's own exits.
        revoke_signing_key(cycle_id=cycle_id, workspace_root=workspace)


def implementation_record(details: dict[str, Any]) -> dict[str, Any]:
    """The implementation outcome record inside a result envelope's details.

    ONE reading, shared by the executor's stamp and the bridge's dispatch:
    ``details.implementation`` when the agent nested the record (the
    contract's shape), else ``details`` itself (the legacy flat shape). A
    stamp that wrote where the bridge does not read — or the reverse — is
    the two-definitions defect this function exists to make impossible.
    ``details`` is the envelope's details object, which both callers hold
    as a dict already (the bridge normalises a non-object to ``{}`` before
    dispatch; the stamp installs one), so the reading always resolves.
    """
    nested = details.get("implementation")
    if isinstance(nested, dict):
        return nested
    return details


def stamp_implementation_signer(
    envelope: dict[str, Any],
    *,
    fingerprint: str,
    request_id: str,
    claim_id: str,
    base_dir: str | Path,
) -> bool:
    """Write the executor-held fingerprint on the envelope's outcome record.

    Returns True when the envelope changed. The fingerprint lands on the
    record ``implementation_record`` reads — the same reading the bridge
    dispatches on — so a flat legacy envelope is stamped flat and the
    contract's nested one is stamped nested. A value the agent supplied that
    differs from the executor's is replaced and recorded on governance
    (``implementation_signer_fp_overridden``) with both values — the agent's
    claim is data about the agent, never the identity of the commit.
    """
    from .tool_registry import append_tools_governance

    details = envelope.get("details")
    if not isinstance(details, dict):
        details = {}
        envelope["details"] = details
    record = implementation_record(details)
    supplied = record.get("signer_key_fp")
    if supplied == fingerprint:
        return False
    if supplied not in (None, ""):
        append_tools_governance(
            base_dir, IMPLEMENTATION_SIGNER_FP_OVERRIDDEN_EVENT,
            {
                "request_id": request_id,
                "claim_id": claim_id,
                "agent_supplied": str(supplied)[:200],
                "signer_key_fp": fingerprint,
            },
        )
    record["signer_key_fp"] = fingerprint
    return True


__all__ = [
    "IMPLEMENTATION_SIGNER_FP_OVERRIDDEN_EVENT",
    "IMPLEMENTATION_SIGNING_UNAVAILABLE_RELEASE_REASON",
    "ImplementationIdentity",
    "ImplementationIdentityRefusal",
    "hold_implementation_identity",
    "implementation_record",
    "stamp_implementation_signer",
]
