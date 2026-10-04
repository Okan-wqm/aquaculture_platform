"""ARIA-HIGH-279 — the class builder's origin is admitted, forging stays refused.

WHY. Program plan rev2 (HIGH ruling 6) routes a fix slice through the
deterministic class builder (CB-3): one finding per (class_key = tool:rule,
Nx project) slice, so the operator's single signed CP-1 request names exactly
one F finding. ``emit_finding`` admits only origins in the closed
``ORIGINATING_SKILL_ALLOWLIST`` (ADR-0002, AISAFETY-HIGH-008), and the class
builder had none, so it could not mint the finding the request must name.

WHAT these tests pin: the class builder's exact origin is admitted, and the
allowlist stays an exact-match set — no prefix, wildcard or near spelling of
it (or of the watchdog's prefix) gets through.
"""
from __future__ import annotations

import unittest

from aria_kernel.finding import ORIGINATING_SKILL_ALLOWLIST, _validate_originating_skill
from aria_kernel.tool_registry import GovernanceError

CLASS_BUILDER_ORIGIN = "class_builder:tool_rule"


class ClassBuilderOriginTests(unittest.TestCase):
    def test_the_class_builder_origin_is_admitted(self) -> None:
        self.assertIn(CLASS_BUILDER_ORIGIN, ORIGINATING_SKILL_ALLOWLIST)
        _validate_originating_skill(CLASS_BUILDER_ORIGIN)

    def test_near_spellings_and_prefixes_are_refused(self) -> None:
        for forged in (
            "class_builder:",
            "class_builder:*",
            "class_builder:tool_rule ",
            "class_builder:tool_rule:hr-module",
            "Class_Builder:tool_rule",
            "aria-watchdog:class_builder",
            "aria-watchdog:*",
        ):
            with self.subTest(forged=forged), self.assertRaises(GovernanceError):
                _validate_originating_skill(forged)

    def test_the_allowlist_holds_exact_origins_only(self) -> None:
        for origin in ORIGINATING_SKILL_ALLOWLIST:
            with self.subTest(origin=origin):
                self.assertRegex(origin, r"^[a-z_-]+:[a-z_-]+$")


if __name__ == "__main__":
    unittest.main()
