"""ORPHAN-HIGH-472 — the cycle ceiling is wall clock, and it binds before the run.

ARIA runs its agents through the Claude Code CLI on a logged-in subscription
session (``claude_runtime`` is explicit that raw ANTHROPIC_API_KEY billing is
disallowed, and both workflows reject those env vars), so there is no marginal
per-run charge for a dollar cap to bound. What is scarce is time: the shared
subscription quota and CI minutes.

The gate that matters is ``remaining < per_run_timeout``, not
``remaining <= 0``. A run started with less time left than its own timeout is
one the runner kills mid-flight, and that is the state that strands a claimed
request — lease held, no result, no governance row, breaker none the wiser.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.budget import (
    USD_BASIS_NOTIONAL_API_EQUIVALENT,
    WallClockExhausted,
    assert_dispatch_fits_wall_clock,
    cycle_wall_clock_spent,
    record_run_wall_clock,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class WallClockAccountingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_spend_accumulates_per_cycle(self) -> None:
        record_run_wall_clock(cycle_id="c1", seconds=120, base_dir=self.tools)
        record_run_wall_clock(cycle_id="c1", seconds=90, base_dir=self.tools)
        record_run_wall_clock(cycle_id="c2", seconds=500, base_dir=self.tools)
        self.assertAlmostEqual(
            cycle_wall_clock_spent(cycle_id="c1", base_dir=self.tools), 210.0
        )
        # Cycles do not bleed into each other: the ceiling is per cycle, and
        # a shared counter would refuse the second cycle for the first's use.
        self.assertAlmostEqual(
            cycle_wall_clock_spent(cycle_id="c2", base_dir=self.tools), 500.0
        )

    def test_unknown_cycle_has_spent_nothing(self) -> None:
        self.assertEqual(
            cycle_wall_clock_spent(cycle_id="never-ran", base_dir=self.tools), 0.0
        )

    def test_negative_duration_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            record_run_wall_clock(cycle_id="c1", seconds=-1, base_dir=self.tools)

    def test_dispatch_with_room_is_allowed(self) -> None:
        record_run_wall_clock(cycle_id="c1", seconds=300, base_dir=self.tools)
        verdict = assert_dispatch_fits_wall_clock(
            cycle_id="c1",
            per_run_timeout_seconds=600,
            cap_seconds=1800,
            base_dir=self.tools,
        )
        self.assertEqual(verdict["status"], "ok")
        self.assertEqual(verdict["remaining_seconds"], 1500)

    def test_dispatch_that_cannot_finish_is_refused_before_it_starts(self) -> None:
        """The load-bearing case.

        1500s spent of a 1800s cap leaves 300s. A run whose own timeout is
        600s cannot complete in that. Starting it anyway is how the runner
        ends up killing the job with the claim still held.
        """
        record_run_wall_clock(cycle_id="c1", seconds=1500, base_dir=self.tools)
        with self.assertRaises(WallClockExhausted) as caught:
            assert_dispatch_fits_wall_clock(
                cycle_id="c1",
                per_run_timeout_seconds=600,
                cap_seconds=1800,
                base_dir=self.tools,
            )
        self.assertIn("cycle_wall_clock_exhausted", str(caught.exception))

    def test_refusal_happens_while_budget_remains(self) -> None:
        # Explicitly NOT "remaining <= 0": there are still 300 seconds left
        # here and the dispatch is still refused, because 300 < 600. A gate
        # that waited for exhaustion would permit exactly the run that gets
        # guillotined.
        record_run_wall_clock(cycle_id="c1", seconds=1500, base_dir=self.tools)
        remaining = 1800 - cycle_wall_clock_spent(cycle_id="c1", base_dir=self.tools)
        self.assertGreater(remaining, 0)
        with self.assertRaises(WallClockExhausted):
            assert_dispatch_fits_wall_clock(
                cycle_id="c1",
                per_run_timeout_seconds=600,
                cap_seconds=1800,
                base_dir=self.tools,
            )

    def test_exactly_fitting_dispatch_is_allowed(self) -> None:
        # remaining == per_run_timeout is a fit, not a refusal. On the
        # executor lane the derived cap (1800s) equals DEFAULT_TIMEOUT_SECONDS
        # exactly, so an off-by-one here would refuse every first dispatch.
        record_run_wall_clock(cycle_id="c1", seconds=1200, base_dir=self.tools)
        verdict = assert_dispatch_fits_wall_clock(
            cycle_id="c1",
            per_run_timeout_seconds=600,
            cap_seconds=1800,
            base_dir=self.tools,
        )
        self.assertEqual(verdict["status"], "ok")

    def test_no_declared_cap_means_unbounded_not_zero(self) -> None:
        # A lane with no pinned timeout must not be treated as a zero budget,
        # which would refuse everything. The runner's own timeout still
        # applies — it just kills rather than halting.
        verdict = assert_dispatch_fits_wall_clock(
            cycle_id="c1",
            per_run_timeout_seconds=600,
            cap_seconds=None,
            base_dir=self.tools,
        )
        self.assertEqual(verdict["status"], "unbounded")


class UsdBasisLabelTests(unittest.TestCase):
    def test_cost_rows_declare_what_the_dollar_figure_is(self) -> None:
        """An unlabelled dollar figure in a ledger gets read as money spent.

        Under a subscription session it is an API-list-price comparable, and
        the row says so — because the row is what a dashboard, an audit, or a
        future reader actually sees.
        """
        from aria_kernel.budget import record_cost_attribution

        with tempfile.TemporaryDirectory() as tmp:
            tools = ensure_tools_dir(Path(tmp) / "aria-tools")
            row = record_cost_attribution(
                cycle_id="c1",
                plan_id="p1",
                agent_role="primary_plan",
                model="claude-opus-5",
                input_tokens=1000,
                output_tokens=200,
                estimated_usd=1.15,
                base_dir=tools,
            )
        self.assertEqual(row["usd_basis"], USD_BASIS_NOTIONAL_API_EQUIVALENT)


if __name__ == "__main__":
    unittest.main()
