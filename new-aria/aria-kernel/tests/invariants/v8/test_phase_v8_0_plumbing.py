"""Plan ORPHAN-HIGH-082 — CLI→orchestrator→drainer plumbing invariants.

Closes ORPHAN-HIGH-082. 4 invariants pin the wiring discovered to be
missing on 2026-05-18: the autonomy CLI parsed `--challenger-timeout-
seconds` and `--max-rounds` (and validated them in the cycle-deadline
fail-fast check) but never passed either argument to
`run_autonomy_orchestrator`, and the orchestrator's
`convergence_runner(...)` call passed `max_rounds=max_iterations_per_
phase` (semantically wrong — daemon iteration bound, not convergence
round bound). Result: drainer used its hardcoded 1800s + 4-rounds
defaults regardless of operator CLI input.

- I-V8.0-07 — `run_autonomy_orchestrator` signature exposes both
  `challenger_timeout_seconds` and `max_rounds` parameters.
- I-V8.0-08 — CLI dispatch site forwards `args.challenger_timeout_
  seconds` and `args.max_rounds` to `run_autonomy_orchestrator(...)`.
- I-V8.0-09 — orchestrator's `convergence_runner(...)` call passes
  `challenger_timeout_seconds=challenger_timeout_seconds` and
  `max_rounds=max_rounds` (NOT `max_iterations_per_phase`).
- I-V8.0-10 — defaults align: orchestrator default and drainer default
  for `challenger_timeout_seconds` match (no silent skew).
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import autonomy_orchestrator, cli, convergence_drainer


class TestCliOrchestratorDrainerPlumbing(unittest.TestCase):

    def test_i_v8_0_07_orchestrator_signature_exposes_both_kwargs(self):
        """run_autonomy_orchestrator MUST accept challenger_timeout_seconds
        + max_rounds as keyword arguments (ORPHAN-HIGH-082)."""
        sig = inspect.signature(autonomy_orchestrator.run_autonomy_orchestrator)
        params = sig.parameters
        self.assertIn(
            "challenger_timeout_seconds", params,
            "challenger_timeout_seconds MUST be a kwarg on run_autonomy_orchestrator",
        )
        self.assertIn(
            "max_rounds", params,
            "max_rounds MUST be a kwarg on run_autonomy_orchestrator",
        )

    def test_i_v8_0_08_cli_forwards_both_args(self):
        """cli._main MUST forward args.challenger_timeout_seconds and
        args.max_rounds to run_autonomy_orchestrator (source-substring
        pin on the call site)."""
        src = inspect.getsource(cli._main)
        self.assertIn(
            "challenger_timeout_seconds=args.challenger_timeout_seconds", src,
            "CLI MUST forward --challenger-timeout-seconds to orchestrator",
        )
        self.assertIn(
            "max_rounds=args.max_rounds", src,
            "CLI MUST forward --max-rounds to orchestrator",
        )

    def test_i_v8_0_09_orchestrator_passes_both_to_drainer(self):
        """orchestrator's convergence_runner(...) call MUST pass
        challenger_timeout_seconds + max_rounds — NOT max_iterations_
        per_phase (which is the daemon dispatch bound, semantically
        unrelated to convergence round count)."""
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        # The call must explicitly carry both kwargs
        self.assertIn(
            "challenger_timeout_seconds=challenger_timeout_seconds", src,
            "convergence_runner(...) MUST receive challenger_timeout_seconds",
        )
        self.assertIn(
            "max_rounds=max_rounds", src,
            "convergence_runner(...) MUST receive max_rounds (not max_iterations_per_phase)",
        )
        # The mis-wiring MUST NOT regress
        self.assertNotIn(
            "max_rounds=max_iterations_per_phase", src,
            "convergence_runner(...) MUST NOT use max_iterations_per_phase as max_rounds (semantic confusion)",
        )

    def test_i_v8_0_10_defaults_align_across_layers(self):
        """The default for challenger_timeout_seconds at the orchestrator
        boundary must match the drainer's own default (no silent skew
        from layer drift). Same for max_rounds where the drainer's
        Protocol declares default=4."""
        orch_sig = inspect.signature(autonomy_orchestrator.run_autonomy_orchestrator)
        drainer_sig = inspect.signature(convergence_drainer.run_convergence_drainer)

        orch_default = orch_sig.parameters["challenger_timeout_seconds"].default
        drainer_default = drainer_sig.parameters["challenger_timeout_seconds"].default
        self.assertEqual(
            orch_default, drainer_default,
            f"orchestrator default ({orch_default}) MUST match drainer default ({drainer_default})",
        )

        # max_rounds: orchestrator default vs ConvergenceRunner Protocol default
        orch_mr_default = orch_sig.parameters["max_rounds"].default
        proto_sig = inspect.signature(convergence_drainer.ConvergenceRunner.__call__)
        proto_mr_default = proto_sig.parameters["max_rounds"].default
        self.assertEqual(
            orch_mr_default, proto_mr_default,
            f"orchestrator max_rounds default ({orch_mr_default}) MUST match Protocol default ({proto_mr_default})",
        )


if __name__ == "__main__":
    unittest.main()
