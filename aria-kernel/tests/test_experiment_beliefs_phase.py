"""ARIA-MEDIUM-421 — the `experiment_beliefs` phase remembers the bench's reproductions.

The writer used to run inside `update_memory`. Its phase (`memory`) runs
before `experiment_night`, and it read only its own cycle's observations. So
every reproduction was recorded after the only reader that would ever look
at it. On aria/state f5c5c86a1 the single matched red (F-020,
cyc-20261008T151306Z, recorded 15:56:12Z) came 27 minutes after that cycle's
memory phase wrote, and memory holds no `finding-reproduced-*` belief.

These tests pin the table position, the same-night path through the real
phase runner, and the frozen-profile gate that moved with the writer.
"""
from __future__ import annotations

import unittest

from aria_kernel.cycle import (
    CYCLE_PHASES,
    WRITES_PERMITTED,
    _phase_experiment_beliefs,
    build_phase_context,
)
from aria_kernel.memory import record_experiment_reproduction_beliefs
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests import test_experiment_finding_bridge as bridge


class ExperimentBeliefsPhaseTableTests(unittest.TestCase):
    def test_phase_runs_directly_after_the_bench_that_writes_its_input(self) -> None:
        names = [phase.name for phase in CYCLE_PHASES]
        self.assertEqual(names.index("experiment_beliefs"), names.index("experiment_night") + 1)
        # The defect's precondition, kept visible: `memory` runs before the
        # bench, so it can never read a night's own reproductions.
        self.assertLess(names.index("memory"), names.index("experiment_night"))
        phase = next(p for p in CYCLE_PHASES if p.name == "experiment_beliefs")
        self.assertEqual(phase.stage, "post_tool")
        self.assertIs(phase.precondition, WRITES_PERMITTED)
        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.state_key, "experiment_beliefs")
        self.assertEqual(phase.modes, frozenset({"standard"}))


class ExperimentBeliefsPhaseRunnerTests(unittest.TestCase):
    # The bridge suite's repo, finding, recipe and finding-bound experiment,
    # borrowed rather than copied so the two cannot drift.
    setUp = bridge.ExperimentFindingBridgeTests.setUp
    tearDown = bridge.ExperimentFindingBridgeTests.tearDown
    _observe = bridge.ExperimentFindingBridgeTests._observe
    _memory_rows = bridge.ExperimentFindingBridgeTests._memory_rows
    _beliefs = bridge.ExperimentFindingBridgeTests._beliefs

    def test_tonights_reproduction_becomes_a_belief_tonight(self) -> None:
        self._observe(run_id="run-red-tonight", cycle_id="cyc-night")
        context = build_phase_context(cycle_id="cyc-night", workspace_root=self.repo, base_dir=self.tools)

        payload = _phase_experiment_beliefs(context)

        self.assertEqual(payload, {"schema_version": 1, "cycle_id": "cyc-night", "beliefs_written": 1})
        [belief] = self._beliefs()
        self.assertEqual(belief["source_validation_run_id"], "run-red-tonight")
        self.assertEqual(belief["status"], "supported")

    def test_frozen_profile_refuses_the_write(self) -> None:
        self._observe(run_id="run-red-frozen", cycle_id="cyc-frozen")
        set_profile("standard", operator_approval_ref="medium-421", base_dir=self.tools)
        set_profile("frozen", operator_approval_ref="medium-421", base_dir=self.tools)

        with self.assertRaises(GovernanceError) as ctx:
            record_experiment_reproduction_beliefs(
                cycle_id="cyc-frozen", base_dir=self.tools, workspace_root=self.repo,
            )
        self.assertIn("'observation'", str(ctx.exception))
        self.assertEqual(self._beliefs(), [])


if __name__ == "__main__":
    unittest.main()
