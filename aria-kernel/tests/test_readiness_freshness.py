"""E13-C11 — adapter_active_readiness stale_run_evidence blocker.

First reader of the manifest-owned freshness metadata: a SHADOW run
ledger whose newest OK run is older than the tool's
freshness_window_hours can no longer justify ACTIVE readiness. Semantics
pinned here:

* fresh OK run inside the window        -> no blocker
* newest OK run older than the window   -> "stale_run_evidence"
* no OK run at all                      -> blocker (fail-closed)
* OK run without a provable recorded_at -> blocker (fail-closed)
* tool row missing the field (legacy)   -> DEFAULT_FRESHNESS_WINDOW_HOURS
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.readiness import adapter_active_readiness
from aria_kernel.tool_registry import DEFAULT_FRESHNESS_WINDOW_HOURS


def _iso_hours_ago(hours: float) -> str:
    return (
        datetime.now(timezone.utc) - timedelta(hours=hours)
    ).replace(microsecond=0).isoformat()


def _ok_run(recorded_at: str | None) -> dict[str, Any]:
    run: dict[str, Any] = {
        "status": "ok",
        "evidence_validation": {"valid": True},
        "runner": {"raw_findings_count": 1},
    }
    if recorded_at is not None:
        run["recorded_at"] = recorded_at
    return run


def _tool(**overrides: Any) -> dict[str, Any]:
    tool: dict[str, Any] = {
        "tool_id": "x-adapter",
        "kind": "adapter",
        "status": "SHADOW",
        "health_thresholds": {"precision_min": 0.85},
    }
    tool.update(overrides)
    return tool


_FIXTURES_GREEN = {
    "current_tool_passed": True,
    "fixture_baseline_passed": True,
    "semantic_fixture_passed": True,
}
_METRICS_GREEN = {
    "precision": 0.97,
    "precision_status": "human_judged",
    "critical_false_positives": 0,
}


def _readiness(tool: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
    with patch("aria_kernel.readiness.get_tool", return_value=tool), \
         patch("aria_kernel.readiness.read_runs_rows", return_value=iter(runs)), \
         patch("aria_kernel.readiness.runs_path", return_value=Path("unused-runs.jsonl")), \
         patch("aria_kernel.readiness.latest_fixture_status", return_value=dict(_FIXTURES_GREEN)), \
         patch("aria_kernel.readiness.compute_metrics", return_value=dict(_METRICS_GREEN)):
        return adapter_active_readiness("x-adapter", base_dir=None)


class StaleRunEvidenceBlockerTests(unittest.TestCase):
    def test_fresh_ok_run_inside_window_has_no_blocker(self) -> None:
        runs = [_ok_run(_iso_hours_ago(2)) for _ in range(5)]
        result = _readiness(_tool(freshness_window_hours=168), runs)
        self.assertFalse(result["stale_run_evidence"])
        self.assertNotIn("stale_run_evidence", result["blocked_by"])
        self.assertTrue(result["active_ready"])
        self.assertEqual(result["freshness_window_hours"], 168.0)
        self.assertIsNotNone(result["last_ok_run_age_hours"])

    def test_ok_run_older_than_window_blocks(self) -> None:
        runs = [_ok_run(_iso_hours_ago(200)) for _ in range(5)]
        result = _readiness(_tool(freshness_window_hours=168), runs)
        self.assertTrue(result["stale_run_evidence"])
        self.assertIn("stale_run_evidence", result["blocked_by"])
        self.assertFalse(result["active_ready"])
        self.assertGreater(result["last_ok_run_age_hours"], 168.0)

    def test_per_tool_window_is_respected(self) -> None:
        # 30h-old evidence: stale for a 24h window, fresh for the 168h default.
        runs = [_ok_run(_iso_hours_ago(30)) for _ in range(5)]
        tight = _readiness(_tool(freshness_window_hours=24), runs)
        self.assertIn("stale_run_evidence", tight["blocked_by"])
        wide = _readiness(_tool(freshness_window_hours=168), runs)
        self.assertNotIn("stale_run_evidence", wide["blocked_by"])

    def test_newest_ok_run_wins_over_older_history(self) -> None:
        runs = [_ok_run(_iso_hours_ago(500)) for _ in range(4)] + [_ok_run(_iso_hours_ago(1))]
        result = _readiness(_tool(freshness_window_hours=168), runs)
        self.assertNotIn("stale_run_evidence", result["blocked_by"])

    def test_no_ok_run_at_all_blocks_fail_closed(self) -> None:
        runs = [
            {"status": "crash", "evidence_validation": {"valid": False}, "recorded_at": _iso_hours_ago(1)}
            for _ in range(5)
        ]
        result = _readiness(_tool(freshness_window_hours=168), runs)
        self.assertIn("stale_run_evidence", result["blocked_by"])
        self.assertIsNone(result["last_ok_run_recorded_at"])

    def test_ok_run_without_recorded_at_blocks_fail_closed(self) -> None:
        # A run that cannot prove WHEN it happened cannot prove freshness.
        runs = [_ok_run(None) for _ in range(5)]
        result = _readiness(_tool(freshness_window_hours=168), runs)
        self.assertIn("stale_run_evidence", result["blocked_by"])
        self.assertIsNone(result["last_ok_run_age_hours"])

    def test_legacy_tool_row_without_field_uses_default_window(self) -> None:
        runs = [_ok_run(_iso_hours_ago(30)) for _ in range(5)]
        result = _readiness(_tool(), runs)
        self.assertEqual(result["freshness_window_hours"], float(DEFAULT_FRESHNESS_WINDOW_HOURS))
        # 30h < 168h default -> fresh.
        self.assertNotIn("stale_run_evidence", result["blocked_by"])


if __name__ == "__main__":
    unittest.main()
