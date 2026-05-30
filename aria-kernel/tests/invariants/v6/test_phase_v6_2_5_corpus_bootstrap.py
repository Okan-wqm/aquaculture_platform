"""Plan ARIA-V6 §3 V6.2.5 Phase 6.2.5 B-V5-1 — corpus bootstrap invariants.

Three invariants pin the calibration_bootstrap operator-workflow
contract:

  * I-V6.2.5-01 — label vocab + severity vocab + finalize floor are
                  pinned at module scope (refactor-resistant).
  * I-V6.2.5-02 — finalize_corpus refuses to migrate when fewer than
                  ``min_labels`` (default 10) entries exist for the
                  tool. This is the structural lower bound on the
                  per-tool corpus that V6.2 sandbox can validate
                  against.
  * I-V6.2.5-03 — list_corpus_status surfaces ``latest_label_age_days``
                  per tool so the operator sees adapters approaching
                  the 90-day freshness floor before V6.2 starts
                  rejecting them at validate_calibration_corpus_sanity.
"""

from __future__ import annotations

import inspect
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV6_2_5CorpusBootstrap(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v6_2_5-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard",
            operator_approval_ref="v6_2_5-test",
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # I-V6.2.5-01 — vocab + finalize floor pinned at module scope.
    def test_i_v6_2_5_01_vocab_and_floor_pinned(self) -> None:
        """Plan ARIA-V6 §3 V6.2.5 — refactor-resistant module surface."""
        import aria_kernel.calibration_bootstrap as mod
        self.assertEqual(
            mod._LABEL_VOCAB,
            frozenset({"tp", "fp", "true_positive", "false_positive"}),
            msg=(
                "Label vocab is the canonical TP/FP enumeration; "
                "extending it requires V6.2 sandbox + V6.2.5 finalizer "
                "co-update. Drift here breaks corpus validation."
            ),
        )
        self.assertEqual(
            mod._SEVERITY_VOCAB,
            frozenset({"CRITICAL", "HIGH", "MEDIUM", "LOW"}),
            msg="Severity vocab pinned by V6.2 critical_FP gate.",
        )
        # finalize_corpus min_labels default MUST be 10 (sandbox floor).
        sig = inspect.signature(mod.finalize_corpus)
        param = sig.parameters["min_labels"]
        self.assertEqual(
            param.default, 10,
            msg=(
                "Plan ARIA-V6 §3 V6.2.5 — finalize_corpus default "
                "min_labels MUST be 10 (matches V6.2 sandbox_min_"
                "fixtures floor). Lowering this would let V6.2 "
                "validate against undersized corpora."
            ),
        )

    # I-V6.2.5-02 — finalize_corpus refuses below-floor migration.
    def test_i_v6_2_5_02_finalize_refuses_below_floor(self) -> None:
        """Plan ARIA-V6 §3 V6.2.5 — < min_labels MUST raise."""
        from aria_kernel.calibration_bootstrap import (
            finalize_corpus,
            label_finding,
        )
        from aria_kernel.tool_registry import GovernanceError
        # Add only 3 labels — well below 10.
        for i in range(3):
            label_finding(
                tool_id="below-floor-tool",
                finding_fingerprint=f"fp-{i}",
                label="tp",
                severity="HIGH",
                evidence=f"evidence-{i}",
                base_dir=self.base,
            )
        with self.assertRaises(GovernanceError) as ctx:
            finalize_corpus(
                tool_id="below-floor-tool",
                base_dir=self.base,
                min_labels=10,
            )
        self.assertIn(
            "below_floor", str(ctx.exception),
            msg=(
                "Plan ARIA-V6 §3 V6.2.5 — finalize_corpus MUST raise "
                "with reason finalize_corpus_below_floor when fewer "
                "than min_labels entries exist. Silent migration would "
                "let V6.2 sandbox validate against an undersized corpus."
            ),
        )

    # I-V6.2.5-03 — status surfaces freshness per tool.
    def test_i_v6_2_5_03_status_surfaces_freshness(self) -> None:
        """Plan ARIA-V6 §3 V6.2.5 — list_corpus_status reports
        latest_label_age_days per tool so the operator sees adapters
        approaching the 90-day freshness floor."""
        from aria_kernel.calibration_bootstrap import (
            finalize_corpus,
            label_finding,
            list_corpus_status,
        )
        # Mint 10 labels then finalize.
        for i in range(10):
            label_finding(
                tool_id="fresh-tool",
                finding_fingerprint=f"fingerprint-{i}",
                label="tp" if i % 2 == 0 else "fp",
                severity="HIGH",
                evidence=f"evidence-{i}",
                base_dir=self.base,
            )
        finalize_corpus(tool_id="fresh-tool", base_dir=self.base)
        status = list_corpus_status(base_dir=self.base)
        self.assertIn("fresh-tool", status["tools"])
        bucket = status["tools"]["fresh-tool"]
        self.assertEqual(bucket["fixture_count"], 10)
        self.assertEqual(bucket["tp_count"], 5)
        self.assertEqual(bucket["fp_count"], 5)
        self.assertIn(
            "latest_label_age_days", bucket,
            msg=(
                "Plan ARIA-V6 §3 V6.2.5 — status MUST surface "
                "latest_label_age_days so the operator can see "
                "which corpora are approaching the 90-day "
                "validate_calibration_corpus_sanity floor before "
                "V6.2 starts rejecting them."
            ),
        )
        # Just-minted entries should be 0 days old.
        self.assertIsNotNone(bucket["latest_label_age_days"])
        self.assertLessEqual(bucket["latest_label_age_days"], 1)


if __name__ == "__main__":
    unittest.main()
