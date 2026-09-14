"""B7 — the cycle knowledge signer: who signs what a CONVERGED cycle learned.

WHY this module exists
----------------------
`knowledge-graph/conventions.jsonl` had never been created on the live
store. Two things had to hold for a row to land and neither ever did
together: a plan had to reach CONVERGED, and the memory hook had to be
handed a signer. The orchestrator handed it ``signer_key_fp=None`` and
disclosed ``convention_record_needs_signing``, trusting a LATER owner to
complete the row — and the only later owner was the implementing V9
runner, which mints the cycle's ephemeral key and is selected by
``pr_create`` (strict / autonomous). Every live run was ``standard``.
Knowledge-write authority had been coupled to PR-open authority, and the
coupling was invisible: no gate refused anything, the disclosure row was
appended once per plan revision, and the ledger simply never appeared.

WHAT this module does
---------------------
It gives the post-CONVERGED seam its own signer, DERIVED from the
``knowledge_record`` cell of ``runtime_profile.ACTION_PERMISSIONS`` — the
same derive-don't-enumerate discipline ``select_v9_implementation_runner``
follows for ``pr_create``. Granting a profile the cell enrols it here on
the same edit; revoking it demotes the seam to "no signer" on the same
edit. There is no second copy of the profile → authority mapping.

The key itself is the per-cycle ed25519 identity the factory mints
(``gh_token_factory.mint_signing_key``), under its lifecycle discipline:
minted for ``cycle_id`` inside the workspace's ``aria-debts/keys/`` and
revoked in ``finally`` so it cannot outlive the phase on any path Python
unwinds. A process killed outright leaves the files behind;
``run_autonomy_orchestrator`` runs ``gh_token_factory.prune_stale_signing_keys``
at startup, next to the orphan-implementation reaper, for exactly that
case. This key signs the convention row and nothing else: the V9 runner
mints no identity (ARIA-HIGH-115 — the bracket it held was revoked before
the implementer was even claimed), and the implementer's commits are
signed by a second key the executor child mints in the request worktree
(``implementation_identity``), registered separately under the same cycle
id. One cycle therefore carries two fingerprints, each on the ledger
where its rows are read.

The PUBLIC half of the key is registered in the knowledge-graph signer
registry (``knowledge_graph.register_convention_signer`` →
``knowledge-graph/signers.jsonl``) before the fingerprint is handed to
anyone. The private key is revoked when the cycle ends and its ``.pub``
file goes with it, so without the registry the fingerprint on a
convention row named a key nobody could ever look at again;
``knowledge_graph.verify_convention_signer`` re-derives the fingerprint
from the registered key for any later reader. A fingerprint whose key
could not be registered is not yielded at all — the key is revoked on
the spot and the cycle proceeds signer-less.

A mint that fails (no ``ssh-keygen`` on PATH, a malformed cycle id, a
keygen timeout), or a registration that fails (a refused ledger write),
is not hidden and not fatal: the seam records a
``knowledge_signer_mint_failed`` governance row naming the stage and the
error class and yields no fingerprint, and the memory hook then takes
its existing ``needs_signing`` disclosure path — the durable retry
source that ``complete_pending_observations`` replays under a later
signer. That disclosure means exactly what it says under this seam: the
cycle had no signer.
"""
from __future__ import annotations

import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Literal

# The action authority that DECIDES whether the post-CONVERGED seam mints a
# signer. Its own cell, not `pr_create`, because writing what the cycle
# learned is a store mutation in the `change_committed` class and has
# nothing to do with GitHub — coupling the two was the defect.
KNOWLEDGE_RECORD_ACTION_KIND: str = "knowledge_record"

KnowledgeSignerStatus = Literal["minted", "not_permitted", "mint_failed"]

# The failure modes `mint_signing_key` documents, and nothing wider: a
# malformed cycle id (ValueError), ssh-keygen absent or failing
# (RuntimeError), an existing key that refuses overwrite (FileExistsError
# is an OSError) and a keygen that never returns (TimeoutExpired is a
# SubprocessError). Anything else is a defect in this seam and propagates
# out of `run_autonomy_orchestrator` to its caller: the post-CONVERGED
# region has no catch-all, and an unexpected fault in `convergence_runner`
# or `specialist_review_runner` leaves the same way.
_MINT_FAILURE_CLASSES: tuple[type[BaseException], ...] = (
    ValueError, RuntimeError, OSError, subprocess.SubprocessError,
)


def _registration_failure_classes() -> tuple[type[BaseException], ...]:
    """The failure modes `register_convention_signer` documents.

    A public key file that cannot be read (OSError), a key line the
    registry refuses or a fingerprint that is not the key's own
    (KnowledgeGraphSchemaError, which the conflict subclass shares), a
    ledger that refuses the append (LedgerIntegrityError) and a profile
    gate that refuses the write (GovernanceError). Lazy for the same
    cold-start reason as every other import in this module.
    """
    from ..knowledge_graph import KnowledgeGraphSchemaError
    from ..ledger import LedgerIntegrityError
    from ..tool_registry import GovernanceError

    return (OSError, KnowledgeGraphSchemaError, LedgerIntegrityError, GovernanceError)


