"""Plan ARIA-V3 §A4 + §2a — single ``AutoActionGate`` SSoT for materialization.

GAP-1 closure (Tier-1: Make impossible). Pre-V3,
``materialize_agent_draft`` / ``materialize_skill`` hard-coded
``if not acknowledge: raise GovernanceError``. The
``genesis_policy.materialization_requires_acknowledge`` flag existed
but the gate code ignored it (dead config).

V3 collapses that check into ``AutoActionGate`` (CRIT-V3-003 + GAP-1
+ MED-V3-010 single consolidation):

  * ``gate_from_policy(base_dir=..., profile=..., lane=...,
    classifier=...)`` produces ONE decision object that both
    ``materialize_agent_draft`` and ``materialize_skill`` consume
    through ``AutoActionGate.acquire_or_consume``.
  * Operator ack tokens are minted by ``ack_ledger.mint_operator_ack``
    (Phase A5); the gate verifies + consumes them.
  * The ``materialize_event_id`` UUID is generated AT GATE entry
    so the three-event chain (draft_validated → ack_consumed →
    materialize_committed) shares a single linkage key
    (AUDITTRAIL-CRITICAL-003 closure).

Merge is a separate authority: ``merge_authority.merge_pr_if_ready`` is
the single real-merge authority (its docstring owns the gate list, and
ADR-041 records the merge lane it enforces); ``auto_merge.merge_if_green``
only evaluates. Neither reads this gate or an ack token, so a materialize
ack never authorizes a merge. This module owns materialization only.

Gate decision shape:

  * ``human_ack_required: bool`` — derived from policy flag +
    profile. Current mainline authority keeps this ``True`` for every
    live lane; historical snowball lanes cannot auto-mint ack tokens.
  * ``AutoActionGate.acquire_or_consume`` — the ONE consumption path:
    it verifies an operator ack's HMAC, its scope (the draft, intent,
    target path, kind and body digest the materializer is about to write)
    and its one-time use through ``ack_ledger.consume_token``. Autonomous
    acks would be recorded by ``ack_ledger.record_autonomous_ack`` (minted
    and consumed in one transaction, never consumable by id);
    AUTONOMOUS_AUTO_ACK_LANES is empty, so no current lane reaches that
    branch.
  * ``materialize_event_id`` — chain linkage key persisted in
    every audit row.

Plan-026R discipline: invariant tests I-V3-14..17e lock the
contract (gate honours policy flag; rejects unsigned tokens;
acknowledge parameter removed from materialize public API;
single Gate consumed by both materializers; 3-event chain
linked by id; 25+ test callsite migration complete; these
docstrings name only existing API).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .ack_row import AckScope
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
    """Plan ARIA-V3 §2a — single source-of-truth materialization gate.

    Consumed by BOTH ``materialize_agent_draft`` and
    ``materialize_skill`` so a change to the gate logic propagates
    to every materializer atomically. The Gate is immutable;
    ``gate_from_policy`` is the production constructor and
    ``gate_from_test_fixture`` the test constructor.
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

    def acquire_or_consume(
        self,
        *,
        ack_id: str | None,
        base_dir: str | Path,
        scope: AckScope,
        commit_sha_at_mint: str,
        profile_state_at_mint: str,
    ) -> dict[str, Any]:
        """Plan ARIA-V3 §A4 + §B2 — unified token-resolution path for one ``scope``.

        ``scope`` is the materializer's ``AckScope`` of the draft row it is
        about to write (``agent_genesis.ack_scope_for_draft`` /
        ``skill_genesis.ack_scope_for_draft``).

        When ``human_ack_required`` is True: caller MUST pass
        ``ack_id``; ``ack_ledger.consume_token`` verifies it is an operator
        ack minted for exactly this scope and consumes it once.

        When ``human_ack_required`` is False, a future live lane contract
        records an autonomous ack for this scope through
        ``ack_ledger.record_autonomous_ack``, which mints and consumes it in
        one transaction. No current lane reaches that branch.
        The same materialize_event_id links the mint + consumption
        events through the audit chain.
        """
        from .ack_ledger import consume_token, record_autonomous_ack

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
                scope=scope,
            )
        # Autonomous path: minted and consumed by this materialization only.
        return record_autonomous_ack(
            base_dir=base_dir,
            scope=scope,
            materialize_event_id=self.materialize_event_id,
            profile_name=self.profile,
            lane=self.lane or "",
            classifier_decision_hash=self.classifier.decision_hash,
            auto_reason_code="classifier_pass",
            profile_state_at_mint=profile_state_at_mint,
            commit_sha_at_mint=commit_sha_at_mint,
            breaker_state_at_mint=self.breaker_state,
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


# ORPHAN-CRITICAL-418 — the state string a safety-signal read collapses
# to when it cannot answer. It is deliberately NOT ``ok``: every
# consumer compares against ``ok``, so an unreadable breaker or cost
# ledger now requires operator acknowledgement instead of waving the
# action through.
SAFETY_STATE_UNREADABLE: str = "unreadable"


def _load_breaker_state(base_dir: str | Path) -> str:
    """Read the autonomous-failure breaker state, fail-closed.

    Pre-fix this swallowed every exception into ``"ok"`` (its own
    comment said "fail-closed-but-permissive"), so a broken kernel
    import or an unreadable ledger read as "no failures recorded" and
    the gate stopped requiring an operator ack. A safety signal that
    cannot be read is not a safe signal — it returns
    ``SAFETY_STATE_UNREADABLE`` (ORPHAN-CRITICAL-418).

    ``circuit_breaker.evaluate_breaker`` already fails closed on a
    damaged ledger; this wrapper closes the remaining hole where the
    read itself raises.
    """
    try:
        from .circuit_breaker import current_state
    except ImportError:
        return SAFETY_STATE_UNREADABLE
    try:
        return current_state(base_dir=base_dir)
    except Exception:  # noqa: BLE001 — any read failure is not-ok, never ok
        return SAFETY_STATE_UNREADABLE


def _load_cost_state(base_dir: str | Path) -> str:
    """Read the cost-budget breaker state, fail-closed.

    Same defect and same fix as :func:`_load_breaker_state` — both feed
    ``AutoActionGate.human_ack_required``, so leaving this one
    permissive would keep the hole open on the cost side
    (ORPHAN-CRITICAL-418).
    """
    try:
        from .cost_budget import current_state
    except ImportError:
        return SAFETY_STATE_UNREADABLE
    try:
        return current_state(base_dir=base_dir)
    except Exception:  # noqa: BLE001 — any read failure is not-ok, never ok
        return SAFETY_STATE_UNREADABLE


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
    "SAFETY_STATE_UNREADABLE",
    "AutoActionGate",
    "ClassifierDecision",
    "gate_from_policy",
    "gate_from_test_fixture",
]
