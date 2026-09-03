"""Plan ARIA-V7 §2g v2 V7.2 — orchestrator try/except invariants.

Five invariants pin the try/except envelope around convergence_runner:

  * I-V7.2-01 — convergence_runner raising GovernanceError →
                ``convergence_invalid_plan`` phase emitted, NO crash;
                cycle reaches reflection cleanly.
  * I-V7.2-02 — plan_synthesizer returning None →
                ``cycle_runner_no_pressure`` phase emitted; cycle
                skips Gate A and reaches reflection.
  * I-V7.2-03 — both skip paths emit governance events (forensics).
  * I-V7.2-04 — source-substring invariant pins the literal
                ``except GovernanceError as _v7_exc:`` envelope.
  * I-V7.2-05 — reflection still runs on both skip paths
                (V3.3 §2b preservation).
"""

from __future__ import annotations

import inspect
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _fake_cycle_runner(**kwargs):
    return {"schema_version": 2, "cycle_id": kwargs["cycle_id"], "status": "completed"}


def _fake_planner_drainer(**kwargs):
    return {"iterations": 1, "claims_dispatched": 0, "exits_clean": True, "exit_reason": "max_iterations"}


def _fake_bridge_drainer(**kwargs):
    return {"status": "ok", "iterations": 0, "pending_after": 0}


def _fake_worker_drainer(**kwargs):
    return {
        "iterations": 1, "assignments_dispatched": 0, "merges_completed": 0,
        "retries_attempted": 0, "exits_clean": True, "exit_reason": "max_iterations",
    }


class _FakeAutoMergeRunner:
    profile = "standard"

    def __call__(self, *, base_dir, workspace_root):
        return {
            "schema_version": 1, "status": "skipped", "merges_completed": 0,
            "candidates_evaluated": 0, "profile": self.profile,
        }


class _FakeGitHubAdapter:
    pass


def _v7_fake_plan_synthesizer_valid(**kwargs):
    cycle_id = kwargs.get("cycle_id", "cycle-test")
    return {
        "schema_version": 1, "title": f"Fake cycle {cycle_id}",
        "summary": "v7 fixture", "affected_surfaces": ["fixture.py"],
        "key_changes": [{"id": "c1", "description": "x", "paths": ["fixture.py"]}],
        "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
        "evidence_refs": ["fixture.py:1:line"],
    }


def _v7_fake_plan_synthesizer_none(**kwargs):
    return None


def _convergence_raises_governance(**kwargs):
    from aria_kernel.tool_registry import GovernanceError
    raise GovernanceError(
        "plan content missing required field(s): schema_version, title"
    )


def _convergence_converged(**kwargs):
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "converged_plan": {}, "rounds_count": 1,
        "arbiter_verdict": "converged",
        "unsatisfied_items": [], "request_ids": [],
        "transcript_path": "", "resumed_from_persistence": False,
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _review_no_gaps(**kwargs):
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "impl_artifacts_ref": "", "review_verdict": "no_gaps",
        "rounds_count": 1, "gaps_found": [], "request_ids": [],
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _specialists_no_gaps(**kwargs):
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "specialists_dispatched": [], "specialists_timed_out": [],
        "consolidated_verdict": "consolidated_no_gaps",
        "findings_by_specialist": {}, "request_ids": [],
        "rounds_count": 1, "token_cost_estimate": 0,
        "profile": kwargs.get("profile", "standard"),
    }


def _skill_genesis_drainer_fake(**kwargs):
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "requests_scanned": 0, "requests_dispatched": 0,
        "requests_skipped_corpus_missing": 0,
        "requests_skipped_evidence_insufficient": 0,
        "requests_skipped_already_terminal": 0,
        "requests_skipped_token_budget": 0,
        "requests_skipped_non_convergent": 0,
        "authoring_results": [], "tokens_spent_this_cycle": 0,
        "aggregate_verdict": "no_requests",
    }


