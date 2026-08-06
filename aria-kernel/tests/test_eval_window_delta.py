"""F4.3 — window-over-window eval delta.

The intelligence program's own success test is "does round N+1 beat round
N", and until now the kernel could only describe ONE window: comparing two
rounds meant a human reading two printouts. These tests pin the comparison
and, more importantly, its refusal — a verdict drawn from three runs is a
coin toss wearing a trend's clothes, and a loop that celebrates noise never
stops for the reason it should.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_eval import (
    EVAL_RUNS_PATH,
    MIN_RUNS_FOR_TREND,
    aggregate_eval_metrics,
    compare_eval_windows,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _write_runs(tools: Path, rows: list[dict]) -> None:
    path = tools.joinpath(*EVAL_RUNS_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def _run(*, days_ago: float, passed: bool, agent: str = "aria-evidence-judge") -> dict:
    recorded = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "schema_version": 1,
        "target_agent": agent,
        "fixture_id": "F001",
        "passed": passed,
        "verdict_match": passed,
        "missing_evidence_refs": [] if passed else ["evidence.md:1"],
        "rounds_used": 1,
        "tokens_used": 100,
        "mock_mode": True,
        "recorded_at": recorded.isoformat().replace("+00:00", "Z"),
    }


class EvalWindowDeltaTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name)
        # The read path is fail-closed on an unbound tools tree (no
        # repo_identity.json => "not my state"), so the fixture must bind it
        # the same way a real run does.
        ensure_tools_dir(self.tools)
        self.addCleanup(self._tmp.cleanup)

    def test_improvement_is_reported_when_the_later_window_passes_more(self) -> None:
        rows = [_run(days_ago=40, passed=False) for _ in range(5)]
        rows += [_run(days_ago=5, passed=True) for _ in range(5)]
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["verdict"], "improved")
        self.assertEqual(result["deltas"]["pass_rate"], 1.0)
        self.assertEqual(result["previous_window"]["run_count"], 5)
        self.assertEqual(result["current_window"]["run_count"], 5)

    def test_regression_is_reported_and_not_softened(self) -> None:
        rows = [_run(days_ago=40, passed=True) for _ in range(5)]
        rows += [_run(days_ago=5, passed=False) for _ in range(5)]
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["verdict"], "regressed")
        self.assertEqual(result["deltas"]["pass_rate"], -1.0)

    def test_thin_data_refuses_a_verdict(self) -> None:
        # The first real baseline was five runs. Two rounds of two runs each
        # would produce a confident-looking delta from nothing.
        rows = [_run(days_ago=40, passed=False), _run(days_ago=5, passed=True)]
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["verdict"], "insufficient_evidence")
        self.assertIn(str(MIN_RUNS_FOR_TREND), result["reason"])

    def test_identical_windows_are_flat_not_improved(self) -> None:
        rows = [_run(days_ago=40, passed=True) for _ in range(5)]
        rows += [_run(days_ago=5, passed=True) for _ in range(5)]
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["verdict"], "flat")
        self.assertEqual(result["deltas"]["pass_rate"], 0.0)

    def test_windows_are_adjacent_and_a_run_is_counted_once(self) -> None:
        # 10 runs spread across 60 days with a 30-day window: every run lands
        # in exactly one side, and nothing older than two windows counts.
        rows = [_run(days_ago=d, passed=True) for d in (1, 5, 10, 20, 29)]
        rows += [_run(days_ago=d, passed=False) for d in (31, 35, 40, 50, 59)]
        rows += [_run(days_ago=200, passed=False) for _ in range(4)]
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["current_window"]["run_count"], 5)
        self.assertEqual(result["previous_window"]["run_count"], 5)
        self.assertEqual(result["verdict"], "improved")

    def test_other_agents_runs_do_not_leak_into_the_comparison(self) -> None:
        rows = [_run(days_ago=40, passed=False) for _ in range(5)]
        rows += [_run(days_ago=5, passed=True) for _ in range(5)]
        rows += [_run(days_ago=5, passed=False, agent="aria-adversarial-judge") for _ in range(9)]
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["current_window"]["run_count"], 5)
        self.assertEqual(result["deltas"]["pass_rate"], 1.0)

    def test_current_window_matches_the_single_window_aggregate(self) -> None:
        # One arithmetic, two callers: the consistency-variance bug must not
        # be able to come back on only one of the two paths.
        rows = [_run(days_ago=d, passed=(d % 2 == 0)) for d in range(1, 11)]
        _write_runs(self.tools, rows)

        delta = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)
        single = aggregate_eval_metrics(target_agent="aria-evidence-judge", base_dir=self.tools)

        for key in ("run_count", "pass_rate", "consistency_score", "mean_tokens"):
            self.assertEqual(delta["current_window"][key], single[key], key)

    def test_undated_rows_are_counted_as_such_not_silently_dropped(self) -> None:
        rows = [_run(days_ago=40, passed=False) for _ in range(5)]
        rows += [_run(days_ago=5, passed=True) for _ in range(5)]
        broken = _run(days_ago=5, passed=True)
        broken["recorded_at"] = "not-a-timestamp"
        rows.append(broken)
        _write_runs(self.tools, rows)

        result = compare_eval_windows(target_agent="aria-evidence-judge", base_dir=self.tools)

        self.assertEqual(result["undated_run_count"], 1)
        self.assertEqual(result["current_window"]["run_count"], 5)

    def test_refuses_a_nonsensical_window(self) -> None:
        with self.assertRaises(GovernanceError):
            compare_eval_windows(target_agent="x", base_dir=self.tools, window_days=0)
        with self.assertRaises(GovernanceError):
            compare_eval_windows(target_agent="x", base_dir=self.tools, min_runs=0)


if __name__ == "__main__":
    unittest.main()
