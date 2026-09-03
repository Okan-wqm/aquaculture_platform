"""Plan ARIA-V5 §2 V5.1 Phase 5.1 — Gate A convergence-gate invariants.

Five invariants (I-V5.1-02..05 plus I-V5.1-04 parameterised over all
non-converged verdicts) lock the architectural contract between the
autonomy orchestrator and the new ``convergence_drainer``:

  * I-V5.1-02 — convergence_runner invoked BEFORE worker_drainer
    (governance + autonomy_state row ordering)
  * I-V5.1-03 — primary + challenger envelopes share matching
    ``convergence_id`` AND ``plan_revision_hash``
  * I-V5.1-04 — worker_drainer + auto_merge_runner skipped when
    arbiter_verdict != "converged" (6 non-converged verdicts × 0
    call count)
  * I-V5.1-05 — max_rounds verdict emits the ``convergence_blocked``
    transition and reflection STILL runs (V3.3 §2b preserved on
    blocked cycles)

I-V5-01 (signature inspection for required kwarg) lives in the
sibling ``test_phase_v5_required_injection.py`` file.

Operator anchor (Plan ARIA-V5 §1, verbatim):
  "agentlar plan yapıyor ya yanı planları sureklı en bastan revıew
   ederek ıkı agent bırbırıne atarak valıde sekılde sonlanrmalı"
"""

