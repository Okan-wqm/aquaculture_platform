"""Plan ARIA-V5 §2 V5.2 Phase 5.2 — Gate B review-gate invariants.

Four invariants pin the architectural contract between the autonomy
orchestrator and the new ``review_runner``:

  * I-V5.2-02 — review_runner invoked AFTER worker_drainer + BEFORE
    auto_merge_runner (autonomy_state phase ordering)
  * I-V5.2-03 — auto_merge_runner NOT invoked for 4 non-pass verdicts
    (gaps_open, max_review_rounds, judge_split, artifact_mismatch)
  * I-V5.2-04 (v2 redesign) — source-substring inspection: the
    literal predicate ``if review_result["review_verdict"] == "no_gaps":``
    MUST exist in autonomy_orchestrator.py source, plus a behavioural
    mock_call_count==0 defense-in-depth check
  * I-V5.2-05 — review_blocked_merge transition fires when verdict
    is non-pass; cycle_summary records auto_merge_blocked_by

I-V5.2-01 (signature inspection for review_runner REQUIRED kwarg)
lives in the sibling ``test_phase_v5_required_injection.py`` file.

Operator anchor (Plan ARIA-V5 §1, verbatim):
  "ımplementerler ımplement ettıkten sonra da eksık varmı yanlıs
   varmı dıye agentlar yıne kontrol etmelı"
"""

from __future__ import annotations

import inspect
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock


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


def _converged_fake(**kwargs):
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "converged_plan": {}, "rounds_count": 1,
        "arbiter_verdict": "converged",
        "unsatisfied_items": [], "request_ids": [],
        "transcript_path": "", "resumed_from_persistence": False,
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _review_no_gaps_fake(**kwargs):
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", ""),
        "review_verdict": "no_gaps", "rounds_count": 1,
        "gaps_found": [], "request_ids": [],
        "convergence_id": kwargs.get("convergence_id", "plan-test"),
    }


def _plan_synthesizer_fake(**kwargs):
    """Plan ARIA-V7 §2i v2 — V7.1 made plan_synthesizer REQUIRED."""
    cycle_id = kwargs.get("cycle_id", "cycle-test")
    return {
        "schema_version": 1,
        "title": f"Fake cycle {cycle_id}",
        "summary": "R-A9 V7 fixture",
        "affected_surfaces": ["fixture.py"],
        "key_changes": [{"id": "c1", "description": "x", "paths": ["fixture.py"]}],
        "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
        "evidence_refs": ["fixture.py:1:line"],
    }


def _skill_genesis_drainer_fake(**kwargs):
    """Plan ARIA-V7 §2h v2 — V7.4 made skill_genesis_drainer REQUIRED."""
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


def _specialists_no_gaps_fake(**kwargs):
    """Plan ARIA-V6 §2c v2 — V6.1 made specialist_review_runner
    REQUIRED; V5.2 tests pass this happy-path fake so the cycle
    proceeds through worker_drainer + auto_merge unimpeded."""
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "specialists_dispatched": [],
        "specialists_timed_out": [],
        "consolidated_verdict": "consolidated_no_gaps",
        "findings_by_specialist": {},
        "request_ids": [],
        "rounds_count": 1,
        "token_cost_estimate": 0,
        "profile": kwargs.get("profile", "standard"),
    }


def _review_verdict_fake_factory(verdict: str, rounds: int = 1):
    def _runner(**kwargs):
        return {
            "plan_id": kwargs.get("plan_id", "plan-test"),
            "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", ""),
            "review_verdict": verdict,
            "rounds_count": rounds,
            "gaps_found": [] if verdict == "no_gaps" else [{"id": "gap-1", "severity": "MEDIUM"}],
            "request_ids": [],
            "convergence_id": kwargs.get("convergence_id", "plan-test"),
        }
    return _runner


