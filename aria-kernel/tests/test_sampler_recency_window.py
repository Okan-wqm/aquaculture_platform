"""ORPHAN-MEDIUM-785 — the judgment sampler sees a recency window, not one
cycle.

The exact-cycle filter (`row.cycle_id != cycle_id → skip`) starved the
judge lane on every night without fresh adapter runs: findings from other
recent nights became permanently unsampleable, so anchors could never
accumulate across nights. The window: this cycle always, the last
SAMPLE_RECENCY_HOURS otherwise; process-all (cycle_id=None) unchanged.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.feedback_store import (
    SAMPLE_RECENCY_HOURS,
    _within_sampling_recency,
    append_jsonl,
    generate_judgment_sample,
    raw_findings_path,
)
from aria_kernel.tool_registry import ensure_tools_dir


def _row(cycle_id: str, recorded_at: str) -> dict:
    return {
        "tool_id": "tool-a",
        "status": "raw",
        "cycle_id": cycle_id,
        "recorded_at": recorded_at,
        "run_id": f"run-{cycle_id}",
        "finding_id": f"F-{cycle_id}",
        "finding": {"id": f"F-{cycle_id}", "rule": "r1", "message": "m"},
    }


class RecencyPredicateTests(unittest.TestCase):
    def test_current_cycle_always_qualifies(self) -> None:
        now = datetime(2026, 8, 21, tzinfo=timezone.utc)
        row = _row("cyc-now", "2026-01-01T00:00:00+00:00")
        self.assertTrue(_within_sampling_recency(row, "cyc-now", now=now))

    def test_recent_foreign_cycle_qualifies_old_one_does_not(self) -> None:
        now = datetime(2026, 8, 21, tzinfo=timezone.utc)
        two_days = (now - timedelta(days=2)).isoformat()
        month_old = (now - timedelta(days=30)).isoformat()
        self.assertTrue(_within_sampling_recency(_row("cyc-old", two_days), "cyc-now", now=now))
        self.assertFalse(_within_sampling_recency(_row("cyc-old", month_old), "cyc-now", now=now))

    def test_window_boundary_follows_the_constant(self) -> None:
        now = datetime(2026, 8, 21, tzinfo=timezone.utc)
        inside = (now - timedelta(hours=SAMPLE_RECENCY_HOURS - 1)).isoformat()
        outside = (now - timedelta(hours=SAMPLE_RECENCY_HOURS + 1)).isoformat()
        self.assertTrue(_within_sampling_recency(_row("cyc-old", inside), "cyc-now", now=now))
        self.assertFalse(_within_sampling_recency(_row("cyc-old", outside), "cyc-now", now=now))

    def test_unparseable_age_falls_back_to_cycle_match_only(self) -> None:
        row = _row("cyc-now", "not-a-timestamp")
        self.assertTrue(_within_sampling_recency(row, "cyc-now"))
        self.assertFalse(_within_sampling_recency(row, "cyc-other"))

    def test_process_all_mode_is_unchanged(self) -> None:
        now = datetime(2026, 8, 21, tzinfo=timezone.utc)
        ancient = (now - timedelta(days=365)).isoformat()
        self.assertTrue(_within_sampling_recency(_row("cyc-old", ancient), None, now=now))


class SamplerWindowTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-785-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        now = datetime.now(timezone.utc)
        rows = [
            _row("cyc-now", now.isoformat()),
            _row("cyc-two-days", (now - timedelta(days=2)).isoformat()),
            _row("cyc-month", (now - timedelta(days=30)).isoformat()),
        ]
        ledger = raw_findings_path(self.tools)
        for row in rows:
            # Through the declared append: the raw-findings surface is
            # strict hash-chained, so hand-written lines fail verification.
            append_jsonl(ledger, row)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_sampling_from_a_thin_night_still_reaches_recent_nights(self) -> None:
        sample = generate_judgment_sample(
            tool_id="tool-a", sample_size=10, cycle_id="cyc-now", base_dir=self.tools
        )
        sampled_cycles = {item.get("cycle_id") for item in sample["items"]}
        self.assertIn("cyc-now", sampled_cycles)
        self.assertIn("cyc-two-days", sampled_cycles)
        self.assertNotIn("cyc-month", sampled_cycles)

    def test_a_judged_finding_is_not_resampled_by_a_later_night(self) -> None:
        # The existing_feedback dedup is upstream of the window: once a
        # verdict row exists for (run, finding), no later night's window
        # re-offers it to the judges — the window widens the entry, not
        # the rejudging.
        from aria_kernel.feedback_store import record_operator_feedback

        first = generate_judgment_sample(
            tool_id="tool-a", sample_size=10, cycle_id="cyc-now", base_dir=self.tools
        )
        self.assertEqual(first["sampled_count"], 2)
        for item in first["items"]:
            record_operator_feedback(
                tool_id="tool-a",
                run_id=item["run_id"],
                finding_id=item["finding_id"],
                verdict="true_positive",
                severity="low",
                note="judged",
                source_type="human",
                base_dir=self.tools,
            )
        second = generate_judgment_sample(
            tool_id="tool-a", sample_size=10, cycle_id="cyc-later", base_dir=self.tools
        )
        self.assertEqual(second["sampled_count"], 0)


if __name__ == "__main__":
    unittest.main()
