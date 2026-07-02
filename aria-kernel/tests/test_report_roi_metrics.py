"""Plan S6 (ORPHAN-MEDIUM-299) — merged-value-per-dollar daily-anchor tests."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.report import _roi_metrics, build_daily_anchor


def _write_fixture(tools: Path) -> None:
    shard = tools / "cost-attribution"
    shard.mkdir(parents=True)
    rows = [
        {"recorded_at": "2026-07-02T01:10:00Z", "cycle_id": "cyc-a", "estimated_usd": 0.65},
        {"recorded_at": "2026-07-02T01:12:00Z", "cycle_id": "cyc-a", "estimated_usd": 0.60},
        {"recorded_at": "2026-07-01T01:00:00Z", "cycle_id": "cyc-z", "estimated_usd": 1.00},
        {"recorded_at": "2026-06-30T01:00:00Z", "cycle_id": "cyc-old", "estimated_usd": 9.99},
    ]
    (shard / "2026-07.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8",
    )
    lifecycle = [
        {"recorded_at": "2026-07-02T02:00:00Z", "event": "merged", "pr_number": 900},
        {"recorded_at": "2026-07-02T03:00:00Z", "event": "observed", "pr_number": 901},
        {"recorded_at": "2026-07-01T02:00:00Z", "event": "merged", "pr_number": 899},
    ]
    (tools / "pr-lifecycle.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in lifecycle), encoding="utf-8",
    )


class RoiMetricsTests(unittest.TestCase):
    def test_day_and_month_scoping(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp)
            _write_fixture(tools)
            roi = _roi_metrics(tools, "2026-07-02")
            self.assertEqual(roi["day_cost_usd"], 1.25)
            self.assertEqual(roi["day_llm_calls"], 2)
            self.assertEqual(roi["day_cycles_with_spend"], 1)
            self.assertEqual(roi["day_merged_prs"], 1)
            self.assertEqual(roi["usd_per_merge"], 1.25)
            self.assertEqual(roi["mtd_cost_usd"], 2.25)
            self.assertEqual(roi["mtd_merged_prs"], 2)

    def test_zero_merge_day_reports_null_usd_per_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp)
            _write_fixture(tools)
            roi = _roi_metrics(tools, "2026-07-03")
            self.assertEqual(roi["day_merged_prs"], 0)
            self.assertIsNone(roi["usd_per_merge"])

    def test_missing_ledgers_yield_zeros(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            roi = _roi_metrics(Path(tmp), "2026-07-02")
            self.assertEqual(roi["day_cost_usd"], 0.0)
            self.assertEqual(roi["mtd_merged_prs"], 0)
            self.assertIsNone(roi["usd_per_merge"])

    def test_anchor_carries_roi_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            _write_fixture(tools)
            anchor = build_daily_anchor(
                date="2026-07-02", workspace_root=Path(tmp), tools_root=tools,
            )
            self.assertEqual(anchor["roi"]["day_merged_prs"], 1)
            self.assertEqual(anchor["roi"]["usd_per_merge"], 1.25)


if __name__ == "__main__":
    unittest.main()
