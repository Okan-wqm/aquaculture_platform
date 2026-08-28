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


class TheLadderIsHonestAboutWhatItCannotMeasure(unittest.TestCase):
    """v2 — the thresholds are a ladder, and the first rung is being able to see.

    Most of these dimensions are not instrumented today: production
    deploys have been disabled since 2026-07-15, the WAL-freshness lane
    has never produced a job, the backup evidence signature is skipped,
    and there is no product-side latency ledger. A charter that scored
    those as green would be measuring its own blindness.
    """

    def test_every_dimension_declares_the_instrument_it_still_lacks(self) -> None:
        for dimension in load_charter(_REPO)["dimensions"]:
            self.assertTrue(
                dimension.get("instrument_gap"),
                f"{dimension['id']}: a dimension must say what it cannot yet "
                "measure — silence there is how a bar becomes theatre",
            )

    def test_the_zero_tolerance_dimension_carries_no_budget_to_spend(self) -> None:
        # A budget says "this much failure is acceptable". For cross-tenant
        # reads there is no such amount, so the budget's every ceiling is 0.
        tenant = next(
            d for d in load_charter(_REPO)["dimensions"] if d.get("zero_tolerance")
        )
        self.assertEqual(tenant["id"], "multi_tenant")
        self.assertTrue(all(v == 0 for v in tenant["budget"].values()), tenant["budget"])

    def test_the_stages_ratchet_upwards(self) -> None:
        stages = load_charter(_REPO)["stages"]
        nights = [int(s["consecutive_green_nights_required"]) for s in stages]
        self.assertEqual(nights, sorted(nights), stages)
        self.assertEqual(len(set(s["id"] for s in stages)), len(stages))

    def test_the_active_stage_is_one_of_the_declared_stages(self) -> None:
        charter = load_charter(_REPO)
        ids = {s["id"] for s in charter["stages"]}
        self.assertIn(charter["active_stage"], ids)
        active = next(
            s for s in charter["stages"] if s["id"] == charter["active_stage"]
        )
        self.assertEqual(
            int(charter["consecutive_green_nights_required"]),
            int(active["consecutive_green_nights_required"]),
            "the evaluated streak requirement must be the ACTIVE stage's, "
            "or the charter says one thing and the phase measures another",
        )

    def test_stage_c_names_the_operator_decision_that_blocks_it(self) -> None:
        # Change-failure rate and MTTR cannot be computed while production
        # deploys are off. Saying so in the charter is what stops a future
        # reader from treating an unmeasurable stage as an unmet one.
        note = load_charter(_REPO)["outcome_metrics_stage_c"]["note"]
        self.assertIn("PRODUCTION_DEPLOY_ENABLED", note)


if __name__ == "__main__":
    unittest.main()
