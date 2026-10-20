"""WP-J D-1 — the stability temper: ONE flip table feeds the judge weights.

The stability lane (stability_reask) re-mints the same judge envelope blind
and records, per judge, whether the verdict flipped. That flip rate must
TEMPER the weight the calibration earned, linearly toward the prior, and a
judge that flips too often loses `calibrated` standing entirely — without a
second weight law: ``judge_weights_from_calibration`` stays the one place a
judge's weight is computed.
"""
from __future__ import annotations

import unittest

from aria_kernel.calibrated_intelligence import (
    PRIOR_A,
    PRIOR_B,
    STABILITY_MAX_FLIP,
    judge_weights_from_calibration,
)

_ROW = {
    "judges": [
        {"judge_id": "j-steady", "calibration_status": "calibrated",
         "true_positive": 90, "false_positive": 10},
        {"judge_id": "j-flippy", "calibration_status": "calibrated",
         "true_positive": 90, "false_positive": 10},
        {"judge_id": "j-unmeasured", "calibration_status": "calibrated",
         "true_positive": 90, "false_positive": 10},
    ]
}


class StabilityTemperTests(unittest.TestCase):
    def test_no_flip_table_is_bit_for_bit_the_legacy_weights(self) -> None:
        self.assertEqual(
            judge_weights_from_calibration(_ROW),
            judge_weights_from_calibration(_ROW, flip_rates=None),
        )

    def test_flip_rate_tempers_toward_the_prior_linearly(self) -> None:
        flip_rate = STABILITY_MAX_FLIP / 2  # inside the cap: temper, not block
        weights = judge_weights_from_calibration(_ROW, flip_rates={"j-steady": flip_rate})
        posterior = 94.0 / 105.0  # Beta(4+90, 1+10) mean
        prior = PRIOR_A / (PRIOR_A + PRIOR_B)
        expected = prior + (posterior - prior) * (1 - flip_rate)
        self.assertAlmostEqual(weights["j-steady"], expected, places=10)
        self.assertLess(weights["j-steady"], posterior)

    def test_unmeasured_judge_keeps_its_untempered_weight(self) -> None:
        plain = judge_weights_from_calibration(_ROW)
        tempered = judge_weights_from_calibration(
            _ROW, flip_rates={"j-steady": STABILITY_MAX_FLIP / 2},
        )
        self.assertEqual(tempered["j-unmeasured"], plain["j-unmeasured"])

    def test_flip_rate_above_the_cap_blocks_calibrated_standing(self) -> None:
        weights = judge_weights_from_calibration(
            _ROW, flip_rates={"j-flippy": STABILITY_MAX_FLIP + 0.01},
        )
        self.assertEqual(weights["j-flippy"], PRIOR_A / (PRIOR_A + PRIOR_B))

    def test_flip_rate_at_the_cap_still_tempers_not_blocks(self) -> None:
        # The cap is inclusive: at exactly STABILITY_MAX_FLIP the judge is
        # tempered (to (1-cap) of its earned edge), not blocked.
        weights = judge_weights_from_calibration(
            _ROW, flip_rates={"j-flippy": STABILITY_MAX_FLIP},
        )
        posterior = 94.0 / 105.0
        prior = PRIOR_A / (PRIOR_A + PRIOR_B)
        expected = prior + (posterior - prior) * (1 - STABILITY_MAX_FLIP)
        self.assertAlmostEqual(weights["j-flippy"], expected, places=10)
        self.assertLess(weights["j-flippy"], posterior)


if __name__ == "__main__":
    unittest.main()
