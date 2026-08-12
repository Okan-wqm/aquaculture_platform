"""C5/E8 — every producer phase's output reaches post-drain reflection.

Pre-C5 the orchestrator's five post-drain `run_reflection` call sites passed
only convergence/review, and `defer_reflection=True` skipped the in-cycle
reflection that used to carry the calibration trio — so on the autonomy lane
the Pedagogy / Skill-Genesis / Calibration / Recommendation / Proactive /
Cycle-Runner report sections could NEVER render. These tests pin the single
kwargs builder all five call sites share, and prove a reflection row built
from it actually carries the sub-objects.
"""
from __future__ import annotations

import inspect
import tempfile
import unittest
from pathlib import Path

from aria_kernel.reflection import run_reflection
from aria_kernel.reflection_inputs import (
    pedagogy_lint_snapshot,
    producer_reflection_kwargs,
)
from aria_kernel.tool_registry import ensure_tools_dir


class ProducerKwargsTests(unittest.TestCase):
    def test_phases_and_summary_are_carried(self) -> None:
        kwargs = producer_reflection_kwargs(
            cycle_summary={
                "skill_genesis": {"resolved": 1},
                "cycle": {"status": "ok"},
            },
            cycle_result={
                "phases": {
                    "judge_calibration": {"judged_judges": 2},
                    "calibration_recommendation": {"recommended": True},
                    "proactive_priority": {"ranked": []},
                },
            },
            pedagogy_lint_result={"lint_pass_rate": 1.0},
        )
        self.assertEqual(kwargs["calibration_result"], {"judged_judges": 2})
        self.assertEqual(kwargs["recommendation_result"], {"recommended": True})
        self.assertEqual(kwargs["proactive_result"], {"ranked": []})
        self.assertEqual(kwargs["skill_genesis_result"], {"resolved": 1})
        self.assertEqual(kwargs["cycle_runner_result"], {"status": "ok"})
        self.assertEqual(kwargs["pedagogy_lint_result"], {"lint_pass_rate": 1.0})

    def test_crashed_cycle_yields_skipped_not_error(self) -> None:
        # The crash path's contract: cycle_result is None, but the crash
        # summary itself still travels via cycle_summary["cycle"].
        kwargs = producer_reflection_kwargs(
            cycle_summary={"cycle": {"status": "failed", "error": "boom"}},
            cycle_result=None,
            pedagogy_lint_result=None,
        )
        self.assertIsNone(kwargs["calibration_result"])
        self.assertIsNone(kwargs["skill_genesis_result"])
        self.assertEqual(
            kwargs["cycle_runner_result"], {"status": "failed", "error": "boom"}
        )

    def test_every_builder_key_is_a_real_reflection_kwarg(self) -> None:
        """Deliberate-break pin: if run_reflection renames or drops a
        producer kwarg, the builder must fail HERE, not silently feed a
        swallowed **kwargs at five call sites."""
        accepted = set(inspect.signature(run_reflection).parameters)
        built = set(
            producer_reflection_kwargs(
                cycle_summary={}, cycle_result=None, pedagogy_lint_result=None
            )
        )
        self.assertTrue(
            built <= accepted,
            f"builder emits kwargs run_reflection does not accept: {built - accepted}",
        )
        self.assertEqual(len(built), 6)


class PedagogySnapshotTests(unittest.TestCase):
    def test_no_agents_dir_is_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(pedagogy_lint_snapshot(tmp))
        self.assertIsNone(pedagogy_lint_snapshot(None))

    def test_agents_dir_yields_report_dict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agents = Path(tmp) / ".claude" / "agents"
            agents.mkdir(parents=True)
            (agents / "sample-agent.md").write_text(
                "---\nname: sample-agent\ndescription: test\n---\nbody\n"
            )
            snap = pedagogy_lint_snapshot(tmp)
        self.assertIsInstance(snap, dict)
        for key in ("lint_pass_rate", "violation_count", "agents_scanned"):
            self.assertIn(key, snap)
        self.assertGreaterEqual(snap["agents_scanned"], 1)


class ReflectionRowCarriesProducersTests(unittest.TestCase):
    def test_reflection_row_renders_producer_sub_objects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            row = run_reflection(
                cycle_id="cyc-c5",
                base_dir=root,
                **producer_reflection_kwargs(
                    cycle_summary={
                        "skill_genesis": {"resolved": 2},
                        "cycle": {"status": "ok"},
                    },
                    cycle_result={
                        "phases": {
                            "judge_calibration": {"judged_judges": 3},
                            "calibration_recommendation": {"x": 1},
                            "proactive_priority": {"y": 2},
                        },
                    },
                    pedagogy_lint_result={
                        "lint_pass_rate": 0.9,
                        "violation_count": 4,
                        "agents_scanned": 40,
                    },
                ),
            )
        # Pre-C5 all of these were None on the autonomy lane, always.
        self.assertEqual(row["pedagogy"]["violation_count"], 4)
        self.assertEqual(row["skill_genesis"], {"resolved": 2})
        self.assertEqual(row["cycle_runner"], {"status": "ok"})
        self.assertEqual(row["calibration"], {"judged_judges": 3})


if __name__ == "__main__":
    unittest.main()
