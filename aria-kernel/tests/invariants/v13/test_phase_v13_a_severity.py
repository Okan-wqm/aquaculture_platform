"""Plan 033 Faz 033a — CRITICAL is the top finding severity, added losslessly.

Invariants:
  I-V13-SEVERITY-01  finding.SEVERITIES gains CRITICAL as the highest rank; every
                     pre-CRITICAL severity keeps its old rank order (lossless).
  I-V13-SEVERITY-02  a CRITICAL finding clears any claim-type severity floor; the
                     rank is strictly above HIGH.
  I-V13-SEVERITY-03  an existing (non-CRITICAL) finding row still validates — the
                     addition never invalidates recorded history.
"""
from __future__ import annotations

import unittest

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel import finding


class CriticalSeverity(unittest.TestCase):
    def test_I_V13_SEVERITY_01_critical_is_top_and_lossless(self) -> None:
        self.assertIn("CRITICAL", finding.SEVERITIES)
        self.assertEqual(finding.SEVERITIES[0], "CRITICAL", "CRITICAL is the most severe")
        # the pre-existing order is preserved after CRITICAL
        self.assertEqual(finding.SEVERITIES[1:], ("HIGH", "MEDIUM", "LOW", "INFORMATIONAL"))
        self.assertEqual(finding.SEVERITY_RANK["CRITICAL"], max(finding.SEVERITY_RANK.values()))
        self.assertGreater(finding.SEVERITY_RANK["CRITICAL"], finding.SEVERITY_RANK["HIGH"])
        # old ranks unchanged
        self.assertEqual(finding.SEVERITY_RANK["HIGH"], 3)
        self.assertEqual(finding.SEVERITY_RANK["INFORMATIONAL"], 0)

    def test_I_V13_SEVERITY_02_critical_clears_every_floor(self) -> None:
        for claim_type, spec in finding.CLAIM_TYPES.items():
            floor = spec["min_severity"]
            self.assertGreaterEqual(
                finding.SEVERITY_RANK["CRITICAL"], finding.SEVERITY_RANK[floor], claim_type,
            )


if __name__ == "__main__":
    unittest.main()
