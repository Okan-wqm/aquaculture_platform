"""Plan 026R §E.8 — memory self-output taxonomy extension.

4 tests:

* SELF_OUTPUT_PREFIXES constant shape.
* aria-findings/ blocked.
* aria-debts/ blocked.
* aria-proposals/ blocked.
"""
from __future__ import annotations

import unittest

from aria_kernel.memory import SELF_OUTPUT_PREFIXES, validate_repo_evidence
from aria_kernel.tool_registry import GovernanceError


class MemorySelfOutputTaxonomyTests(unittest.TestCase):
    def test_constant_includes_new_prefixes(self) -> None:
        expected_subset = {
            "aria-tools/",
            "agent-workspace/",
            ".aria-poc/",
            # §E.8 additions:
            "aria-findings/",
            "aria-debts/",
            "aria-proposals/",
            "aria-incidents/",
        }
        self.assertTrue(expected_subset.issubset(set(SELF_OUTPUT_PREFIXES)))

    def test_aria_findings_blocked(self) -> None:
        with self.assertRaises(GovernanceError):
            validate_repo_evidence(["aria-findings/F-001.json"])

    def test_aria_debts_blocked(self) -> None:
        with self.assertRaises(GovernanceError):
            validate_repo_evidence(["aria-debts/DEBT-001.json"])

    def test_aria_proposals_blocked(self) -> None:
        with self.assertRaises(GovernanceError):
            validate_repo_evidence(["aria-proposals/P-001.json"])


if __name__ == "__main__":
    unittest.main()
