"""The exit streak covers exactly the cycles its exits bracket.

`read_orchestrator_exit_streak` joins two append-only ledgers that share one
clock: `governance.jsonl` (``autonomy_orchestrator_exit``, stamped ``ts``)
and `autonomy_state.jsonl` (``cycle_completed``, stamped ``recorded_at``).
The first revision took "the last ``window`` cycle rows" as the streak's
cycles, which is only right when every run completes exactly one cycle. The
fixture below drives both ledgers with a controlled clock (an explicit
``ts`` through `append_tools_governance`'s ``prepared_event``, and
`autonomy_state.utc_now` patched) so runs of different lengths can
interleave a second apart, and pins:

  * a run of three ok cycles inside the window does not push an older
    run's failed cycle out of the streak (the first revision missed it);
  * a failed cycle from BEFORE the window is not reported (the first
    revision reported it when the window's runs were short);
  * a cycle recorded after the newest exit (a run still in flight) is not
    part of the streak;
  * without an older exit to bound the bracket, every cycle up to the
    newest exit counts; without any exit, none does.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.autonomy_state import AutonomyStateReducer
from aria_kernel.orchestrator_exit_history import read_orchestrator_exit_streak
from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir
from aria_kernel.workspace import governance_event


class _TwoLedgerClock(unittest.TestCase):
    """Writes exits and cycles in the shapes the orchestrator writes them,
    one controlled second apart, in the order the test names."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        self._now = datetime(2026, 9, 4, 9, 0, 0, tzinfo=timezone.utc)

    def _tick(self) -> str:
        self._now += timedelta(seconds=1)
        return self._now.isoformat()

    def _exit(self, reason: str, cycles_completed: int) -> str:
        stamp = self._tick()
        event = governance_event("autonomy_orchestrator_exit", {
            "auto_merges_completed": 0, "cycles_completed": cycles_completed,
            "daemon_id": "autonomy", "exit_reason": reason,
            "planner_claims_dispatched": 0, "worker_assignments_dispatched": 0,
        })
        append_tools_governance(
            self.tools, "autonomy_orchestrator_exit", {}, prepared_event={**event, "ts": stamp},
        )
        return stamp

    def _cycle(self, cycle_id: str, status: str) -> str:
        stamp = self._tick()
        with patch("aria_kernel.autonomy_state.utc_now", return_value=stamp):
            AutonomyStateReducer.transition(
                self.tools, cycle_id=cycle_id, phase="cycle_started", status="ok", profile="standard",
            )
            AutonomyStateReducer.transition(
                self.tools, cycle_id=cycle_id, phase="cycle_completed", status=status,
                profile="standard",
                details={"summary": {"schema_version": 2, "cycle_id": cycle_id, "status": status,
                                     "runtime_status": status, "failed_phases": [], "non_ok_tools": []}},
            )
        return stamp

    def _failed_ids(self, window: int = 3) -> list[str]:
        streak = read_orchestrator_exit_streak(self.tools, window=window)
        return [cycle["cycle_id"] for cycle in streak.failed_cycles]


class TheStreakCoversWhatItsExitsBracket(_TwoLedgerClock):
    def test_a_long_run_inside_the_window_does_not_hide_an_older_runs_failure(self) -> None:
        """Run A fails; run B completes three ok cycles; run C completes one.
        Window 3 = exits C, B, A — A's failed cycle is in the streak even
        though four ok cycles were recorded after it."""
        self._cycle("cyc-a1", "failed")
        self._exit("cycle_failed", 0)
        for n in (1, 2, 3):
            self._cycle(f"cyc-b{n}", "ok")
        self._exit("max_cycles", 3)
        self._cycle("cyc-c1", "ok")
        self._exit("max_cycles", 1)

        self.assertEqual(self._failed_ids(), ["cyc-a1"])

    def test_a_failure_older_than_the_window_is_not_reported(self) -> None:
        """Run Z fails, then runs A, B, C each complete one ok cycle. Window
        3 = exits C, B, A — Z's failure is outside the bracket."""
        self._cycle("cyc-z1", "failed")
        self._exit("cycle_failed", 0)
        for run in ("a", "b", "c"):
            self._cycle(f"cyc-{run}1", "ok")
            self._exit("max_cycles", 1)

        self.assertEqual(self._failed_ids(), [])
        # Widen the window by one and Z is back: the bracket moved, not the data.
        self.assertEqual(self._failed_ids(window=4), ["cyc-z1"])

    def test_every_failed_cycle_of_every_windowed_run_is_reported_newest_first(self) -> None:
        """Runs A and C fail after an ok cycle each; run B fails at once."""
        self._cycle("cyc-a1", "ok")
        self._cycle("cyc-a2", "failed")
        self._exit("cycle_failed", 1)
        self._cycle("cyc-b1", "failed")
        self._exit("cycle_failed", 0)
        self._cycle("cyc-c1", "ok")
        self._cycle("cyc-c2", "failed")
        self._exit("cycle_failed", 1)

        self.assertEqual(self._failed_ids(), ["cyc-c2", "cyc-b1", "cyc-a2"])
        streak = read_orchestrator_exit_streak(self.tools)
        self.assertTrue(streak.all_failed)

    def test_a_cycle_recorded_after_the_newest_exit_is_in_flight_not_in_the_streak(self) -> None:
        self._cycle("cyc-a1", "failed")
        self._exit("cycle_failed", 0)
        self._cycle("cyc-inflight", "failed")

        self.assertEqual(self._failed_ids(), ["cyc-a1"])

    def test_without_an_older_exit_every_cycle_up_to_the_newest_counts(self) -> None:
        """A store whose first run announced no exit: its failed cycle folds
        into the first announced one rather than vanishing."""
        self._cycle("cyc-unannounced", "failed")
        self._cycle("cyc-a1", "failed")
        self._exit("cycle_failed", 0)

        self.assertEqual(self._failed_ids(), ["cyc-a1", "cyc-unannounced"])

    def test_without_any_exit_no_cycle_is_covered(self) -> None:
        self._cycle("cyc-orphan", "failed")

        streak = read_orchestrator_exit_streak(self.tools)

        self.assertEqual((streak.exits, streak.failed_cycles), ((), ()))

    def test_the_bracket_is_closed_on_the_newest_exit_and_open_on_the_previous(self) -> None:
        """The live shape: a failed cycle and its exit share one second."""
        self._cycle("cyc-old", "failed")
        old_exit = self._exit("cycle_failed", 0)
        # Run A's failed cycle lands in the SAME second as its own exit.
        stamp = self._tick()
        with patch("aria_kernel.autonomy_state.utc_now", return_value=stamp):
            AutonomyStateReducer.transition(
                self.tools, cycle_id="cyc-a1", phase="cycle_completed", status="failed",
                profile="standard", details={"summary": {"schema_version": 2, "cycle_id": "cyc-a1"}},
            )
        event = governance_event("autonomy_orchestrator_exit", {"exit_reason": "cycle_failed", "cycles_completed": 0})
        append_tools_governance(
            self.tools, "autonomy_orchestrator_exit", {}, prepared_event={**event, "ts": stamp},
        )

        self.assertEqual(self._failed_ids(window=1), ["cyc-a1"])
        self.assertLess(old_exit, stamp)


if __name__ == "__main__":
    unittest.main()
