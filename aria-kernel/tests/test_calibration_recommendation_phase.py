"""ARIA's own scoring finally has something feeding the approval it requires.

`record_weight_override` turns an approved recommendation into behaviour, and
until now nothing could produce a recommendation for it to act on. The producer
`recommend_calibration` was reachable only from `heartbeat_tick` — a superseded
driver that calls `run_cycle` itself, and therefore has no production caller —
and `list_calibration_recommendations` had no caller at all. Three dead links in
one chain: nothing computed advice, nothing displayed it, so there was never
anything for an operator to approve.

These pin the producer, the display, and — as firmly — the line the loop must
not cross on its own.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel import reflection as reflection_mod


def _context(base_dir: str):
    return cycle_mod.build_phase_context(
        cycle_id="cyc-calibration",
        workspace_root=Path(base_dir),
        base_dir=Path(base_dir),
    )


class CalibrationRecommendationPhaseTest(unittest.TestCase):
    def test_phase_exists_and_runs_beside_the_ledgers_it_reads(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]

        self.assertIn("calibration_recommendation", names)
        # It joins the same feedback ledger judge_calibration scores.
        self.assertLess(names.index("judge_calibration"), names.index("calibration_recommendation"))

    def test_a_failed_recommendation_does_not_fail_the_cycle(self) -> None:
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "calibration_recommendation")

        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.state_key, "calibration_recommendation")

    def test_produces_a_recommendation_row_every_cycle(self) -> None:
        with TemporaryDirectory() as tmp:
            context = _context(tmp)
            with patch.object(
                cycle_mod, "recommend_calibration", return_value={"status": "recommendation_only"}
            ) as produce:
                result = cycle_mod._phase_calibration_recommendation(context)

            produce.assert_called_once()
            self.assertEqual(produce.call_args.kwargs["cycle_id"], "cyc-calibration")
            self.assertEqual(result["status"], "recommendation_only")

    def test_stops_at_advice_and_never_applies_a_weight_itself(self) -> None:
        # The line that matters: a system which silently reweights its own
        # scoring can rationalise anything it later measures. Approval is an
        # operator act, so the phase must not reach the override writer.
        with TemporaryDirectory() as tmp:
            context = _context(tmp)
            with patch("aria_kernel.pressure.record_weight_override") as apply_override:
                cycle_mod._phase_calibration_recommendation(context)

            apply_override.assert_not_called()


class CalibrationRecommendationReportTest(unittest.TestCase):
    def test_renders_the_weights_it_would_change(self) -> None:
        section = reflection_mod._render_calibration_recommendation_section(
            {
                "calibration_recommendation": {
                    "pressure_weight_recommendations": [
                        {
                            "source": "evidence_gone",
                            "current_weight": 80,
                            "recommended_weight": 65,
                            "reason": "precision 0.41 over 22 samples",
                        }
                    ],
                }
            }
        )
        rendered = "\n".join(section)

        self.assertIn("evidence_gone", rendered)
        self.assertIn("80 -> 65", rendered)
        # The operator has to be told HOW to act, in the place they read it.
        self.assertIn("pressure weight-override", rendered)
        self.assertIn("operator act", rendered)

    def test_says_nothing_when_there_is_nothing_to_recommend(self) -> None:
        # A section that renders an empty heading every day teaches the reader
        # to skip the heading.
        self.assertEqual(reflection_mod._render_calibration_recommendation_section({}), [])
        self.assertEqual(
            reflection_mod._render_calibration_recommendation_section(
                {"calibration_recommendation": {"pressure_weight_recommendations": [], "tool_recommendations": []}}
            ),
            [],
        )

    def test_the_renderer_is_actually_called_by_the_report_writer(self) -> None:
        # Writing a renderer and never calling it is the same defect this whole
        # chain is made of, one level down: deleting the call from the assembly
        # left every direct-render test green. Asserted at the source rather
        # than by writing a report, because the writer reads a dozen unrelated
        # sub-objects and reproducing its schema here would be a second copy of
        # it — the duplication this change exists to stop.
        import inspect

        assembly = inspect.getsource(reflection_mod._write_daily_report)

        self.assertIn("_render_calibration_recommendation_section", assembly)

    def test_reflection_carries_the_recommendation_through(self) -> None:
        # The phase result has to survive the trip into the row the report
        # renders; otherwise the producer feeds a display that never sees it.
        import inspect

        params = inspect.signature(reflection_mod.run_reflection).parameters
        self.assertIn("recommendation_result", params)


if __name__ == "__main__":
    unittest.main()
