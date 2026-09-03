"""Plan ARIA-V8 v2 §4 Phase 8.6 — source-substring invariants on REAL constants.

Closes F-014-D6 + F-014 umbrella.

Per architect B-V2-04: V8 v1's invariants pinned literals like
``_round1_envelopes = ("challenger", "cross_review")`` that did NOT
exist in real source — pure theater. These invariants pin REAL
module-level constants (_ROUND1_ENVELOPES, _ROUND_N_ENVELOPES,
_PRIMARY_PLAN_STATE_DISPATCH) + CALL-SITE substrings that mirror
V6.2 / V7.6 precedent (inspect.getsource(...).index("literal")).

4 invariants:

- I-V8.6-01 — round-1 call-site order: issue_challenger_envelope BEFORE issue_cross_review_envelope
- I-V8.6-02 — _run_challenge_and_cross_review_phase helper contains BOTH minter calls
- I-V8.6-03 — _ROUND1_ENVELOPES + _ROUND_N_ENVELOPES module-level constants present
- I-V8.6-04 — _PRIMARY_PLAN_STATE_DISPATCH module-level constant present
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import convergence_drainer, plan_convergence_bridge


class TestSourceSubstringInvariantsOnRealConstants(unittest.TestCase):

    def test_i_v8_6_01_round1_call_order_pinned(self):
        """issue_challenger_envelope MUST appear in source BEFORE
        issue_cross_review_envelope (V8 round-1 ordering)."""
        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        idx_challenger = src.index("issue_challenger_envelope(")
        idx_cross_review = src.index("issue_cross_review_envelope(")
        self.assertLess(idx_challenger, idx_cross_review,
                        "V8: issue_challenger_envelope MUST come before issue_cross_review_envelope in drainer source")

    def test_i_v8_6_02_step_owns_both_minter_calls_without_duplication(self):
        """CL-1 (ORPHAN-725): the round-loop helper is gone — the step
        function itself owns the mints, one per state branch. The DRY
        property the helper existed to guarantee is PINNED DIRECTLY:
        the cross-review envelope has exactly one mint site, and the
        challenger's two sites are the two legal predecessor states
        (DRAFT and REVISED), not copy-paste of one round shape."""
        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        self.assertEqual(src.count("issue_cross_review_envelope("), 1)
        self.assertEqual(src.count("issue_challenger_envelope("), 3)
        for state_branch in ('plan_state is None', 'plan_state == "DRAFT"', 'plan_state == "REVISED"'):
            self.assertIn(state_branch, src)

    def test_i_v8_6_03_round_envelope_constants_real_and_present(self):
        """_ROUND1_ENVELOPES + _ROUND_N_ENVELOPES MUST be REAL module-
        level constants with the expected tuple shapes (architect B-V2-04:
        constants are real, not invariant theater)."""
        self.assertTrue(hasattr(convergence_drainer, "_ROUND1_ENVELOPES"))
        self.assertTrue(hasattr(convergence_drainer, "_ROUND_N_ENVELOPES"))
        self.assertEqual(convergence_drainer._ROUND1_ENVELOPES,
                         ("challenger", "cross_review"))
        self.assertEqual(convergence_drainer._ROUND_N_ENVELOPES,
                         ("primary_revision", "challenger", "cross_review"))

    def test_i_v8_6_04_primary_plan_state_dispatch_real(self):
        """_PRIMARY_PLAN_STATE_DISPATCH MUST be a REAL module-level
        constant (architect I1: declarative dispatch, not if/elif)."""
        self.assertTrue(hasattr(plan_convergence_bridge, "_PRIMARY_PLAN_STATE_DISPATCH"))
        dispatch = plan_convergence_bridge._PRIMARY_PLAN_STATE_DISPATCH
        self.assertIsInstance(dispatch, dict)
        self.assertIn("CRITIQUED", dispatch)
        self.assertIn("CROSS_REVIEWED", dispatch)
        # DRAFT MUST NOT be in the table — V8 makes primary mint impossible
        self.assertNotIn("DRAFT", dispatch)


if __name__ == "__main__":
    unittest.main()
