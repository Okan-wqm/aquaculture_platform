"""Plan ORPHAN-HIGH-082 — CLI→orchestrator→drainer plumbing invariants.

Closes ORPHAN-HIGH-082: the autonomy CLI parsed `--max-rounds` (and
validated it in the cycle-deadline fail-fast check) but never passed it to
`run_autonomy_orchestrator`, and the orchestrator's `convergence_runner(...)`
call passed `max_rounds=max_iterations_per_phase` (the daemon iteration
bound, not the convergence round bound).

ARIA-HIGH-194 — `--challenger-timeout-seconds` was plumbed the same way
and then discarded by the resumable drainer (CL-1: it waits on nothing), so
an operator's value changed nothing. A knob that does nothing is removed,
not wired to a meaning it cannot have; these invariants pin its absence.

- I-V8.0-07 — `run_autonomy_orchestrator` exposes `max_rounds` and no
  challenger timeout.
- I-V8.0-08 — the CLI forwards `args.max_rounds` and defines no
  `--challenger-timeout-seconds` flag.
- I-V8.0-09 — `convergence_runner(...)` receives `max_rounds=max_rounds`
  (NOT `max_iterations_per_phase`) and no timeout.
- I-V8.0-10 — the orchestrator's `max_rounds` default matches the
  ConvergenceRunner Protocol's, and neither the Protocol nor the drainer
  accepts a timeout.
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import autonomy_orchestrator, cli, convergence_drainer

_RETIRED = ("challenger_timeout_seconds", "critic_timeout_seconds")


class TestCliOrchestratorDrainerPlumbing(unittest.TestCase):

    def test_i_v8_0_07_orchestrator_signature(self):
        params = inspect.signature(autonomy_orchestrator.run_autonomy_orchestrator).parameters
        self.assertIn("max_rounds", params)
        for name in _RETIRED:
            self.assertNotIn(name, params)

    def test_i_v8_0_08_cli_forwards_max_rounds_and_has_no_timeout_flag(self):
        self.assertIn("max_rounds=args.max_rounds", inspect.getsource(cli._main))
        self.assertNotIn("--challenger-timeout-seconds", inspect.getsource(cli))

    def test_i_v8_0_09_orchestrator_passes_max_rounds_to_drainer(self):
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        self.assertIn("max_rounds=max_rounds", src)
        self.assertNotIn("max_rounds=max_iterations_per_phase", src)
        for name in _RETIRED:
            self.assertNotIn(name, src)

    def test_i_v8_0_10_defaults_align_and_no_layer_takes_a_timeout(self):
        orch_sig = inspect.signature(autonomy_orchestrator.run_autonomy_orchestrator)
        proto_sig = inspect.signature(convergence_drainer.ConvergenceRunner.__call__)
        drainer_sig = inspect.signature(convergence_drainer.run_convergence_drainer)
        self.assertEqual(
            orch_sig.parameters["max_rounds"].default,
            proto_sig.parameters["max_rounds"].default,
        )
        for name in _RETIRED:
            self.assertNotIn(name, proto_sig.parameters)
            self.assertNotIn(name, drainer_sig.parameters)


if __name__ == "__main__":
    unittest.main()
