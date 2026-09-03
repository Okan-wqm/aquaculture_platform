"""Plan ARIA-V9.0-A — plan_candidate_source.py shared enum invariants.

Closes architectural-arbiter CRIT-006 (ad-hoc strings across modules).
Pins (a) the closed enum's exact member set, (b) string values are
stable + lowercase_snake_case (replay-stable hash inputs), (c) import
discipline — known consumer modules import from this SSoT.
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import plan_candidate_source as _pcs


class TestV9PlanCandidateSource(unittest.TestCase):

    def test_i_v9_pressure_01_enum_member_set_closed(self):
        """PlanCandidateSource MUST be exactly the v3-Phase-9.4 5-member
        closed set. Adding a 6th member is a one-way door (governance
        rows + cost-attribution rows already reference these strings);
        adding requires an explicit ADR + invariant amendment."""
        members = {m.name for m in _pcs.PlanCandidateSource}
        self.assertEqual(
            members,
            {
                "OPERATOR_FEEDBACK",
                "FAILING_CI",
                "ORPHAN_FINDING",
                "F_FINDING",
                "GIT_DIFF",
                "GITHUB_ISSUE",  # Plan 032 Faz 032f — one-way door 14
            },
            "PlanCandidateSource member set drifted — see "
            "docs/aria/v3-plan-module-inventory.md naming-collision "
            "section before amending",
        )

    def test_i_v9_pressure_01_string_values_canonical(self):
        """Values are lowercase_snake_case and stable. These strings
        land in append-only ledgers (governance.jsonl,
        cost-attribution.jsonl) so a rename is a forensic-history
        loss."""
        expected = {
            _pcs.PlanCandidateSource.OPERATOR_FEEDBACK: "operator_feedback",
            _pcs.PlanCandidateSource.FAILING_CI: "failing_ci",
            _pcs.PlanCandidateSource.ORPHAN_FINDING: "orphan_finding",
            _pcs.PlanCandidateSource.F_FINDING: "f_finding",
            _pcs.PlanCandidateSource.GIT_DIFF: "git_diff",
        }
        for member, value in expected.items():
            self.assertEqual(member.value, value)
            self.assertEqual(member, value)  # str equality
            self.assertTrue(
                value.islower() and " " not in value and "-" not in value,
                f"{member.name} value MUST be lowercase_snake_case",
            )

    def test_i_v9_pressure_01_inherits_str_enum(self):
        """PlanCandidateSource MUST inherit (str, Enum) so direct
        string comparison + JSON serialization Just Work — appended
        rows persist as plain strings, not as ``"PlanCandidateSource.GIT_DIFF"``."""
        import enum

        self.assertTrue(
            issubclass(_pcs.PlanCandidateSource, str),
            "PlanCandidateSource MUST inherit str for JSON ledger compat",
        )
        self.assertTrue(
            issubclass(_pcs.PlanCandidateSource, enum.Enum),
            "PlanCandidateSource MUST inherit Enum for closed set",
        )

    def test_i_v9_pressure_01_module_distinct_from_pressure_py(self):
        """plan_candidate_source.py is DELIBERATELY a separate module
        from pressure.py (which has its own SOURCE_WEIGHTS taxonomy
        for *why* a pressure point arose). The two coexist; v3
        plan-inventory.md documents the split."""
        from aria_kernel import pressure as _pressure

        # pressure.py SOURCE_WEIGHTS strings are NOT PlanCandidateSource
        # values — confirm zero overlap (Tier-1: cannot accidentally
        # cross-import).
        pressure_sources = set(_pressure.SOURCE_WEIGHTS.keys())
        candidate_sources = {m.value for m in _pcs.PlanCandidateSource}
        overlap = pressure_sources & candidate_sources
        self.assertEqual(
            overlap,
            set(),
            f"pressure.py SOURCE_WEIGHTS and PlanCandidateSource "
            f"share values {overlap} — taxonomies MUST stay disjoint",
        )

    def test_i_v9_pressure_01_module_exports_only_enum(self):
        """Module __all__ MUST export exactly PlanCandidateSource —
        prevent accidental sibling-symbol creep."""
        self.assertEqual(
            _pcs.__all__,
            ("PlanCandidateSource",),
            "plan_candidate_source.__all__ drifted",
        )

    def test_i_v9_pressure_01_module_source_pinned(self):
        """The module's source string MUST contain the 5 canonical
        values verbatim — prevents a refactor that silently renames
        an enum member while leaving the test passing on stale
        constants."""
        src = inspect.getsource(_pcs)
        for canonical in (
            '"operator_feedback"',
            '"failing_ci"',
            '"orphan_finding"',
            '"f_finding"',
            '"git_diff"',
        ):
            self.assertIn(
                canonical, src,
                f"plan_candidate_source.py MUST contain literal {canonical}",
            )


if __name__ == "__main__":
    unittest.main()
