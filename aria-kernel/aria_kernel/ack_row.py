"""Plan ARIA-V3 §A5 + §2h + AUDITTRAIL-CRITICAL-002 — ack-ledger row schema.

Every operator-mint OR autonomous-profile-mint produces an
``AckLedgerRow`` with 17 mandatory fields. The schema is locked by
I-V3-19a (set-equality on field names) and I-V3-19b
(``actor_kind`` discriminates operator vs autonomous).

Field semantics:

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
  ``reason`` — operator-supplied --reason text (or auto-reason code).
  ``auto_reason_code`` — enum value for autonomous mints
    (``classifier_pass``, etc.); ``None`` for operator.
  ``signature`` — HMAC-SHA256 of the canonical row content.
  ``signed_key_id`` — UUID of the HMAC key version used; resolved
    against the rolling key list at verify time.
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
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

# Plan ARIA-V3 §2h — 17 mandatory field names. Locked by I-V3-19a.
ACK_ROW_REQUIRED_FIELDS: frozenset[str] = frozenset({
    "ack_id",
    "event_time",
    "actor_kind",
    "actor_user_id",
    "profile_name",
    "lane",
    "classifier_decision_hash",
    "draft_id",
    "intent_id",
    "target_path",
    "kind",
    "reason",
    "auto_reason_code",
    "signature",
    "signed_key_id",
    "consumed_at",
    "consumed_by_event_id",
    "breaker_state_at_mint",
    "profile_state_at_mint",
    "commit_sha_at_mint",
    "parent_observation_id",
})


ACK_ACTOR_KINDS: frozenset[str] = frozenset({
    "operator",
    "autonomous_profile",
})


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
    signature: str
    signed_key_id: str
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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


__all__ = [
    "AckLedgerRow",
    "ACK_ROW_REQUIRED_FIELDS",
    "ACK_ACTOR_KINDS",
]
