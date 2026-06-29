"""Plan 031-R R7 (B7) — the autonomy orchestrator advances the unlock ladder on
a clean cycle.

Pre-R7 record_clean_cycle had no caller inside the orchestrator, so a normal
clean autonomous cycle never moved the ladder. This pins the operator-gated
wiring: with ARIA_LADDER_ACCOUNTING=1 a clean cycle records an observe_success,
and under CODEX_CLI_MOCK it lands on the MOCK ledger (the sandbox can never
unlock real merge). Reuses the V7.2 orchestrator fakes.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.autonomy_ladder import evaluate_mock_unlock
from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock
from aria_kernel.runtime_profile import set_profile
from tests.invariants.v3_3._helpers import clear_aria_tools_env, restore_aria_tools_env
from tests.invariants.v7.test_phase_v7_2_orchestrator_try_except import (
    _convergence_converged,
    _fake_bridge_drainer,
    _fake_cycle_runner,
    _fake_planner_drainer,
    _fake_worker_drainer,
    _FakeAutoMergeRunner,
    _FakeGitHubAdapter,
    _review_no_gaps,
    _skill_genesis_drainer_fake,
    _specialists_no_gaps,
    _v7_fake_plan_synthesizer_valid,
)


class LadderOrchestratorWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-r7-wiring-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile("standard", operator_approval_ref="r7-test", base_dir=self.base)

    def tearDown(self) -> None:
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self):
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        return run_autonomy_orchestrator(
            base_dir=self.base, workspace_root=str(self.tmp),
            max_cycles=1, max_iterations_per_phase=3,
            cycle_runner=_fake_cycle_runner,
            planner_drainer=_fake_planner_drainer,
            worker_drainer=_fake_worker_drainer,
            bridge_drainer=_fake_bridge_drainer,
            auto_merge_runner=_FakeAutoMergeRunner(),
            github_adapter=_FakeGitHubAdapter(),
            convergence_runner=_convergence_converged,
            review_runner=_review_no_gaps,
            specialist_review_runner=_specialists_no_gaps,
            plan_synthesizer=_v7_fake_plan_synthesizer_valid,
            skill_genesis_drainer=_skill_genesis_drainer_fake,
            profile="standard",
        )

    def test_clean_cycle_advances_mock_ladder_when_enabled(self) -> None:
        with patch.dict("os.environ", {"ARIA_LADDER_ACCOUNTING": "1", "CODEX_CLI_MOCK": "1"}):
            self._run()
        mock = evaluate_mock_unlock(lane="L1", base_dir=self.base)
        real = evaluate_autonomy_unlock(lane="L1", base_dir=self.base)
        self.assertEqual(mock.counts["observe_successes"], 1)
        # Mock mode must never write the real ledger.
        self.assertEqual(real.counts["observe_successes"], 0)

    def test_no_accounting_env_means_no_ladder_write(self) -> None:
        # Without the opt-in env, a clean cycle does NOT touch the ladder.
        self._run()
        mock = evaluate_mock_unlock(lane="L1", base_dir=self.base)
        self.assertEqual(mock.counts["observe_successes"], 0)


if __name__ == "__main__":
    unittest.main()
