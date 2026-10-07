"""ARIA-HIGH-370 — bounded calibration auto-apply, and its automatic revert.

THE DEFECT. ``recommend_calibration`` wrote 36 rows on the runner store
(2026-10-07), each recommending the same four adapter weights (e.g.
``tenant-scoping-adapter`` 50 → 40 at precision 0.19 over 58 labels), and no
weight ever moved. The rows keyed adapter tool ids against the
pressure-source table, so ``current_weight`` was the default 50 of a dial
that did not exist, and ``record_weight_override`` refuses an unknown
source: there was nothing an apply could have written.

Pinned here:

1. the producer reads an adapter's labels as that tool's dial, at the dial's
   current value (not a phantom 50);
2. a recommendation inside the declared bounds and step limit is applied and
   ledgered with its evidence and the bet its revert rule judges;
3. outside the bounds, a step too large, an open window or an operator-owned
   dial stays ``recommendation_only`` and is surfaced with its reason;
4. a window whose labels contradict the bet reverts the dial; one that does
   not holds it; under a profile that may not commit, nothing is written;
5. the dial changes the pressure that carries the tool's raw findings.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.calibration import recommend_calibration
from aria_kernel.tool_registry import ensure_tools_dir

TOOL = "tenant-scoping-adapter"


def label(tool: str, verdict: str, at: str) -> dict[str, Any]:
    return {"tool_id": tool, "verdict": verdict, "recorded_at": at, "finding_id": "x"}


def labels(tool: str, tp: int, fp: int, at: str) -> list[dict[str, Any]]:
    return [label(tool, "true_positive", at)] * tp + [label(tool, "false_positive", at)] * fp


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.feedback: list[dict[str, Any]] = labels(TOOL, 11, 47, "2026-10-01T00:00:00+00:00")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def recommend(self, cycle: str) -> dict[str, Any]:
        with patch("aria_kernel.calibration.load_feedback", return_value=list(self.feedback)):
            return recommend_calibration(cycle_id=cycle, base_dir=self.tools)

    def act(self, recommendation: dict[str, Any], cycle: str) -> dict[str, Any]:
        from aria_kernel.calibration_actuator import apply_bounded_calibration

        with patch("aria_kernel.feedback_store.load_feedback", return_value=list(self.feedback)):
            return apply_bounded_calibration(recommendation=recommendation, base_dir=self.tools, cycle_id=cycle)

    def weight(self) -> int:
        from aria_kernel.calibration_dials import tool_pressure_weights

        return tool_pressure_weights(self.tools).get(TOOL, 50)


class TheProducerNamesARealDialTests(_Store):
    def test_adapter_labels_measure_the_tools_dial_at_its_current_value(self) -> None:
        rec = self.recommend("cyc-1")["pressure_weight_recommendations"]
        self.assertEqual([(r["source"], r["dial"], r["current_weight"], r["recommended_weight"]) for r in rec],
                         [(TOOL, "tool_pressure_weight", 50, 40)])
        self.act(self.recommend("cyc-1"), "cyc-1")
        again = self.recommend("cyc-2")["pressure_weight_recommendations"]
        self.assertEqual((again[0]["current_weight"], again[0]["recommended_weight"]), (40, 30))


class BoundedApplyTests(_Store):
    def test_an_in_bounds_step_is_applied_with_its_evidence(self) -> None:
        recommendation = self.recommend("cyc-1")
        out = self.act(recommendation, "cyc-1")

        self.assertEqual(self.weight(), 40)
        row = out["applied"][0]
        self.assertEqual((row["from_weight"], row["to_weight"], row["bet"]["direction"], row["bet"]["threshold"]),
                         (50, 40, "down", 0.5))
        self.assertEqual(row["evidence"]["recommendation_ledger_hash"], recommendation["ledger_hash"])
        self.assertEqual(row["evidence"]["sample_count"], 58)

    def test_what_it_may_not_apply_is_surfaced_as_advice(self) -> None:
        from aria_kernel.calibration_dials import TOOL_DIAL_MIN

        recs = [
            {"source": "low-adapter", "dial": "tool_pressure_weight", "current_weight": TOOL_DIAL_MIN,
             "recommended_weight": TOOL_DIAL_MIN - 10, "feedback_precision": 0.1, "sample_count": 9},
            {"source": "jump-adapter", "dial": "tool_pressure_weight", "current_weight": 50,
             "recommended_weight": 65, "feedback_precision": 0.9, "sample_count": 9},
            {"source": "evidence_gone", "dial": "pressure_source", "current_weight": 80,
             "recommended_weight": 70, "feedback_precision": 0.2, "sample_count": 9},
        ]
        out = self.act({"cycle_id": "cyc-1", "pressure_weight_recommendations": recs}, "cyc-1")

        self.assertEqual(out["applied"], [])
        self.assertEqual([(s["name"], s["reason"], s["status"]) for s in out["surfaced"]], [
            ("low-adapter", "outside_declared_bounds", "recommendation_only"),
            ("jump-adapter", "step_exceeds_cycle_limit", "recommendation_only"),
            ("evidence_gone", "operator_owned_dial", "recommendation_only"),
        ])

    def test_one_step_per_window_never_a_ratchet_on_the_same_labels(self) -> None:
        self.act(self.recommend("cyc-1"), "cyc-1")
        out = self.act(self.recommend("cyc-2"), "cyc-2")
        self.assertEqual([s["reason"] for s in out["surfaced"]], ["window_open"])
        self.assertEqual(self.weight(), 40)

    def test_a_profile_that_may_not_commit_writes_nothing(self) -> None:
        with patch("aria_kernel.runtime_profile.get_profile", return_value="observe"):
            out = self.act(self.recommend("cyc-1"), "cyc-1")
        self.assertEqual((out["status"], out["applied"]), ("withheld_by_profile", []))
        self.assertFalse((self.tools / "calibration" / "auto-applied.jsonl").exists())


class AutoRevertTests(_Store):
    def test_a_window_that_contradicts_the_bet_reverts_the_dial(self) -> None:
        self.act(self.recommend("cyc-1"), "cyc-1")
        self.feedback += labels(TOOL, 4, 1, "2099-01-01T00:00:00+00:00")  # precision 0.8 > 0.5 after the cut

        out = self.act(self.recommend("cyc-2"), "cyc-2")

        self.assertEqual([(j["event"], j["weight"], j["window"]["labels"]) for j in out["judged"]],
                         [("reverted", 50, 5)])
        self.assertEqual(self.weight(), 50)
        self.assertEqual([s["reason"] for s in out["surfaced"]], ["judged_this_cycle"])

    def test_a_window_that_confirms_the_bet_holds_it(self) -> None:
        self.act(self.recommend("cyc-1"), "cyc-1")
        self.feedback += labels(TOOL, 1, 4, "2099-01-01T00:00:00+00:00")
        out = self.act(self.recommend("cyc-2"), "cyc-2")
        self.assertEqual([j["event"] for j in out["judged"]], ["held"])
        self.assertEqual(self.weight(), 40)

    def test_a_window_short_of_labels_is_not_judged(self) -> None:
        self.act(self.recommend("cyc-1"), "cyc-1")
        self.feedback += labels(TOOL, 4, 0, "2099-01-01T00:00:00+00:00")
        self.assertEqual(self.act(self.recommend("cyc-2"), "cyc-2")["judged"], [])


class TheDialMovesThePressureTests(_Store):
    def test_the_raw_delta_pressure_of_a_cut_tool_scores_lower(self) -> None:
        from aria_kernel import record_run, register_tool
        from aria_kernel.pressure import run_pressure

        from tests.test_enterprise_cycle import shadow_tool

        register_tool({**shadow_tool(), "tool_id": TOOL}, base_dir=self.tools)
        base = {"schema_version": 1, "tool_id": TOOL, "status": "ok", "input_hash": "sha256:i",
                "output_hash": "sha256:o", "read_paths": ["src/app.ts"], "emitted_observations": [],
                "emitted_findings": [], "evidence_validation": {"valid": True}, "operator_feedback_refs": [],
                "duration_ms": 1, "cost_units": 0}
        record_run({**base, "run_id": "r1", "cycle_id": "cycle-1", "runner": {"raw_findings_count": 2}},
                   base_dir=self.tools)
        record_run({**base, "run_id": "r2", "cycle_id": "cycle-2", "runner": {"raw_findings_count": 5}},
                   base_dir=self.tools)

        def score() -> float:
            pressures = run_pressure(cycle_id="cycle-2", base_dir=self.tools)["pressures"]
            return next(p["score"] for p in pressures if p["source"] == "shadow_raw_delta")

        neutral = score()
        self.act(self.recommend("cyc-1"), "cyc-1")
        self.assertAlmostEqual(score(), round(neutral * 40 / 50, 3), places=2)


if __name__ == "__main__":
    unittest.main()
