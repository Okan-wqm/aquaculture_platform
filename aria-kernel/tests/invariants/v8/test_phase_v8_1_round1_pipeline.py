"""Plan ARIA-V8 v2 §4 Phase 8.1 — round-1 producer flow invariants.

Closes F-014-D1. 7 invariants:

- I-V8.1-01 — Round-1 mints challenger BEFORE waiting for state change
- I-V8.1-02 — Round-1 does NOT mint primary envelope
- I-V8.1-03 — Round-1 mints cross_review AFTER CHALLENGER_DRAFTED
- I-V8.1-04 — Round-1 calls evaluate_plan only after CROSS_REVIEWED
- I-V8.1-05 — Cross-review poll timeout → arbiter_verdict=cross_review_unavailable
- I-V8.1-06 — Challenger poll timeout → arbiter_verdict=challenger_unavailable
- I-V8.1-07 — _run_challenge_and_cross_review_phase helper extracted
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import convergence_drainer


class TestRound1Pipeline(unittest.TestCase):
    """V8.1 round-1 envelope-mint sequence via source-substring pins
    on the real run_convergence_drainer body. The actual functional
    test of the pipeline lives in C6's 30-cycle smoke; here we
    enforce structural correctness."""

    def setUp(self) -> None:
        self.src = inspect.getsource(convergence_drainer.run_convergence_drainer)

    def test_i_v8_1_01_round1_mints_challenger_before_state_poll(self):
        # In round-1 body (round_n == 1 branch), issue_challenger_envelope
        # call MUST appear before the CHALLENGER_DRAFTED poll. V8 helper
        # _run_challenge_and_cross_review_phase enforces this — verify
        # the helper itself has the order.
        helper_src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        # The helper is a closure inside the function; verify the entire
        # function source has issue_challenger_envelope BEFORE the
        # CHALLENGER_DRAFTED target_states reference.
        idx_mint = helper_src.find("issue_challenger_envelope(")
        idx_poll = helper_src.find('"CHALLENGER_DRAFTED"')
        self.assertGreater(idx_mint, 0, "issue_challenger_envelope must appear in drainer source")
        self.assertGreater(idx_poll, 0, "CHALLENGER_DRAFTED poll target must appear")
        self.assertLess(idx_mint, idx_poll, "challenger envelope MUST be minted before the CHALLENGER_DRAFTED poll")

    def test_i_v8_1_02_round1_does_not_mint_primary_envelope(self):
        # V8 round-1 has NO primary envelope. The legacy entry
        # start_convergent_plan_with_envelope was DELETED in C1
        # (B-V2-07). Verify it's gone from the bridge AND not
        # referenced in the drainer.
        from aria_kernel import convergent_planning_bridge
        bridge_src = inspect.getsource(convergent_planning_bridge)
        self.assertNotIn("start_convergent_plan_with_envelope", bridge_src,
                         "V8: legacy start_convergent_plan_with_envelope MUST be deleted")
        # Drainer round-1 uses start_convergent_plan_drafted_by_primary
        self.assertIn("start_convergent_plan_drafted_by_primary", self.src,
                      "V8 drainer MUST use the new entry for round-1")

    def test_i_v8_1_03_round1_mints_cross_review_after_challenger_drafted(self):
        # cross_review envelope mint MUST happen after the
        # CHALLENGER_DRAFTED poll (helper sequence verifies this).
        idx_chal_drafted = self.src.find('"CHALLENGER_DRAFTED"')
        idx_cross_review = self.src.find("issue_cross_review_envelope(")
        self.assertGreater(idx_chal_drafted, 0)
        self.assertGreater(idx_cross_review, 0)
        self.assertLess(idx_chal_drafted, idx_cross_review,
                        "cross_review envelope MUST be minted AFTER CHALLENGER_DRAFTED poll")

    def test_i_v8_1_04_round1_evaluates_only_after_cross_reviewed(self):
        # CROSS_REVIEWED poll must precede evaluate_plan call
        idx_cross_reviewed = self.src.find('"CROSS_REVIEWED"')
        idx_eval = self.src.find("evaluate_plan(")
        self.assertGreater(idx_cross_reviewed, 0)
        self.assertGreater(idx_eval, 0)
        self.assertLess(idx_cross_reviewed, idx_eval,
                        "evaluate_plan MUST come AFTER CROSS_REVIEWED poll")

    def test_i_v8_1_05_cross_review_unavailable_verdict_present(self):
        # Source contains the cross_review_unavailable arbiter_verdict
        # for the poll-timeout case.
        self.assertIn('arbiter_verdict="cross_review_unavailable"', self.src,
                      "cross_review poll timeout MUST emit cross_review_unavailable verdict")

    def test_i_v8_1_06_challenger_unavailable_verdict_present(self):
        # Source contains the challenger_unavailable arbiter_verdict
        # for the challenger poll-timeout case.
        self.assertIn('arbiter_verdict="challenger_unavailable"', self.src,
                      "challenger poll timeout MUST emit challenger_unavailable verdict")

    def test_i_v8_1_07_run_challenge_and_cross_review_phase_helper_extracted(self):
        # The helper must exist as a nested function (closure) in
        # run_convergence_drainer. Negative test: issue_cross_review_envelope
        # appears EXACTLY ONCE in the drainer body (inside the helper),
        # not duplicated for round-1 and round-2+.
        cross_review_calls = self.src.count("issue_cross_review_envelope(")
        self.assertEqual(
            cross_review_calls, 1,
            "issue_cross_review_envelope MUST appear exactly once "
            "(inside _run_challenge_and_cross_review_phase helper). "
            f"Found {cross_review_calls} call sites — DRY violation (architect B2)."
        )
        # Helper name present in source
        self.assertIn("_run_challenge_and_cross_review_phase", self.src,
                      "Helper function MUST be defined in drainer body")


if __name__ == "__main__":
    unittest.main()
