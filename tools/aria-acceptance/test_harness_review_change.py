#!/usr/bin/env python3
"""WP-D1 — `harness.py review-change`: the room driver for one change.

DESIGN-discovery §(b) step 0: the command takes one change (base, head) and an
EXPLICIT store, binds the store env as HARNESS §2.1 lists it, and runs the
production loop (cycle run --mode change_review → ci_executor.py --drain →
cycle run) until nothing is pending for the subject or the round cap is
reached. It retires the decision-test script's Stage J, which imported private
kernel functions to do the same.

These pin the command's front door: it exists, and a run without either end
of the change or without an explicit store is a usage error naming the missing
input — never a run against a guessed store (HARNESS §2.1: every default of
the store binding resolves to real ARIA state). New API: the `review-change`
subcommand and its `--change-base`, `--change-head` and `--store` flags.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_HARNESS = Path(__file__).with_name("harness.py")


def _harness(*argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(_HARNESS), *argv], capture_output=True, text=True, timeout=120, check=False,
    )


class ReviewChangeFrontDoorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-review-change-")
        root = Path(self._tmp.name)
        self.inputs = {
            "--change-base": "a" * 40,
            "--change-head": "b" * 40,
            "--store": str(root / "store"),
            "--workspace-root": str(root / "tree"),
        }

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_review_change_documents_the_change_and_the_store(self) -> None:
        result = _harness("review-change", "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in ("--change-base", "--change-head", "--store"):
            with self.subTest(flag=flag):
                self.assertIn(flag, result.stdout)

    def test_a_missing_input_is_a_usage_error_that_names_it(self) -> None:
        for missing in ("--change-base", "--change-head", "--store"):
            with self.subTest(missing=missing):
                argv = [part for flag, value in self.inputs.items() if flag != missing for part in (flag, value)]
                result = _harness("review-change", *argv)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(missing, result.stderr, "the usage error must name the missing input")
                self.assertFalse(Path(self.inputs["--store"]).exists(), "a refused run created a store")


class RoomReportCostTests(unittest.TestCase):
    """WP-D4 — the room's report carries the cost attribution of the change it reviewed.

    The kernel computes it (``cost_budget``'s own derivation, in the cycle's
    ``change_intelligence`` payload); the harness copies it and imports no
    private kernel function to do so (HARNESS: nothing here re-implements the
    kernel). The report's block is the LAST settled round's: the attribution is
    cumulative over the room's store, so the first round's would understate it.
    New API: ``report["cost_budget"]``.
    """

    @staticmethod
    def _load_harness():
        spec = importlib.util.spec_from_file_location("aria_acceptance_harness_under_test", _HARNESS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_report_carries_the_last_rounds_cost_budget_block(self) -> None:
        harness = self._load_harness()
        first = {"monetary_admission": "metered", "daily_usd": 0.0, "monthly_usd": 0.0,
                 "caps": {"daily": 5.0, "monthly": 100.0, "per_run": 0.5}}
        settled = {**first, "daily_usd": 0.9, "monthly_usd": 0.9}
        rounds = iter((
            {"status": "completed", "change_intelligence": {
                "subject_ref": "change:a..b", "change_intelligence_requests_minted": 1,
                "subject_open_requests": ["REQ-1"], "cost_budget": first}},
            {"status": "completed", "change_intelligence": {
                "subject_ref": "change:a..b", "change_intelligence_requests_minted": 0,
                "subject_open_requests": [], "cost_budget": settled}},
        ))

        def fake_run(argv, **_kwargs):
            if "--drain" in argv:
                return subprocess.CompletedProcess(argv, 0, "", "")
            return subprocess.CompletedProcess(argv, 0, json.dumps(next(rounds)), "")

        with tempfile.TemporaryDirectory(prefix="aria-room-cost-") as tmp:
            root = Path(tmp)
            with mock.patch.object(harness.subprocess, "run", side_effect=fake_run):
                report = harness.review_change(
                    change_base="a" * 40, change_head="b" * 40, store=root / "store",
                    workspace_root=root / "tree", rounds=2,
                )

        self.assertTrue(report["settled"], report)
        self.assertIn("cost_budget", report, "the room report names no cost attribution for the change it reviewed")
        self.assertEqual(report["cost_budget"], settled)


if __name__ == "__main__":
    unittest.main()
