"""SI-1 — a stage that converts nothing becomes a pressure, not a low draw.

The counters were already there; nothing acted on them. Measured
2026-08-19: 597 requests minted, ZERO plans ever CONVERGED, a wedge two
days old — and the only consumer of those numbers lowered a Thompson
sampling weight, so ARIA's own paralysis read as a scheduling
preference. A human found it by reading ledgers.
"""
from __future__ import annotations

import unittest

from aria_kernel.funnel_health import (
    MIN_UPSTREAM_FOR_STALL,
    detect_funnel_stalls,
)
from aria_kernel.pressure import DRIFT_CLASS_BY_SOURCE, SOURCE_WEIGHTS


def _row(source: str, minted: int, converged: int, merged: int) -> dict:
    return {
        "source_type": source,
        "cycles_minted": minted,
        "cycles_converged": converged,
        "cycles_merged": merged,
    }


class TheStallIsNamed(unittest.TestCase):
    def test_the_measured_production_wedge_is_detected(self) -> None:
        # The real numbers from the night this was written.
        stalls = detect_funnel_stalls([_row("finding", 597, 0, 0)])
        stages = {s.stage for s in stalls}
        self.assertIn("convergence", stages)
        stall = next(s for s in stalls if s.stage == "convergence")
        self.assertEqual(stall.upstream, 597)
        self.assertIn("597 arrived", stall.summary)

    def test_a_small_sample_is_idle_not_stalled(self) -> None:
        # Below the volume floor "zero converged" says more about the
        # sample than the pipeline — a new source is not a defect.
        self.assertEqual(
            detect_funnel_stalls([_row("new-source", MIN_UPSTREAM_FOR_STALL - 1, 0, 0)]),
            [],
        )

    def test_a_flowing_funnel_is_silent(self) -> None:
        self.assertEqual(detect_funnel_stalls([_row("healthy", 40, 12, 5)]), [])

    def test_each_stage_is_judged_against_its_own_upstream(self) -> None:
        # Merge converts nothing, but only 3 plans ever converged — that is
        # a small sample at the merge stage, not a stalled one. Judging
        # merge against MINTED instead would fire a false alarm here.
        self.assertEqual(detect_funnel_stalls([_row("s", 500, 3, 0)]), [
            s for s in detect_funnel_stalls([_row("s", 500, 3, 0)])
            if s.stage == "convergence"
        ])
        stalls = detect_funnel_stalls([_row("s", 500, 3, 0)])
        self.assertEqual([s.stage for s in stalls], [])

    def test_the_merge_stage_can_stall_on_its_own(self) -> None:
        stalls = detect_funnel_stalls([_row("s", 500, 60, 0)])
        self.assertEqual([s.stage for s in stalls], ["merge"])

    def test_an_empty_ledger_is_not_a_stall(self) -> None:
        self.assertEqual(detect_funnel_stalls([]), [])


class TheSourceIsRegisteredEverywhere(unittest.TestCase):
    def test_the_pressure_source_is_in_both_closed_tables(self) -> None:
        # ORPHAN-733's lesson, paid once: a source registered in one table
        # and not the other kills the whole cycle at runtime.
        self.assertIn("pipeline_stalled", SOURCE_WEIGHTS)
        self.assertIn("pipeline_stalled", DRIFT_CLASS_BY_SOURCE)

    def test_a_stalled_pipeline_outranks_every_other_source(self) -> None:
        # Every other pressure describes work ARIA could do; this one says
        # the machinery that would do it is stuck.
        self.assertEqual(
            SOURCE_WEIGHTS["pipeline_stalled"], max(SOURCE_WEIGHTS.values())
        )


if __name__ == "__main__":
    unittest.main()
