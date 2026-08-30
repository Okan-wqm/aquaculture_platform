"""The decision weights come from math, and every number is re-derivable.

ORPHAN-HIGH-627 (Kalibre Zekâ Z1): hand-set constants ran ARIA's targeting —
SOURCE_WEIGHTS never moved with evidence, the mission scheduler's source
tiebreak was a frozen table, and nothing anywhere turned an operator's
true/false-positive verdicts into standing. The closed-form layer here is
deliberately NOT a neural net: tens of labels cannot train one, and ARIA's
constitution demands every decision number be recomputable from append-only
ledgers. Beta-Binomial + seeded Thompson satisfy both.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel.calibrated_intelligence import (
    PRIOR_A,
    PRIOR_B,
    beta_posterior,
    calibrate_source_weights,
    calibrated_multiplier,
    deterministic_seed,
    thompson_rank,
)
from aria_kernel.tool_registry import ensure_tools_dir


class ClosedFormTest(unittest.TestCase):
    def test_posterior_matches_hand_computation(self) -> None:
        # Beta(4+6, 1+2): mean = 10/13.
        post = beta_posterior(6, 2)

        self.assertAlmostEqual(post["mean"], 10 / 13)
        self.assertEqual(post["observations"], 8.0)

    def test_zero_labels_is_exactly_a_no_op(self) -> None:
        # The load-bearing property: calibration must not move anything
        # until evidence exists — the hand-set weight IS the prior belief.
        scaled = calibrated_multiplier(0, 0)

        self.assertEqual(scaled["multiplier"], 1.0)

    def test_labels_move_the_multiplier_the_closed_form_amount(self) -> None:
        # prior mean 0.8; Beta(4+0, 1+4) mean = 4/9; raw = (4/9)/0.8 = 5/9
        # → clamped at floor 0.25? 5/9≈0.556 > 0.25, so exact.
        scaled = calibrated_multiplier(0, 4)

        self.assertAlmostEqual(scaled["multiplier"], (4 / 9) / (PRIOR_A / (PRIOR_A + PRIOR_B)))

    def test_operator_override_is_never_second_guessed(self) -> None:
        rows = [{"metadata": {"pressure_source": "own_pr_ci"}, "verdict": "false_positive"}] * 6

        calibrated = calibrate_source_weights(
            {"own_pr_ci": 90}, rows, operator_overridden=frozenset({"own_pr_ci"})
        )

        self.assertEqual(calibrated["own_pr_ci"]["weight"], 90.0)
        self.assertEqual(calibrated["own_pr_ci"]["reason"], "operator_override_wins")

    def test_every_base_key_survives_calibration(self) -> None:
        # _pressure() KeyErrors on a missing source — the calibrated table
        # must cover exactly the base table's keys.
        from aria_kernel.pressure import SOURCE_WEIGHTS

        calibrated = calibrate_source_weights(SOURCE_WEIGHTS, [])

        self.assertEqual(set(calibrated), set(SOURCE_WEIGHTS))
        for detail in calibrated.values():
            self.assertEqual(detail["multiplier"], 1.0)


class ThompsonTest(unittest.TestCase):
    _CANDS = [
        {"key": "a", "successes": 8, "trials": 10},
        {"key": "b", "successes": 1, "trials": 10},
        {"key": "fresh", "successes": 0, "trials": 0},
    ]

    def test_same_seed_same_order(self) -> None:
        seed = deterministic_seed("test", "2026-08-11")

        first = thompson_rank(self._CANDS, seed=seed)
        second = thompson_rank(self._CANDS, seed=seed)

        self.assertEqual([r["key"] for r in first], [r["key"] for r in second])
        self.assertEqual([r["draw"] for r in first], [r["draw"] for r in second])

    def test_the_ranking_is_total_and_defined_for_fresh_candidates(self) -> None:
        ranked = thompson_rank(self._CANDS, seed=deterministic_seed("x"))

        self.assertEqual(len(ranked), 3)
        self.assertEqual({r["key"] for r in ranked}, {"a", "b", "fresh"})


class PressureIntegrationTest(unittest.TestCase):
    def test_no_labels_leaves_run_pressure_weights_bit_identical(self) -> None:
        # Golden: an unlabelled store scores exactly as before this change.
        from aria_kernel.pressure import SOURCE_WEIGHTS, run_pressure

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)

            result = run_pressure(cycle_id="cyc-z1", base_dir=root)

        detail = result["calibrated_weights"]
        for source, base in SOURCE_WEIGHTS.items():
            self.assertEqual(detail[source]["weight"], float(base))
            self.assertEqual(detail[source]["multiplier"], 1.0)

    def test_labels_change_the_weight_a_pressure_scores_with(self) -> None:
        # The deliberate-break twin: this test proves the feed link carries.
        # Severing the calibration block in run_pressure turns it red.
        from unittest.mock import patch

        from aria_kernel.pressure import run_pressure

        rows = [
            {"metadata": {"pressure_source": "uncertainty_repeat"},
             "verdict": "false_positive"}
        ] * 5
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            with patch("aria_kernel.feedback_store.load_feedback", return_value=rows):
                result = run_pressure(cycle_id="cyc-z1", base_dir=root)

        detail = result["calibrated_weights"]["uncertainty_repeat"]
        self.assertEqual(detail["fp"], 5)
        self.assertLess(detail["weight"], detail["base"])


if __name__ == "__main__":
    unittest.main()
