"""F1.3 slice a — `judge_calibration.exact_binomial_interval`: the exact proportion interval.

The plan's section-test claim reads "0/13 located, [0, 24.7%]". 24.7% is the
exact (Clopper-Pearson) upper bound for 0 of 13; the Wilson upper bound for the
same count is 0.2281, so a caller that wants the plan's number cannot get it
from `wilson_lower`, the one proportion-interval owner beside which this
function lives. Its caller in the baseline exam is the labelled legacy 0/13.

What is pinned, each case failing when the behaviour breaks:

* the numbers the specification lists, for the counts the exam and its later
  slices use (0/13, 0/9, 0/4, 10/13, 13/13, ...), at 95 % and at 99 %;
* the closed forms at k = 0 and k = n, from the formula and not from a table;
* the DEFINITION of the interval, for interior counts: the exact binomial tail
  at the returned bound reaches alpha/2 (the bound is rounded to 4 decimals, so
  the tail is bracketed over the rounding step), up to n = 2000 where a naive
  factorial or product body overflows or loses the tail;
* the containment properties against `wilson_lower` for every (k, n) with
  n <= 30: a Wilson-score or normal-approximation body is narrower than the
  exact interval and fails them;
* the refusals: no trials is None, a count outside 0..trials or a confidence
  outside (0, 1) is a ValueError.

NEW API: `exact_binomial_interval` does not exist at the branch base, so every
test that calls it is red there because the name is missing; the assertion that
names it comes first so the failure says so.
"""
from __future__ import annotations

import math
import unittest
from typing import Callable

from aria_kernel import judge_calibration
from aria_kernel.judge_calibration import wilson_lower

# The rounding step of the returned bounds: 4 decimals.
_HALF_STEP = 0.5e-4


class _IntervalTestCase(unittest.TestCase):
    def interval(self) -> Callable[..., tuple[float, float] | None]:
        self.assertTrue(
            hasattr(judge_calibration, "exact_binomial_interval"),
            "judge_calibration.exact_binomial_interval does not exist: the exact (Clopper-Pearson) "
            "interval has no owner beside wilson_lower",
        )
        return judge_calibration.exact_binomial_interval


def _log_pmf(k: int, n: int, p: float) -> float:
    return (math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
            + k * math.log(p) + (n - k) * math.log1p(-p))


def _upper_tail(k: int, n: int, p: float) -> float:
    """P(X >= k) for X ~ Binomial(n, p), summed in log space (valid to n = 2000)."""
    return min(1.0, sum(math.exp(_log_pmf(i, n, p)) for i in range(k, n + 1)))


def _lower_tail(k: int, n: int, p: float) -> float:
    """P(X <= k) for X ~ Binomial(n, p)."""
    return min(1.0, sum(math.exp(_log_pmf(i, n, p)) for i in range(0, k + 1)))


class ListedValues(_IntervalTestCase):
    def test_the_specified_95_percent_intervals(self) -> None:
        interval = self.interval()
        listed = (
            ((0, 13), (0.0, 0.2471)),
            ((0, 9), (0.0, 0.3363)),
            ((0, 4), (0.0, 0.6024)),
            ((10, 13), (0.4619, 0.9496)),
            ((3, 10), (0.0667, 0.6525)),
            ((13, 13), (0.7529, 1.0)),
            ((1, 20), (0.0013, 0.2487)),
            ((0, 1000), (0.0, 0.0037)),
            ((500, 1000), (0.4685, 0.5315)),
        )
        for (successes, trials), expected in listed:
            with self.subTest(successes=successes, trials=trials):
                self.assertEqual(interval(successes, trials), expected)

    def test_the_plans_upper_bound_is_the_exact_one_not_wilsons(self) -> None:
        # The plan prints [0, 24.7%] for 0/13. Wilson's upper bound for the same
        # count is 0.2281 (1 - wilson_lower(13, 13)): the two differ at the second
        # decimal, so the plan's number can only come from the exact interval.
        interval = self.interval()
        self.assertEqual(interval(0, 13), (0.0, 0.2471))
        wilson_upper = round(1.0 - wilson_lower(13, 13), 4)
        self.assertEqual(wilson_upper, 0.2281)
        self.assertGreater(interval(0, 13)[1], wilson_upper)

    def test_the_99_percent_interval_for_zero_of_thirteen(self) -> None:
        self.assertEqual(self.interval()(0, 13, confidence=0.99), (0.0, 0.3347))

    def test_the_default_confidence_is_95_percent(self) -> None:
        interval = self.interval()
        self.assertEqual(interval(3, 10), interval(3, 10, confidence=0.95))

    def test_the_result_is_a_pair_of_floats_rounded_to_four_decimals(self) -> None:
        interval = self.interval()
        for successes, trials in ((0, 13), (2, 7), (13, 13), (40, 117)):
            with self.subTest(successes=successes, trials=trials):
                result = interval(successes, trials)
                self.assertIsInstance(result, tuple)
                self.assertEqual(len(result), 2)
                for bound in result:
                    self.assertIsInstance(bound, float)
                    self.assertEqual(bound, round(bound, 4))


