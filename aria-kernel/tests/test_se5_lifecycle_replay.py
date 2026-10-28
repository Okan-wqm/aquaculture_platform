"""SE-5 group A — the lifecycle state of an entity has ONE owner, and it replays the chain.

``genesis_lifecycle.current_lifecycle_state`` returns the last ledger row whose ``to_state``
is a known state. It does not replay the transitions, does not look at the proofs, and
silently ignores a row with an unknown ``to_state``; ``agent_invocations._target_is_shadow``
is a second, unverified replay of the same ledger (the claim-side SHADOW predicate). A
hand-appended ACTIVE row therefore reads ``ACTIVE``, and a forged ACTIVE row over a SHADOW
chain unblocks production traffic for an agent that never earned it.

SE-5 makes the owner replay ``validate_transition`` over the entity's own chain, from
``None``: a row whose ``to_state`` is unknown, whose recorded ``from_state`` differs from the
replayed one, whose transition is illegal, or whose ACTIVE row lacks the kernel-computed
proof makes the chain an ``InvalidLifecycleChain(entity_id, reasons)`` (a value, not a raise,
not a state string). ``record_transition`` refuses to extend such a chain by name, and the
claim-side predicate folds into ``production_block_reason`` (fail-closed on an invalid chain).

Red at the branch base, every one on an assertion (each test asserts that the API it reaches
exists before using it, so nothing fails at import or collection):

  L2-L6  the invalid chains read as ``InvalidLifecycleChain`` (base: the last known row wins)
  L7     ``record_transition`` on an invalid chain raises ``genesis_lifecycle_chain_invalid:``
  L8     ``production_block_reason`` (new API)
  L9     the claim path (mint, selection, claim) refuses a forged chain (base: it unblocks)
  L10    ``agent_invocations`` has no ``_target_is_shadow``

Pins (seven tests, green at the base, must stay green): L1 (a valid chain reads its state), the near-miss
of L4 (a legal successor row is valid), L7's valid chain, and L9's no-chain mint and valid-SHADOW refusal at
the mint, the selection and the claim.

New API pinned here, named by the specification: ``genesis_lifecycle.InvalidLifecycleChain``
(``entity_id``, ``reasons``) and ``genesis_lifecycle.production_block_reason(entity_id, *, base_dir)``
returning ``"shadow"``, ``"chain_invalid:<reasons>"`` or ``None``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import agent_invocations, genesis_lifecycle
from aria_kernel.agent_invocations import (
    claim_request,
    derive_request_states,
    next_pending_request,
    selection_skip,
)
from aria_kernel.evidence_probe import GitProbeSession
from aria_kernel.genesis_lifecycle import current_lifecycle_state, record_transition
from aria_kernel.provider_clock import provider_clock
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.lifecycle_chain import LADDER, chain, evidence_for, forged_row, reason_texts
from tests._helpers.seat_routing import DEFAULT_SUBJECT, GENERIC, ROLE, mint_request

HUMAN_REQUIRED_NEEDS = "human_required_requires_capability_resolution_decision"


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-se5-lifecycle-")
        self.addCleanup(self._tmp.cleanup)
        self.store = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def state(self, entity: str) -> Any:
        return current_lifecycle_state(entity_id=entity, base_dir=self.store)

    def assertInvalidChain(self, entity: str, needle: str) -> None:
        """``entity`` reads as an ``InvalidLifecycleChain`` whose reasons name ``needle`` (and it is no state)."""
        result = self.state(entity)
        # The defect first, from API that exists at the base: a chain that does not replay reads a state.
        self.assertNotIsInstance(
            result, str,
            f"the chain of {entity!r} does not replay, yet it reads {result!r}: the last row is believed, not replayed",
        )
        invalid = getattr(genesis_lifecycle, "InvalidLifecycleChain", None)
        self.assertIsNotNone(invalid, "genesis_lifecycle.InvalidLifecycleChain does not exist: nothing can say a chain is invalid")
        self.assertIsInstance(result, invalid)
        self.assertEqual(getattr(result, "entity_id", None), entity)
        self.assertTrue(
            any(needle in reason for reason in reason_texts(result)),
            f"the reasons {reason_texts(result)} do not name {needle!r}",
        )

    def mint_generic(self) -> dict[str, Any]:
        """The claim path's mint, for the generic change-intelligence agent, under a door decision for the change."""
        return mint_request(self.store, target=GENERIC, subject=DEFAULT_SUBJECT)

    def selection(self, request: dict[str, Any]) -> Any:
        return selection_skip(
            self.store, request, states=derive_request_states(base_dir=self.store), repo_root=None,
            probes=GitProbeSession(), clock=provider_clock(self.store), may_record=lambda: False,
        )


