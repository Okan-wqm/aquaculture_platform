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

ARIA-HIGH-140 (trial eleven, 2026-09-15) added the second half: the phases
that DO the sealing — artifact_integrity and metrics — are close-out phases,
run past the deadline and never under the alarm, and a cycle the alarm cut
reports the phase it cut rather than an untrustworthy store.
"""
from __future__ import annotations

import os
import time
import unittest

import tempfile
from pathlib import Path
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.cycle import CYCLE_PHASES, CyclePhase, _job_deadline_reached
from aria_kernel.cycle_runtime_status import RUNTIME_FAILED, RUNTIME_INTEGRITY_FAILED, RUNTIME_OK


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


def _context() -> cycle_mod.PhaseContext:
    tmp = Path(tempfile.mkdtemp(prefix="aria-closeout-"))
    return cycle_mod.build_phase_context(cycle_id="cyc-closeout", workspace_root=tmp, base_dir=tmp / "aria-tools")


class CloseOutPhasesTests(unittest.TestCase):
    """ARIA-HIGH-140 — past the deadline the cycle still seals its store."""

    def setUp(self) -> None:
        self._prior = os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        if self._prior is None:
            os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)
        else:
            os.environ["ARIA_JOB_DEADLINE_EPOCH"] = self._prior

    def test_the_close_out_set_is_exactly_the_sealing_phases(self) -> None:
        # Declared on the table, reviewed here: a phase joins the set only
        # by being what the deadline exists to protect time for. Anything
        # else added here would run unbounded past the wall.
        self.assertEqual({p.name for p in CYCLE_PHASES if p.closeout}, {"artifact_integrity", "metrics"})
        for phase in CYCLE_PHASES:
            if phase.closeout:
                self.assertEqual(phase.stage, "post_tool", phase.name)

    def test_past_the_deadline_work_is_skipped_and_the_close_out_runs_unarmed(self) -> None:
        ran: list[str] = []
        table = (
            CyclePhase("work", "post_tool", lambda ctx: ran.append("work") or {"did": "work"}),
            CyclePhase("seal", "post_tool", lambda ctx: ran.append("seal") or {"valid": True}, closeout=True),
        )
        context = _context()
        with patch.object(cycle_mod, "CYCLE_PHASES", table), \
             patch.object(cycle_mod, "_job_deadline_reached", return_value=True), \
             patch.object(cycle_mod, "_run_phase_with_deadline") as armed:
            cycle_mod._run_phase_stage("post_tool", context)

        self.assertEqual(ran, ["seal"])
        self.assertEqual(context.outcomes["work"], {"outcome": "skipped", "reason": "job_deadline_reached"})
        self.assertEqual(context.outcomes["seal"], {"outcome": "ran"})
        self.assertEqual(context.results["seal"], {"valid": True})
        # The close-out phase ran WITHOUT the alarm: the deadline helper
        # was never consulted for it, so a wall that has already passed
        # cannot interrupt the sealing itself.
        armed.assert_not_called()

    def test_with_time_to_spare_a_close_out_phase_still_runs_unarmed(self) -> None:
        # The alarm is for work phases only, deadline or not: the sealing
        # is cheap by contract and must never be the phase that is cut.
        table = (
            CyclePhase("work", "post_tool", lambda ctx: {"did": "work"}),
            CyclePhase("seal", "post_tool", lambda ctx: {"valid": True}, closeout=True),
        )
        context = _context()
        with patch.object(cycle_mod, "CYCLE_PHASES", table), \
             patch.object(cycle_mod, "_job_deadline_reached", return_value=False), \
             patch.object(cycle_mod, "_run_phase_with_deadline", wraps=cycle_mod._run_phase_with_deadline) as armed:
            cycle_mod._run_phase_stage("post_tool", context)

        self.assertEqual(context.outcomes["work"], {"outcome": "ran"})
        self.assertEqual(context.outcomes["seal"], {"outcome": "ran"})
        self.assertEqual(armed.call_count, 1)
        self.assertIs(armed.call_args.args[0], table[0].runner)

    def test_the_first_interrupted_phase_is_named(self) -> None:
        context = _context()
        self.assertIsNone(cycle_mod._first_interrupted_phase(context))
        context.outcomes["discovery"] = {"outcome": "ran"}
        context.outcomes["fixture_refresh"] = {"outcome": "interrupted", "reason": "phase_deadline_exceeded"}
        context.outcomes["judgment_pipeline"] = {"outcome": "interrupted", "reason": "phase_deadline_exceeded"}
        self.assertEqual(cycle_mod._first_interrupted_phase(context), "fixture_refresh")

    def test_a_store_nobody_verified_is_not_an_untrustworthy_store(self) -> None:
        # The 2026-09-15 shape: artifact_integrity never ran, its result is
        # the absent payload, and the old reading of an empty dict was
        # ``integrity_failed`` — the one verdict the orchestrator fails
        # closed on — over a store whose index verified 9/9.
        context = _context()
        context.results["artifact_integrity"] = {}
        context.outcomes["artifact_integrity"] = {"outcome": "skipped", "reason": "mode_not_included:burn_in"}
        self.assertEqual(cycle_mod._runtime_status(context), RUNTIME_OK)

        # The alarm cut a work phase: the cycle failed and says so — never
        # integrity_failed — whatever the sealing phases then found.
        context.outcomes["fixture_refresh"] = {"outcome": "interrupted", "reason": "phase_deadline_exceeded"}
        context.results["artifact_integrity"] = {"valid": True}
        context.outcomes["artifact_integrity"] = {"outcome": "ran"}
        self.assertEqual(cycle_mod._runtime_status(context), RUNTIME_FAILED)

        # A verdict the phase actually reached still fails closed.
        del context.outcomes["fixture_refresh"]
        context.results["artifact_integrity"] = {"valid": False}
        self.assertEqual(cycle_mod._runtime_status(context), RUNTIME_INTEGRITY_FAILED)


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
