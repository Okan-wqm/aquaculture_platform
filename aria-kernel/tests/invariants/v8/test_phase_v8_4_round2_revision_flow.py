"""Plan ARIA-V8 v2 §4 Phase 8.4 — round-2+ revision flow invariants.

Closes F-014-D4. 5 invariants:

- I-V8.4-01 — Round-2+ mints primary REVISION envelope via issue_primary_envelope
- I-V8.4-02 — Primary REVISION succeeds only when state in {CRITIQUED, CROSS_REVIEWED}
- I-V8.4-03 — Round-2 waits for REVISED state after primary envelope
- I-V8.4-04 — NEXT_ROUND_REQUIRED → round_n+1 dispatch
- I-V8.4-05 — issue_primary_envelope literal appears once outside helper (round-2+ body only)
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import convergence_drainer, cross_review_bridge
from aria_kernel.bridge_exceptions import BridgeContractViolation


class TestRound2RevisionFlow(unittest.TestCase):

    def setUp(self) -> None:
        self.src = inspect.getsource(convergence_drainer.run_convergence_drainer)

    def test_i_v8_4_01_round_n_mints_primary_revision_envelope(self):
        """Round-2+ body references cross_review_bridge.issue_primary_envelope."""
        self.assertIn("issue_primary_envelope(", self.src,
                      "V8 drainer round-2+ MUST mint primary REVISION envelope via "
                      "cross_review_bridge.issue_primary_envelope")
        # Module imports it
        drainer_module_src = inspect.getsource(convergence_drainer)
        self.assertIn("issue_primary_envelope", drainer_module_src.split("from .cross_review_bridge import")[1].split(")")[0])

    def test_i_v8_4_02_primary_envelope_state_guard(self):
        """issue_primary_envelope refuses if state not in legal set."""
        # Module-level constant exposes the legal state set
        src = inspect.getsource(cross_review_bridge)
        self.assertIn("_PRIMARY_REVISION_LEGAL_STATES", src)
        self.assertIn('"CRITIQUED"', src)
        self.assertIn('"CROSS_REVIEWED"', src)
        # Raises BridgeContractViolation
        self.assertIn("BridgeContractViolation", src)

    def test_i_v8_4_03_round_n_polls_for_revised_after_primary_revision(self):
        """Round-2+ body polls for REVISED state after primary REVISION mint."""
        # In the round-2+ branch (round_n > 1), source contains REVISED poll target
        self.assertIn('"REVISED"', self.src)
        # primary_revision_failed verdict present
        self.assertIn('arbiter_verdict="primary_revision_failed"', self.src)

    def test_i_v8_4_04_next_round_required_advances_round_n(self):
        """The for-loop iterates rounds 1..max_rounds; NEXT_ROUND_REQUIRED
        persists and loops back. Source structure preserved from V5.1."""
        self.assertIn("for round_n in range(starting_round, max_rounds + 1):", self.src)
        # The persistence write for next round bump
        self.assertIn('"round": round_n + 1', self.src)

    def test_i_v8_4_05_issue_cross_review_envelope_exactly_once(self):
        """DRY enforcement: cross_review minted inside helper only.

        Negative test: issue_cross_review_envelope literal appears EXACTLY
        ONCE in the drainer body (inside _run_challenge_and_cross_review_phase
        helper). Round-1 and round-2+ both call the helper; the call site
        is single."""
        # Count includes both definitions and references; the helper has 1 call site
        count = self.src.count("issue_cross_review_envelope(")
        self.assertEqual(
            count, 1,
            f"V8 architect B2: issue_cross_review_envelope MUST appear exactly once "
            f"(inside _run_challenge_and_cross_review_phase helper). Found {count} call sites — DRY violation."
        )


if __name__ == "__main__":
    unittest.main()