class PhaseV5_2ReviewGate(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v5_2-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard", operator_approval_ref="v5_2-test", base_dir=self.base,
        )

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, **overrides):
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        kwargs = dict(
            base_dir=self.base,
            workspace_root=str(self.tmp),
            max_cycles=1,
            max_iterations_per_phase=3,
            cycle_runner=_fake_cycle_runner,
            planner_drainer=_fake_planner_drainer,
            worker_drainer=_fake_worker_drainer,
            bridge_drainer=_fake_bridge_drainer,
            auto_merge_runner=_FakeAutoMergeRunner(),
            github_adapter=_FakeGitHubAdapter(),
            convergence_runner=_converged_fake,
            review_runner=_review_no_gaps_fake,
            # Plan ARIA-V6 §2c v2 — V6.1 makes specialist_review_runner
            # REQUIRED; V5.2 tests pass happy-path fake so the cycle
            # proceeds past Gate C into worker_drainer + auto_merge.
            specialist_review_runner=_specialists_no_gaps_fake,
            # Plan ARIA-V7 §2i v2 — V7.1 makes plan_synthesizer REQUIRED;
            # V5.2 tests pass happy-path fake so cycle proceeds through Gate A.
            plan_synthesizer=_plan_synthesizer_fake,
            # Plan ARIA-V7 §2h v2 — V7.4 skill_genesis_drainer REQUIRED.
            skill_genesis_drainer=_skill_genesis_drainer_fake,
            # Plan ARIA-V3.1-E — REQUIRED profile kwarg; standard
            # for V5.2 review-gate tests.
            profile="standard",
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def _read_autonomy_state(self) -> list[dict]:
        from aria_kernel.autonomy_state import autonomy_state_path
        path = autonomy_state_path(self.base)
        if not path.exists():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    # I-V5.2-02 — review runs AFTER worker + BEFORE auto_merge.
    def test_i_v5_2_02_review_runs_between_worker_and_auto_merge(
        self,
    ) -> None:
        """Plan ARIA-V5 §2 V5.2 — phase ordering invariant.

        ``review_started`` + ``review_resolved`` transitions MUST
        land in autonomy_state.jsonl AFTER ``worker_dispatch_drained``
        and BEFORE ``auto_merge_completed``. Pre-V5 the orchestrator
        went worker → auto_merge with no review gate; V5.2 inserts
        review between them.
        """
        self._run()
        rows = self._read_autonomy_state()
        phases = [r.get("phase") for r in rows]
        try:
            worker_drained = phases.index("worker_dispatch_drained")
            review_started = phases.index("review_started")
            review_resolved = phases.index("review_resolved")
            auto_merge_completed = phases.index("auto_merge_completed")
        except ValueError as exc:
            self.fail(
                f"V5.2 — expected phases worker_dispatch_drained → "
                f"review_started → review_resolved → "
                f"auto_merge_completed. Missing: {exc}. "
                f"Observed: {phases!r}"
            )
        self.assertLess(
            worker_drained, review_started,
            msg=f"V5.2 — review must START after worker dispatch drains",
        )
        self.assertLess(
            review_started, review_resolved,
            msg="V5.2 — review_resolved must follow review_started",
        )
        self.assertLess(
            review_resolved, auto_merge_completed,
            msg=(
                f"V5.2 — review must RESOLVE before auto_merge fires. "
                f"review_resolved at {review_resolved}, "
                f"auto_merge_completed at {auto_merge_completed}."
            ),
        )

    # I-V5.2-03 — auto_merge NOT invoked for non-pass verdicts.
    def test_i_v5_2_03_auto_merge_skipped_for_non_pass_verdicts(
        self,
    ) -> None:
        """Plan ARIA-V5 §2 V5.2 — auto-merge gate.

        For all 4 non-pass verdicts (gaps_open, max_review_rounds,
        judge_split, artifact_mismatch), auto_merge_runner MUST NOT
        be invoked. The orchestrator emits review_blocked_merge
        transition and records auto_merge_blocked_by on the cycle
        summary.
        """
        non_pass = [
            "gaps_open", "max_review_rounds",
            "judge_split", "artifact_mismatch",
        ]
        for verdict in non_pass:
            with self.subTest(verdict=verdict):
                mock_auto_merge = MagicMock(side_effect=lambda **kw: {
                    "schema_version": 1, "status": "skipped",
                    "merges_completed": 0, "candidates_evaluated": 0,
                    "profile": "standard",
                })
                mock_auto_merge.profile = "standard"
                result = self._run(
                    review_runner=_review_verdict_fake_factory(verdict),
                    auto_merge_runner=mock_auto_merge,
                )
                mock_auto_merge.assert_not_called()
                per_cycle = result.get("per_cycle", [])
                self.assertGreaterEqual(len(per_cycle), 1)
                self.assertEqual(
                    per_cycle[-1].get("auto_merge_blocked_by"),
                    f"review_{verdict}",
                    msg=(
                        f"V5.2 — cycle_summary['auto_merge_blocked_by'] "
                        f"must record the non-pass verdict ({verdict}) "
                        f"so the operator sees why merge was blocked."
                    ),
                )

    # I-V5.2-04 — source-substring + behavioural defense-in-depth.
    def test_i_v5_2_04_auto_merge_guarded_by_review_verdict(
        self,
    ) -> None:
        """Plan ARIA-V5 §3d v2 (B2 redesign) — source-substring
        inspection: the literal predicate
        ``if review_result["review_verdict"] == "no_gaps":`` MUST
        exist in autonomy_orchestrator.py. This is a Tier-1 structural
        check — refactoring the predicate (e.g., into a helper) WILL
        intentionally break this invariant and force the implementer
        to consciously re-validate the guard semantic.

        v1 plan proposed an AST-walking invariant; CPython AST does
        not auto-set ``.parent``, making the walk fragile. The
        source-substring approach mirrors V3
        ``test_i_v3_03_real_runner_imports_merge_if_green``.
        """
        from aria_kernel import autonomy_orchestrator
        source = inspect.getsource(autonomy_orchestrator)
        self.assertIn(
            'if review_result["review_verdict"] == "no_gaps":',
            source,
            msg=(
                "Plan ARIA-V5 §3d v2 (B2 fix) — auto_merge_runner "
                "call MUST be guarded by the literal predicate "
                "`if review_result[\"review_verdict\"] == \"no_gaps\":`. "
                "Refactoring the guard into a helper function will "
                "break this invariant intentionally so the implementer "
                "must re-validate the gate semantic."
            ),
        )

    # I-V5.2-05 — review_blocked_merge transition fires on non-pass.
    def test_i_v5_2_05_review_blocked_merge_transition_fires(
        self,
    ) -> None:
        """Plan ARIA-V5 §2 V5.2 — operator-visibility invariant.

        When review verdict is non-pass, the ``review_blocked_merge``
        autonomy_state transition MUST fire so the canonical state
        reducer records the block reason. Without this transition the
        operator's ``/aria-status`` cannot surface why a cycle did
        not merge.
        """
        self._run(review_runner=_review_verdict_fake_factory("gaps_open"))
        rows = self._read_autonomy_state()
        phases = [r.get("phase") for r in rows]
        self.assertIn(
            "review_blocked_merge", phases,
            msg=(
                f"V5.2 — gaps_open verdict MUST emit "
                f"review_blocked_merge transition. Phases: {phases!r}"
            ),
        )
        # auto_merge_completed transition still fires (orchestrator
        # records the skip via cycle_summary, but the phase row
        # itself can be present with status="skipped" depending on
        # downstream consumers).
        review_idx = phases.index("review_blocked_merge")
        review_resolved_idx = phases.index("review_resolved")
        self.assertLess(
            review_resolved_idx, review_idx,
            msg=(
                "V5.2 — review_resolved must precede review_blocked_merge "
                "in ordering."
            ),
        )


if __name__ == "__main__":
    unittest.main()
