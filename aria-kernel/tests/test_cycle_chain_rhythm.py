"""SI-5 — the return edge terminates, and every refusal has a name.

Three nights of measurement: GitHub's scheduled trigger fires this repo
60-75 minutes late (02:13, 02:19, 03:21 against crons at 01:13/02:29)
and on 2026-08-19 the cron cycle was evicted outright by a running drain.
ORPHAN-724 built the forward edge; without a return edge the pace of the
whole loop belongs to that clock. The danger of a return edge is a
runaway chain, so termination is what these pins protect.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.cycle_rhythm import (
    MIN_CYCLE_INTERVAL_HOURS,
    ChainDecision,
    evaluate_cycle_chain,
)

_NOW = datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc)


def _decide(**overrides) -> ChainDecision:
    kwargs = dict(
        last_cycle_started_at="2026-08-19T02:00:00Z",
        now=_NOW,
        open_findings=5,
        backlog_cap=25,
        drained=3,
    )
    kwargs.update(overrides)
    return evaluate_cycle_chain(**kwargs)


class TheChainTerminates(unittest.TestCase):
    def test_a_ready_rhythm_chains(self) -> None:
        self.assertTrue(_decide().dispatch)

    def test_the_minimum_interval_bounds_the_loop(self) -> None:
        # The load-bearing brake: however fast the drain becomes, cycles
        # can never run closer together than this.
        recent = (_NOW - timedelta(hours=MIN_CYCLE_INTERVAL_HOURS / 2)).isoformat()
        decision = _decide(last_cycle_started_at=recent)
        self.assertFalse(decision.dispatch)
        self.assertTrue(decision.reason.startswith("min_interval_not_elapsed"))

    def test_a_full_backlog_stops_the_chain(self) -> None:
        decision = _decide(open_findings=25, backlog_cap=25)
        self.assertFalse(decision.dispatch)
        self.assertEqual(decision.reason, "backlog_at_cap")

    def test_an_empty_drain_has_nothing_to_feed(self) -> None:
        decision = _decide(drained=0)
        self.assertFalse(decision.dispatch)
        self.assertEqual(decision.reason, "drain_empty")

    def test_unknown_history_fails_closed(self) -> None:
        for value in (None, "", "not-a-timestamp"):
            decision = _decide(last_cycle_started_at=value)
            self.assertFalse(decision.dispatch, value)
            self.assertEqual(decision.reason, "last_cycle_time_unknown")

    def test_the_interval_is_at_least_four_hours(self) -> None:
        # A tuning that shrinks this toward zero would turn the edge into
        # a spin loop; the floor is pinned so that becomes a visible edit.
        self.assertGreaterEqual(MIN_CYCLE_INTERVAL_HOURS, 4.0)


class TheChainScriptNeverBreaksTheDrain(unittest.TestCase):
    def _run(self, env: dict[str, str]) -> str:
        script = Path(__file__).resolve().parents[2] / "tools" / "aria" / "chain_next_cycle.py"
        completed = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", **env},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout.strip()

    def test_it_prints_a_decision_and_exits_zero(self) -> None:
        out = self._run({"DRAINED": "0"})
        self.assertIn('"dispatch": false', out)
        self.assertIn("drain_empty", out)

    def test_a_broken_environment_declines_by_name(self) -> None:
        # Fail-closed with a NAMED reason: the cron still fires, so an
        # undecidable chain costs one late cycle, never a stacked one.
        out = self._run({"DRAINED": "not-a-number"})
        self.assertIn('"dispatch": false', out)
        self.assertIn("chain_undecidable", out)


if __name__ == "__main__":
    unittest.main()
