"""Plan ARIA-V10.2 — pattern_signature stability trigger invariants.

Closes:
  * arb CRIT-007 — N>=5 + cardinality guard prevents false-positive trigger
  * ai MED-015 — supply-chain collusion mitigation (distinct sources +
    distinct reviewers)
"""
from __future__ import annotations

import unittest

from . import _helpers  # noqa: F401

from aria_kernel import skill_genesis_drainer as _sgd


SIG_A = "sha256:" + "a" * 64
SIG_B = "sha256:" + "b" * 64


class TestV10PatternSignatureStability(unittest.TestCase):

    def test_thresholds_canonical(self):
        self.assertEqual(_sgd.PATTERN_SIGNATURE_TRIGGER_MIN_CYCLES, 5)
        self.assertEqual(_sgd.PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_SOURCES, 2)
        self.assertEqual(_sgd.PATTERN_SIGNATURE_TRIGGER_MIN_DISTINCT_REVIEWERS, 2)

    def test_invalid_signature_format_rejected(self):
        result = _sgd.check_pattern_signature_stability(
            pattern_signature="not-a-hash",
            governance_rows=[],
        )
        self.assertFalse(result["stable"])
        self.assertIn("invalid_pattern_signature_format", result["reason"])

    def test_too_few_cycles_rejected(self):
        rows = [
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": f"c{i}", "pressure_source_type": "orphan_finding",
             "cross_reviewer_agent_id": "rev-1"}
            for i in range(3)  # only 3 cycles
        ]
        result = _sgd.check_pattern_signature_stability(
            pattern_signature=SIG_A, governance_rows=rows,
        )
        self.assertFalse(result["stable"])
        self.assertIn("only_3_matching_cycles", result["reason"])

    def test_too_few_sources_rejected(self):
        """5 cycles but all 1 source type → reject (ai MED-015)."""
        rows = [
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": f"c{i}", "pressure_source_type": "git_diff",
             "cross_reviewer_agent_id": f"rev-{i % 3}"}
            for i in range(5)
        ]
        result = _sgd.check_pattern_signature_stability(
            pattern_signature=SIG_A, governance_rows=rows,
        )
        self.assertFalse(result["stable"])
        self.assertIn("only_1_distinct_pressure_sources", result["reason"])

    def test_too_few_reviewers_rejected(self):
        """5 cycles, 2 sources, but all 1 reviewer → reject (echo-chamber)."""
        rows = [
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": f"c{i}", "pressure_source_type": ("orphan_finding" if i % 2 else "git_diff"),
             "cross_reviewer_agent_id": "same-reviewer"}
            for i in range(5)
        ]
        result = _sgd.check_pattern_signature_stability(
            pattern_signature=SIG_A, governance_rows=rows,
        )
        self.assertFalse(result["stable"])
        self.assertIn("only_1_distinct_reviewers", result["reason"])

    def test_stable_when_all_thresholds_met(self):
        """Plan ARIA-V10.2 + V3.1-C-4 — stability fires when the 3
        thresholds + OPERATOR_FEEDBACK gate are met.

        V3.1-C-4 amendment: at least ONE row must carry
        `pressure_source_type=operator_feedback` so an adversarial
        planner that fakes 5 CONVERGED cycles with auto-discovered
        sources alone (orphan_finding / failing_ci / f_finding /
        git_diff) cannot trigger skill genesis without the operator's
        signed trust anchor (closes MEDIUM-011 + ai-safety HIGH-005).
        """
        rows = [
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c0", "pressure_source_type": "operator_feedback",
             "cross_reviewer_agent_id": "rev-A"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c1", "pressure_source_type": "failing_ci",
             "cross_reviewer_agent_id": "rev-B"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c2", "pressure_source_type": "orphan_finding",
             "cross_reviewer_agent_id": "rev-A"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c3", "pressure_source_type": "failing_ci",
             "cross_reviewer_agent_id": "rev-B"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c4", "pressure_source_type": "f_finding",
             "cross_reviewer_agent_id": "rev-C"},
        ]
        result = _sgd.check_pattern_signature_stability(
            pattern_signature=SIG_A, governance_rows=rows,
        )
        self.assertTrue(result["stable"], f"reason={result.get('reason')}")
        self.assertEqual(len(result["matching_cycles"]), 5)
        self.assertEqual(len(result["distinct_pressure_source_types"]), 4)
        self.assertEqual(len(result["distinct_cross_reviewer_agent_ids"]), 3)
        # V3.1-C-4 — operator_feedback MUST be in the distinct sources.
        self.assertIn("operator_feedback",
                      result["distinct_pressure_source_types"])

    def test_non_converged_breaks_streak(self):
        """Non-CONVERGED row in the lookback breaks the streak —
        skill-genesis triggers only on a CONSECUTIVE convergence
        run, not 5-of-N window."""
        rows = [
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c0", "pressure_source_type": "orphan_finding",
             "cross_reviewer_agent_id": "rev-A"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c1", "pressure_source_type": "failing_ci",
             "cross_reviewer_agent_id": "rev-B"},
            {"terminal_state": "HUMAN_REQUIRED", "pattern_signature": SIG_A,
             "cycle_id": "c2-non-converged"},  # BREAK
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c3", "pressure_source_type": "f_finding",
             "cross_reviewer_agent_id": "rev-C"},
        ]
        result = _sgd.check_pattern_signature_stability(
            pattern_signature=SIG_A, governance_rows=rows,
        )
        self.assertFalse(result["stable"])
        self.assertEqual(result["matching_cycles"], ["c0", "c1"])

    def test_different_signature_breaks_streak(self):
        """Different signature in the lookback breaks the streak."""
        rows = [
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c0", "pressure_source_type": "orphan_finding",
             "cross_reviewer_agent_id": "rev-A"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_B,  # DIFFERENT
             "cycle_id": "c1"},
            {"terminal_state": "CONVERGED", "pattern_signature": SIG_A,
             "cycle_id": "c2", "pressure_source_type": "failing_ci",
             "cross_reviewer_agent_id": "rev-B"},
        ]
        result = _sgd.check_pattern_signature_stability(
            pattern_signature=SIG_A, governance_rows=rows,
        )
        self.assertFalse(result["stable"])
        self.assertEqual(result["matching_cycles"], ["c0"])


if __name__ == "__main__":
    unittest.main()