class ReplayTests(_Store):
    def test_a_valid_chain_reads_its_state_at_every_rung(self) -> None:
        # L1 — pin. The replay must not cost a legitimate chain its state.
        for state in LADDER:
            with self.subTest(state=state):
                chain(self.store, f"entity-{state.lower()}", state)
                self.assertEqual(self.state(f"entity-{state.lower()}"), state)

    def test_an_active_row_without_the_kernel_proof_is_an_invalid_chain(self) -> None:
        # L2 — the hand-appended ACTIVE. The rows up to EVAL_WINDOW are valid; the ACTIVE row carries only the
        # reviewers a caller can assert, not the superiority proof record_transition computes kernel-side.
        chain(self.store, "hand-appended", "ACTIVE", with_proof=False)
        self.assertInvalidChain("hand-appended", "active_requires_kernel_computed_eval_superiority")
        self.assertNotEqual(self.state("hand-appended"), "ACTIVE")

    def test_a_skipped_state_is_an_invalid_chain(self) -> None:
        # L3 — DRAFT -> ACTIVE directly, with every proof the ACTIVE gate asks for: only the transition is illegal.
        chain(self.store, "skipper", "DRAFT")
        forged_row(self.store, "skipper", "ACTIVE", from_state="DRAFT", evidence=evidence_for("ACTIVE"))
        self.assertInvalidChain("skipper", "genesis_invalid_transition:DRAFT->ACTIVE")

    def test_a_row_naming_an_unknown_state_is_an_invalid_chain_not_an_ignored_row(self) -> None:
        # L4 — a valid ACTIVE chain, then a row whose state the vocabulary does not know. The base IGNORES it and
        # reads ACTIVE; the replay says the chain is broken.
        chain(self.store, "quarantined", "ACTIVE")
        forged_row(self.store, "quarantined", "QUARANTINED", from_state="ACTIVE")
        self.assertInvalidChain("quarantined", "genesis_lifecycle_unknown_state:QUARANTINED")

    def test_a_row_naming_a_known_legal_successor_is_valid(self) -> None:
        # L4 near-miss — pin. The same append, with a state the vocabulary knows and the ladder allows, is a chain.
        chain(self.store, "advancing", "SHADOW")
        forged_row(self.store, "advancing", "EVAL_WINDOW", from_state="SHADOW", evidence=evidence_for("EVAL_WINDOW"))
        self.assertEqual(self.state("advancing"), "EVAL_WINDOW")

    def test_a_recorded_from_state_that_differs_from_the_replayed_one_is_an_invalid_chain(self) -> None:
        # L5 — a legal DRAFT -> REAL_SANDBOX row that CLAIMS to come from EVAL_WINDOW: from_state is derived by the
        # replay and never trusted.
        chain(self.store, "forger", "DRAFT")
        forged_row(self.store, "forger", "REAL_SANDBOX", from_state="EVAL_WINDOW", evidence=evidence_for("REAL_SANDBOX"))
        self.assertInvalidChain("forger", "genesis_from_state_mismatch")

    def test_one_entitys_invalid_chain_does_not_touch_another_entity_in_the_same_ledger(self) -> None:
        # L6 — isolation. The invalid chain is the red part; the valid ACTIVE chain beside it is the pin.
        chain(self.store, "broken", "ACTIVE", with_proof=False)
        chain(self.store, "sound", "ACTIVE")
        self.assertEqual(self.state("sound"), "ACTIVE")
        self.assertInvalidChain("broken", "active_requires_kernel_computed_eval_superiority")


class RecordTransitionRefusesAnInvalidChainTests(_Store):
    def _rows_of(self, entity: str) -> list[dict[str, Any]]:
        from aria_kernel.ledger import load_declared_jsonl

        return [
            row for row in load_declared_jsonl(
                genesis_lifecycle.lifecycle_events_path(self.store), expected_surface="genesis_lifecycle_events")
            if row.get("entity_id") == entity
        ]

    def test_a_transition_out_of_an_invalid_chain_is_refused_by_name_and_writes_nothing(self) -> None:
        # L7 — HUMAN_REQUIRED without the capability resolution its gate asks for is a forged row. REJECTED is a
        # legal successor of HUMAN_REQUIRED, so the base records it on top of the forgery.
        chain(self.store, "forged-chain", "CANDIDATE_PROPOSED")
        forged_row(self.store, "forged-chain", "HUMAN_REQUIRED", from_state="CANDIDATE_PROPOSED", evidence={})
        before = len(self._rows_of("forged-chain"))

        with self.assertRaises(GovernanceError) as refused:
            record_transition(entity_id="forged-chain", entity_kind="agent", to_state="REJECTED", evidence={},
                              base_dir=self.store)

        self.assertIn("genesis_lifecycle_chain_invalid:forged-chain", str(refused.exception),
                      "the refusal must name the entity whose chain does not replay")
        self.assertIn(HUMAN_REQUIRED_NEEDS, str(refused.exception), "the refusal must carry the reasons")
        self.assertEqual(len(self._rows_of("forged-chain")), before, "a refused transition wrote a row")

    def test_a_valid_chain_still_records_normally(self) -> None:
        # L7 pin (test_enterprise_readiness_and_genesis_lifecycle) — the refusal is for an invalid chain only.
        chain(self.store, "sound-chain", "DRAFT")
        row = record_transition(entity_id="sound-chain", entity_kind="agent", to_state="REJECTED", evidence={},
                                base_dir=self.store)
        self.assertEqual(row["to_state"], "REJECTED")
        self.assertEqual(row["from_state"], "DRAFT")
        self.assertEqual(self.state("sound-chain"), "REJECTED")


