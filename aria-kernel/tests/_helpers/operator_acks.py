"""Operator-signed ack mints for tests (ARIA-MEDIUM-254) — never the operator's key.

An operator ack is the operator's own signed act, verified against the
allowed-signers file committed on main. :class:`OperatorAckSigner` is an
``OperatorRequestFixture`` checkout (on main, a throwaway ed25519 key enrolled
for the operator namespaces) that a test passes as the mint's and the
materializer's ``workspace_root``; :meth:`OperatorAckSigner.mint` goes through
the production minter (``ack_ledger.mint_operator_ack``), reviewing the draft
as it stands unless the test names the reviewed digest.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aria_kernel.ack_ledger import mint_operator_ack, review_draft
from aria_kernel.ack_row import AckLedgerRow
from tests._helpers.operator_requests import OperatorRequestFixture


class OperatorAckSigner:
    """A checkout on main whose committed allowed-signers file enrols this signer's throwaway key."""

    def __init__(self, root: Path) -> None:
        self.fixture = OperatorRequestFixture(root)
        self.repo = self.fixture.repo
        self.key = self.fixture.key
        self.principal = self.fixture.principal
        self.subjects = self.fixture.subjects

    def mint(
        self, *, base_dir: str | Path, draft_id: str, kind: str = "agent",
        reviewed_body_sha256: str | None = None, **overrides: Any,
    ) -> AckLedgerRow:
        """Mint as the operator does: review the draft as it stands, then sign an ack for that body."""
        if reviewed_body_sha256 is None:
            reviewed_body_sha256 = review_draft(base_dir=base_dir, draft_id=draft_id, kind=kind)["scope"]["body_sha256"]
        arguments: dict[str, Any] = {
            "base_dir": base_dir, "draft_id": draft_id, "kind": kind, "reason": "operator ack fixture mint",
            "operator_user_id": "tester", "profile_name": "standard", "profile_state_at_mint": "standard:v1",
            "commit_sha_at_mint": "0" * 40, "reviewed_body_sha256": reviewed_body_sha256,
            "signing_key": self.key, "signer_principal": self.principal, "actor_class": "T0",
            "workspace_root": self.repo, "subject_stream": self.subjects,
        }
        arguments.update(overrides)
        return mint_operator_ack(**arguments)
