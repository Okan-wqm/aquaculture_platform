"""Smoke-run 31653106474 — the deadline must CLOSE the night, not just
refuse spawns.

The second live night proved the spawn clamp (ORPHAN-661) necessary but not
sufficient: adapters finished, the clamp held, and the night still died at
the job wall because nothing BETWEEN phases ever asked "is there time
left?" — the refused-spawn error was treated as a per-request failure, the
machinery ground on to the wall, and cycles.jsonl was left without a
terminal row (→ quarantine, → no night ever publishes). These pin the
cycle-level answer: past the deadline, remaining phases are skipped with a
recorded reason and the cycle SEALS.
"""
from __future__ import annotations

import os
import time
import unittest

from aria_kernel.cycle import _job_deadline_reached


class JobDeadlineHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prior = os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        if self._prior is None:
            os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        else:
            os.environ["ARIA_JOB_DEADLINE_EPOCH"] = self._prior

    def test_no_env_never_triggers(self) -> None:
        self.assertFalse(_job_deadline_reached())

    def test_far_deadline_does_not_trigger(self) -> None:
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(time.time() + 3600)
        self.assertFalse(_job_deadline_reached())

    def test_inside_margin_triggers(self) -> None:
        # 60s remain < 120s phase margin → the cycle must start closing.
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(time.time() + 60)
        self.assertTrue(_job_deadline_reached())

    def test_malformed_env_does_not_crash_the_cycle(self) -> None:
        # The spawn clamp already refuses garbage loudly at the spawn
        # boundary; the phase loop must not crash over the same garbage.
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = "garbage"
        self.assertFalse(_job_deadline_reached())

    def test_phase_loop_consults_the_deadline(self) -> None:
        """Source pin: a refactor that drops the check from the phase loop
        reopens the graveyard-shift class silently."""
        import inspect

        from aria_kernel import cycle as cycle_mod

        source = inspect.getsource(cycle_mod._run_phase_stage)
        self.assertIn("_job_deadline_reached()", source)
        self.assertIn("job_deadline_reached", source)


class DrainConsultsTheDeadlineTests(unittest.TestCase):
    def test_drain_loop_stops_at_the_job_deadline(self) -> None:
        import inspect
        import sys
        from pathlib import Path

        poc = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
        if str(poc) not in sys.path:
            sys.path.insert(0, str(poc))
        import ci_executor_drain

        source = inspect.getsource(ci_executor_drain)
        self.assertIn("job_deadline_reached", source)
        self.assertIn("ARIA_JOB_DEADLINE_EPOCH", source)


if __name__ == "__main__":
    unittest.main()