class ProductionBlockReasonTests(_Store):
    def _reason(self, entity: str) -> Any:
        owner = getattr(genesis_lifecycle, "production_block_reason", None)
        self.assertIsNotNone(
            owner, "genesis_lifecycle.production_block_reason does not exist: the claim-side SHADOW predicate has no owner")
        return owner(entity, base_dir=self.store)

    def test_a_valid_shadow_chain_blocks_production_as_shadow(self) -> None:
        # L8 — the old predicate's answer, now from the owner.
        chain(self.store, "in-shadow", "SHADOW")
        self.assertEqual(self._reason("in-shadow"), "shadow")

    def test_an_entity_with_no_chain_is_not_blocked(self) -> None:
        # L8 — a generic agent never recorded in the ledger (every static pairing target) mints.
        self.assertIsNone(self._reason("never-recorded"))

    def test_a_valid_active_chain_is_not_blocked(self) -> None:
        chain(self.store, "earned", "ACTIVE")
        self.assertIsNone(self._reason("earned"))

    def test_a_forged_active_row_over_a_shadow_chain_is_blocked_as_an_invalid_chain(self) -> None:
        # L8 — the forged ACTIVE skips EVAL_WINDOW. Fail-closed: the old predicate read the last row (ACTIVE) and
        # let the agent through.
        chain(self.store, "impostor", "SHADOW")
        forged_row(self.store, "impostor", "ACTIVE", from_state="SHADOW", evidence=evidence_for("ACTIVE"))
        reason = self._reason("impostor")
        self.assertIsInstance(reason, str)
        self.assertTrue(str(reason).startswith("chain_invalid:"), f"the block reason is {reason!r}")
        self.assertIn("genesis_invalid_transition:SHADOW->ACTIVE", str(reason))


class ClaimPathTests(_Store):
    """L9 — every place the claim side asks 'may this agent take production traffic' asks the one owner."""

    def _forge_active_over_shadow(self, entity: str = GENERIC) -> None:
        chain(self.store, entity, "SHADOW")
        forged_row(self.store, entity, "ACTIVE", from_state="SHADOW", evidence=evidence_for("ACTIVE"))

    def test_a_valid_shadow_agent_is_refused_at_the_mint(self) -> None:
        # Pin of the old predicate.
        chain(self.store, GENERIC, "SHADOW")
        with self.assertRaisesRegex(GovernanceError, "shadow_agent_invocation_blocked"):
            self.mint_generic()

    def test_an_agent_with_no_chain_mints(self) -> None:
        # Pin: the generic agents have no ledger row and are not blocked by that.
        row = self.mint_generic()
        self.assertTrue(row.get("request_id"))

    def test_a_forged_chain_is_refused_at_the_mint(self) -> None:
        self._forge_active_over_shadow()
        with self.assertRaises(GovernanceError) as refused:
            self.mint_generic()
        self.assertIn("chain_invalid", str(refused.exception))

    def test_a_valid_shadow_agent_is_skipped_by_the_selection(self) -> None:
        request = self.mint_generic()
        chain(self.store, GENERIC, "SHADOW")
        skip = self.selection(request)
        self.assertIsNotNone(skip, "a SHADOW agent's request was handed out")
        self.assertEqual(skip.reason, "shadow_target")

    def test_a_forged_chain_is_a_named_selection_skip_and_wedges_no_drain(self) -> None:
        request = self.mint_generic()
        self._forge_active_over_shadow()

        skip = self.selection(request)

        self.assertIsNotNone(skip, "a request of an agent with a forged chain was handed out for production traffic")
        self.assertIn("chain_invalid", f"{skip.reason} {skip.detail}", "the skip must carry the reason the chain gave")
        self.assertIsNone(next_pending_request(role=ROLE, base_dir=self.store),
                          "the drain handed the forged-chain request out (or raised instead of skipping it)")

    def test_a_valid_shadow_agent_is_refused_at_the_claim(self) -> None:
        request = self.mint_generic()
        chain(self.store, GENERIC, "SHADOW")
        with self.assertRaisesRegex(GovernanceError, "shadow_agent_invocation_blocked"):
            claim_request(request_id=request["request_id"], agent_id="se5-worker", base_dir=self.store)

    def test_a_forged_chain_is_refused_at_the_claim(self) -> None:
        request = self.mint_generic()
        self._forge_active_over_shadow()
        with self.assertRaises(GovernanceError) as refused:
            claim_request(request_id=request["request_id"], agent_id="se5-worker", base_dir=self.store)
        self.assertIn("chain_invalid", str(refused.exception))


class OneOwnerTests(unittest.TestCase):
    def test_agent_invocations_holds_no_second_shadow_predicate(self) -> None:
        # L10 — the copy is deleted, not kept beside the owner.
        self.assertFalse(
            hasattr(agent_invocations, "_target_is_shadow"),
            "agent_invocations._target_is_shadow is a second, unverified replay of the lifecycle ledger",
        )


if __name__ == "__main__":
    unittest.main()
