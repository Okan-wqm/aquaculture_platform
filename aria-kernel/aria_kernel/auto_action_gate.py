"""Plan ARIA-V3 §A4 + §2a — single ``AutoActionGate`` SSoT.

GAP-1 closure (Tier-1: Make impossible). Pre-V3:
  * ``materialize_agent_draft`` / ``materialize_skill`` hard-coded
    ``if not acknowledge: raise GovernanceError``. The
    ``genesis_policy.materialization_requires_acknowledge`` flag
    existed but the gate code ignored it (dead config).
  * Auto-merge had its OWN gate logic inside
    ``auto_merge.evaluate_auto_merge`` — two independent
    classifiers with no shared SSoT. Materialise could pass while
    merge failed for the same diff (and vice versa).

V3 collapses both into ``AutoActionGate`` (CRIT-V3-003 + GAP-1
+ MED-V3-010 single consolidation):

  * One ``AutoActionGate.from_policy(policy, profile, lane,
    classifier_decision)`` produces ONE decision object consumed
    by both ``materialize_*`` (via ``Gate.consume_ack_token``)
    and ``merge_if_green`` (via ``Gate.permit_merge``).
  * Acknowledge tokens are produced by ``ack_ledger.mint_*``
    (Phase A5) — the gate never mints them itself; it only
    verifies + consumes.
  * The ``materialize_event_id`` UUID is generated AT GATE entry
    so the three-event chain (draft_validated → ack_consumed →
    materialize_committed) shares a single linkage key
    (AUDITTRAIL-CRITICAL-003 closure).

Gate decision shape:

  * ``human_ack_required: bool`` — derived from policy flag +
    profile. Current mainline authority keeps this ``True`` for every
    live lane; historical snowball lanes cannot auto-mint ack tokens.
  * ``consume_ack_token(token_id)`` — verifies HMAC + one-time
    consumption against ``ack_ledger``. Auto-ack tokens are
    minted by ``ack_ledger.mint_auto_ack`` from this module's
    own ``acquire_token`` path when the profile permits.
  * ``materialize_event_id`` — chain linkage key persisted in
    every audit row.

Plan-026R discipline: invariant tests I-V3-14..17d lock the
contract (gate honours policy flag; rejects unsigned tokens;
acknowledge parameter removed from materialize public API;
single Gate consumed by materialize + merge; 3-event chain
linked by id; 25+ test callsite migration complete).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError


_AUTONOMOUS_PROFILE: str = "autonomous"
AUTONOMOUS_AUTO_ACK_LANES: frozenset[str] = frozenset()


@dataclass(frozen=True)
class ClassifierDecision:
    """Plan ARIA-V3 §A4 — classifier output consumed by the gate."""

    passed: bool
    rejected_paths: tuple[str, ...] = field(default_factory=tuple)
    decision_hash: str = ""


@dataclass(frozen=True)
class AutoActionGate:
    """Plan ARIA-V3 §2a — single source-of-truth gate.

    Consumed by BOTH ``materialize_*`` and ``merge_if_green`` so
    a future change to the gate logic propagates atomically. The
    Gate is immutable; ``from_policy`` is the only constructor.
    """

    materialize_event_id: str
    profile: str
    lane: str | None
    classifier: ClassifierDecision
    policy_requires_acknowledge: bool
    breaker_state: str
    cost_state: str

    @property
    def human_ack_required(self) -> bool:
        """Return True when an operator-minted ack token is required.

        The live SSOT currently has no autonomous auto-ack lane. Keeping the
        allowlist empty prevents stale snowball classifications from enabling
        materialization without an explicit operator ack.
        """
        if self.profile != _AUTONOMOUS_PROFILE:
            return True
        if self.lane not in AUTONOMOUS_AUTO_ACK_LANES:
            return True
        if not self.classifier.passed:
            return True
        if self.breaker_state != "ok":
            return True
        if self.cost_state != "ok":
            return True
        # Reserved for a future live lane contract. The empty
        # AUTONOMOUS_AUTO_ACK_LANES set makes this branch unreachable today.
        return bool(self.policy_requires_acknowledge)

    def consume_ack_token(
        self,
        *,
        ack_id: str,
        base_dir: str | Path,
    ) -> dict[str, Any]:
        """Plan ARIA-V3 §A4 — verify + consume an ack token.

        Routes through ``ack_ledger.consume_token`` (Phase A5)
        which is one-time-use (I-V3-19) + HMAC-verified
        (I-V3-19a..f). The materialize_event_id is the linkage
        key for the three-event chain.
        """
        from .ack_ledger import consume_token

        return consume_token(
            base_dir=base_dir,
            ack_id=ack_id,
            materialize_event_id=self.materialize_event_id,
        )

    def acquire_or_consume(
        self,
        *,
        ack_id: str | None,
        base_dir: str | Path,
        draft_id: str,
        intent_id: str,
        target_path: str,
        kind: str,
        commit_sha_at_mint: str,
        profile_state_at_mint: str,
    ) -> dict[str, Any]:
        """Plan ARIA-V3 §A4 + §B2 — unified token-resolution path.

        When ``human_ack_required`` is True: caller MUST pass
        ``ack_id``; we verify + consume.

        When ``human_ack_required`` is False, a future live lane contract may
        auto-mint a fresh token via ``ack_ledger.mint_auto_ack`` and consume it.
        No current lane reaches that branch.
        The same materialize_event_id links the mint + consumption
        events through the audit chain.
        """
        from .ack_ledger import consume_token, mint_auto_ack

        if self.human_ack_required:
            if not ack_id:
                raise GovernanceError(
                    "materialize_requires_operator_ack_token: profile "
                    f"{self.profile!r} + lane {self.lane!r} + "
                    f"classifier_passed={self.classifier.passed} requires "
                    f"an operator-minted ack token (run `aria-kernel ack mint`)"
                )
            return consume_token(
                base_dir=base_dir,
                ack_id=ack_id,
                materialize_event_id=self.materialize_event_id,
            )
        # Autonomous auto-mint path.
        auto_row = mint_auto_ack(
            base_dir=base_dir,
            draft_id=draft_id,
            intent_id=intent_id,
            target_path=target_path,
            kind=kind,
            profile_name=self.profile,
            lane=self.lane or "",
            classifier_decision_hash=self.classifier.decision_hash,
            auto_reason_code="classifier_pass",
            profile_state_at_mint=profile_state_at_mint,
            commit_sha_at_mint=commit_sha_at_mint,
            breaker_state_at_mint=self.breaker_state,
        )
        return consume_token(
            base_dir=base_dir,
            ack_id=auto_row.ack_id,
            materialize_event_id=self.materialize_event_id,
        )


def _load_policy_flag(base_dir: str | Path) -> bool:
    """Read ``materialization_requires_acknowledge`` from genesis_policy.

    Default ``True`` (operator-ack required) when policy file
    absent or flag missing. Plan ARIA-V3 §A4 makes this flag
    LOAD-BEARING (GAP-1 closure — pre-V3 the flag was ignored).
    """
    from .genesis_policy import load_policy

    policy = load_policy(Path(base_dir))
    flag = policy.get("materialization_requires_acknowledge", True)
    return bool(flag)


def _load_breaker_state(base_dir: str | Path) -> str:
    """Plan ARIA-V3 §B2 stub — ``ok`` until Phase B2's circuit
    breaker module lands. Returns ``ok`` when the breaker file
    is absent (no failures recorded).
    """
    try:
        from .circuit_breaker import current_state
    except ImportError:
        return "ok"
    try:
        return current_state(base_dir=base_dir)
    except Exception:  # noqa: BLE001 — fail-closed-but-permissive
        return "ok"


def _load_cost_state(base_dir: str | Path) -> str:
    """Plan ARIA-V3 §B0 stub — ``ok`` until cost_budget module lands."""
    try:
        from .cost_budget import current_state
    except ImportError:
        return "ok"
    try:
        return current_state(base_dir=base_dir)
    except Exception:  # noqa: BLE001
        return "ok"


def gate_from_policy(
    *,
    base_dir: str | Path,
    profile: str,
    lane: str | None,
    classifier: ClassifierDecision | None = None,
) -> AutoActionGate:
    """Plan ARIA-V3 §A4 — primary factory.

    The gate's ``materialize_event_id`` is minted here so the
    same UUID links every event in the three-event chain
    (draft_validated → ack_consumed → materialize_committed).
    """
    if classifier is None:
        classifier = ClassifierDecision(passed=False)
    return AutoActionGate(
        materialize_event_id=str(uuid.uuid4()),
        profile=profile,
        lane=lane,
        classifier=classifier,
        policy_requires_acknowledge=_load_policy_flag(base_dir),
        breaker_state=_load_breaker_state(base_dir),
        cost_state=_load_cost_state(base_dir),
    )


def gate_from_test_fixture(
    *,
    profile: str = "standard",
    lane: str | None = None,
    classifier_passed: bool = True,
    policy_requires_acknowledge: bool = True,
    breaker_state: str = "ok",
    cost_state: str = "ok",
    materialize_event_id: str | None = None,
) -> AutoActionGate:
    """Plan ARIA-V3 §2l test-fixture factory.

    Existing tests (test_v13_contracts, test_materialize_agent_draft_gate,
    test_skill_genesis_chain, test_phase1_e2e_invariants, etc.)
    use this helper to construct an AutoActionGate for the 25+
    callsite migration that Phase A4 lands.
    """
    return AutoActionGate(
        materialize_event_id=materialize_event_id or str(uuid.uuid4()),
        profile=profile,
        lane=lane,
        classifier=ClassifierDecision(
            passed=classifier_passed,
            decision_hash=hashlib.sha256(
                f"test_fixture:{classifier_passed}".encode("utf-8")
            ).hexdigest()[:16],
        ),
        policy_requires_acknowledge=policy_requires_acknowledge,
        breaker_state=breaker_state,
        cost_state=cost_state,
    )


__all__ = [
    "AutoActionGate",
    "ClassifierDecision",
    "gate_from_policy",
    "gate_from_test_fixture",
]
