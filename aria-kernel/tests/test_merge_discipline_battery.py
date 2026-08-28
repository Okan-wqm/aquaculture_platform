"""ORPHAN-717/718 (2026-08-18 operator directive) — merge discipline.

Three deliberate-breakage batteries:

* the auto-merge evaluator demands the FULL check-run battery green —
  a red or pending NON-required check run blocks (branch protection's
  short required list merged a PR whose optional lint was red);
* the triple gate's Gate 4 demands verified exit-0 hygiene runs
  (format:check / type-check / tests) — CI alone cannot prove local
  tests because ~16 projects are unit-test-quarantined on CI;
* the post-merge scan records whether main stayed green after ARIA's
  own merges, discloses new reds as governance, and feeds them to the
  pressure producer as critical fix-forward work.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import (
    _all_check_runs_result,
    _hygiene_battery_result,
    evaluate_auto_merge,
)
from aria_kernel.own_pr_ci import (
    load_post_merge_reds,
    merge_outcomes_path,
    scan_merged_own_prs,
)
from aria_kernel.tool_registry import ensure_tools_dir

from tests.test_auto_merge import github, pr


class FullBatteryGateTests(unittest.TestCase):
    def _decide(self, github_payload):
        with tempfile.TemporaryDirectory(prefix="aria-717-") as tmp:
            return evaluate_auto_merge(
                pr=pr(), github=github_payload, base_dir=Path(tmp) / "aria-tools",
            )

    def test_optional_red_check_run_blocks(self) -> None:
        payload = github()
        payload["checks"]["runs"].append(
            {"name": "lint-and-typecheck", "head_sha": "abc1234",
             "status": "completed", "conclusion": "failure"},
        )
        decision = self._decide(payload)
        self.assertFalse(decision["eligible"])
        self.assertTrue(
            any("check runs red (including non-required)" in r for r in decision["reasons"]),
            decision["reasons"],
        )

    def test_pending_optional_check_run_blocks(self) -> None:
        payload = github()
        payload["checks"]["runs"].append(
            {"name": "invariants", "head_sha": "abc1234",
             "status": "in_progress", "conclusion": None},
        )
        decision = self._decide(payload)
        self.assertFalse(decision["eligible"])
        self.assertTrue(
            any("check runs still pending" in r for r in decision["reasons"]),
            decision["reasons"],
        )

    def test_zero_check_runs_fails_closed(self) -> None:
        decision = self._decide(github(checks={"readable": True, "runs": []}))
        self.assertFalse(decision["eligible"])
        self.assertTrue(
            any("full battery cannot be proven green" in r for r in decision["reasons"]),
            decision["reasons"],
        )

    def test_neutral_and_skipped_do_not_block(self) -> None:
        payload = github()
        payload["checks"]["runs"].extend([
            {"name": "conditional-job", "head_sha": "abc1234",
             "status": "completed", "conclusion": "skipped"},
            {"name": "advisory", "head_sha": "abc1234",
             "status": "completed", "conclusion": "neutral"},
        ])
        result = _all_check_runs_result(payload, "abc1234")
        self.assertEqual(result["red"], [])
        self.assertEqual(result["pending"], [])
        self.assertEqual(result["total"], 4)

    def test_legacy_status_rows_map_correctly(self) -> None:
        result = _all_check_runs_result(
            {"checks": {"readable": True, "runs": [
                {"context": "legacy-green", "sha": "abc", "state": "success"},
                {"context": "legacy-red", "sha": "abc", "state": "failure"},
                {"context": "legacy-wait", "sha": "abc", "state": "pending"},
            ]}},
            "abc",
        )
        self.assertEqual(result["red"], ["legacy-red"])
        self.assertEqual(result["pending"], ["legacy-wait"])


class HygieneBatteryTests(unittest.TestCase):
    @staticmethod
    def _run(cmd: str, *, status: str = "ok", run_id: str = "vr-1") -> dict:
        return {"validation_run_id": run_id, "cmd": cmd, "status": status}

    def test_full_battery_satisfies_all_dimensions(self) -> None:
        result = _hygiene_battery_result([
            self._run("npm run format:check", run_id="vr-f"),
            self._run("npm run type-check", run_id="vr-t"),
            self._run("npx nx affected --target=test --base=main", run_id="vr-x"),
        ])
        self.assertEqual(result["missing"], [])
        self.assertEqual(
            result["satisfied"],
            {"format": "vr-f", "typecheck": "vr-t", "test": "vr-x"},
        )

    def test_each_missing_dimension_is_named(self) -> None:
        result = _hygiene_battery_result([self._run("npm run test:all")])
        self.assertEqual(result["missing"], ["format", "typecheck"])

    def test_failed_run_does_not_satisfy(self) -> None:
        result = _hygiene_battery_result([
            self._run("npm run format:check", status="failed"),
        ])
        self.assertIn("format", result["missing"])

    def test_empty_runs_miss_everything(self) -> None:
        self.assertEqual(
            _hygiene_battery_result([])["missing"],
            ["format", "typecheck", "test"],
        )


class _FakeMergedReader:
    def __init__(self, merged, runs_by_sha):
        self._merged = merged
        self._runs = runs_by_sha

    def readable(self):
        return (True, "ok")

    def list_merged_own_prs(self, *, limit=20):
        return self._merged

    def runs_for_commit(self, sha):
        return self._runs.get(sha, [])


class PostMergeScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-718-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @staticmethod
    def _merged_pr(number: int, sha: str) -> dict:
        return {
            "number": number,
            "headRefName": f"aria/change-{number}",
            "mergeCommit": {"oid": sha},
        }

    def test_red_main_recorded_disclosed_and_pressurized(self) -> None:
        reader = _FakeMergedReader(
            [self._merged_pr(101, "sha-red")],
            {"sha-red": [
                {"name": "CI-Affected", "status": "completed",
                 "conclusion": "failure", "headBranch": "main"},
            ]},
        )
        result = scan_merged_own_prs(cycle_id="cyc-1", base_dir=self.tools, reader=reader)
        self.assertEqual(result["red"], [101])
        reds = load_post_merge_reds(base_dir=self.tools)
        self.assertEqual(len(reds), 1)
        self.assertEqual(reds[0]["red_jobs"], ["CI-Affected"])
        gov = self.tools / "governance.jsonl"
        kinds = [json.loads(l)["kind"] for l in gov.read_text(encoding="utf-8").splitlines() if l.strip()]
        self.assertIn("post_merge_ci_red", kinds)

    def test_green_outcome_retires_the_red(self) -> None:
        red_reader = _FakeMergedReader(
            [self._merged_pr(102, "sha-x")],
            {"sha-x": [{"name": "CI-Affected", "status": "completed",
                        "conclusion": "failure", "headBranch": "main"}]},
        )
        scan_merged_own_prs(cycle_id="cyc-1", base_dir=self.tools, reader=red_reader)
        green_reader = _FakeMergedReader(
            [self._merged_pr(102, "sha-x")],
            {"sha-x": [{"name": "CI-Affected", "status": "completed",
                        "conclusion": "success", "headBranch": "main"}]},
        )
        scan_merged_own_prs(cycle_id="cyc-2", base_dir=self.tools, reader=green_reader)
        self.assertEqual(load_post_merge_reds(base_dir=self.tools), [])

    def test_unchanged_outcome_appends_nothing(self) -> None:
        reader = _FakeMergedReader(
            [self._merged_pr(103, "sha-g")],
            {"sha-g": [{"name": "CI-Affected", "status": "completed",
                        "conclusion": "success", "headBranch": "main"}]},
        )
        scan_merged_own_prs(cycle_id="cyc-1", base_dir=self.tools, reader=reader)
        scan_merged_own_prs(cycle_id="cyc-2", base_dir=self.tools, reader=reader)
        rows = [
            l for l in merge_outcomes_path(self.tools).read_text(encoding="utf-8").splitlines()
            if l.strip()
        ]
        self.assertEqual(len(rows), 1)

    def test_non_main_runs_are_ignored(self) -> None:
        reader = _FakeMergedReader(
            [self._merged_pr(104, "sha-b")],
            {"sha-b": [{"name": "some-branch-run", "status": "completed",
                        "conclusion": "failure", "headBranch": "feature/x"}]},
        )
        result = scan_merged_own_prs(cycle_id="cyc-1", base_dir=self.tools, reader=reader)
        self.assertEqual(result["red"], [])
        rows = [json.loads(l) for l in merge_outcomes_path(self.tools).read_text(encoding="utf-8").splitlines() if l.strip()]
        self.assertEqual(rows[0]["status"], "no_runs_observed")

    def test_recording_reader_reports_unreadable(self) -> None:
        from aria_kernel.github_adapters import RecordingChecksReader

        result = scan_merged_own_prs(
            cycle_id="cyc-1", base_dir=self.tools,
            reader=RecordingChecksReader(profile="standard"),
        )
        self.assertEqual(result["status"], "unreadable")


if __name__ == "__main__":
    unittest.main()
