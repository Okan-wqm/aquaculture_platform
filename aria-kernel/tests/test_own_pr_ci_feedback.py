"""ARIA reads the checks of the PRs it pushed (ORPHAN-HIGH-626).

Before this loop: ARIA pushed a branch, CI went red, the merge gate blocked
the PR forever, and nothing ARIA runs ever learned the code was wrong.
`poll_pr_checks` was dead, the whole of ci.py had zero producers while
executor.py READ its failures ledger for flaky fingerprints, and the
standard nightly's Recording adapter returned empty check lists — so "maybe
it wrote the code wrong" was a question only the operator could answer.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.own_pr_ci import (
    is_own_pr_head,
    load_open_own_pr_reds,
    scan_own_prs,
)
from aria_kernel.tool_registry import ensure_tools_dir


class _FakeReader:
    def __init__(self, prs, snapshots, readable=(True, "ok")):
        self._prs = prs
        self._snapshots = snapshots
        self._readable = readable

    def readable(self):
        return self._readable

    def list_own_prs(self):
        return self._prs

    def pr_snapshot(self, pr_number):
        return self._snapshots.get(pr_number)


def _snapshot(number, head_sha, conclusions):
    return {
        "pr": {"number": number, "headRefOid": head_sha, "files": []},
        "github": {
            "workflow_runs": [
                {"name": name, "status": "completed", "conclusion": conclusion}
                for name, conclusion in conclusions
            ],
        },
    }


class OwnPrIdentityTest(unittest.TestCase):
    def test_only_arias_branches_count(self) -> None:
        self.assertTrue(is_own_pr_head("aria/fix-thing"))
        self.assertTrue(is_own_pr_head("automation/aria-daily-report-2026-08-11"))
        self.assertFalse(is_own_pr_head("aria/state"))
        self.assertFalse(is_own_pr_head("feature/human-branch"))
        self.assertFalse(is_own_pr_head("dependabot/npm_and_yarn/x"))


class ScanTest(unittest.TestCase):
    def _scan(self, tools, reader):
        return scan_own_prs(
            cycle_id="cyc-ci", base_dir=tools, workspace_root=".", reader=reader,
        )

    def test_a_red_own_pr_lands_in_the_bridge_and_the_revived_ledger(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            reader = _FakeReader(
                prs=[{"number": 7, "headRefName": "aria/fix-thing"},
                     {"number": 8, "headRefName": "feature/not-ours"}],
                snapshots={7: _snapshot(7, "a" * 40, [("CI - Affected", "failure"), ("docs", "success")])},
            )

            result = self._scan(tools, reader)
            reds = load_open_own_pr_reds(base_dir=tools)

            self.assertEqual(result["red"], [7])
            self.assertEqual([r["pr_number"] for r in reds], [7])
            self.assertEqual(reds[0]["red_jobs"], ["CI - Affected"])
            # The dead pipeline's ledger got its first producer.
            self.assertTrue((tools / "ci" / "failures.jsonl").exists())
            # The foreign PR was never snapshotted.
            self.assertEqual(len(result["scanned"]), 1)

    def test_a_green_pr_clears_its_own_red(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            red = _FakeReader(
                prs=[{"number": 7, "headRefName": "aria/fix-thing"}],
                snapshots={7: _snapshot(7, "a" * 40, [("CI - Affected", "failure")])},
            )
            green = _FakeReader(
                prs=[{"number": 7, "headRefName": "aria/fix-thing"}],
                snapshots={7: _snapshot(7, "b" * 40, [("CI - Affected", "success")])},
            )

            self._scan(tools, red)
            self._scan(tools, green)

            self.assertEqual(load_open_own_pr_reds(base_dir=tools), [])

    def test_an_unreadable_night_is_a_named_cause_not_a_quiet_zero(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            reader = _FakeReader(prs=[], snapshots={}, readable=(False, "gh_token_absent"))

            result = self._scan(tools, reader)

        self.assertEqual(result["status"], "unreadable")
        self.assertEqual(result["reason"], "gh_token_absent")


class PressureProducerTest(unittest.TestCase):
    def test_an_open_red_becomes_an_own_pr_ci_pressure(self) -> None:
        from aria_kernel.pressure import run_pressure

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            reader = _FakeReader(
                prs=[{"number": 7, "headRefName": "aria/fix-thing"}],
                snapshots={7: _snapshot(7, "a" * 40, [("CI - Affected", "failure")])},
            )
            scan_own_prs(cycle_id="cyc-ci", base_dir=tools, workspace_root=".", reader=reader)

            result = run_pressure(cycle_id="cyc-ci", base_dir=tools)

        rows = [p for p in result.get("pressures", []) if p.get("source") == "own_pr_ci"]
        self.assertEqual(len(rows), 1)
        self.assertIn("pr-7", rows[0]["pressure_id"])
        self.assertIn("CI - Affected", rows[0]["reason"])

    def test_a_cleared_red_mints_no_pressure(self) -> None:
        from aria_kernel.pressure import run_pressure

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            reader = _FakeReader(
                prs=[{"number": 7, "headRefName": "aria/fix-thing"}],
                snapshots={7: _snapshot(7, "b" * 40, [("CI - Affected", "success")])},
            )
            scan_own_prs(cycle_id="cyc-ci", base_dir=tools, workspace_root=".", reader=reader)

            result = run_pressure(cycle_id="cyc-ci", base_dir=tools)

        self.assertEqual(
            [p for p in result.get("pressures", []) if p.get("source") == "own_pr_ci"], []
        )

    def test_the_feed_link_is_load_bearing(self) -> None:
        # Deliberate break: sever the bridge read and a red PR produces no
        # pressure — proving the producer block, not table membership, is
        # what carries the signal.
        from aria_kernel.pressure import run_pressure

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            reader = _FakeReader(
                prs=[{"number": 7, "headRefName": "aria/fix-thing"}],
                snapshots={7: _snapshot(7, "a" * 40, [("CI - Affected", "failure")])},
            )
            scan_own_prs(cycle_id="cyc-ci", base_dir=tools, workspace_root=".", reader=reader)

            with patch("aria_kernel.own_pr_ci.load_open_own_pr_reds", return_value=[]):
                result = run_pressure(cycle_id="cyc-ci", base_dir=tools)

        self.assertEqual(
            [p for p in result.get("pressures", []) if p.get("source") == "own_pr_ci"], []
        )


class PhaseAndProfileTest(unittest.TestCase):
    def test_the_scan_runs_before_pressure(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]

        self.assertIn("pr_ci_scan", names)
        self.assertLess(names.index("pr_ci_scan"), names.index("pressure"))
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "pr_ci_scan")
        self.assertEqual(phase.on_error, "record_and_continue")

    def test_standard_profile_finally_gets_a_real_reader(self) -> None:
        from aria_kernel.github_adapters import (
            RealChecksReader,
            RecordingChecksReader,
            select_checks_reader,
        )

        self.assertIsInstance(
            select_checks_reader(profile="standard"), RealChecksReader
        )
        self.assertIsInstance(
            select_checks_reader(profile="observe"), RecordingChecksReader
        )
        readable, reason = select_checks_reader(profile="frozen").readable()
        self.assertFalse(readable)
        self.assertIn("frozen", reason)


if __name__ == "__main__":
    unittest.main()
