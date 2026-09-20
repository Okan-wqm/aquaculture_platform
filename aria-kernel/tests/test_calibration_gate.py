"""Typed-judgment plan Phase 6 — a suggestion, not a closer.

One property per test:

* under `measure_only` the confidence gate is the legacy gate bit for bit
  and the consensus row records what `enforce` would have excluded;
* under `enforce`, closing authority is a calibrated quorum: two calibrated
  judges of distinct models — a calibrated judge beside an uncalibrated
  partner does NOT close on its own confidence (the review's C2 path), two
  calibrated judges of one model do not either, two of distinct models do,
  and an uncalibrated dissenter still produces `judge_disagreement`;
* without a calibration map there is nothing to enforce: the gate is
  `measure_only` by construction, whatever the caller asked;
* `effective_calibration_gate` downgrades `enforce` while fewer than two
  calibrated judges of distinct models exist, and says why;
* the two reasons that never escalated are in every vocabulary, and the
  AST invariant walks every reason `feedback_store` emits;
* the escalation sweep records at most N `confidence_uncalibrated`
  escalations per sweep and names the cap on the rest;
* the doctor warns after seven days of a downgraded `enforce`.
"""
from __future__ import annotations

import ast
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel import feedback_store
from aria_kernel.doctor import _check_calibration_gate
from aria_kernel.feedback_store import (
    CALIBRATION_GATES,
    CONSENSUS_UNCERTAINTY_REASONS,
    generate_ai_consensus,
    load_feedback,
    record_consensus_uncertainty,
    record_operator_feedback,
)
from aria_kernel.genesis_policy import effective_calibration_gate, judgment_pipeline_policy
from aria_kernel.human_required import (
    CONSENSUS_UNCERTAINTY_SEVERITY,
    sweep_consensus_uncertainties_for_human_required,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

_KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"


def _seed(root, votes):
    for judge, model, verdict, conf in votes:
        record_operator_feedback(
            tool_id="t", run_id="r", finding_id="f", verdict=verdict, severity="medium", note="x",
            source_type="ai_judge", judge_id=judge, model=model, confidence=conf,
            judgment_group_id="judge:t:fp", base_dir=root,
        )


def _uncertainty_reasons(result) -> list[str]:
    return sorted(u["reason"] for u in result["uncertainties"])


class TheGate(unittest.TestCase):
    def _root(self, tmp) -> Path:
        root = Path(tmp) / "aria-tools"
        ensure_tools_dir(root)
        return root

    def test_measure_only_is_the_legacy_gate_and_records_the_exclusions(self) -> None:
        with TemporaryDirectory() as tmp:
            root = self._root(tmp)
            _seed(root, [("j1", "opus", "true_positive", 0.95), ("j2", "glm", "true_positive", 0.85)])
            legacy = generate_ai_consensus(tool_id="t", base_dir=root)
            self.assertEqual(legacy["consensus_count"], 1)
        with TemporaryDirectory() as tmp:
            root = self._root(tmp)
            _seed(root, [("j1", "opus", "true_positive", 0.95), ("j2", "glm", "true_positive", 0.85)])
            measured = generate_ai_consensus(
                tool_id="t", base_dir=root, judge_calibration={"j1": "calibrated", "j2": "provisional"},
                calibration_gate="measure_only",
            )
            self.assertEqual(measured["consensus_count"], 1)
            row = measured["consensus"][0]
            self.assertEqual(row["confidence"], legacy["consensus"][0]["confidence"])
            self.assertEqual(row["judge_count"], 2)
            self.assertEqual(row["calibration_basis"], {"gate": "measure_only", "excluded_judges": ["j2"]})

    def test_enforce_needs_two_calibrated_judges_of_distinct_models(self) -> None:
        cases = [
            # one calibrated beside an uncalibrated partner: the C2 path
            ({"j1": "calibrated", "j2": "provisional"}, ("opus", "glm"), "confidence_uncalibrated"),
            ({"j1": "calibrated", "j2": "calibrated"}, ("opus", "opus"), "confidence_uncalibrated"),
            ({"j1": "calibrated", "j2": "calibrated"}, ("opus", "glm"), None),
        ]
        for calibration, models, expected in cases:
            with self.subTest(calibration=calibration, models=models):
                with TemporaryDirectory() as tmp:
                    root = self._root(tmp)
                    _seed(root, [("j1", models[0], "true_positive", 0.95), ("j2", models[1], "true_positive", 0.85)])
                    result = generate_ai_consensus(tool_id="t", base_dir=root, judge_calibration=calibration,
                                                   calibration_gate="enforce")
                    if expected is None:
                        self.assertEqual(result["consensus_count"], 1)
                        row = result["consensus"][0]
                        self.assertEqual(row["calibration_basis"], {"gate": "enforce", "excluded_judges": []})
                        self.assertEqual(row["judge_count"], 2)
                    else:
                        self.assertEqual(result["consensus_count"], 0)
                        self.assertEqual(_uncertainty_reasons(result), [expected])

    def test_the_mean_under_enforce_is_over_the_calibrated_quorum_only(self) -> None:
        with TemporaryDirectory() as tmp:
            root = self._root(tmp)
            _seed(root, [("j1", "opus", "true_positive", 0.95), ("j2", "glm", "true_positive", 0.85),
                         ("j3", "fable", "true_positive", 0.55)])
            result = generate_ai_consensus(
                tool_id="t", base_dir=root, judge_calibration={"j1": "calibrated", "j2": "calibrated", "j3": "provisional"},
                calibration_gate="enforce",
            )
            self.assertEqual(result["consensus_count"], 1)
            row = result["consensus"][0]
            self.assertEqual(row["confidence"], 0.9)
            self.assertEqual((row["judge_count"], row["judges_voted"]), (2, 3))
            self.assertEqual(row["calibration_basis"]["excluded_judges"], ["j3"])
            self.assertEqual({o["judge_id"] for o in row["observers"]}, {"j1", "j2"})

    def test_an_uncalibrated_dissenter_still_disagrees(self) -> None:
        with TemporaryDirectory() as tmp:
            root = self._root(tmp)
            _seed(root, [("j1", "opus", "true_positive", 0.95), ("j2", "glm", "true_positive", 0.9),
                         ("j3", "fable", "false_positive", 0.9)])
            result = generate_ai_consensus(
                tool_id="t", base_dir=root, judge_calibration={"j1": "calibrated", "j2": "calibrated", "j3": "provisional"},
                calibration_gate="enforce",
            )
            self.assertEqual(_uncertainty_reasons(result), ["judge_disagreement"])

    def test_without_a_calibration_map_the_gate_is_measure_only_by_construction(self) -> None:
        with TemporaryDirectory() as tmp:
            root = self._root(tmp)
            _seed(root, [("j1", "opus", "true_positive", 0.95), ("j2", "glm", "true_positive", 0.85)])
            result = generate_ai_consensus(tool_id="t", base_dir=root, calibration_gate="enforce")
            self.assertEqual(result["consensus_count"], 1)
            self.assertIsNone(result["consensus"][0]["calibration_basis"])
        with self.assertRaisesRegex(GovernanceError, "unknown calibration_gate"):
            with TemporaryDirectory() as tmp:
                generate_ai_consensus(tool_id="t", base_dir=self._root(tmp), calibration_gate="always")
        self.assertEqual(CALIBRATION_GATES, ("measure_only", "enforce"))


class TheEffectiveGate(unittest.TestCase):
    def test_enforce_waits_for_two_calibrated_judges_of_distinct_models(self) -> None:
        none = effective_calibration_gate("enforce", {})
        self.assertEqual((none["effective"], none["reason"]), ("measure_only", "fewer_than_two_calibrated_judges_of_distinct_models"))
        one = effective_calibration_gate("enforce", {"a": {"calibration_status": "calibrated", "model": "opus"},
                                                     "b": {"calibration_status": "provisional", "model": "glm"}})
        self.assertEqual(one["effective"], "measure_only")
        same = effective_calibration_gate("enforce", {"a": {"calibration_status": "calibrated", "model": "opus"},
                                                      "b": {"calibration_status": "calibrated", "model": "opus"}})
        self.assertEqual(same["effective"], "measure_only")
        ready = effective_calibration_gate("enforce", {"a": {"calibration_status": "calibrated", "model": "opus"},
                                                       "b": {"calibration_status": "calibrated", "model": "glm"}})
        self.assertEqual((ready["effective"], ready["reason"], ready["calibrated_judges"]),
                         ("enforce", "calibrated_quorum_available", ["a", "b"]))
        configured = effective_calibration_gate("measure_only", {"a": {"calibration_status": "calibrated", "model": "opus"},
                                                                 "b": {"calibration_status": "calibrated", "model": "glm"}})
        self.assertEqual((configured["effective"], configured["reason"]), ("measure_only", "configured_measure_only"))
        self.assertEqual(judgment_pipeline_policy()["calibration_gate"], "measure_only")


class TheVocabulariesAgree(unittest.TestCase):
    def test_every_emitted_reason_is_in_both_tables(self) -> None:
        tree = ast.parse((_KERNEL / "feedback_store.py").read_text(encoding="utf-8"))
        emitted: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_consensus_uncertainty":
                last = node.args[-1] if node.args else None
                if isinstance(last, ast.Constant) and isinstance(last.value, str):
                    emitted.add(last.value)
        self.assertTrue(emitted)
        for reason in sorted(emitted):
            with self.subTest(reason=reason):
                self.assertIn(reason, CONSENSUS_UNCERTAINTY_REASONS)
                if reason != "single_judge":
                    self.assertIn(reason, CONSENSUS_UNCERTAINTY_SEVERITY)
        self.assertEqual(set(CONSENSUS_UNCERTAINTY_REASONS) - set(CONSENSUS_UNCERTAINTY_SEVERITY), {"single_judge"},
                         "single_judge is the one deliberately benign reason")
        self.assertEqual(CONSENSUS_UNCERTAINTY_SEVERITY["observer_identity_missing"], "HIGH")
        self.assertEqual(CONSENSUS_UNCERTAINTY_SEVERITY["confidence_uncalibrated"], "LOW")

    def test_the_recorder_accepts_the_two_reasons(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            for reason in ("observer_identity_missing", "confidence_uncalibrated"):
                row = record_consensus_uncertainty(tool_id="t", run_id="r", finding_id="f", group_id="g", reason=reason,
                                                   base_dir=root)
                self.assertEqual(row["reason"], reason)


class TheSweepCap(unittest.TestCase):
    def test_at_most_n_uncalibrated_escalations_per_sweep(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            for i in range(8):
                record_consensus_uncertainty(tool_id="t", run_id=f"r{i}", finding_id=f"f{i}", group_id=f"g{i}",
                                             reason="confidence_uncalibrated", base_dir=root)
            record_consensus_uncertainty(tool_id="t", run_id="rx", finding_id="fx", group_id="gx",
                                         reason="judge_disagreement", base_dir=root)
            result = sweep_consensus_uncertainties_for_human_required(base_dir=root, max_uncalibrated_escalations=3)
            created_reasons = [r["context"]["uncertainty_reason"] for r in result["created"]]
            self.assertEqual(created_reasons.count("confidence_uncalibrated"), 3)
            self.assertEqual(created_reasons.count("judge_disagreement"), 1)
            self.assertEqual(sum(1 for s in result["skipped"] if s.get("kind") == "sweep_cap_reached"), 5)


class TheDoctorHearsADowngradedEnforce(unittest.TestCase):
    def test_warns_after_seven_days_and_not_before(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            self.assertEqual(_check_calibration_gate(root).status, "ok")
            append_tools_governance(root, "calibration_gate", {
                "schema_version": 1, "configured": "enforce", "effective": "measure_only",
                "reason": "fewer_than_two_calibrated_judges_of_distinct_models",
            })
            fresh = _check_calibration_gate(root)
            self.assertEqual(fresh.status, "ok")
            self.assertEqual(fresh.detail["effective"], "measure_only")
            later = datetime.now(timezone.utc) + timedelta(days=8)
            self.assertEqual(_check_calibration_gate(root, now=later).status, "warn")


if __name__ == "__main__":
    unittest.main()
