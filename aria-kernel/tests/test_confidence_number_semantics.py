"""NaN and bool are not probabilities — the unit-interval gate everywhere.

The 2026-09-01 audit reproduced all three sites accepting them:
``record_operator_feedback`` (isinstance passes True; ``nan < 0`` and
``nan > 1`` are both False), the consensus mean (isinstance-only filter),
and the judge bridge's envelope path (isinstance-only coercion to None).
All three now run ``confidence.confidence_in_unit_interval`` — the one
gate the kernel already had — instead of three local interpretations.
"""
from __future__ import annotations

import math
import unittest

from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class ConfidenceNumberSemanticsTests(unittest.TestCase):
    def setUp(self) -> None:
        import shutil
        import tempfile
        from pathlib import Path

        self._tmp = Path(tempfile.mkdtemp(prefix="aria-conf-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")

    def _feedback(self, confidence: object) -> None:
        record_operator_feedback(
            tool_id="tool-a",
            run_id="run-1",
            finding_id="F-1",
            verdict="true_positive",
            severity="high",
            note="x",
            confidence=confidence,  # type: ignore[arg-type]
            base_dir=self.tools,
        )

    def test_nan_confidence_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._feedback(float("nan"))

    def test_boolean_confidence_is_refused(self) -> None:
        # True is an int to isinstance; a probability it is not.
        with self.assertRaises(GovernanceError):
            self._feedback(True)
        with self.assertRaises(GovernanceError):
            self._feedback(False)

    def test_infinite_and_out_of_range_still_refused(self) -> None:
        for bad in (math.inf, -math.inf, 1.5, -0.1):
            with self.subTest(value=bad), self.assertRaises(GovernanceError):
                self._feedback(bad)

    def test_valid_confidence_still_accepted(self) -> None:
        self._feedback(0.87)
        self._feedback(1)
        self._feedback(0)


if __name__ == "__main__":
    unittest.main()
