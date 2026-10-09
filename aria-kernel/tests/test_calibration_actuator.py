"""ARIA-HIGH-370 — bounded calibration auto-apply on the tool dial.

THE DEFECT. ``recommend_calibration`` wrote 36 rows on the runner store
(2026-10-07), each recommending the same four adapter weights, and no
weight ever moved: the rows keyed adapter tool ids against the
pressure-source table, a dial that did not exist for them.

REVIEW OF #1829 (HIGH-4, M). The first actuator flapped (a raise undone at a
true precision of 0.9 about 41 % of the time, on a 5-label point estimate),
re-cut a "held" dial down to the floor on the same labels, let a window with
no labels freeze the dial, cut the security adapters, and trusted the ledger
on read. Pinned here:

1. the producer reads an adapter's labels as that tool's dial, at its
   current value, and needs ten labels;
2. a step needs ten FRESH labels whose 90 % Wilson interval sits on the
   step's side; the same labels never take two steps; a window that cannot
   fill closes as ``held_timeout`` and takes no further step;
3. undo is hysteretic (the opposite bound) and is followed by a cooldown;
4. security adapters are raise-only, floor neutral; the set covers every
   registered adapter that names security, tenant, auth, rls or secret;
5. the dial is clamped on read; it changes the tool's raw-delta pressure;
   nothing is written under a profile that may not commit.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.calibration import recommend_calibration
from aria_kernel.tool_registry import ensure_tools_dir

TOOL = "doc-staleness-adapter"
SECURE = "tenant-scoping-adapter"
T0 = datetime(2026, 10, 10, tzinfo=timezone.utc)
REPO = Path(__file__).resolve().parents[2]


def labels(tool: str, tp: int, fp: int, at: datetime) -> list[dict[str, Any]]:
    row = {"tool_id": tool, "recorded_at": at.isoformat(), "finding_id": "x"}
    return [{**row, "verdict": "true_positive"}] * tp + [{**row, "verdict": "false_positive"}] * fp


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.feedback: list[dict[str, Any]] = labels(TOOL, 11, 47, T0 - timedelta(days=9))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def recommend(self, cycle: str) -> dict[str, Any]:
        with patch("aria_kernel.calibration.load_feedback", return_value=list(self.feedback)):
            return recommend_calibration(cycle_id=cycle, base_dir=self.tools)

    def act(self, cycle: str, at: datetime, recommendation: dict[str, Any] | None = None) -> dict[str, Any]:
        from aria_kernel.calibration_actuator import apply_bounded_calibration

        rec = recommendation if recommendation is not None else self.recommend(cycle)
        with patch("aria_kernel.feedback_store.load_feedback", return_value=list(self.feedback)):
            return apply_bounded_calibration(recommendation=rec, base_dir=self.tools, cycle_id=cycle, now=at)

    def weight(self, tool: str = TOOL) -> int:
        from aria_kernel.calibration_dials import tool_pressure_weights

        return tool_pressure_weights(self.tools).get(tool, 50)

    def reasons(self, out: dict[str, Any]) -> list[str]:
        return [s["reason"] for s in out["surfaced"]]


class TheProducerNamesARealDialTests(_Store):
    def test_adapter_labels_measure_the_tools_dial_at_its_current_value(self) -> None:
        rec = self.recommend("cyc-1")["pressure_weight_recommendations"]
        self.assertEqual([(r["source"], r["dial"], r["current_weight"], r["recommended_weight"]) for r in rec],
                         [(TOOL, "tool_pressure_weight", 50, 40)])
        self.act("cyc-1", T0)
        self.assertEqual(self.recommend("cyc-2")["pressure_weight_recommendations"][0]["current_weight"], 40)

    def test_nine_labels_recommend_nothing(self) -> None:
        self.feedback = labels(TOOL, 0, 9, T0)
        self.assertEqual(self.recommend("cyc-1")["pressure_weight_recommendations"], [])


class OnlyGroundTruthMovesAnAutoAppliedDialTests(unittest.TestCase):
    """Review of #1896 (HIGH) — the actuator counts ground truth only:
    human labels and anchored ai_consensus. A replay row, a lone ai_judge
    verdict and an unanchored consensus are never fresh labels."""

    def count(self, rows: list[dict[str, Any]]) -> tuple[int, int]:
        from aria_kernel.calibration_actuator import _labels

        out = _labels(rows, TOOL, None)
        return out["tp"], out["fp"]

    def test_human_and_legacy_unlabelled_rows_count(self) -> None:
        base = {"tool_id": TOOL, "recorded_at": T0.isoformat(), "finding_id": "x"}
        rows = [{**base, "verdict": "true_positive", "source_type": "human"},
                {**base, "verdict": "false_positive"}]
        self.assertEqual(self.count(rows), (1, 1))

    def test_ai_judge_rows_never_move_a_dial(self) -> None:
        base = {"tool_id": TOOL, "recorded_at": T0.isoformat(), "finding_id": "x", "source_type": "ai_judge"}
        self.assertEqual(self.count([{**base, "verdict": "false_positive"}] * 20), (0, 0))

    def test_an_unanchored_consensus_never_moves_a_dial(self) -> None:
        base = {"tool_id": TOOL, "recorded_at": T0.isoformat(), "finding_id": "x",
                "source_type": "ai_consensus", "judge_count": 2, "judges_voted": 2}
        self.assertEqual(self.count([{**base, "verdict": "false_positive"}] * 20), (0, 0))

    def test_a_belief_verdict_never_moves_the_source_tools_dial(self) -> None:
        # An operator settling a belief escalation is recorded as a human
        # row carrying the source tool's id (human_required); it judges the
        # belief, not the adapter.
        base = {"tool_id": TOOL, "recorded_at": T0.isoformat(), "finding_id": "x", "source_type": "human"}
        rows = [{**base, "verdict": "false_positive", "judgment_subject": "belief"}]
        self.assertEqual(self.count(rows), (0, 0))
        self.assertEqual(self.count([{**base, "verdict": "false_positive", "judgment_subject": "finding"}]), (0, 1))

    def test_replay_rows_never_move_a_dial_even_as_human(self) -> None:
        base = {"tool_id": TOOL, "recorded_at": T0.isoformat(), "finding_id": "x", "source_type": "human"}
        rows = [{**base, "verdict": "true_positive", "judgment_group_id": f"replay:{TOOL}:r:f"},
                {**base, "verdict": "false_positive", "judge_id": "goldset-replay"}]
        self.assertEqual(self.count(rows), (0, 0))


class StepsNeedFreshSupportingLabelsTests(_Store):
    def test_an_in_bounds_supported_cut_is_applied_with_its_evidence(self) -> None:
        recommendation = self.recommend("cyc-1")
        row = self.act("cyc-1", T0, recommendation)["applied"][0]
        self.assertEqual(self.weight(), 40)
        self.assertEqual((row["from_weight"], row["to_weight"], row["direction"]), (50, 40, "down"))
        self.assertEqual(row["evidence"]["recommendation_ledger_hash"], recommendation["ledger_hash"])
        self.assertEqual(row["evidence"]["fresh_labels"]["labels"], 58)
        self.assertNotIn("bet", row)  # no outcome is claimed for a pressure dial

    def test_what_it_may_not_apply_is_surfaced_as_advice(self) -> None:
        def rec(source: str, dial: str, cur: int, to: int) -> dict[str, Any]:
            return {"source": source, "dial": dial, "current_weight": cur, "recommended_weight": to,
                    "feedback_precision": 0.1, "sample_count": 58}

        self.feedback += labels("thin-adapter", 0, 4, T0) + labels("mid-adapter", 6, 6, T0)
        out = self.act("cyc-1", T0, {"cycle_id": "c", "pressure_weight_recommendations": [
            rec(TOOL, "tool_pressure_weight", 20, 10), rec(TOOL, "tool_pressure_weight", 50, 65),
            rec("evidence_gone", "pressure_source", 80, 70), rec("thin-adapter", "tool_pressure_weight", 50, 40),
            rec("mid-adapter", "tool_pressure_weight", 50, 40)]})
        self.assertEqual(out["applied"], [])
        self.assertEqual(self.reasons(out), ["outside_declared_bounds", "step_exceeds_cycle_limit",
                                             "operator_owned_dial", "too_few_fresh_labels",
                                             "interval_does_not_support_step"])

    def test_one_step_per_window_and_an_unfilled_window_times_out_to_hold_with_no_further_step(self) -> None:
        self.act("cyc-1", T0)
        self.assertEqual(self.reasons(self.act("cyc-2", T0 + timedelta(days=1))), ["window_open"])
        out = self.act("cyc-3", T0 + timedelta(days=22))
        self.assertEqual([j["event"] for j in out["judged"]], ["held_timeout"])
        later = self.act("cyc-4", T0 + timedelta(days=23))
        self.assertEqual((self.reasons(later), self.weight()), (["too_few_fresh_labels"], 40))


class HysteresisAndCooldownTests(_Store):
    def test_a_raise_is_not_undone_by_a_precision_inside_the_band(self) -> None:
        self.feedback = labels(TOOL, 30, 0, T0 - timedelta(days=9))
        self.act("cyc-1", T0)
        self.assertEqual(self.weight(), 55)
        self.feedback += labels(TOOL, 8, 2, T0 + timedelta(days=1))  # 0.8: under 0.85, inside the band
        out = self.act("cyc-2", T0 + timedelta(days=2))
        self.assertEqual(([j["event"] for j in out["judged"]], self.weight()), (["held"], 55))

    def test_fresh_labels_past_the_opposite_bound_undo_the_cut_and_start_a_cooldown(self) -> None:
        self.act("cyc-1", T0)
        self.feedback += labels(TOOL, 10, 0, T0 + timedelta(days=1))
        out = self.act("cyc-2", T0 + timedelta(days=2))
        self.assertEqual(([j["event"] for j in out["judged"]], self.weight()), (["reverted"], 50))
        self.feedback += labels(TOOL, 0, 40, T0 + timedelta(days=3))
        self.assertEqual(self.reasons(self.act("cyc-3", T0 + timedelta(days=4))), ["cooldown_after_undo"])


class SecurityAdaptersAreRaiseOnlyTests(_Store):
    def test_a_security_adapter_is_never_cut_and_its_floor_is_neutral(self) -> None:
        from aria_kernel.calibration_dials import dial_bounds

        self.feedback = labels(SECURE, 11, 47, T0 - timedelta(days=9))
        out = self.act("cyc-1", T0)
        self.assertEqual((self.reasons(out), self.weight(SECURE)), (["security_tool_cut_is_operator_act"], 50))
        self.assertEqual(dial_bounds(SECURE)[0], 50)

    def test_every_registered_security_adapter_is_in_the_set(self) -> None:
        from aria_kernel.calibration_dials import SECURITY_TOOLS

        names = {json.loads(p.read_text(encoding="utf-8")).get("tool_id")
                 for p in (REPO / "tools" / "aria-adapters").glob("*.tool.json")}
        sensitive = {n for n in names if n and any(w in n for w in ("security", "tenant", "auth", "rls", "secret"))}
        self.assertTrue(sensitive)
        self.assertLessEqual(sensitive, SECURITY_TOOLS)


class TheDialIsClampedOnReadTests(_Store):
    def test_a_stray_ledger_weight_cannot_leave_the_bounds(self) -> None:
        from aria_kernel.calibration_dials import AUTO_APPLIED_SURFACE, tool_pressure_weights
        from aria_kernel.ledger import append_declared_jsonl

        path = self.tools / "calibration" / "auto-applied.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        for tool, weight in ((TOOL, 1000), (SECURE, 20)):
            append_declared_jsonl(path, {"schema_version": 1, "event": "applied", "application_id": tool,
                                         "dial": {"kind": "tool_pressure_weight", "name": tool},
                                         "from_weight": 50, "to_weight": weight, "applied_at": T0.isoformat()},
                                  expected_surface=AUTO_APPLIED_SURFACE)
        self.assertEqual(tool_pressure_weights(self.tools), {TOOL: 80, SECURE: 50})


class ProfileAndPressureTests(_Store):
    def test_a_profile_that_may_not_commit_writes_nothing(self) -> None:
        with patch("aria_kernel.runtime_profile.get_profile", return_value="observe"):
            out = self.act("cyc-1", T0)
        self.assertEqual((out["status"], out["applied"]), ("withheld_by_profile", []))
        self.assertFalse((self.tools / "calibration" / "auto-applied.jsonl").exists())

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
        self.act("cyc-1", T0)
        self.assertAlmostEqual(score(), round(neutral * 40 / 50, 3), places=2)


if __name__ == "__main__":
    unittest.main()
