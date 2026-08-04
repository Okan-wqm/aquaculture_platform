"""A plan that CONVERGED is not a plan that WORKED.

PLAN gap 7. When the convergent gate resolves, the memory phase records
the result as a `convention` pattern at a hard-coded confidence of 0.9 —
before the change has been merged, before CI has run against it, before
any outcome exists at all. `MIN_PATTERN_CONFIDENCE` is 0.7, so that row
is immediately served by `lookup_pattern` to later planners as
established knowledge.

Convergence is real evidence: a planner, a challenger and a cross-review
agreed. It is evidence about AGREEMENT, not about outcome. Recording it
at a confidence above the serving floor makes ARIA teach itself its own
predictions as facts.

The row is still recorded — the observation is worth keeping. It is
recorded as a hypothesis, below the floor, so it is not handed to the
next planner as something already known. Promotion on a VERIFIED outcome
(and demotion on a rolled-back one) is Wave 10's work; this is the half
that stops the false claim.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.knowledge_graph import (
    MIN_PATTERN_CONFIDENCE,
    Pattern,
    lookup_pattern,
    record_convention,
)
from aria_kernel.cycle_phases.memory import CONVENTION_HYPOTHESIS_CONFIDENCE

SIGNER = "SHA256:" + "a" * 43


class ConventionOutcomeStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name)

    def _record(self, confidence: float, *, outcome_status: str | None = None) -> Pattern:
        kwargs = {}
        if outcome_status is not None:
            kwargs["outcome_status"] = outcome_status
        pattern = Pattern(
            pattern_id="conv_test_0001",
            pattern_type="convention",
            confidence=confidence,
            evidence_refs=("docs/a.md",),
            discovered_by_cycle_id="cycle-1",
            observed_at="2026-08-03T00:00:00Z",
            **kwargs,
        )
        record_convention(pattern, workspace_root=self.workspace, signer_key_fp=SIGNER)
        return pattern

    def test_a_pre_outcome_convention_is_below_the_serving_floor(self) -> None:
        """The whole point: it is stored, and it is not served."""
        self.assertLess(
            CONVENTION_HYPOTHESIS_CONFIDENCE,
            MIN_PATTERN_CONFIDENCE,
            "a hypothesis recorded at or above the lookup floor is handed to the "
            "next planner as established knowledge, which is the defect",
        )
        self._record(CONVENTION_HYPOTHESIS_CONFIDENCE, outcome_status="hypothesis")
        self.assertIsNone(
            lookup_pattern("conv_test_0001", workspace_root=self.workspace),
            "a pre-outcome convention was surfaced as established knowledge",
        )

    def test_the_row_is_still_recorded_and_readable(self) -> None:
        """Not-served is not the same as not-kept."""
        self._record(CONVENTION_HYPOTHESIS_CONFIDENCE, outcome_status="hypothesis")
        row = lookup_pattern(
            "conv_test_0001", workspace_root=self.workspace, min_confidence=0.0
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["outcome_status"], "hypothesis")
        self.assertEqual(row["confidence"], CONVENTION_HYPOTHESIS_CONFIDENCE)

    def test_outcome_status_defaults_for_rows_that_predate_the_field(self) -> None:
        """Old rows must not be silently relabelled as verified.

        Every convention recorded before this change was also written
        pre-outcome. Defaulting them to 'verified' would assert something
        the ledger never observed; 'unknown' says exactly what is known.
        """
        pattern = self._record(0.9)
        self.assertEqual(pattern.outcome_status, "unknown")

    def test_an_outcome_verified_convention_is_served(self) -> None:
        """Wave 10 promotes on a VERIFIED outcome; the shape must allow it."""
        self._record(0.9, outcome_status="verified")
        row = lookup_pattern("conv_test_0001", workspace_root=self.workspace)
        self.assertIsNotNone(row)
        self.assertEqual(row["outcome_status"], "verified")


if __name__ == "__main__":
    unittest.main()
