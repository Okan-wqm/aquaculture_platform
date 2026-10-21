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


class TheDrainRechainIsBounded(unittest.TestCase):
    """ARIA-MEDIUM-398 — a self-minted, window-skipped implementation request
    is taken by ONE direct executor re-chain, not by the run after the next
    cycle.

    The drain that mints an implementation request mid-run and then cannot
    fit its worst case in the remaining window leaves it PENDING; the only
    chain out of a drain was `chain-next-cycle`, so the request waited a
    full cycle (AIR-aria-implementer-9f5893f12678: minted 07:41Z, skipped
    with 16659 s left, still waiting while the chained cycle ran at 09:07Z)
    for work the drain itself had just produced. The return edge for that
    case is ONE drain hop: one re-chain per minted request, and a re-chain
    run never re-chains again — it takes the normal cycle edge.
    """

    def _rechain(self, **overrides) -> ChainDecision:
        # Imported per call so the missing-capability red is this class's
        # alone; the module's existing pins keep running.
        from aria_kernel.cycle_rhythm import evaluate_drain_rechain

        kwargs = dict(
            window_skipped_self_minted=frozenset({"AIR-IMPL-1"}),
            already_rechained_request_ids=frozenset(),
            dispatched_as_rechain=False,
        )
        kwargs.update(overrides)
        return evaluate_drain_rechain(**kwargs)

    def test_a_self_minted_window_skip_earns_one_direct_rechain(self) -> None:
        decision = self._rechain()
        self.assertTrue(decision.dispatch)
        self.assertEqual(decision.reason, "rechain_ready")

    def test_no_self_minted_window_skip_refuses_by_name(self) -> None:
        decision = self._rechain(window_skipped_self_minted=frozenset())
        self.assertFalse(decision.dispatch)
        self.assertEqual(decision.reason, "no_self_minted_window_skip")

    def test_an_already_rechained_request_is_not_rechained_again(self) -> None:
        # The one-per-request ledger is the bound: a request the re-chain
        # ledger already names waits for the cycle like everything else.
        decision = self._rechain(already_rechained_request_ids=frozenset({"AIR-IMPL-1"}))
        self.assertFalse(decision.dispatch)
        self.assertEqual(decision.reason, "already_rechained")

    def test_a_rechain_run_never_rechains_again(self) -> None:
        # The depth brake: one drain hop before the cycle edge. A re-chain
        # that could re-chain would be a drain→drain loop with a minting
        # implementation inside it.
        decision = self._rechain(dispatched_as_rechain=True)
        self.assertFalse(decision.dispatch)
        self.assertEqual(decision.reason, "rechain_depth_exhausted")

    def test_one_rechain_run_serves_every_waiting_candidate(self) -> None:
        # The bound is per REQUEST (the ledger row), not per run: one
        # dispatch is handed the whole waiting set, so a drain that minted
        # and skipped three implementations queues exactly one re-chain.
        decision = self._rechain(
            window_skipped_self_minted=frozenset({"AIR-IMPL-1", "AIR-IMPL-2"}),
            already_rechained_request_ids=frozenset({"AIR-IMPL-1"}),
        )
        self.assertTrue(decision.dispatch)
        self.assertEqual(decision.reason, "rechain_ready")


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
