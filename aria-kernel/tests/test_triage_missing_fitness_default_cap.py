"""Plan 023 v3 §R-4 — missing fitness row default tier cap.

Pre-Plan-023 _enforce_max_triage_tier returned the classified tier
unchanged when fitness_row was None ("Missing fitness row -> no
demotion"). An anonymous or newly-introduced agent with no fitness
ledger row could be assigned 'auto_fix_safe' work via classify_
pressure path-class result alone, with no ceiling.

Plan 023 v3 §R-4 fix: missing fitness row caps the classification
at 'needs_review' (operator-readable default). The helper returns
the cap + a 'missing_fitness_default_cap:<tier>' reason; the caller
appends it to the row's reasons list. Anonymous agents can no longer
get auto_fix_safe via path-class alone.

Tests:
1. Missing fitness + classified='auto_fix_safe' → cap to needs_review.
2. Missing fitness + classified='needs_review' → unchanged.
3. Missing fitness + classified='human_only' → unchanged (already stricter).
4. Existing fitness row with stricter max_triage_tier still applies
   (Plan 022 §H-6 regression).
"""
from __future__ import annotations

import unittest

from aria_kernel.triage import _enforce_max_triage_tier


class MissingFitnessDefaultCapTests(unittest.TestCase):
    def test_missing_fitness_caps_auto_fix_safe(self) -> None:
        """Plan 023 v3 §R-4: anonymous agent + auto_fix_safe path-class
        → cap to needs_review."""
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row=None,
        )
        self.assertEqual(tier, "needs_review")
        self.assertTrue(
            any("missing_fitness_default_cap" in r for r in reasons),
            f"missing default-cap reason: {reasons!r}",
        )

    def test_missing_fitness_with_needs_review_unchanged(self) -> None:
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="needs_review",
            fitness_row=None,
        )
        self.assertEqual(tier, "needs_review")
        self.assertEqual(reasons, [])

    def test_missing_fitness_with_human_only_unchanged(self) -> None:
        """Already stricter than the default cap; helper does NOT
        loosen the ceiling."""
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="human_only",
            fitness_row=None,
        )
        self.assertEqual(tier, "human_only")
        self.assertEqual(reasons, [])

    def test_existing_fitness_max_triage_tier_still_applied(self) -> None:
        """Plan 022 §H-6 regression: when fitness HAS a row, the row's
        max_triage_tier is the binding cap (no longer the §R-4 default)."""
        tier, reasons = _enforce_max_triage_tier(
            classified_tier="auto_fix_safe",
            fitness_row={"max_triage_tier": "human_only"},
        )
        self.assertEqual(tier, "human_only")
        self.assertTrue(
            any("agent_max_triage_tier_ceiling" in r for r in reasons),
            f"missing H-6 reason: {reasons!r}",
        )


if __name__ == "__main__":
    unittest.main()
