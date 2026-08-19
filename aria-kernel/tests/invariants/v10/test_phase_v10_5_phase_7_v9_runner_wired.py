"""Plan ARIA-V10.5 Phase 7 — V9 ImplementationRunner CLI factory wire +
orchestrator post-CONVERGED invocation.

Closes F-027 (V10.5 F-026 validation endurance cycle 3 reached the
first CONVERGED outcome in production but emitted 0 implementation_
requested events because the orchestrator never invoked
v9_implementation_runner.run(...) and the CLI never installed the
factory's return value).

Root cause:

The V3.1-B implementation phase plan landed the runner Protocol
(V9ImplementationRunner), three concrete variants
(NoOpV9ImplementationRunner, StrictV9ImplementationRunner,
AutonomousV9ImplementationRunner), a factory
(select_v9_implementation_runner), the orchestrator parameter
declaration (v9_implementation_runner kwarg), and the orchestrator
default fallback to NoOp. The two final wiring statements — the CLI
installing the factory's return value and the orchestrator invoking
.run() between MemoryHook and specialist_review — were left
incomplete. CONVERGED cycles never produced implementation_requested
events; aria-implementer subprocess never spawned; no real PRs were
created.

Tier-1 architectural fix (Phase 7):

  1. CLI installs the factory's return value:
     run_autonomy_orchestrator(
       ...
       v9_implementation_runner=select_v9_implementation_runner(profile=profile),
     )

  2. Orchestrator invokes the runner between memory_hook_recorded and
     specialist_review_started phases:
     AutonomyStateReducer.transition(... phase="v9_implementation_phase_started")
     v9_result = v9_implementation_runner.run(cycle_id, plan_id, ...)
     AutonomyStateReducer.transition(... phase="v9_implementation_phase_resolved")

  NoOp/Strict variants return IMPLEMENTATION_REQUEST_REFUSED with
  specialist_review_signal=review_converged_plan, preserving V8
  behavior. Autonomous variant mints the aria-implementer subprocess.

Tier-3 layer (this file): pin both wiring sites so a future refactor
that drops either fails CI before reaching production.

Invariants:

- I-V10.5-7-01 — CLI imports select_v9_implementation_runner from
  cycle_phases and passes its return value as v9_implementation_runner
  kwarg to run_autonomy_orchestrator.
- I-V10.5-7-02 — orchestrator source contains
  v9_implementation_runner.run( call site.
- I-V10.5-7-03 — orchestrator source has the .run() call site
  positioned AFTER memory_hook_recorded transition and BEFORE
  specialist_review_started transition (per the docstring contract
  in cycle_phases/implementer.py:7-8).
- I-V10.5-7-04 — select_v9_implementation_runner factory correctly
  maps profile → runner variant (autonomous → Autonomous, strict →
  Strict, observe/standard/frozen → NoOp).
- I-V10.5-7-05 — runtime: NoOp variant returns
  IMPLEMENTATION_REQUEST_REFUSED with specialist_review_signal=
  review_converged_plan; this is the V8-preserving default that
  fires when injection is absent.
"""
from __future__ import annotations

import inspect
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401