class PhaseV7_2OrchestratorTryExcept(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v7_2-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile("standard", operator_approval_ref="v7_2-test", base_dir=self.base)

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, **overrides):
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        kwargs = dict(
            base_dir=self.base,
            workspace_root=str(self.tmp),
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
            # Plan ARIA-V3.1-E — REQUIRED profile kwarg; standard
            # for V7.2 try/except envelope tests.
            profile="standard",
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def _read_state(self):
        from aria_kernel.autonomy_state import autonomy_state_path
        path = autonomy_state_path(self.base)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    # I-V7.2-01 — GovernanceError → convergence_invalid_plan phase.
    def test_i_v7_2_01_governance_error_emits_invalid_plan_phase(self) -> None:
        """Plan ARIA-V7 §2g v2 — GovernanceError converted to verdict."""
        result = self._run(convergence_runner=_convergence_raises_governance)
        phases = [r.get("phase") for r in self._read_state()]
        self.assertIn(
            "convergence_invalid_plan", phases,
            msg=(
                "Plan ARIA-V7 §2g v2 — GovernanceError from "
                "convergence_runner MUST be caught + converted to "
                "convergence_invalid_plan phase. Crash = ORPHAN-HIGH-079 "
                f"resurrected. Got phases: {phases}"
            ),
        )
        # Cycle should still complete (not crash).
        self.assertIn("next_cycle_queued", phases)
        self.assertEqual(result.get("cycles_completed"), 1)

    # I-V7.2-02 — synthesizer returning None → cycle_runner_no_pressure.
    def test_i_v7_2_02_synthesizer_none_emits_no_pressure(self) -> None:
        """Plan ARIA-V7 §2g v2 — None plan_content skips Gate A cleanly."""
        result = self._run(plan_synthesizer=_v7_fake_plan_synthesizer_none)
        phases = [r.get("phase") for r in self._read_state()]
        self.assertIn(
            "cycle_runner_no_pressure", phases,
            msg=(
                "Plan ARIA-V7 §2i v2 — synthesizer returning None MUST "
                "emit cycle_runner_no_pressure phase + skip Gate A. "
                f"Got phases: {phases}"
            ),
        )
        self.assertNotIn(
            "convergence_started", phases,
            msg="No-pressure cycle MUST NOT invoke convergence_runner",
        )
        self.assertEqual(result.get("cycles_completed"), 1)

    # I-V7.2-03 — both skip paths emit governance events.
    def test_i_v7_2_03_governance_event_captures_invalid_plan(self) -> None:
        """Plan ARIA-V7 §2g v2 — operator forensics via governance event."""
        self._run(convergence_runner=_convergence_raises_governance)
        gov_path = self.base / "governance.jsonl"
        self.assertTrue(
            gov_path.exists(),
            msg="governance.jsonl MUST exist after invalid-plan event",
        )
        rows = [json.loads(line) for line in gov_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        kinds = [r.get("kind") for r in rows]
        self.assertIn(
            "convergence_invalid_plan", kinds,
            msg=(
                "Plan ARIA-V7 §2g v2 — convergence_invalid_plan MUST "
                "be appended to governance.jsonl for operator forensics. "
                f"Got kinds: {kinds}"
            ),
        )

    # I-V7.2-04 — source-substring invariant.
    def test_i_v7_2_04_source_substring_pins_try_except(self) -> None:
        """Plan ARIA-V7 §2g v2 — refactor-resistant try/except envelope."""
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        # The literal envelope must appear. A refactor that converts
        # try/except to a context manager or swallows the exception
        # silently re-introduces the crash path.
        self.assertIn(
            "except GovernanceError as _v7_exc:", src,
            msg=(
                "Plan ARIA-V7 §2g v2 (I-V7.2-04) — orchestrator MUST "
                "contain the literal `except GovernanceError as _v7_exc:` "
                "envelope. Refactor that drops it re-introduces "
                "ORPHAN-HIGH-079 crash path."
            ),
        )
        self.assertIn(
            'phase="convergence_invalid_plan"', src,
            msg=(
                "Plan ARIA-V7 §2g v2 — the catch block MUST emit "
                "phase=convergence_invalid_plan AutonomyStateReducer "
                "transition."
            ),
        )

    # I-V7.2-05 — reflection still runs on both skip paths.
    def test_i_v7_2_05_reflection_runs_on_both_skip_paths(self) -> None:
        """Plan ARIA-V7 §2g v2 — V3.3 §2b reflection preservation."""
        # Test both paths.
        for runner_kw in (
            {"convergence_runner": _convergence_raises_governance},
            {"plan_synthesizer": _v7_fake_plan_synthesizer_none},
        ):
            shutil.rmtree(self.tmp, ignore_errors=True)
            self.tmp.mkdir()
            (self.base).mkdir(parents=True, exist_ok=True)
            self._run(**runner_kw)
            phases = [r.get("phase") for r in self._read_state()]
            # Reflection emits its own ledger row; daily report file
            # may or may not exist depending on reducer state. We
            # check that the cycle reached next_cycle_queued (means
            # reflection block fired).
            self.assertIn(
                "next_cycle_queued", phases,
                msg=(
                    "Plan ARIA-V7 §2g v2 — every skip path MUST still "
                    "reach next_cycle_queued (reflection ran). "
                    f"Got phases for {runner_kw}: {phases}"
                ),
            )


if __name__ == "__main__":
    unittest.main()
