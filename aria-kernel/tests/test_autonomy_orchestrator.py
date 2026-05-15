"""Plan 026R §F.1 LOAD-BEARING — autonomy orchestrator state machine.

8 tests:

* Full chain happy path → cycles_completed=N + all phases recorded.
* ARIA_STOP exits clean with reason=aria_stop, no cycle ran.
* Frozen profile exits clean with reason=profile_frozen.
* max_cycles cap honored.
* Single-instance daemon lock contention returns
  exits_clean=False + reason=daemon_already_running.
* Cycle runner failure → cycle_completed status=failed transition
  + orchestrator still advances to next cycle.
* Idempotent re-run: per-cycle results are additive.
* Reducer state after run reflects every transition counter.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
from aria_kernel.autonomy_state import (
    AutonomyStateReducer,
    autonomy_state_path,
)
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir


def _fake_cycle_runner(*, workspace_root, cycle_id, base_dir):
    return {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "status": "completed",
    }


def _failing_cycle_runner(*, workspace_root, cycle_id, base_dir):
    raise RuntimeError("simulated cycle failure")


def _fake_planner_drainer(*, base_dir, workspace_root, max_iterations):
    return {
        "iterations": 1,
        "claims_dispatched": 2,
        "exits_clean": True,
        "exit_reason": "max_iterations",
    }


def _fake_worker_drainer(**kwargs):
    """Plan ARIA-V3 §A2 — accept arbitrary kwargs so the orchestrator
    can pass through new dependencies (e.g. ``github_adapter``)
    without breaking this fixture.
    """
    return {
        "iterations": 1,
        "assignments_dispatched": 3,
        "retries_attempted": 0,
        "merges_completed": 1,
        "exits_clean": True,
        "exit_reason": "max_iterations",
    }


def _fake_bridge_drainer(*, base_dir, max_iterations):
    return {
        "status": "ok",
        "iterations": 0,
        "pending_after": 0,
    }


class _FakeAutoMergeRunner:
    """Plan ARIA-V3 §A1 migration — orchestrator now requires an
    auto_merge_runner. The existing fake_worker_drainer accumulates
    merges_completed=1 per cycle for backward-compat with the
    pre-V3 happy-path test; this fake runner adds zero so the
    historical assertion (auto_merges_completed=2 across 2 cycles)
    is preserved exactly.
    """

    profile = "standard"

    def __call__(self, *, base_dir, workspace_root):
        return {
            "schema_version": 1,
            "status": "skipped",
            "reason": "fake_runner_for_orchestrator_tests",
            "merges_completed": 0,
            "candidates_evaluated": 0,
            "profile": self.profile,
        }


_fake_auto_merge_runner = _FakeAutoMergeRunner()


class _FakeGitHubAdapter:
    """Plan ARIA-V3 §A2 — required github_adapter test fixture.

    The orchestrator now requires a GitHubAdapter Protocol instance.
    These tests inject fake worker_drainer + fake invoke_worker that
    do not touch GitHub, so a placeholder that satisfies attribute
    lookups is sufficient. Real adapter selection lives in
    aria_kernel.github_adapters.select_github_adapter and is
    exercised by tests/invariants/v3/test_phase_a1_a2_required_injection.py.
    """


_fake_github_adapter = _FakeGitHubAdapter()


class AutonomyOrchestratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f1-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="f1-t", base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, **overrides: Any) -> dict[str, Any]:
        kwargs: dict[str, Any] = dict(
            base_dir=self.base,
            workspace_root=str(self.tmp),
            max_cycles=1,
            max_iterations_per_phase=3,
            cycle_runner=_fake_cycle_runner,
            planner_drainer=_fake_planner_drainer,
            worker_drainer=_fake_worker_drainer,
            bridge_drainer=_fake_bridge_drainer,
            # Plan ARIA-V3 §A1 — auto_merge_runner is REQUIRED.
            auto_merge_runner=_fake_auto_merge_runner,
            # Plan ARIA-V3 §A2 — github_adapter is REQUIRED.
            github_adapter=_fake_github_adapter,
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def test_full_chain_happy_path(self) -> None:
        result = self._run(max_cycles=2)
        self.assertEqual(result["exit_reason"], "max_cycles")
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 2)
        self.assertEqual(result["planner_claims_dispatched"], 4)
        self.assertEqual(result["worker_assignments_dispatched"], 6)
        self.assertEqual(result["auto_merges_completed"], 2)
        # Inspect autonomy_state.jsonl for transition coverage.
        rows = load_jsonl(autonomy_state_path(self.base))
        phases = {row["phase"] for row in rows}
        self.assertIn("cycle_started", phases)
        self.assertIn("cycle_completed", phases)
        self.assertIn("planner_dispatch_drained", phases)
        self.assertIn("bridge_drained", phases)
        self.assertIn("worker_dispatch_drained", phases)
        self.assertIn("max_cycles_reached", phases)

    def test_aria_stop_exits_before_cycle_starts(self) -> None:
        ensure_tools_dir(self.base)
        (self.base / "ARIA_STOP").write_text("stop", encoding="utf-8")
        result = self._run(max_cycles=5)
        self.assertEqual(result["exit_reason"], "aria_stop")
        self.assertEqual(result["cycles_completed"], 0)
        rows = load_jsonl(autonomy_state_path(self.base))
        # Only aria_stop transition was recorded.
        self.assertTrue(any(r["phase"] == "aria_stop" for r in rows))
        self.assertFalse(
            any(r["phase"] == "cycle_started" for r in rows),
        )

    def test_frozen_profile_blocks_orchestrator(self) -> None:
        set_profile(
            "frozen",
            operator_approval_ref="ops-approved",
            base_dir=self.base,
        )
        result = self._run(max_cycles=3)
        self.assertEqual(result["exit_reason"], "profile_frozen")
        self.assertEqual(result["cycles_completed"], 0)

    def test_max_cycles_cap_honored(self) -> None:
        result = self._run(max_cycles=1)
        self.assertEqual(result["cycles_completed"], 1)
        result2 = self._run(max_cycles=4)
        # Each invocation is independent (no cross-call state).
        self.assertEqual(result2["cycles_completed"], 4)

    def test_single_instance_lock_contended(self) -> None:
        ensure_tools_dir(self.base)
        daemon_lock = (
            self.base / "daemons" / "autonomy.pid.lock"
        )
        daemon_lock.parent.mkdir(parents=True, exist_ok=True)
        # Hold the lock to simulate a concurrent orchestrator.
        with with_exclusive_lock(daemon_lock):
            result = self._run()
        self.assertEqual(
            result["exit_reason"], "daemon_already_running",
        )
        self.assertFalse(result["exits_clean"])

    def test_cycle_runner_failure_records_failed_transition(self) -> None:
        result = self._run(cycle_runner=_failing_cycle_runner)
        self.assertEqual(result["cycles_completed"], 0)
        rows = load_jsonl(autonomy_state_path(self.base))
        cycle_completed_rows = [
            r for r in rows if r["phase"] == "cycle_completed"
        ]
        self.assertEqual(len(cycle_completed_rows), 1)
        self.assertEqual(cycle_completed_rows[0]["status"], "failed")
        # Orchestrator still emits subsequent phases.
        self.assertTrue(
            any(r["phase"] == "worker_dispatch_drained" for r in rows),
        )

    def test_idempotent_re_run_accumulates_state(self) -> None:
        self._run(max_cycles=1)
        first_state = AutonomyStateReducer.derive_current(self.base)
        self._run(max_cycles=1)
        second_state = AutonomyStateReducer.derive_current(self.base)
        self.assertEqual(
            second_state.cycles_completed,
            first_state.cycles_completed + 1,
        )
        self.assertEqual(
            second_state.planner_claims_dispatched,
            first_state.planner_claims_dispatched + 2,
        )

    def test_reducer_state_matches_run_counters(self) -> None:
        result = self._run(max_cycles=3)
        state = AutonomyStateReducer.derive_current(self.base)
        self.assertEqual(
            state.cycles_completed, result["cycles_completed"],
        )
        self.assertEqual(
            state.planner_claims_dispatched,
            result["planner_claims_dispatched"],
        )
        self.assertEqual(
            state.worker_assignments_dispatched,
            result["worker_assignments_dispatched"],
        )


if __name__ == "__main__":
    unittest.main()