@dataclass(frozen=True)
class KnowledgeSigner:
    """What the seam knows about this cycle's knowledge signer.

    ``fingerprint`` is the public ``SHA256:<base64>`` value the memory hook
    stamps on the convention row as ``signer_key_fp``; it is None exactly
    when the row must be disclosed as ``needs_signing`` instead. The
    private key never leaves ``aria-debts/keys/`` and is not carried here.
    """

    cycle_id: str
    status: KnowledgeSignerStatus
    fingerprint: str | None
    error_class: str | None = None

    def receipt(self) -> dict[str, Any]:
        """The public, summary-safe projection of this signer."""
        return {
            "status": self.status,
            "signer_cycle_id": self.cycle_id if self.fingerprint is not None else None,
            "signer_key_fp": self.fingerprint,
            "error_class": self.error_class,
        }


def knowledge_record_permitted(*, profile: str) -> bool:
    """Whether ``profile`` holds ``knowledge_record`` — read from the table.

    Lazy import: ``cycle_phases`` submodules keep a bare top-level import
    surface so ``autonomy_orchestrator``'s cold start stays hermetic
    (I-V31-0-01 / I-V31-0-05).
    """
    from ..runtime_profile import ACTION_PERMISSIONS

    return profile in ACTION_PERMISSIONS[KNOWLEDGE_RECORD_ACTION_KIND]


@contextmanager
def cycle_knowledge_signer(
    *,
    profile: str,
    cycle_id: str,
    workspace_root: Path,
    base_dir: Path,
) -> Iterator[KnowledgeSigner]:
    """Hold the cycle's signing identity for the post-CONVERGED phases.

    Yields a ``KnowledgeSigner``. Under a profile without
    ``knowledge_record`` nothing is minted and the status says so. Under a
    permitted profile the key is minted before the body runs and revoked
    after it, whatever the body did — the ``try/finally`` shape every
    holder of a cycle key keeps (V3.1-B-7; the executor's
    ``implementation_identity`` holds the implementer's the same way).
    """
    if not knowledge_record_permitted(profile=profile):
        yield KnowledgeSigner(cycle_id=cycle_id, status="not_permitted", fingerprint=None)
        return

    from ..gh_token_factory import mint_signing_key, revoke_signing_key
    from ..knowledge_graph import register_convention_signer
    from ..tool_registry import append_tools_governance

    def _failed(stage: str, exc: BaseException) -> KnowledgeSigner:
        # Visible in the audit trail, not fatal to the cycle: the memory
        # hook discloses `needs_signing` and a later signer replays it.
        append_tools_governance(
            base_dir, "knowledge_signer_mint_failed",
            {
                "cycle_id": cycle_id,
                "profile": profile,
                "stage": stage,
                "error_class": type(exc).__name__,
                "error_message": str(exc)[:500],
            },
        )
        return KnowledgeSigner(
            cycle_id=cycle_id, status="mint_failed", fingerprint=None,
            error_class=type(exc).__name__,
        )

    try:
        key = mint_signing_key(cycle_id=cycle_id, workspace_root=workspace_root)
    except _MINT_FAILURE_CLASSES as exc:
        yield _failed("mint_key", exc)
        return

    try:
        # The public key goes on the ledger BEFORE the fingerprint goes
        # anywhere: a fingerprint the memory hook stamps on a row is one a
        # later reader can resolve to a real key after the cycle's files
        # are gone. Registration is idempotent for the same key.
        register_convention_signer(
            cycle_id=cycle_id, signer_key_fp=key.fingerprint,
            public_key=key.public_key_path.read_text(encoding="utf-8"),
            base_dir=base_dir,
        )
    except _registration_failure_classes() as exc:
        # An unregistrable key is not a knowledge signer. Revoke it now so
        # the cycle proceeds signer-less rather than with a fingerprint
        # nobody could verify.
        revoke_signing_key(cycle_id=cycle_id, workspace_root=workspace_root)
        yield _failed("register_public_key", exc)
        return

    try:
        yield KnowledgeSigner(cycle_id=cycle_id, status="minted", fingerprint=key.fingerprint)
    finally:
        # Per-cycle keypair cannot outlive the phase. `revoke_signing_key`
        # is idempotent and never raises on an absent file; an OS-level
        # refusal is reported in its return value (V3.1-P-6).
        revoke_signing_key(cycle_id=cycle_id, workspace_root=workspace_root)


__all__ = [
    "KNOWLEDGE_RECORD_ACTION_KIND",
    "KnowledgeSigner",
    "KnowledgeSignerStatus",
    "cycle_knowledge_signer",
    "knowledge_record_permitted",
]
