"""Plan 022 H-6 — max_triage_tier enforcement in triage.

Pre-Plan-022 fitness.py wrote 'max_triage_tier' on every fitness row
but triage.py never read it. An agent whose fitness ceiling was
'human_only' could still be assigned 'auto_fix_safe' work via
classify_pressure path-class result.

Fix: triage._enforce_max_triage_tier compares the classification to
the agent's fitness max_triage_tier and demotes to the (stricter)
ceiling when needed.
"""
from __future__ import annotations

import unittest

from aria_kernel.triage import _enforce_max_triage_tier


class EnforceMaxTriageTierTests(unittest.TestCase):
    def test_no_fitness_row_caps_at_default(self) -> None:
        """Plan 023 v3 §R-4 changed this behavior: missing fitness row
        now caps at needs_review (anonymous-agent default), not the
        Plan 022 §H-6 'no demotion' baseline. Anonymous agents could
        otherwise be assigned auto_fix_safe via path-class only."""
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe", fitness_row=None,
        )
        self.assertEqual(tier, "needs_review")
        self.assertTrue(
            any("missing_fitness_default_cap" in r for r in reasons),
            f"missing default-cap reason: {reasons!r}",
        )

    def test_max_equals_classification_no_demotion(self) -> None:
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row={"max_triage_tier": "auto_fix_safe"},
        )
        self.assertEqual(tier, "auto_fix_safe")
        self.assertEqual(reasons, [])

    def test_max_more_permissive_no_demotion(self) -> None:
        # Classification already stricter than the fitness max.
        # Fitness max=auto_fix_safe (most permissive), classification
        # human_only (stricter) -> classification stands.
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="human_only",
            fitness_row={"max_triage_tier": "auto_fix_safe"},
        )
        self.assertEqual(tier, "human_only")
        self.assertEqual(reasons, [])

    def test_max_stricter_demotes_classification(self) -> None:
        # Fitness max=needs_review, classification=auto_fix_safe ->
        # demote to needs_review.
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row={"max_triage_tier": "needs_review"},
        )
        self.assertEqual(tier, "needs_review")
        self.assertEqual(reasons, ["agent_max_triage_tier_ceiling:needs_review"])

    def test_human_only_ceiling_demotes_auto_fix_safe(self) -> None:
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row={"max_triage_tier": "human_only"},
        )
        self.assertEqual(tier, "human_only")
        self.assertIn("agent_max_triage_tier_ceiling:human_only", reasons)

    def test_blocked_ceiling_demotes_everything(self) -> None:
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row={"max_triage_tier": "blocked"},
        )
        self.assertEqual(tier, "blocked")

    def test_unknown_max_triage_tier_no_demotion(self) -> None:
        # Defensive: unknown tier in fitness row doesn't crash, just
        # leaves the classification alone.
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row={"max_triage_tier": "frobozz"},
        )
        self.assertEqual(tier, "auto_fix_safe")
        self.assertEqual(reasons, [])

    def test_missing_max_triage_tier_field_defaults_to_auto_fix_safe(self) -> None:
        # Missing field -> default cap = auto_fix_safe (no effective
        # demotion, classification stands).
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="needs_review",
            fitness_row={"agent_name": "x"},  # no max_triage_tier
        )
        self.assertEqual(tier, "needs_review")
        self.assertEqual(reasons, [])


if __name__ == "__main__":
    unittest.main()
