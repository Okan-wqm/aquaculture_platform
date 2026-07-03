"""Credit-exhaustion fallback wiring — executor source-structure pins.

The fable→opus@xhigh credit fallback lives inside the two executor dispatch
functions, which need a full lease/dispatch environment to run end-to-end.
The load-bearing policy is therefore pinned at the SOURCE level (the same
technique the convergence drainer's coverage phase uses): the credit branch
must exist next to the K2 refusal branch, guard on model=="fable", retry on
opus at xhigh effort, and share the single-retry budget via
_fell_back_to_opus. Detection itself is unit-tested in
test_claude_runtime_contract.CreditExhaustionDetectionTests.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
_CI = (_POC / "ci_executor.py").read_text(encoding="utf-8")
_WORKER = (_POC / "worker_executor.py").read_text(encoding="utf-8")


class CreditFallbackWiringTests(unittest.TestCase):
    def _assert_credit_branch(self, src: str, label: str) -> None:
        # The guard: credit_exhaustion present AND the exhausted model was fable.
        self.assertRegex(
            src,
            r"completed\.credit_exhaustion is not None and \w+\.model == \"fable\"",
            f"{label}: credit fallback guard missing/renamed",
        )
        # The retry is on opus at xhigh ("ultra code") effort.
        credit_idx = src.index("credit_exhaustion is not None and")
        window = src[credit_idx:credit_idx + 1400]
        self.assertIn('model="opus"', window, f"{label}: credit fallback not on opus")
        self.assertIn('effort="xhigh"', window, f"{label}: credit fallback effort not xhigh")

    def _assert_single_retry_budget(self, src: str, label: str) -> None:
        self.assertIn("_fell_back_to_opus = False", src, f"{label}: retry-budget flag missing")
        # The refusal branch must respect the shared budget so a credit
        # fallback followed by an opus refusal escalates instead of re-retrying.
        self.assertRegex(
            src,
            r"completed\.refusal is not None and \w+\.model == \"fable\" and not _fell_back_to_opus",
            f"{label}: refusal branch does not share the single-retry budget",
        )

    def test_ci_executor_credit_branch(self) -> None:
        self._assert_credit_branch(_CI, "ci_executor")
        self._assert_single_retry_budget(_CI, "ci_executor")
        # ci_executor emits a governance row the operator tunes markers from.
        self.assertIn('"model_credit_fallback_attempted"', _CI)

    def test_worker_executor_credit_branch(self) -> None:
        self._assert_credit_branch(_WORKER, "worker_executor")
        self._assert_single_retry_budget(_WORKER, "worker_executor")
        # worker_executor surfaces the marker on stderr (its audit channel).
        self.assertIn("model_credit_fallback assignment=", _WORKER)

    def test_credit_branch_precedes_refusal_branch(self) -> None:
        # Credit (harder failure) is checked before the refusal branch in both.
        for src, label in ((_CI, "ci_executor"), (_WORKER, "worker_executor")):
            credit = src.index("credit_exhaustion is not None and")
            refusal = src.index("refusal is not None and")
            self.assertLess(credit, refusal, f"{label}: credit branch must precede refusal branch")


if __name__ == "__main__":
    unittest.main()
