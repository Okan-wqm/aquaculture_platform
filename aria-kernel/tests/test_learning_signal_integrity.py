"""Three learning-signal integrity fixes (Kalibre Zekâ Z5a/Z2b/Z2d)."""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel.reflection import _compute_dataflow_health
from aria_kernel.tool_registry import ensure_tools_dir


class SentinelReadsRealLedgersTest(unittest.TestCase):
    def test_values_come_from_producer_ledgers_not_cycle_rows(self) -> None:
        from aria_kernel.feedback_store import append_jsonl
        from aria_kernel.judge_calibration import calibration_path
        from aria_kernel.ledger import append_declared_jsonl

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            for i in range(5):
                append_declared_jsonl(
                    root / "cycles.jsonl",
                    {"cycle_id": f"c{i}", "event": "completed", "status": "completed"},
                    expected_surface="cycles",
                )
            append_jsonl(calibration_path(root), {"judged_judges": 3, "cycle_id": "c4"})

            health = _compute_dataflow_health(root)

        self.assertEqual(health["signals"]["judged_judges"]["window_values"], [3])
        self.assertNotIn("judged_judges", health["starved"])

    def test_an_empty_producer_after_full_history_is_starved(self) -> None:
        from aria_kernel.ledger import append_declared_jsonl

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            for i in range(5):
                append_declared_jsonl(
                    root / "cycles.jsonl",
                    {"cycle_id": f"c{i}", "event": "completed", "status": "completed"},
                    expected_surface="cycles",
                )

            health = _compute_dataflow_health(root)

        self.assertIn("judged_judges", health["starved"])

    def test_short_history_never_alarms(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)

            health = _compute_dataflow_health(root)

        self.assertEqual(health["starved"], [])


class MissingConfidenceTest(unittest.TestCase):
    def test_none_confidence_stays_out_of_the_mean(self) -> None:
        from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            for judge, conf in (("j1", 0.95), ("j2", None)):
                record_operator_feedback(
                    tool_id="t", run_id="r", finding_id="f",
                    verdict="true_positive", severity="medium", note="x",
                    source_type="ai_judge", judge_id=judge, confidence=conf,
                    judgment_group_id="judge:t:r:f", base_dir=root,
                )

            result = generate_ai_consensus(tool_id="t", base_dir=root)

        # One 0.95 judge + one None judge: pre-fix mean 0.475 -> false
        # low_confidence; post-fix mean 0.95 -> consensus published.
        self.assertEqual(result["consensus_count"], 1)

    def test_no_numeric_confidence_escalates_under_its_own_name(self) -> None:
        from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback
        from aria_kernel.human_required import CONSENSUS_UNCERTAINTY_SEVERITY

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            for judge in ("j1", "j2"):
                record_operator_feedback(
                    tool_id="t", run_id="r", finding_id="f",
                    verdict="true_positive", severity="medium", note="x",
                    source_type="ai_judge", judge_id=judge, confidence=None,
                    judgment_group_id="judge:t:r:f", base_dir=root,
                )

            result = generate_ai_consensus(tool_id="t", base_dir=root)

        reasons = [u["reason"] for u in result["uncertainties"]]
        self.assertEqual(reasons, ["missing_confidence"])
        # The map entry is load-bearing: an unmapped reason silently drops.
        self.assertIn("missing_confidence", CONSENSUS_UNCERTAINTY_SEVERITY)


if __name__ == "__main__":
    unittest.main()
