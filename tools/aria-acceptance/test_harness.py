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


class CycleCleanlinessTests(unittest.TestCase):
    """Plan 031-R R5 (B6) — only a clean terminal cycle is acceptable."""

    def test_clean_cycle_passes(self) -> None:
        result = {"status": "completed", "runtime_status": "ok", "failed_phases": []}
        self.assertEqual(harness._cycle_cleanliness_failures(result), [])

    def test_failed_cycle_rejected(self) -> None:
        result = {"status": "failed", "runtime_status": "ok", "failed_phases": []}
        self.assertTrue(harness._cycle_cleanliness_failures(result))

    def test_aborted_cycle_rejected(self) -> None:
        result = {"status": "aborted", "runtime_status": "ok", "failed_phases": []}
        self.assertTrue(harness._cycle_cleanliness_failures(result))

    def test_nonok_runtime_status_rejected(self) -> None:
        result = {"status": "completed", "runtime_status": "degraded", "failed_phases": []}
        self.assertTrue(harness._cycle_cleanliness_failures(result))

    def test_failed_phases_rejected(self) -> None:
        result = {"status": "completed", "runtime_status": "ok",
                  "failed_phases": [{"phase": "validation_matrix", "status": "failed"}]}
        self.assertTrue(harness._cycle_cleanliness_failures(result))


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


class ScenarioReactionTests(unittest.TestCase):
    def test_aria_reacts_to_all_scenarios(self) -> None:
        result = harness.assert_reacts_to_scenarios()
        self.assertTrue(result["passed"], result["scenarios"])


class CycleAcceptanceTests(unittest.TestCase):
    def test_isolated_cycle_closes_and_keeps_ledger_valid(self) -> None:
        result = harness.run_cycle_acceptance()
        self.assertTrue(result["passed"], result["failures"])
        self.assertIn(result["cycle_status"], ("completed", "failed"))


if __name__ == "__main__":
    unittest.main()
