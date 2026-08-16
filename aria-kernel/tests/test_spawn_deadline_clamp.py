"""Smoke-run 31645296013 — a spawn that cannot finish before the job dies
must not start.

The first live night died mid-spawn: adapters finished at 22:29, one claude
spawn started with its full 1800s budget, and the job's 50-minute wall
killed everything at 22:53. The half-night failed state verification and
was quarantined (correctly) — which makes the failure mode a PERMANENT
loop: every night's last spawn is cut, every night quarantines, no night
ever publishes. These pin the clamp: spawn timeouts respect the job's
remaining wall-clock, and a too-late spawn is refused loudly so the night
closes cleanly instead.
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from claude_runtime import (  # noqa: E402
    ClaudePolicyViolation,
    _clamp_timeout_to_job_deadline,
)


class SpawnDeadlineClampTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prior = os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        if self._prior is None:
            os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        else:
            os.environ["ARIA_JOB_DEADLINE_EPOCH"] = self._prior

    def test_no_deadline_is_unclamped(self) -> None:
        self.assertEqual(_clamp_timeout_to_job_deadline(1800), 1800)

    def test_far_deadline_leaves_timeout_alone(self) -> None:
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(time.time() + 7200)
        self.assertEqual(_clamp_timeout_to_job_deadline(1800), 1800)

    def test_near_deadline_clamps_the_timeout(self) -> None:
        # 600s remain → the spawn gets 600 - 60 (close margin), not 1800.
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(time.time() + 600)
        clamped = _clamp_timeout_to_job_deadline(1800)
        self.assertLessEqual(clamped, 540)
        self.assertGreater(clamped, 500)

    def test_too_late_refuses_the_spawn(self) -> None:
        # Pre-fix this spawn started with 1800s and was cut by the job wall;
        # now it is refused up front so the night can close and publish.
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(time.time() + 90)
        with self.assertRaisesRegex(
            ClaudePolicyViolation, "insufficient_wallclock"
        ):
            _clamp_timeout_to_job_deadline(1800)

    def test_malformed_deadline_is_refused_not_ignored(self) -> None:
        # A deadline that silently stopped binding is the class this fix
        # kills; garbage must fail loudly, not run unbounded.
        os.environ["ARIA_JOB_DEADLINE_EPOCH"] = "not-an-epoch"
        with self.assertRaisesRegex(
            ClaudePolicyViolation, "invalid_job_deadline"
        ):
            _clamp_timeout_to_job_deadline(1800)

    def test_clamp_sits_on_the_spawn_path(self) -> None:
        import inspect

        import claude_runtime

        source = inspect.getsource(claude_runtime.run_claude_exec)
        self.assertIn("_clamp_timeout_to_job_deadline", source)


if __name__ == "__main__":
    unittest.main()