class ClosedFormsAtTheEnds(_IntervalTestCase):
    """k = 0 and k = n have closed forms: 1 - (alpha/2)^(1/n) and (alpha/2)^(1/n)."""

    def test_zero_successes_upper_bound_is_one_minus_the_root_of_alpha_over_two(self) -> None:
        interval = self.interval()
        for trials in (1, 2, 5, 13, 50, 400, 2000):
            for confidence in (0.95, 0.99, 0.9):
                with self.subTest(trials=trials, confidence=confidence):
                    alpha_half = (1.0 - confidence) / 2.0
                    self.assertEqual(interval(0, trials, confidence=confidence),
                                     (0.0, round(1.0 - alpha_half ** (1.0 / trials), 4)))

    def test_all_successes_lower_bound_is_the_root_of_alpha_over_two(self) -> None:
        interval = self.interval()
        for trials in (1, 2, 5, 13, 50, 400, 2000):
            for confidence in (0.95, 0.99, 0.9):
                with self.subTest(trials=trials, confidence=confidence):
                    alpha_half = (1.0 - confidence) / 2.0
                    self.assertEqual(interval(trials, trials, confidence=confidence),
                                     (round(alpha_half ** (1.0 / trials), 4), 1.0))


class TheBoundsAreDefinedByTheExactTail(_IntervalTestCase):
    """For 0 < k < n the lower bound p_lo has P(X >= k | p_lo) = alpha/2 and the upper bound
    p_hi has P(X <= k | p_hi) = alpha/2. The bounds come back rounded, so the tail is
    bracketed over the rounding step: the true bound lies inside it, and each tail is
    monotone in p. A Wilson body, a normal approximation, a mid-p interval or a body that
    loses the tail at large n lands outside the bracket."""

    GRID = (
        (1, 2), (1, 3), (2, 5), (3, 10), (6, 13), (12, 13), (1, 13), (7, 50), (25, 50), (49, 50),
        (3, 200), (100, 200), (197, 200), (1, 1000), (500, 1000), (999, 1000),
        (1, 2000), (1000, 2000), (1999, 2000),
    )

    def test_the_lower_and_upper_bounds_reach_alpha_over_two_at_95_percent(self) -> None:
        self._check_grid(0.95)

    def test_the_lower_and_upper_bounds_reach_alpha_over_two_at_99_percent(self) -> None:
        self._check_grid(0.99)

    def _check_grid(self, confidence: float) -> None:
        interval = self.interval()
        alpha_half = (1.0 - confidence) / 2.0
        for successes, trials in self.GRID:
            with self.subTest(successes=successes, trials=trials, confidence=confidence):
                lower, upper = interval(successes, trials, confidence=confidence)
                # sf(k | p) rises with p: below the true lower bound it is under alpha/2.
                self.assertLessEqual(_upper_tail(successes, trials, max(lower - _HALF_STEP, 1e-12)), alpha_half * (1 + 1e-9))
                self.assertGreaterEqual(_upper_tail(successes, trials, min(lower + _HALF_STEP, 1 - 1e-12)), alpha_half * (1 - 1e-9))
                # cdf(k | p) falls with p: above the true upper bound it is under alpha/2.
                self.assertLessEqual(_lower_tail(successes, trials, min(upper + _HALF_STEP, 1 - 1e-12)), alpha_half * (1 + 1e-9))
                self.assertGreaterEqual(_lower_tail(successes, trials, max(upper - _HALF_STEP, 1e-12)), alpha_half * (1 - 1e-9))


class ContainmentProperties(_IntervalTestCase):
    def test_every_count_up_to_thirty_is_inside_the_interval_and_the_interval_contains_wilsons(self) -> None:
        interval = self.interval()
        for trials in range(1, 31):
            for successes in range(trials + 1):
                with self.subTest(successes=successes, trials=trials):
                    lower, upper = interval(successes, trials)
                    self.assertLessEqual(lower, successes / trials)
                    self.assertLessEqual(successes / trials, upper)
                    # The exact interval is the conservative one: it contains Wilson's. Wilson's
                    # interval is symmetric, so its upper bound is 1 - wilson_lower(n - k, n).
                    self.assertLessEqual(lower, wilson_lower(successes, trials))
                    self.assertGreaterEqual(upper, round(1.0 - wilson_lower(trials - successes, trials), 4))

    def test_the_99_percent_interval_is_strictly_wider_than_the_95_percent_one(self) -> None:
        interval = self.interval()
        for trials in range(1, 31):
            for successes in range(trials + 1):
                with self.subTest(successes=successes, trials=trials):
                    low95, high95 = interval(successes, trials, confidence=0.95)
                    low99, high99 = interval(successes, trials, confidence=0.99)
                    self.assertLessEqual(low99, low95)
                    self.assertGreaterEqual(high99, high95)
                    self.assertGreater(high99 - low99, high95 - low95)

    def test_the_interval_is_symmetric_under_swapping_successes_and_failures(self) -> None:
        interval = self.interval()
        for trials in (4, 13, 29):
            for successes in range(trials + 1):
                with self.subTest(successes=successes, trials=trials):
                    lower, upper = interval(successes, trials)
                    mirror_lower, mirror_upper = interval(trials - successes, trials)
                    self.assertAlmostEqual(lower, round(1.0 - mirror_upper, 4), places=4)
                    self.assertAlmostEqual(upper, round(1.0 - mirror_lower, 4), places=4)


class Refusals(_IntervalTestCase):
    def test_no_trials_is_none_not_a_number(self) -> None:
        interval = self.interval()
        self.assertIsNone(interval(0, 0))
        self.assertIsNone(interval(0, -1))

    def test_a_count_outside_zero_to_trials_is_a_value_error(self) -> None:
        interval = self.interval()
        with self.assertRaises(ValueError):
            interval(-1, 13)
        with self.assertRaises(ValueError):
            interval(14, 13)

    def test_a_confidence_outside_zero_to_one_is_a_value_error(self) -> None:
        interval = self.interval()
        for confidence in (1.0, 0.0, 1.5, -0.1):
            with self.subTest(confidence=confidence):
                with self.assertRaises(ValueError):
                    interval(0, 13, confidence=confidence)


if __name__ == "__main__":
    unittest.main()
