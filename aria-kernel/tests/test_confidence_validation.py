"""Out-of-range confidence is refused, never coerced toward certainty.

ORPHAN-HIGH-541 (PLAN §4d.1). Two modules disagreed about what an
out-of-range ``confidence`` means: `instinct_candidate` refused
(GovernanceError outside [0,1]) while `tool_runner._valid_memory_candidates`
accepted any non-negative number and CLAMPED it — ``min(float(confidence),
1.0)`` — so an adapter emitting a count, a severity grade, or a milliseconds
reading as ``confidence`` was silently promoted to 1.0, maximum certainty,
and flowed into `memory._record_belief` as a belief weight. A unit error
became a certainty, in the direction that matters most on a trust surface.

One definition now lives in `aria_kernel.confidence` and both callers use
it. An adapter candidate whose confidence is not a probability is DROPPED
(the adapter contract skips malformed candidates rather than aborting the
batch); an instinct candidate raises, as it always did.
"""

from __future__ import annotations

import math
import unittest

from aria_kernel.confidence import (
    CONFIDENCE_KINDS,
    confidence_in_unit_interval,
    validated_confidence,
)
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.tool_runner import _valid_memory_candidates


def _candidate(confidence) -> dict:
    return {
        "belief_id": "belief-x",
        "claim": "the repo uses nx",
        "confidence": confidence,
        "evidence_refs": ["nx.json"],
    }


class UnitIntervalTests(unittest.TestCase):
    def test_the_interval_is_inclusive(self) -> None:
        for value in (0.0, 0.5, 1.0):
            self.assertEqual(confidence_in_unit_interval(value), value)

    def test_everything_else_is_none(self) -> None:
        for value in (-0.001, 1.001, 5, -1, math.nan, math.inf, "0.7", None, [0.7]):
            self.assertIsNone(confidence_in_unit_interval(value), repr(value))

    def test_booleans_are_not_probabilities(self) -> None:
        """`True` is an int and would read as 1.0 — but a flag is a claim of
        kind, not of degree, and letting it through re-opens the coercion
        door this module closes."""
        self.assertIsNone(confidence_in_unit_interval(True))
        self.assertIsNone(confidence_in_unit_interval(False))


class ValidatedConfidenceTests(unittest.TestCase):
    def test_valid_input_round_trips(self) -> None:
        self.assertEqual(validated_confidence(0.7, kind="adapter_score"), 0.7)

    def test_out_of_range_raises(self) -> None:
        for value in (5, -0.1, math.nan, True, "0.9"):
            with self.assertRaises(GovernanceError):
                validated_confidence(value, kind="adapter_score")

    def test_the_kind_vocabulary_is_closed(self) -> None:
        with self.assertRaises(GovernanceError):
            validated_confidence(0.5, kind="vibes")
        self.assertIn("adapter_score", CONFIDENCE_KINDS)
        self.assertIn("instinct_score", CONFIDENCE_KINDS)


class AdapterCandidateConfidenceTests(unittest.TestCase):
    """The 541 defect itself, pinned at the callsite that had it."""

    def test_out_of_range_confidence_drops_the_candidate(self) -> None:
        valid = _valid_memory_candidates([_candidate(5)], "tool-x")
        self.assertEqual(valid, [])

    def test_no_surviving_candidate_exceeds_certainty(self) -> None:
        survivors = _valid_memory_candidates(
            [_candidate(0.4), _candidate(1.0), _candidate(2.0), _candidate(-1)],
            "tool-x",
        )
        self.assertEqual(len(survivors), 2)
        for candidate in survivors:
            self.assertLessEqual(candidate["confidence"], 1.0)
            self.assertGreaterEqual(candidate["confidence"], 0.0)

    def test_in_range_confidence_is_carried_verbatim(self) -> None:
        survivors = _valid_memory_candidates([_candidate(0.85)], "tool-x")
        self.assertEqual(survivors[0]["confidence"], 0.85)


class InstinctCandidateAlignmentTests(unittest.TestCase):
    def test_instinct_refusal_still_holds(self) -> None:
        from aria_kernel.instinct_candidate import record_candidate

        with self.assertRaises(GovernanceError):
            record_candidate(
                trigger_signal="x",
                action_observation="y",
                evidence_refs=[],
                confidence_0_to_1=1.5,
            )


if __name__ == "__main__":
    unittest.main()
