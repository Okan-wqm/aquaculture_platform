"""Plan ARIA-V3 §A5 + §2h + AUDITTRAIL-CRITICAL-002 — ack-ledger row schema.

Every operator-mint OR autonomous-profile-mint produces an
``AckLedgerRow``; every field of that dataclass is mandatory on a minted
row. I-V3-19a locks a minted row's key set to exactly
``ACK_ROW_REQUIRED_FIELDS`` plus the ledger hash-chain envelope, and
I-V3-19b locks ``actor_kind`` as the operator vs autonomous discriminator.

Field semantics:

  ``schema_version`` — row format version; every mint writes
    :data:`ACK_ROW_SCHEMA_VERSION` (``2`` since ARIA-MEDIUM-254; rows minted
    before it carry ``1`` and no operator terms).
  ``row_kind`` — :data:`OPERATOR_ACK_ROW_KIND` on an operator mint (the
    signed subject's kind inside the ``aria-operator-request`` namespace);
    ``None`` for autonomous.
  ``ack_id`` — UUID4 minted at ack creation; primary key.
  ``event_time`` — ISO-8601 UTC at mint.
  ``actor_kind`` — ``"operator"`` (CLI mint with explicit reason) or
    ``"autonomous_profile"`` (reserved auto-mint primitive; no live lane
    derives this path today).
  ``actor_user_id`` — operator user ID (or ``None`` for autonomous).
  ``profile_name`` — runtime profile at mint time (always present;
    for operator mints this is "standard"/"strict" usually).
  ``lane`` — kernel-derived lane decision string (``L0-main`` / ``None``).
  ``classifier_decision_hash`` — SHA256 of the L3 classifier decision
    inputs (autonomous mints only); ``None`` for operator mints.
  ``draft_id`` — target genesis draft id.
  ``intent_id`` — kernel-emitted intent id (Plan ARIA-V3 §A3).
  ``target_path`` — repo-relative path the materialize will write.
  ``kind`` — ``"agent"`` or ``"skill"``.
  ``body_sha256`` — bare hex sha256 of the draft ``body`` the ack
    authorizes (the value ``draft_validated`` records). Together with
    ``draft_id``, ``intent_id``, ``target_path`` and ``kind`` it is the
    ack's :class:`AckScope`: derived from the draft at mint, compared field
    by field at consumption (ARIA-MEDIUM-254 slice A).
  ``reason`` — operator-supplied --reason text (or auto-reason code).
  ``auto_reason_code`` — enum value for autonomous mints
    (``classifier_pass``, etc.); ``None`` for operator.
  ``signature`` — operator mint: the operator's armored SSH signature
    (ARIA-MEDIUM-254), verified with ``ssh-keygen -Y verify`` against the
    allowed-signers file committed on main; autonomous mint: HMAC-SHA256 of
    the canonical row content.
  ``signed_key_id`` — autonomous mint: UUID of the HMAC key version used,
    resolved against the rolling key list at verify time; ``None`` on an
    operator mint (no kernel-held key signs it).
  ``actor_class`` / ``audience`` / ``expires_at`` / ``signer_principal`` —
    the operator-act terms every operator subject signs (ADR-0023): who
    signs, as T0 or T1, for which repository, until when. ``None`` for
    autonomous.
  ``consumed_at`` — legacy compatibility field. New consumes do not
    mutate the mint row; they append ``aria/ack-consumption/v1`` rows.
  ``consumed_by_event_id`` — legacy compatibility field paired with
    ``consumed_at`` on pre-append-only ledgers.
  ``breaker_state_at_mint`` — ``"ok"`` / ``"tripped"`` snapshot.
  ``profile_state_at_mint`` — full profile state hash.
  ``commit_sha_at_mint`` — workspace HEAD SHA at mint.
  ``parent_observation_id`` — pressure/observation that triggered
    the draft (forward link in the audit chain).

I-V3-19 (one-time consumption) is enforced by the ack_ledger
append-only reducer: ``consume_token`` rejects if either a legacy
``consumed_at`` value or a newer ``event=consumed`` transition exists.
It also refuses a row whose scope differs from the materialization's, a
row minted before scope binding (no ``body_sha256``), and any row that is
not an operator's: an autonomous row is minted and consumed in one
transaction (``record_autonomous_ack``) and is never consumable by id.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import asdict, dataclass, fields
from typing import Any


ACK_ACTOR_KINDS: frozenset[str] = frozenset({
    "operator",
    "autonomous_profile",
})
# ARIA-MEDIUM-254 — an operator ack is the operator's own signed act: a
# subject of this kind inside the ``aria-operator-request`` namespace, as an
# MCP write approval is (``mcp_server.MCP_WRITE_ROW_KIND``). The kind is
# inside the signed bytes, so an ack never verifies as a plan request or a
# write approval and neither verifies as an ack.
OPERATOR_ACK_ROW_KIND = "operator_ack"
ACK_ROW_SCHEMA_VERSION = 2


@dataclass(frozen=True)
class AckLedgerRow:
    """Plan ARIA-V3 §A5 — immutable ack-ledger row.

    Fields whose value is operator-vs-autonomous-conditional are
    typed as ``str | None``; the actor_kind discriminator
    determines which subset is required.
    """

    ack_id: str
    event_time: str
    actor_kind: str  # one of ACK_ACTOR_KINDS
    profile_name: str
    lane: str | None
    draft_id: str
    intent_id: str
    target_path: str
    kind: str  # "agent" | "skill"
    body_sha256: str
    signature: str
    signed_key_id: str | None  # None on an operator mint (ARIA-MEDIUM-254)
    breaker_state_at_mint: str
    profile_state_at_mint: str
    commit_sha_at_mint: str
    schema_version: int = 1
    # Operator-conditional fields
    actor_user_id: str | None = None
    reason: str | None = None
    # Autonomous-conditional fields
    classifier_decision_hash: str | None = None
    auto_reason_code: str | None = None
    # Legacy lifecycle fields (new consumption appends a transition row)
    consumed_at: str | None = None
    consumed_by_event_id: str | None = None
    # Audit chain link
    parent_observation_id: str | None = None
    # ARIA-MEDIUM-254 — the operator-act terms of an operator mint; None for
    # autonomous. ``signer_principal`` is stamped by the signer.
    row_kind: str | None = None
    actor_class: str | None = None
    audience: str | None = None
    expires_at: str | None = None
    signer_principal: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Plan ARIA-V3 §2h — the mandatory field names, derived from the dataclass
# so the row schema has one owner: a hand-kept copy drifted (it said 17,
# held 21, and missed the ``schema_version`` every mint writes). I-V3-19a
# pins SET-EQUALITY between this set and every minted row minus the ledger
# chain envelope.
ACK_ROW_REQUIRED_FIELDS: frozenset[str] = frozenset(
    f.name for f in fields(AckLedgerRow)
)


@dataclass(frozen=True)
class AckScope:
    """ARIA-MEDIUM-254 slice A / ARIA-MEDIUM-512 — what one ack authorizes.

    One body (by digest) of one draft, under its intent, written to one
    target path, for one materializer kind. Mint derives it from the draft
    (``mint_operator_ack``) and materialize derives it from the draft row it
    writes, through the same per-kind function
    (``agent_genesis.ack_scope_for_draft`` / ``skill_genesis.ack_scope_for_draft``),
    so the two cannot name different subjects; consumption refuses the first
    field the minted row binds differently.
    """

    draft_id: str
    intent_id: str
    target_path: str
    kind: str  # "agent" | "skill"
    body_sha256: str

    @classmethod
    def of_draft(cls, draft: Mapping[str, Any], *, kind: str, body: str) -> AckScope:
        """The scope of ``draft`` whose validated drafter ``body`` the caller passes."""
        intent = draft.get("intent")
        return cls(
            draft_id=str(draft["draft_id"]),
            intent_id=str(intent.get("intent_id", "")) if isinstance(intent, dict) else "",
            target_path=str(draft.get("target_path") or ""),
            kind=kind,
            body_sha256=hashlib.sha256(body.encode("utf-8")).hexdigest(),
        )

    def mismatched_field(self, row: Mapping[str, Any]) -> str | None:
        """The first scope field ``row`` binds to another value, or None when it binds this scope."""
        return next((name for name in ACK_SCOPE_FIELDS if row.get(name) != getattr(self, name)), None)


# The scope's field names, derived from the dataclass: every one is also a
# mint-row field (``AckLedgerRow``), so a scope field the row cannot carry is
# a test failure, not a silent skip (I-V3-19a).
ACK_SCOPE_FIELDS: tuple[str, ...] = tuple(f.name for f in fields(AckScope))


__all__ = [
    "ACK_ROW_SCHEMA_VERSION",
    "OPERATOR_ACK_ROW_KIND",
    "AckLedgerRow",
    "AckScope",
    "ACK_ROW_REQUIRED_FIELDS",
    "ACK_SCOPE_FIELDS",
    "ACK_ACTOR_KINDS",
]
