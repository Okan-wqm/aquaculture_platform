"""Plan 023 v3.1 §R-3-followup — expected_cmd_substring coverage on
all required-test spec tables.

Plan 023 v3 §R-3 added expected_cmd_substring + the
_check_required_test_cmd_correlation helper, but only the
auth_change spec table got the field migrated. The post-sign-off
audit confirmed that tenant_change, schema_change, and event_change
specs still allowed `cmd: 'echo ok'` to satisfy any required test —
the cmd-correlation gate fired ONLY for auth_change risk type.

Plan 023 v3.1 fix: every required-test spec across all four risk
type tables (auth_change, tenant_change, schema_change, event_change)
now carries expected_cmd_substring. The cmd-correlation gate fires
uniformly across the matrix.
"""
from __future__ import annotations

import unittest

from aria_kernel.validation_matrix_gate import _REQUIRED_TESTS_BY_RISK


class CmdSubstringCoverageTests(unittest.TestCase):
    def test_every_required_test_has_expected_cmd_substring(self) -> None:
        """Plan 023 v3.1 §R-3-followup: every entry in
        _REQUIRED_TESTS_BY_RISK across all risk types MUST declare
        expected_cmd_substring as a non-empty string."""
        gaps: list[str] = []
        for risk_type, specs in _REQUIRED_TESTS_BY_RISK.items():
            for spec in specs:
                substr = spec.get("expected_cmd_substring")
                if not isinstance(substr, str) or not substr.strip():
                    gaps.append(f"{risk_type}/{spec.get('name')}")
        self.assertEqual(
            gaps, [],
            f"required tests missing expected_cmd_substring: {gaps!r}",
        )

    def test_all_four_risk_types_present(self) -> None:
        """Regression: the four risk-type tables exist."""
        for rt in ("auth_change", "tenant_change", "schema_change", "event_change"):
            self.assertIn(rt, _REQUIRED_TESTS_BY_RISK)
            self.assertGreater(len(_REQUIRED_TESTS_BY_RISK[rt]), 0)


if __name__ == "__main__":
    unittest.main()
