#!/usr/bin/env python3
"""Tests for the ARIA acceptance harness (Plan 030).

The drift classifier is the deterministic truth gate; these tests pin its TP/FP/
unverifiable verdicts. The cycle + scenario checks are exercised as integration
smoke tests (they drive the real kernel in an isolated temp dir)."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

_HARNESS = Path(__file__).with_name("harness.py")
_spec = importlib.util.spec_from_file_location("aria_acceptance_harness", _HARNESS)
assert _spec and _spec.loader
harness = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = harness
_spec.loader.exec_module(harness)


class DriftClassifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        (self.repo / "a.ts").write_text("x\n", encoding="utf-8")
        (self.repo / "b.sql").write_text("y\n", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_true_positive(self) -> None:
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": []}
        verdict, _ = harness._classify_drift(d, self.repo)
        self.assertEqual(verdict, "true_positive")

    def test_false_positive_no_value_difference(self) -> None:
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": [], "missing_in_sql": [], "existing_gate_refs": []}
        verdict, _ = harness._classify_drift(d, self.repo)
        self.assertEqual(verdict, "false_positive")

    def test_false_positive_already_gated(self) -> None:
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": ["tests/x.ts:1 (Status)"]}
        verdict, _ = harness._classify_drift(d, self.repo)
        self.assertEqual(verdict, "false_positive")

    def test_unverifiable_when_ref_missing(self) -> None:
        d = {"ts": {"ref": "ghost.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": []}
        verdict, reason = harness._classify_drift(d, self.repo)
        self.assertEqual(verdict, "unverifiable")
        self.assertIn("not resolvable", reason)


class ZeroSampleVerdictTests(unittest.TestCase):
    """A check that examined nothing must never report success.

    Measured gap: `validate_drift_output` collapsed "ARIA cited no bad
    evidence" and "ARIA emitted nothing" into one `passed` flag, so the truth
    layer of the acceptance lane printed `[PASS] checked=0 TP=0 FP=0` — a
    green produced by an empty sample. These tests pin the three states apart.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        (self.repo / "a.ts").write_text("x\n", encoding="utf-8")
        (self.repo / "b.sql").write_text("y\n", encoding="utf-8")
        self._real_run_poc = harness._run_poc

    def tearDown(self) -> None:
        harness._run_poc = self._real_run_poc
        self._tmp.cleanup()

    def _with_artifact(self, artifact: dict) -> dict:
        harness._run_poc = lambda repo_root, out_dir: artifact
        return harness.validate_drift_output(repo_root=self.repo)

    def test_empty_output_is_inconclusive_not_pass(self) -> None:
        r = self._with_artifact({"drifts_above_threshold": []})
        self.assertEqual(r["verdict"], "inconclusive")
        self.assertFalse(r["passed"], "an empty sample must not set the ACCEPT flag")
        self.assertIsNone(r["fp_rate"], "no sample means no rate, not a rate of 0.0")

    def test_sub_threshold_signal_alone_is_a_sample(self) -> None:
        # Nothing crossed the threshold, but ARIA did emit something whose
        # evidence can be verified — that is a measurement, not a blank.
        r = self._with_artifact({
            "drifts_above_threshold": [],
            "frontend_dropdown_drifts": [
                {"concept": "x", "ui": {"ref": "a.ts:1"}, "source": {"ref": "b.sql:1"}}
            ],
        })
        self.assertEqual(r["verdict"], "pass")
        self.assertEqual(r["unexamined_signals"], 1)
        self.assertEqual(r["unresolved_refs"], [])

    def test_unresolvable_sub_threshold_ref_fails(self) -> None:
        # A fabricated ref is a fabricated ref at any Jaccard score; scoping
        # the integrity sweep to above-threshold drifts is what let three of
        # four emitted signals go unexamined.
        r = self._with_artifact({
            "drifts_above_threshold": [],
            "drifts_filtered_below_threshold": [
                {"concept": "x", "ts": {"ref": "ghost.ts:1"}, "sql": {"ref": "b.sql:1"}}
            ],
        })
        self.assertEqual(r["verdict"], "fail")
        self.assertFalse(r["passed"])
        self.assertEqual(len(r["unresolved_refs"]), 1)


class CycleFixtureTests(unittest.TestCase):
    """The acceptance fixture must be a git repository.

    Measured gap: the fixture was a bare directory, so `experiment_night`
    failed with `experiment_night_head_sha_unavailable`, the cycle terminated
    'failed', and the harness returned REJECT unconditionally — for a reason
    that said nothing about ARIA.
    """

    def test_fixture_workspace_has_a_resolvable_head_sha(self) -> None:
        import subprocess

        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "workspace"
            (ws / "src").mkdir(parents=True)
            (ws / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
            harness._git_init_fixture(ws)
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=ws, capture_output=True, text=True, check=True
            )
            self.assertRegex(head.stdout.strip(), r"^[0-9a-f]{40}$")


class ScenarioReactionTests(unittest.TestCase):
    def test_aria_reacts_to_all_scenarios(self) -> None:
        result = harness.assert_reacts_to_scenarios()
        self.assertTrue(result["passed"], result["scenarios"])


class CycleAcceptanceTests(unittest.TestCase):
    def test_isolated_cycle_closes_and_keeps_ledger_valid(self) -> None:
        result = harness.run_cycle_acceptance()
        # ARIA-AUDIT-025: only 'completed' is a passing terminal state; the
        # oracle must not green-pin a failed cycle that behaved structurally.
        self.assertEqual(
            result["cycle_status"], "completed", result.get("failed_phases")
        )
        self.assertTrue(
            result["passed"],
            "a completed cycle with intact phase keys + ledger must pass",
        )


class ScorecardPersistenceTests(unittest.TestCase):
    """SI-0 — persistence is the DEFAULT, opt-out is explicit.

    Measured gap: eight days of "continuous" acceptance measurement
    produced zero scorecard artifacts, because persistence hid behind an
    opt-in flag nobody passed. A measurement nobody can read later is a
    claim, not a measurement.
    """

    def test_default_invocation_names_a_dated_scorecard(self) -> None:
        import re

        source = (Path(harness.__file__)).read_text(encoding="utf-8")
        self.assertIn('"acceptance"', source)
        self.assertIn("--no-artifact", source)
        # The default path is derived from _REPO_ROOT (repo-relative), so
        # the artifact lands beside the daily reports wherever the
        # checkout lives — never at an ambient cwd.
        self.assertTrue(
            re.search(r'_REPO_ROOT\s*/\s*"aria-tools"\s*/\s*"reports"\s*/\s*"acceptance"', source),
            "default scorecard path must derive from _REPO_ROOT",
        )

    def test_no_artifact_flag_suppresses_persistence(self) -> None:
        # The flag is the ONLY way to run without a scorecard; its absence
        # plus no --json-out must resolve to the dated default.
        import argparse

        source = (Path(harness.__file__)).read_text(encoding="utf-8")
        self.assertIn("if json_out is None and not args.no_artifact:", source)


if __name__ == "__main__":
    unittest.main()
