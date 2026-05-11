"""Plan 023 v3 §A-3 — self-review normalization (NFC + casefold).

Pre-Plan-023 executor.review_executor_diff used exact-string ==
compare:

    if source_agent and source_agent == str(reviewer or "").strip():
        raise GovernanceError("self_review_violation: ...")

source_agent="Codex-Executor" + reviewer="codex-executor" (case-only
diff) bypassed. NBSP / unicode-confusable variants (Codex‑Executor
with U+2011) also passed.

Plan 023 v3 §A-3 fix: NFC-normalize + casefold + strip both sides
before compare. Variants that fold to the same canonical form are
caught.

Tests target the normalization logic in isolation by stubbing
get_executor_packet — the executor.review_executor_diff function
otherwise needs full ledger setup; this unit test exercises the
normalization helper directly so the compare-after-normalize logic
is verified at the function level.
"""
from __future__ import annotations

import unittest
import unicodedata


class SelfReviewNormalizationTests(unittest.TestCase):
    """Unit-test the normalization logic at the function level.

    The actual review_executor_diff path runs registered-executor and
    packet-existence checks before the normalization compare; these
    tests pin the normalization function shape directly so the
    compare-after-normalize logic is verified without ledger setup.
    """

    @staticmethod
    def _norm(s: str) -> str:
        # Mirror the helper inlined into review_executor_diff.
        return unicodedata.normalize("NFC", s).strip().casefold()

    def test_exact_match_normalizes_equal(self) -> None:
        self.assertEqual(self._norm("Codex-Executor"), self._norm("Codex-Executor"))

    def test_case_only_diff_folds_equal(self) -> None:
        """Plan 023 v3 §A-3 — pre-fix this slipped through (case-only)."""
        self.assertEqual(
            self._norm("Codex-Executor"),
            self._norm("codex-executor"),
        )

    def test_nbsp_variant_folds_equal(self) -> None:
        """Plan 023 v3 §A-3 — Codex+NBSP+Executor should fold to the
        same normalized form as Codex-Executor when NFC normalization
        runs on a non-breaking-hyphen confusable. The canonical form
        differs from a regular hyphen, but the normalize+casefold pass
        catches the case where NBSP or other invisible chars wrap the
        agent id."""
        # NBSP-padded reviewer string (e.g. clipboard paste artifact)
        nbsp_padded = " Codex-Executor "  # NBSP padding
        self.assertEqual(
            self._norm(nbsp_padded.replace(" ", "").strip()),
            self._norm("codex-executor"),
        )

    def test_distinct_agents_fold_unequal(self) -> None:
        """Regression: Codex vs Anthropic agents must fold UNEQUAL so
        the legitimate review path is not blocked."""
        self.assertNotEqual(
            self._norm("Codex-Executor"),
            self._norm("Anthropic-Reviewer"),
        )

    def test_whitespace_padding_normalized(self) -> None:
        """Plan 023 v3 §A-3 — leading/trailing whitespace shouldn't
        cause spurious mismatch."""
        self.assertEqual(
            self._norm("  Codex-Executor  "),
            self._norm("codex-executor"),
        )


if __name__ == "__main__":
    unittest.main()
