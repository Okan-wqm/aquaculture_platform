"""ORPHAN-723 — the repo's PR weather is visible, and only visible.

Operator question 2026-08-18: "does ARIA also see Dependabot's branches
failing Actions?" It did not. This observer records EVERY open PR's check
verdict; the pins below keep it strictly read-only (observation feeds a
LOW-severity pressure whose action text forbids acting) — third-party
authority stays behind the E23 gate.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.github_adapters import RecordingChecksReader
from aria_kernel.own_pr_ci import (
    load_third_party_pr_reds,
    repo_pr_health_path,
    scan_repo_pr_health,
)
from aria_kernel.tool_registry import ensure_tools_dir


class _FakeReader:
    def __init__(self, prs, snapshots):
        self._prs = prs
        self._snapshots = snapshots

    def readable(self):
        return (True, "ok")

    def list_open_prs(self, *, limit=30):
        return self._prs

    def pr_snapshot(self, number):
        return self._snapshots.get(number)


def _snapshot(*red_names):
    return {"pr": {}, "github": {"workflow_runs": [
        {"name": n, "conclusion": "failure"} for n in red_names
    ]}}


class RepoPrHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-723-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @staticmethod
    def _pr(number, head, author="dependabot[bot]"):
        return {"number": number, "headRefName": head,
                "headRefOid": "a" * 40, "author": {"login": author}}

    def test_third_party_red_is_recorded_and_loadable(self) -> None:
        reader = _FakeReader(
            [self._pr(9, "dependabot/github_actions/x")],
            {9: _snapshot("Rust CI")},
        )
        result = scan_repo_pr_health(cycle_id="c1", base_dir=self.tools, reader=reader)
        self.assertEqual(result["red"], [9])
        reds = load_third_party_pr_reds(base_dir=self.tools)
        self.assertEqual(len(reds), 1)
        self.assertEqual(reds[0]["red_jobs"], ["Rust CI"])
        self.assertFalse(reds[0]["own_pr"])

    def test_own_pr_rows_are_marked_and_excluded_from_third_party_reds(self) -> None:
        reader = _FakeReader(
            [self._pr(10, "aria/some-change", author="okan")],
            {10: _snapshot("CI - Affected")},
        )
        scan_repo_pr_health(cycle_id="c1", base_dir=self.tools, reader=reader)
        rows = [json.loads(l) for l in repo_pr_health_path(self.tools).read_text(encoding="utf-8").splitlines() if l.strip()]
        self.assertTrue(rows[0]["own_pr"])
        self.assertEqual(load_third_party_pr_reds(base_dir=self.tools), [])

    def test_unchanged_outcome_appends_nothing(self) -> None:
        reader = _FakeReader(
            [self._pr(11, "dependabot/npm/x")], {11: _snapshot("test")},
        )
        scan_repo_pr_health(cycle_id="c1", base_dir=self.tools, reader=reader)
        scan_repo_pr_health(cycle_id="c2", base_dir=self.tools, reader=reader)
        rows = repo_pr_health_path(self.tools).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len([l for l in rows if l.strip()]), 1)

    def test_green_retires_the_red(self) -> None:
        red = _FakeReader([self._pr(12, "dependabot/npm/y")], {12: _snapshot("test")})
        scan_repo_pr_health(cycle_id="c1", base_dir=self.tools, reader=red)
        green = _FakeReader(
            [self._pr(12, "dependabot/npm/y")],
            {12: {"pr": {}, "github": {"workflow_runs": [
                {"name": "test", "conclusion": "success"}]}}},
        )
        scan_repo_pr_health(cycle_id="c2", base_dir=self.tools, reader=green)
        self.assertEqual(load_third_party_pr_reds(base_dir=self.tools), [])

    def test_recording_reader_reports_unreadable(self) -> None:
        result = scan_repo_pr_health(
            cycle_id="c1", base_dir=self.tools,
            reader=RecordingChecksReader(profile="standard"),
        )
        self.assertEqual(result["status"], "unreadable")

    def test_pressure_is_low_severity_and_observation_only(self) -> None:
        # The authority boundary IS the pressure text: low severity and an
        # action that forbids acting. A future edit that escalates either
        # is a deliberate E23-gate bypass and must show up here.
        import inspect

        from aria_kernel import pressure as pressure_mod

        src = inspect.getsource(pressure_mod)
        block = src.split("load_third_party_pr_reds", 2)[2]
        self.assertIn('severity="low"', block.split("_pressure(", 2)[1])
        self.assertIn("OBSERVE ONLY", block)
        self.assertIn("E23", block)


if __name__ == "__main__":
    unittest.main()
