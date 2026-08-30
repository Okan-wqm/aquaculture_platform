"""Phase-interruptible deadline + phase-filter split.

Operator requirements 2026-08-30: both the mid-phase interrupt (a 30-minute
judge fan-out cannot consume the close-out margin) and the phase-split (a
cycle can run as observe-only, judge-only, implement-only across shorter
workflow runs).
"""

from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

_PARENT = Path(__file__).resolve().parents[1]
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

from aria_kernel.cycle import (  # noqa: E402
    PhaseDeadlineExceeded,
    _remaining_wallclock_seconds,
    _run_phase_with_deadline,
)


class PhaseInterruptible(unittest.TestCase):
    def test_no_deadline_runs_normally(self) -> None:
        env = dict(os.environ)
        env.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
            result = _run_phase_with_deadline(lambda ctx: "done", None)
        self.assertEqual(result, "done")

    def test_deadline_in_future_completes(self) -> None:
        with mock.patch.dict(os.environ, {"ARIA_JOB_DEADLINE_EPOCH": str(time.time() + 100)}):
            result = _run_phase_with_deadline(lambda ctx: "ok", None)
        self.assertEqual(result, "ok")

    def test_zero_remaining_raises_immediately(self) -> None:
        with mock.patch.dict(os.environ, {"ARIA_JOB_DEADLINE_EPOCH": str(time.time() - 100)}):
            with self.assertRaises(PhaseDeadlineExceeded):
                _run_phase_with_deadline(lambda ctx: "should not run", None)

    def test_long_running_phase_interrupted(self) -> None:
        """The core fix: a phase that sleeps past the deadline gets SIGALRM'd."""
        with mock.patch.dict(os.environ, {"ARIA_JOB_DEADLINE_EPOCH": str(time.time() + 0.5)}):
            with self.assertRaises(PhaseDeadlineExceeded):
                _run_phase_with_deadline(lambda ctx: time.sleep(10), None)

    def test_remaining_wallclock_inf_without_env(self) -> None:
        env = dict(os.environ)
        env.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
            self.assertEqual(_remaining_wallclock_seconds(), float("inf"))


class PhaseFilterSplit(unittest.TestCase):
    def test_filter_parameter_exists_on_stage_runner(self) -> None:
        from aria_kernel.cycle import _run_phase_stage
        import inspect
        sig = inspect.signature(_run_phase_stage)
        self.assertIn("phase_filter", sig.parameters)


if __name__ == "__main__":
    unittest.main()