from __future__ import annotations

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
        "converged_plan": {},
        "rounds_count": 1,
        "arbiter_verdict": "converged",
        "unsatisfied_items": [],
        "request_ids": [],
        "transcript_path": "",
        "resumed_from_persistence": False,
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _verdict_fake_factory(verdict: str, rounds: int = 4):
    def _runner(**kwargs):
        return {
            "plan_id": kwargs.get("plan_id", "plan-test"),
            "converged_plan": {},
            "rounds_count": rounds,
            "arbiter_verdict": verdict,
            "unsatisfied_items": [],
            "request_ids": [],
            "transcript_path": "",
            "resumed_from_persistence": False,
            "convergence_id": kwargs.get("plan_id", "plan-test"),
        }
    return _runner


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
    REQUIRED; V5.1 tests pass this happy-path fake so the cycle
    proceeds through worker_drainer after convergence verdict==converged."""
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


def _review_no_gaps_fake(**kwargs):
    """Plan ARIA-V5 §3d v2 — V5.2 made review_runner REQUIRED; V5.1
    tests pass this happy-path fake so the cycle proceeds through
    auto_merge after convergence verdict==converged."""
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", ""),
        "review_verdict": "no_gaps", "rounds_count": 1,
        "gaps_found": [], "request_ids": [],
        "convergence_id": kwargs.get("convergence_id", "plan-test"),
    }


class PhaseV5_1ConvergenceGate(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v5_1-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard", operator_approval_ref="v5_1-test", base_dir=self.base,
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
            # Plan ARIA-V5 §3d v2 — V5.2 makes review_runner REQUIRED;
            # V5.1 tests pass happy-path fake by default so the cycle
            # progresses past worker_drainer to auto_merge.
            review_runner=_review_no_gaps_fake,
            # Plan ARIA-V6 §2c v2 — V6.1 makes specialist_review_runner
            # REQUIRED; V5.1 tests pass happy-path fake so the cycle
            # proceeds past Gate C into worker_drainer.
            specialist_review_runner=_specialists_no_gaps_fake,
            # Plan ARIA-V7 §2i v2 — V7.1 makes plan_synthesizer
            # REQUIRED; V5.1 tests pass happy-path fake so cycle
            # proceeds through Gate A.
            plan_synthesizer=_plan_synthesizer_fake,
            # Plan ARIA-V7 §2h v2 — V7.4 makes skill_genesis_drainer
            # REQUIRED; happy-path fake returns no_requests.
            skill_genesis_drainer=_skill_genesis_drainer_fake,
            # Plan ARIA-V3.1-E — `profile` REQUIRED kwarg; V5.1 tests
            # exercise the convergence gate under default standard
            # profile (preflight skipped, agent_claim permitted).
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

    # I-V5.1-02 — convergence runner invoked BEFORE worker drainer.
    def test_i_v5_1_02_convergence_runs_before_worker_drainer(self) -> None:
        """Plan ARIA-V5 §2 V5.1 — phase ordering invariant.

        The convergence_started + convergence_resolved transitions
        MUST land in autonomy_state.jsonl BEFORE the
        worker_dispatch_drained transition. Pre-V5.1 the orchestrator
        went planner → bridge → worker; V5.1 inserts convergence
        between bridge and worker.
        """
        self._run(convergence_runner=_converged_fake)
        rows = self._read_autonomy_state()
        phases = [r.get("phase") for r in rows]
        try:
            conv_started = phases.index("convergence_started")
            conv_resolved = phases.index("convergence_resolved")
        except ValueError:
            self.fail(
                f"V5.1 — convergence_started + convergence_resolved "
                f"transitions MUST appear in autonomy_state.jsonl. "
                f"Observed phases: {phases!r}"
            )
        try:
            worker_drained = phases.index("worker_dispatch_drained")
        except ValueError:
            self.fail(
                f"V5.1 — worker_dispatch_drained MUST fire on a "
                f"converged cycle. Observed phases: {phases!r}"
            )
        self.assertLess(
            conv_started, worker_drained,
            msg=(
                f"V5.1 §2 — convergence_started ({conv_started}) MUST "
                f"come before worker_dispatch_drained ({worker_drained}). "
                f"Pre-V5.1 worker_drainer fired unconditionally; V5.1 "
                f"gates it on convergence verdict."
            ),
        )
        self.assertLess(
            conv_resolved, worker_drained,
            msg=(
                f"V5.1 §2 — convergence_resolved ({conv_resolved}) MUST "
                f"come before worker_dispatch_drained ({worker_drained})."
            ),
        )

    # I-V5.1-03 — primary + challenger envelopes share convergence_id.
    def test_i_v5_1_03_primary_and_challenger_share_convergence_id(
        self,
    ) -> None:
        """Plan ARIA-V5 §3c v2 — bridge invariants.

        Both ``start_convergent_plan_with_envelope`` and
        ``issue_challenger_envelope`` MUST mint envelopes carrying
        the SAME ``convergence_id`` (== plan_id) AND the SAME
        ``plan_revision_hash`` so the cross-review collusion check
        in plan_convergence.py:473 can identify same-revision pairs.
        """
        # Plan ARIA-V8 v2 §4 Phase 8.1 (B-V2-07) — V5.1-03 ported.
        # V8 deleted start_convergent_plan_with_envelope (legacy
        # round-1 primary envelope is OBSOLETE; cycle_runner's
        # plan_content IS the primary draft). Updated invariant
        # verifies challenger + cross_review envelopes share
        # convergence_id and plan_revision_hash — same collusion-
        # detection guarantee, new V8 producer surface.
        from aria_kernel.convergent_planning_bridge import (
            issue_challenger_envelope,
            start_convergent_plan_drafted_by_primary,
        )
        from aria_kernel.cross_review_bridge import (
            issue_cross_review_envelope,
        )

        start_convergent_plan_drafted_by_primary(
            plan_id="plan-v5_1-03",
            plan_content={
                "schema_version": 1,
                "title": "V5.1 I-V5.1-03 test plan",
                "summary": "V5.1 I-V5.1-03 test plan summary",
                "affected_surfaces": ["test/"],
                "key_changes": ["rule-1 satisfied"],
                "validation_commands": [{"cmd": "pytest", "expected_exit": 0, "timeout_ms": 60000}],
                "evidence_refs": ["test.py"],
            },
            initial_revision_id="rev-1",
            base_dir=self.base,
        )
        challenger_record = issue_challenger_envelope(
            plan_id="plan-v5_1-03",
            round_number=1,
            must_satisfy=[{"id": "rule-1", "description": "must satisfy rule 1"}],
            evidence_refs=["test.py:1"],
            allowed_scope=["test/"],
            plan_revision_hash="rev-1",
            base_dir=self.base,
        )
        cross_review_record = issue_cross_review_envelope(
            plan_id="plan-v5_1-03",
            round_number=1,
            primary_revision_id="rev-1",
            primary_plan_text="primary text fixture",
            challenger_revision_id="c-1",
            challenger_plan_text="challenger text fixture",
            must_satisfy=[{"id": "rule-1", "description": "must satisfy rule 1", "content_hash": "sha256:p"}],
            evidence_refs=["test.py:1"],
            allowed_scope=["test/"],
            plan_revision_hash="rev-1",
            base_dir=self.base,
        )
        self.assertEqual(
            challenger_record["convergence_id"],
            cross_review_record["convergence_id"],
            msg=(
                "V8 §4 Phase 8.1 — challenger + cross_review envelopes "
                "MUST share convergence_id (plan_id) so independence "
                "checking can identify same-plan envelopes."
            ),
        )
        self.assertEqual(
            challenger_record["plan_revision_hash"],
            cross_review_record["plan_revision_hash"],
            msg=(
                "V8 §4 Phase 8.1 — challenger + cross_review MUST "
                "carry the SAME plan_revision_hash to bind the "
                "cross-review verdict to a specific challenger "
                "revision."
            ),
        )

    # I-V5.1-04 — worker_drainer NOT invoked for non-converged verdicts.
    def test_i_v5_1_04_worker_skipped_for_non_converged_verdicts(
        self,
    ) -> None:
        """Plan ARIA-V5 §2 V5.1 — worker dispatch gate.

        For all 6 non-converged verdicts (max_rounds, split,
        scope_abort, primary_silent, challenger_unavailable,
        aria_stop_interrupted), worker_drainer MUST NOT be invoked
        and auto_merge_runner MUST NOT be invoked. Pre-V5 they fired
        unconditionally — the operator-facing risk was an
        implementation landing without consensus.
        """
        # Plan ARIA-V8 v2 §4 Phase 8.1 (B-V2-02) — primary_silent
        # OBSOLETED; cross_review_unavailable / cross_review_self_agreement
        # / primary_revision_failed / budget_exhausted added.
        non_converged = [
            "max_rounds", "split", "scope_abort",
            "challenger_unavailable",
            "cross_review_unavailable",
            "cross_review_self_agreement",
            "primary_revision_failed",
            "budget_exhausted",
            "aria_stop_interrupted",
        ]
        for verdict in non_converged:
            with self.subTest(verdict=verdict):
                mock_worker = MagicMock(return_value={
                    "iterations": 0, "assignments_dispatched": 0,
                    "merges_completed": 0, "retries_attempted": 0,
                    "exits_clean": True, "exit_reason": "max_iterations",
                })
                mock_auto_merge = MagicMock(side_effect=lambda **kw: {
                    "schema_version": 1, "status": "skipped",
                    "merges_completed": 0, "candidates_evaluated": 0,
                    "profile": "standard",
                })
                mock_auto_merge.profile = "standard"
                self._run(
                    convergence_runner=_verdict_fake_factory(verdict),
                    worker_drainer=mock_worker,
                    auto_merge_runner=mock_auto_merge,
                )
                mock_worker.assert_not_called()
                mock_auto_merge.assert_not_called()

    # I-V5.1-05 — max_rounds emits convergence_blocked + reflection runs.
    def test_i_v5_1_05_max_rounds_blocks_and_reflects(self) -> None:
        """Plan ARIA-V5 §2 V5.1 — max_rounds verdict path.

        Hitting the convergence max_rounds cap MUST:
          (a) emit the ``convergence_blocked`` transition in
              autonomy_state.jsonl
          (b) STILL run reflection (V3.3 §2b post-drain semantics
              preserved on blocked cycles) so the operator daily
              report records the convergence-blocked cycle
          (c) NOT invoke worker_drainer or auto_merge_runner
        """
        max_rounds_fake = _verdict_fake_factory("max_rounds", rounds=4)
        result = self._run(convergence_runner=max_rounds_fake)
        rows = self._read_autonomy_state()
        phases = [r.get("phase") for r in rows]
        self.assertIn(
            "convergence_blocked", phases,
            msg=(
                f"V5.1 §2 — max_rounds verdict MUST emit "
                f"convergence_blocked transition. Phases: {phases!r}"
            ),
        )
        self.assertNotIn(
            "worker_dispatch_drained", phases,
            msg="V5.1 — worker_drainer must not fire on max_rounds verdict",
        )
        # Reflection runs on blocked cycle — daily report still emitted.
        reflections_path = self.base / "reflections.jsonl"
        self.assertTrue(
            reflections_path.exists(),
            msg=(
                "V5.1 + V3.3 §2b — reflection MUST still run on "
                "convergence-blocked cycles so the daily report "
                "covers them."
            ),
        )
        # Per-cycle result records the block reason.
        per_cycle = result.get("per_cycle", [])
        self.assertGreaterEqual(len(per_cycle), 1)
        last_cycle = per_cycle[-1]
        self.assertIn("convergence", last_cycle)
        self.assertEqual(
            last_cycle["convergence"]["arbiter_verdict"], "max_rounds",
        )
        self.assertEqual(
            last_cycle.get("dispatch_blocked_reason"),
            "convergence_max_rounds",
        )


if __name__ == "__main__":
    unittest.main()
