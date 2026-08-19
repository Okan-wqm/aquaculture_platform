"""G-1 — the operator's threshold, and the honesty rule that makes it worth having.

Before this, ARIA could say how much it did and never whether the product
was good: every bar was a process count or a per-adapter precision floor,
and the acceptance harness computed a false-positive rate it then ignored.
These pins guard the two ways a fitness score goes wrong — scoring green
while blind, and letting the charter drift out of the operator's hands.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from aria_kernel.product_fitness import (
    evaluate_fitness,
    load_charter,
    streak_from_history,
)

_REPO = Path(__file__).resolve().parents[2]


class _Reader:
    def __init__(self, runs, *, boom: bool = False) -> None:
        self._runs, self._boom = runs, boom

    def runs_for_commit(self, sha: str):
        if self._boom:
            raise RuntimeError("gh unavailable")
        return self._runs


def _all_lanes(conclusion: str = "success") -> list[dict]:
    charter = load_charter(_REPO)
    names = {n for d in charter["dimensions"] for n in d.get("workflows") or []}
    return [
        {"name": n, "status": "completed", "conclusion": conclusion} for n in names
    ]


class UnknownIsNeverGreen(unittest.TestCase):
    def test_an_unreadable_reader_is_unknown_not_green(self) -> None:
        verdict = evaluate_fitness(
            workspace_root=_REPO, head_sha="x", reader=_Reader([], boom=True),
        )
        self.assertEqual(verdict.status, "unknown")
        self.assertTrue(all(d.status == "unknown" for d in verdict.dimensions))

    def test_a_silent_lane_is_unknown_not_green(self) -> None:
        runs = _all_lanes()
        dropped = runs[:-1]
        verdict = evaluate_fitness(
            workspace_root=_REPO, head_sha="x", reader=_Reader(dropped),
        )
        self.assertEqual(verdict.status, "unknown")
        self.assertTrue(
            any("did not report" in d.detail for d in verdict.dimensions),
            [d.as_dict() for d in verdict.dimensions],
        )

    def test_all_lanes_passing_is_green(self) -> None:
        verdict = evaluate_fitness(
            workspace_root=_REPO, head_sha="x", reader=_Reader(_all_lanes()),
        )
        self.assertEqual(verdict.status, "green", [d.as_dict() for d in verdict.dimensions])

    def test_one_failing_lane_reds_the_whole_verdict(self) -> None:
        runs = _all_lanes()
        runs[0] = {**runs[0], "conclusion": "failure"}
        verdict = evaluate_fitness(
            workspace_root=_REPO, head_sha="x", reader=_Reader(runs),
        )
        self.assertEqual(verdict.status, "red")

    def test_unknown_breaks_the_streak_exactly_like_red(self) -> None:
        for breaker in ("unknown", "red"):
            history = [{"status": "green"}] * 5 + [{"status": breaker}]
            self.assertEqual(
                streak_from_history(history, required=7)["consecutive_green_nights"],
                0, breaker,
            )


class TheCharterStaysTheOperatorsDocument(unittest.TestCase):
    def test_every_dimension_names_operator_words_and_a_rationale(self) -> None:
        # A dimension nobody can trace back to what the operator asked for
        # is a metric ARIA invented for itself.
        charter = load_charter(_REPO)
        for dimension in charter["dimensions"]:
            self.assertTrue(dimension.get("operator_words"), dimension)
            self.assertTrue(dimension.get("rationale"), dimension)

    def test_every_measurement_is_an_existing_gate(self) -> None:
        # The instrument may not invent a measurement: each dimension
        # resolves through lanes that already vote in this repository.
        charter = load_charter(_REPO)
        workflows_dir = _REPO / ".github" / "workflows"
        declared = {
            (wf.get("name") or "").strip()
            for wf in (
                _read_workflow_name(p) for p in workflows_dir.glob("*.yml")
            )
            if wf
        }
        for dimension in charter["dimensions"]:
            for name in dimension.get("workflows") or []:
                self.assertIn(
                    name, declared,
                    f"{dimension['id']}: no workflow named {name!r} exists — a "
                    "charter dimension cannot measure a lane that does not vote",
                )

    def test_the_threshold_is_a_streak_not_a_single_night(self) -> None:
        charter = load_charter(_REPO)
        self.assertGreaterEqual(int(charter["consecutive_green_nights_required"]), 5)


def _read_workflow_name(path: Path) -> dict | None:
    import yaml

    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — a malformed workflow is not this test's subject
        return None
    return doc if isinstance(doc, dict) else None


if __name__ == "__main__":
    unittest.main()