class V9RunnerWiredInvariants(unittest.TestCase):
    """Plan ARIA-V10.5 Phase 7 — F-027 closure invariants."""

    def test_i_v10_5_7_01_cli_installs_factory(self):
        """CLI must import select_v9_implementation_runner and pass
        its return value as v9_implementation_runner kwarg to
        run_autonomy_orchestrator.

        F-027 root cause part 1 was the CLI never installing the
        factory's return value, so the orchestrator always fell back
        to NoOp regardless of profile. The fix is two source-level
        statements: the import and the kwarg.
        """
        from aria_kernel import cli
        src = inspect.getsource(cli)
        self.assertIn(
            "select_v9_implementation_runner",
            src,
            (
                "I-V10.5-7-01: cli.py must import "
                "select_v9_implementation_runner from cycle_phases. "
                "Pre-F-027 the symbol was absent so the factory's "
                "profile-derived variant was never installed."
            ),
        )
        self.assertIn(
            "v9_implementation_runner=select_v9_implementation_runner(profile=profile)",
            src,
            (
                "I-V10.5-7-01: cli.py must pass "
                "v9_implementation_runner=select_v9_implementation_runner(profile=profile) "
                "to run_autonomy_orchestrator. Without this kwarg the "
                "orchestrator falls back to NoOpV9ImplementationRunner "
                "regardless of operator profile, recreating F-027."
            ),
        )

    def test_i_v10_5_7_02_orchestrator_invokes_run(self):
        """The orchestrator source must contain
        v9_implementation_runner.run( call site.

        F-027 root cause part 2 was the orchestrator declaring the
        parameter but never invoking .run(). The fix adds the explicit
        invocation between memory_hook_recorded and
        specialist_review_started transitions.
        """
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator)
        self.assertIn(
            "v9_implementation_runner.run(",
            src,
            (
                "I-V10.5-7-02: autonomy_orchestrator.py must invoke "
                "v9_implementation_runner.run(...). Dropping this call "
                "recreates F-027 — CONVERGED plans never produce "
                "implementation_requested events; aria-implementer "
                "subprocess never spawns."
            ),
        )

    def test_i_v10_5_7_03_run_site_positioned_between_memory_hook_and_specialist_review(self):
        """The .run() call site must appear AFTER the
        memory_hook_recorded transition emit AND BEFORE the
        specialist_review_started transition emit.

        Per cycle_phases/implementer.py:7-8 docstring contract:
          "CONVERGED → V9 implementation phase → specialist_review"
        Placing the V9 phase outside this window (e.g. before
        memory_hook or after specialist_review) breaks the documented
        cycle ordering.
        """
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator)
        memory_idx = src.find('phase="memory_hook_recorded"')
        run_idx = src.find("v9_implementation_runner.run(")
        specialist_idx = src.find('phase="specialist_review_started"')
        self.assertGreater(memory_idx, 0)
        self.assertGreater(run_idx, 0)
        self.assertGreater(specialist_idx, 0)
        self.assertLess(
            memory_idx, run_idx,
            (
                "I-V10.5-7-03: v9_implementation_runner.run() must "
                "appear AFTER the memory_hook_recorded phase transition. "
                "Per the V10 memory pillar ordering (autonomy_orchestrator "
                "comment line ~1182), MemoryHook fires per CONVERGED "
                "cycle BEFORE specialist_review; V9 belongs in the "
                "same window, after memory."
            ),
        )
        self.assertLess(
            run_idx, specialist_idx,
            (
                "I-V10.5-7-03: v9_implementation_runner.run() must "
                "appear BEFORE the specialist_review_started phase "
                "transition. Per cycle_phases/implementer.py docstring: "
                "'CONVERGED → V9 implementation phase → specialist_review'. "
                "Inverting the order would let specialist_review run on "
                "the converged plan without seeing the V9 result's "
                "specialist_review_signal."
            ),
        )

    def test_i_v10_5_7_04_factory_maps_profile_to_variant(self):
        """select_v9_implementation_runner must map profile to variant
        per the contract:

          autonomous → AutonomousV9ImplementationRunner
          strict     → StrictV9ImplementationRunner
          observe / standard / frozen → NoOpV9ImplementationRunner

        Anything else (typo, new profile) must default to NoOp to
        preserve V8 backward-compat.
        """
        from aria_kernel.cycle_phases.implementer import (
            AutonomousV9ImplementationRunner,
            NoOpV9ImplementationRunner,
            StrictV9ImplementationRunner,
            select_v9_implementation_runner,
        )
        self.assertIsInstance(
            select_v9_implementation_runner(profile="autonomous"),
            AutonomousV9ImplementationRunner,
            "I-V10.5-7-04: autonomous profile must yield AutonomousV9ImplementationRunner",
        )
        self.assertIsInstance(
            select_v9_implementation_runner(profile="strict"),
            StrictV9ImplementationRunner,
            "I-V10.5-7-04: strict profile must yield StrictV9ImplementationRunner",
        )
        for safe_profile in ("observe", "standard", "frozen"):
            self.assertIsInstance(
                select_v9_implementation_runner(profile=safe_profile),
                NoOpV9ImplementationRunner,
                (
                    f"I-V10.5-7-04: {safe_profile!r} profile must yield "
                    "NoOpV9ImplementationRunner to preserve V8 backward-"
                    "compat behavior (refuses cleanly + specialist_review "
                    "still runs on the CONVERGED plan)."
                ),
            )

    def test_i_v10_5_7_05_noop_returns_review_converged_plan_signal(self):
        """Runtime: NoOpV9ImplementationRunner.run(...) returns
        terminal_state=IMPLEMENTATION_REQUEST_REFUSED and
        specialist_review_signal=review_converged_plan.

        This is the V8-preserving default. Even with the orchestrator
        wiring in place, NoOp variant ensures observe/standard/frozen
        profiles never accidentally trigger the autonomous PR-creation
        pipeline.
        """
        from aria_kernel.cycle_phases.implementer import (
            NoOpV9ImplementationRunner,
        )
        runner = NoOpV9ImplementationRunner()
        with __import__("tempfile").TemporaryDirectory() as tmpdir:
            result = runner.run(
                cycle_id="cyc-test-f027",
                plan_id="plan-test-f027",
                workspace_root=Path(tmpdir),
                base_dir=Path(tmpdir),
                cross_review_summary={},
                profile="standard",
            )
        self.assertEqual(
            result.terminal_state, "IMPLEMENTATION_REQUEST_REFUSED",
            (
                "I-V10.5-7-05: NoOp variant must refuse cleanly with "
                "IMPLEMENTATION_REQUEST_REFUSED terminal_state — the "
                "V8 backward-compat path."
            ),
        )
        self.assertEqual(
            result.specialist_review_signal, "review_converged_plan",
            (
                "I-V10.5-7-05: NoOp variant must signal "
                "review_converged_plan so the orchestrator's "
                "downstream specialist_review still runs on the "
                "CONVERGED plan as in pre-V9 behavior."
            ),
        )
        self.assertEqual(
            result.pr_url, None,
            "I-V10.5-7-05: NoOp variant produces no PR.",
        )


if __name__ == "__main__":
    unittest.main()
