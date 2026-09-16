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

import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from unittest.mock import patch

from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
from aria_kernel.autonomy_state import (
    AutonomyStateReducer,
    autonomy_state_path,
)
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import fold_plan_state
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir
from tests.test_implementation_lifecycle_continuity import (
    drive_plan_to_converged,
    drive_plan_to_implementation_requested,
    seed_reviewer_agent,
)


def _fake_cycle_runner(
    *, workspace_root, cycle_id, base_dir, defer_reflection=False,
):
    # Plan ARIA-V3.3 §2b — mocks must mirror the real cycle_runner
    # contract; the orchestrator passes ``defer_reflection=True`` so
    # the kwarg has to be accepted by every cycle_runner injection
    # seam.
    return {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "status": "completed",
    }


def _failing_cycle_runner(
    *, workspace_root, cycle_id, base_dir, defer_reflection=False,
):
    raise RuntimeError("simulated cycle failure")


def _fake_convergence_runner(**kwargs):
    """Plan ARIA-V5 §4 V5.1 — happy-path mock convergence runner.

    Returns ``arbiter_verdict="converged"`` on round 1 so the cycle
    proceeds through worker_drainer + auto_merge_runner unimpeded.
    Accepts ``**kwargs`` permissively (V3 §A2 pattern) so future
    ConvergenceRunner Protocol kwargs do not break this fixture.
    """
    return {
        "plan_id": kwargs.get("plan_id", f"plan-{kwargs.get('cycle_id', 'test')}"),
        "converged_plan": {"plan_id": kwargs.get("plan_id"), "must_satisfy": []},
        "rounds_count": 1,
        "arbiter_verdict": "converged",
        "unsatisfied_items": [],
        "request_ids": [],
        "transcript_path": f"convergence/{kwargs.get('cycle_id', 'test')}.jsonl",
        "resumed_from_persistence": False,
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _fake_review_runner(**kwargs):
    """Plan ARIA-V5 §4 V5.2 — happy-path mock review runner.

    Returns ``review_verdict="no_gaps"`` on round 1 so the cycle
    proceeds through auto_merge_runner unimpeded. Accepts ``**kwargs``
    permissively so future ReviewRunner Protocol kwargs do not break
    this fixture.
    """
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", f"cycle:{kwargs.get('cycle_id', 'test')}"),
        "review_verdict": "no_gaps",
        "rounds_count": 1,
        "gaps_found": [],
        "request_ids": [],
        "convergence_id": kwargs.get("convergence_id", kwargs.get("plan_id", "plan-test")),
    }


def _fake_specialist_review_runner(**kwargs):
    """Plan ARIA-V6 §2c V6.1 — happy-path mock specialist review runner.

    Returns ``consolidated_verdict="consolidated_no_gaps"`` so cycle
    proceeds through worker_drainer. R-A9 compat pattern from V5 §A1.
    """
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "specialists_dispatched": ["auth-security-expert", "farm-expert"],
        "specialists_timed_out": [],
        "consolidated_verdict": "consolidated_no_gaps",
        "findings_by_specialist": {},
        "request_ids": [],
        "rounds_count": 1,
        "token_cost_estimate": 0,
        "profile": kwargs.get("profile", "standard"),
    }


def _fake_plan_synthesizer(**kwargs):
    """Plan ARIA-V7 §2i v2 V7.1 — happy-path mock plan_synthesizer."""
    cycle_id = kwargs.get("cycle_id", "cycle-test")
    return {
        "schema_version": 1,
        "title": f"Fake cycle {cycle_id}",
        "summary": "Fake plan_content for R-A9 fixture compat",
        "affected_surfaces": ["fixture/path.py"],
        "key_changes": [{
            "id": "fixture-change-1",
            "description": "fixture cluster",
            "paths": ["fixture/path.py"],
        }],
        "validation_commands": [{
            "cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0,
        }],
        "evidence_refs": ["fixture/path.py:1:fixture line"],
    }


def _fake_skill_genesis_drainer(**kwargs):
    """Plan ARIA-V7 §2h v2 V7.4 — happy-path mock skill_genesis_drainer.

    Returns ``aggregate_verdict="no_requests"`` (no convergent requests
    to dispatch) so the cycle proceeds through Gate A unimpeded.
    R-A9 compat pattern from V5/V6/V7.1 §A1.
    """
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "requests_scanned": 0,
        "requests_dispatched": 0,
        "requests_skipped_corpus_missing": 0,
        "requests_skipped_evidence_insufficient": 0,
        "requests_skipped_already_terminal": 0,
        "requests_skipped_token_budget": 0,
        "requests_skipped_non_convergent": 0,
        "authoring_results": [],
        "tokens_spent_this_cycle": 0,
        "aggregate_verdict": "no_requests",
    }


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
            # Plan ARIA-V5 §3c v2 — convergence_runner is REQUIRED
            # (V5.1 Tier-1, no default). Happy-path fake returns
            # arbiter_verdict="converged" so existing V3-era tests
            # see worker_drainer + auto_merge_runner fire normally.
            convergence_runner=_fake_convergence_runner,
            # Plan ARIA-V5 §3d v2 — review_runner is REQUIRED (V5.2
            # Tier-1, no default). Happy-path fake returns
            # review_verdict="no_gaps" so auto_merge_runner still
            # fires per existing V3-era test expectations.
            review_runner=_fake_review_runner,
            # Plan ARIA-V6 §2c v2 — specialist_review_runner is
            # REQUIRED (V6.1 Tier-1, no default). Happy-path fake
            # returns consolidated_no_gaps so cycle proceeds through
            # worker_drainer.
            specialist_review_runner=_fake_specialist_review_runner,
            # Plan ARIA-V7 §2i v2 — plan_synthesizer is REQUIRED
            # (V7.1 Tier-1, no default). Happy-path fake returns a
            # structurally-valid plan_content so the cycle proceeds
            # through Gate A unimpeded.
            plan_synthesizer=_fake_plan_synthesizer,
            # Plan ARIA-V7 §2h v2 — skill_genesis_drainer is REQUIRED
            # (V7.4 Tier-1, no default). Happy-path fake returns
            # aggregate_verdict="no_requests" so cycle proceeds.
            skill_genesis_drainer=_fake_skill_genesis_drainer,
            # Plan ARIA-V3.1-E — `profile` is REQUIRED (no default).
            # Tests default to "standard" so preflight is skipped +
            # the action-permission set permits agent_claim +
            # change_committed + change_validated (pr_open is strict-
            # only — V3-era tests don't exercise PR open).
            profile="standard",
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def test_native_postcheck_failed_terminal_stops_outer_progression(self) -> None:
        from unittest.mock import Mock
        from aria_kernel.architecture_spine_gate import list_spine_events
        from aria_kernel.cycle import run_cycle
        from aria_kernel.memory import update_memory
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git

        repo = self.tmp / "source"
        schemas = repo / "libs/event-contracts/src/schemas"
        schemas.mkdir(parents=True)
        contracts = schemas.parent / "ordinary-events.ts"
        contracts.write_text(
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n"
            "export interface BetaEvent extends BaseEvent {}\n"
            "export interface GammaEvent extends BaseEvent {}\n",
            encoding="utf-8",
        )
        beta_schema = schemas / "beta_event.json"
        beta_schema.write_text('{"type":"object"}\n', encoding="utf-8")
        (repo / "package.json").write_text('{"name":"outer-fixture"}\n', encoding="utf-8")
        _git(["init", "-q"], cwd=repo)
        _git(["config", "user.email", "outer-fixture@aria.test"], cwd=repo)
        _git(["config", "user.name", "Outer Fixture"], cwd=repo)
        _git(["add", "-A"], cwd=repo)
        _git(["commit", "-q", "-m", "test: ordinary outer schema source"], cwd=repo)
        ensure_tools_binding(self.base, workspace_root=repo)
        plan_id = "ordinary-outer-schema-plan"
        observed: dict[str, Any] = {}

        def source_cycle(*, workspace_root, cycle_id, base_dir, defer_reflection=False):
            # Existing runner seam binds the native cycle's optional plan.
            # This proves consumption of its real result, not default outer
            # plan selection, which remains a separate production boundary.
            self.assertEqual(Path(workspace_root), repo)
            self.assertEqual(Path(base_dir), self.base)
            self.assertTrue(defer_reflection)
            observed["result"] = run_cycle(
                workspace_root=workspace_root, cycle_id=cycle_id, base_dir=base_dir,
                defer_reflection=defer_reflection, plan_id=plan_id,
                workspace_base=self.tmp / "cycle-workspaces", shadow_only=True,
                snapshot_mode="working-tree",
            )
            return observed["result"]

        def update_memory_then_edit(**kwargs):
            result = update_memory(**kwargs)
            (schemas / "alpha_event.json").write_text('{"type":"object"}\n', encoding="utf-8")
            beta_schema.unlink()
            return result

        native_runner = Mock(side_effect=source_cycle)
        planner = Mock(wraps=_fake_planner_drainer)
        worker = Mock(wraps=_fake_worker_drainer)
        synthesizer = Mock(return_value=None)
        with patch("aria_kernel.cycle.update_memory", side_effect=update_memory_then_edit) as memory_call:
            result = self._run(
                workspace_root=repo, cycle_runner=native_runner,
                planner_drainer=planner, worker_drainer=worker,
                plan_synthesizer=synthesizer,
            )

        native_runner.assert_called_once()
        native = observed["result"]
        cycle_id = native["cycle_id"]
        memory_call.assert_called_once_with(cycle_id=cycle_id, base_dir=self.base, workspace_root=repo)
        self.assertEqual(native["status"], "failed")
        self.assertEqual(native["runtime_status"], "ok")
        self.assertEqual(native["phase_failures"], ["architecture_postcheck"])
        self.assertTrue(native["artifact_integrity"]["valid"])
        self.assertEqual(native["non_ok_tools"], [])
        for phase in ("architecture_baseline", "memory", "architecture_postcheck"):
            self.assertEqual(native["phases"][phase], {"outcome": "ran"})
        spine = list_spine_events(plan_id=plan_id, base_dir=self.base)
        self.assertEqual([row["kind"] for row in spine], [
            "architecture_spine_baseline", "architecture_spine_regression",
        ])
        baseline, postcheck = [row["details"] for row in spine]
        self.assertEqual(postcheck["cycle_id"], cycle_id)
        self.assertEqual(baseline["cycle_id"], cycle_id)
        self.assertEqual(postcheck["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(postcheck["regression_count"], 1)
        prefix = "libs/event-contracts/src/ordinary-events.ts::"
        for measurement, names in (
            (baseline["invariant_measurements"]["event_contracts"], ["AlphaEvent", "GammaEvent"]),
            (postcheck["postcheck_measurements"]["event_contracts"], ["BetaEvent", "GammaEvent"]),
        ):
            self.assertEqual(measurement["source"], "static:_check_event_contracts")
            self.assertEqual(measurement["measurements"], {
                "declared_event_count": 3, "missing_schema_count": 2,
                "missing_schema_identities": [prefix + name for name in names],
            })
        cycles = [row for row in load_jsonl(self.base / "cycles.jsonl") if row.get("cycle_id") == cycle_id]
        self.assertEqual([row["event"] for row in cycles], ["started", "failed"])
        self.assertEqual(len(result["per_cycle"]), 1)
        self.assertEqual(result["per_cycle"][0]["cycle_id"], cycle_id)
        self.assertEqual(result["per_cycle"][0]["cycle"]["status"], "failed")

        self.assertEqual(result["cycles_completed"], 0, "A native failed terminal cannot count as outer success.")
        self.assertEqual(result["exit_reason"], "cycle_failed")
        self.assertFalse(result["exits_clean"])
        planner.assert_not_called()
        worker.assert_not_called()
        synthesizer.assert_not_called()
        transitions = [row for row in load_jsonl(autonomy_state_path(self.base))
                       if row.get("cycle_id") == cycle_id and row.get("phase") == "cycle_completed"]
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["status"], "failed")
        self.assertEqual(transitions[0]["details"]["summary"]["status"], "failed")

        from aria_kernel.runtime_artifacts import autonomy_output_summary

        summary = autonomy_output_summary(
            result, base_dir=self.base, workspace_root=repo,
        )
        self.assertEqual(summary["cycle_status_counts"], {"failed": 1})
        self.assertEqual(summary["overall_status"], "failed")
        self.assertEqual(summary["exit_code"], 1)
        self.assertEqual(summary["cycles_completed"], 0)
        self.assertEqual(summary["failed_phases"], [{"phase": "architecture_postcheck", "status": "failed"}])

    def test_native_clean_postcheck_preserves_outer_progression_and_summary(self) -> None:
        from unittest.mock import Mock
        from aria_kernel.architecture_spine_gate import list_spine_events
        from aria_kernel.cycle import run_cycle
        from aria_kernel.runtime_artifacts import autonomy_output_summary
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git

        repo = self.tmp / "clean-source"
        schemas = repo / "libs/event-contracts/src/schemas"
        schemas.mkdir(parents=True)
        (schemas.parent / "ordinary-events.ts").write_text(
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n", encoding="utf-8",
        )
        (schemas / "alpha_event.json").write_text('{"type":"object"}\n', encoding="utf-8")
        (repo / "package.json").write_text('{"name":"outer-clean-fixture"}\n', encoding="utf-8")
        _git(["init", "-q"], cwd=repo)
        _git(["config", "user.email", "outer-fixture@aria.test"], cwd=repo)
        _git(["config", "user.name", "Outer Fixture"], cwd=repo)
        _git(["add", "-A"], cwd=repo)
        _git(["commit", "-q", "-m", "test: ordinary clean outer source"], cwd=repo)
        ensure_tools_binding(self.base, workspace_root=repo)
        plan_id = "ordinary-clean-outer-plan"
        observed: dict[str, Any] = {}

        def source_cycle(*, workspace_root, cycle_id, base_dir, defer_reflection=False):
            self.assertEqual(Path(workspace_root), repo)
            self.assertEqual(Path(base_dir), self.base)
            self.assertTrue(defer_reflection)
            observed["result"] = run_cycle(
                workspace_root=workspace_root, cycle_id=cycle_id, base_dir=base_dir,
                defer_reflection=defer_reflection, plan_id=plan_id,
                workspace_base=self.tmp / "cycle-workspaces", shadow_only=True,
                snapshot_mode="working-tree",
            )
            return observed["result"]

        runner = Mock(side_effect=source_cycle)
        planner = Mock(wraps=_fake_planner_drainer)
        result = self._run(
            workspace_root=repo, cycle_runner=runner, planner_drainer=planner,
            plan_synthesizer=lambda **kwargs: None,
        )
        runner.assert_called_once()
        native = observed["result"]
        self.assertEqual(native["status"], "completed")
        self.assertEqual(native["runtime_status"], "ok")
        self.assertEqual(native["phase_failures"], [])
        self.assertTrue(native["artifact_integrity"]["valid"])
        self.assertEqual(native["phases"]["architecture_postcheck"], {"outcome": "ran"})
        rows = list_spine_events(plan_id=plan_id, base_dir=self.base)
        self.assertEqual([row["kind"] for row in rows], [
            "architecture_spine_baseline", "architecture_spine_postcheck",
        ])
        baseline, postcheck = [row["details"] for row in rows]
        self.assertEqual(postcheck["cycle_id"], native["cycle_id"])
        self.assertEqual(postcheck["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(postcheck["regression_count"], 0)
        self.assertEqual(postcheck["drifts"], [])
        self.assertEqual(native["architecture_postcheck"], postcheck)
        self.assertEqual(result["cycles_completed"], 1)
        self.assertEqual(result["exit_reason"], "max_cycles")
        self.assertTrue(result["exits_clean"])
        planner.assert_called_once()
        transitions = [row for row in load_jsonl(autonomy_state_path(self.base))
                       if row.get("phase") == "cycle_completed"]
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["status"], "ok")
        summary = autonomy_output_summary(result, base_dir=self.base, workspace_root=repo)
        self.assertEqual(summary["cycle_status_counts"], {"ok": 1})
        self.assertEqual(summary["overall_status"], "ok")
        self.assertEqual(summary["exit_code"], 0)

    def test_outer_cycle_status_contract_preserves_legacy_outputs_and_unknown(self) -> None:
        from unittest.mock import Mock
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        # (label, cycle fields, cycles_completed, projected status, autonomy-state
        # row status, overall summary status). ARIA-HIGH-098 — a claimed-ok cycle
        # carrying non-ok tools projects by the tools' CLASS: a tool-class entry
        # (budget, evidence, crash) is `degraded` and the run continues; a
        # store-class entry (a lost artifact) is `integrity_failed` and fails
        # closed. Pre-fix both were `failed`.
        cases = (
            ("terminal-only", {"status": "completed"}, 1, "ok", "ok", "ok"),
            ("runtime-only", {"runtime_status": "ok"}, 1, "ok", "ok", "ok"),
            ("both-clean", {"status": "completed", "runtime_status": "ok"}, 1, "ok", "ok", "ok"),
            ("unknown-terminal", {"status": "unknown", "runtime_status": "ok"}, 0, "unknown", "failed", "failed"),
            ("aborted-terminal", {"status": "aborted"}, 0, "aborted", "failed", "failed"),
            ("stopped-terminal", {"status": "stopped"}, 0, "stopped", "failed", "failed"),
            ("runtime-integrity", {"status": "failed", "runtime_status": "integrity_failed"}, 0, "integrity_failed", "failed", "failed"),
            ("non-ok-tool-class", {"status": "completed", "runtime_status": "ok", "non_ok_tools": [{"tool_id": "t", "status": "budget_exceeded", "artifact_status": "present"}]}, 1, "degraded", "degraded", "degraded"),
            ("non-ok-store-class", {"status": "completed", "runtime_status": "ok", "non_ok_tools": [{"tool_id": "t", "status": "ok", "artifact_status": "missing"}]}, 0, "integrity_failed", "failed", "failed"),
        )
        for label, fields, completed, projected, row_status, overall in cases:
            with self.subTest(result_shape=label):
                base = self.tmp / label
                set_profile("standard", operator_approval_ref="ordinary-status-contract", base_dir=base)

                def cycle_output(*, workspace_root, cycle_id, base_dir, defer_reflection=False):
                    self.assertEqual(Path(base_dir), base)
                    self.assertTrue(defer_reflection)
                    return {"schema_version": 2, "cycle_id": cycle_id, **fields}

                # These are legacy caller-result compatibility inputs, not
                # native detection or model execution. The separate native
                # test requires its actual producer before the failure oracle.
                planner = Mock(wraps=_fake_planner_drainer)
                result = self._run(
                    base_dir=base, cycle_runner=cycle_output,
                    planner_drainer=planner, plan_synthesizer=lambda **kwargs: None,
                )
                self.assertEqual(result["cycles_completed"], completed)
                self.assertEqual(result["exit_reason"], "max_cycles" if completed else "cycle_failed")
                self.assertEqual(result["exits_clean"], bool(completed))
                self.assertEqual(planner.call_count, completed)
                rows = [row for row in load_jsonl(autonomy_state_path(base))
                        if row.get("phase") == "cycle_completed"]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["status"], row_status)
                if label == "unknown-terminal":
                    self.assertEqual(rows[0]["details"]["summary"]["status"], "unknown")
                summary = autonomy_output_summary(result, base_dir=base)
                self.assertEqual(summary["cycle_status_counts"], {projected: 1})
                self.assertEqual(summary["overall_status"], overall)
                self.assertEqual(summary["exit_code"], {"ok": 0, "degraded": 2}.get(overall, 1))

    def test_terminal_failure_preserves_explicit_continue_policy(self) -> None:
        from unittest.mock import Mock
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        def cycle_output(*, workspace_root, cycle_id, base_dir, defer_reflection=False):
            return {"schema_version": 2, "cycle_id": cycle_id,
                    "status": "failed", "runtime_status": "ok"}

        # Existing opt-out governs progression, while the failed result remains
        # visible. This declared caller control is not a repair or provider run.
        planner = Mock(wraps=_fake_planner_drainer)
        result = self._run(
            cycle_runner=cycle_output, fail_closed_on_cycle_failure=False,
            planner_drainer=planner, plan_synthesizer=lambda **kwargs: None,
        )
        self.assertEqual(result["cycles_completed"], 0)
        self.assertEqual(result["exit_reason"], "max_cycles")
        self.assertTrue(result["exits_clean"])
        planner.assert_called_once()
        rows = [row for row in load_jsonl(autonomy_state_path(self.base))
                if row.get("phase") == "cycle_completed"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[0]["details"]["summary"]["status"], "failed")
        summary = autonomy_output_summary(result, base_dir=self.base)
        self.assertEqual(summary["cycle_status_counts"], {"failed": 1})
        self.assertEqual(summary["overall_status"], "failed")
        self.assertEqual(summary["exit_code"], 1)

    def _run_with_native_planner_source(self, *, adopted: bool) -> None:
        import hashlib
        import json
        from unittest.mock import Mock
        from aria_kernel import agent_invocations as ai
        from aria_kernel.cycle import _phase_discovery, _phase_twin_refresh, build_phase_context
        from aria_kernel.convergence_drainer import run_convergence_drainer
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.plan_convergence import content_hash, start_plan, plan_body_from_state
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.twin import read_twin_map
        from tests._helpers.git_fixtures import _git

        repo = self.tmp / "source"
        kernel = Path(__file__).resolve().parents[1]
        modules = ("runtime_artifacts", "knowledge_graph", "cycle_phases/memory", "cli", "autonomy_orchestrator",
                   "reflection_inputs", "reflection", "report", "snapshot", "discovery", "twin", "convergence_drainer",
                   "convergent_planning_bridge", "cross_review_bridge", "plan_convergence", "runtime_profile",
                   "agent_surface", "agent_network", "capability_gap", "state_manifest", "tool_registry", "agent_invocations")
        tests = ("test_runtime_artifacts", "test_autonomy_orchestrator", "test_learned_context_and_intent",
                 "test_twin_map", "test_phase2_fates_snapshot", "test_prompt_render_versioning", "test_convergence_resumable_step")
        for relative in [f"aria_kernel/{name}.py" for name in modules] + [f"tests/{name}.py" for name in tests] + ["pyproject.toml"]:
            destination = repo / "aria-kernel" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((kernel / relative).read_bytes())
        seed_reviewer_agent(repo)
        _git(["init", "-q"], cwd=repo)
        _git(["config", "user.email", "outer-fixture@aria.test"], cwd=repo)
        _git(["config", "user.name", "Outer Fixture"], cwd=repo)
        _git(["add", "-A"], cwd=repo)
        _git(["commit", "-q", "-m", "fixture: outer planner source inputs"], cwd=repo)
        head = _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()
        ensure_tools_binding(self.base, workspace_root=repo)
        owner = "aria-kernel/aria_kernel/knowledge_graph.py"
        body = {"schema_version": 1, "title": "Reuse the existing convention lookup",
                "summary": "PRIMARY_PROPOSAL_ONLY: reuse the existing owner.",
                "affected_surfaces": [owner],
                "key_changes": [{"id": "reuse-conventions", "description": "Reuse the existing lookup", "paths": [owner]}],
                # The opener refuses a seed whose commands the plan contract
                # does not admit (ARIA-HIGH-104), so the seed declares the suite.
                "validation_commands": [{"cmd": "nx affected --target=test"}],
                "evidence_refs": [owner + ":1"]}
        if adopted:
            body["affected_surfaces"] = [owner, "aria-kernel/aria_kernel/runtime_artifacts.py"]
            start_plan(plan_id="plan-adopted", initial_revision_id="rev-existing", plan_content=body, base_dir=self.base)
        fresh_seed = {**body, "summary": "A separate freshly synthesized proposal.",
                      "affected_surfaces": [owner],
                      "evidence_refs": ["aria-kernel/aria_kernel/runtime_artifacts.py:1"]} if adopted else body
        observed = {}

        def source_cycle(*, workspace_root, cycle_id, base_dir, defer_reflection=False):
            self.assertTrue(defer_reflection)
            self.assertEqual(Path(workspace_root), repo)
            self.assertEqual(Path(base_dir), self.base)
            context = build_phase_context(cycle_id=cycle_id, workspace_root=workspace_root,
                                          base_dir=base_dir, snapshot_mode="committed")
            context.results["discovery"] = _phase_discovery(context)
            observed.update(cycle_id=cycle_id, discovery=context.results["discovery"], twin=_phase_twin_refresh(context))
            return {"schema_version": 2, "cycle_id": cycle_id, "status": "completed"}

        def synthesize(*, cycle_id, workspace_root, base_dir):
            self.assertEqual(cycle_id, observed["cycle_id"])
            self.assertEqual(Path(workspace_root), repo)
            self.assertEqual(Path(base_dir), self.base)
            return fresh_seed

        blocked = Mock(side_effect=AssertionError("Nonconverged source inspection must not dispatch implementation/review/merge"))
        blocked.profile = "standard"
        result = self._run(workspace_root=repo, cycle_runner=source_cycle, plan_synthesizer=synthesize,
                           convergence_runner=run_convergence_drainer,
                           planner_drainer=lambda **kwargs: {"iterations": 0, "claims_dispatched": 0, "exits_clean": True, "exit_reason": "no_requests"},
                           worker_drainer=blocked, auto_merge_runner=blocked, review_runner=blocked,
                           specialist_review_runner=blocked)
        blocked.assert_not_called()
        self.assertEqual(result["cycles_completed"], 1)
        self.assertEqual(result["exit_reason"], "max_cycles")
        self.assertEqual(len(result["per_cycle"]), 1)
        outer = result["per_cycle"][0]
        cycle_id = outer["cycle_id"]
        self.assertEqual(cycle_id, observed["cycle_id"])
        self.assertEqual(outer["convergence"]["arbiter_verdict"], "in_progress")
        self.assertEqual(outer["dispatch_blocked_reason"], "convergence_in_progress")
        plan_id = "plan-adopted" if adopted else "plan-" + cycle_id
        self.assertEqual(outer["convergence"]["plan_id"], plan_id)
        state = fold_plan_state(plan_id=plan_id, base_dir=self.base)
        self.assertEqual(sum(row["event_type"] == "plan_started" for row in state["events"]), 1)
        self.assertEqual(plan_body_from_state(state)["plan_content"], body)
        requests = load_declared_jsonl(self.base / "agent-invocations/requests.jsonl", expected_surface="agent_invocation_requests")
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual((request["role"], request["target_agent"], request["round_number"]),
                         ("challenger_plan", "aria-challenger-planner", 1))
        self.assertEqual(request["convergence_id"], plan_id)
        self.assertEqual(request["cycle_id"], cycle_id)
        self.assertEqual(request["target_sha"], head)
        self.assertEqual(request["plan_revision_hash"], content_hash(body))
        self.assertEqual(request["evidence_refs"], body["evidence_refs"])
        self.assertEqual(request["allowed_scope"], fresh_seed["affected_surfaces"])
        self.assertEqual(request["context_source_paths"], body["affected_surfaces"])
        if adopted:
            self.assertNotEqual(request["context_source_paths"], request["allowed_scope"])
        native = ai.verify_invocation_context_binding(request_id=request["request_id"], context_hash=request["context_hash"],
                                                     prompt_hash=request["prompt_hash"], base_dir=self.base)
        self.assertEqual(native["context"]["repo_root"], str(repo.resolve()))
        for label in ("context", "prompt"):
            self.assertEqual(native[label]["ledger_hash"], request[label + "_ledger_hash"])
        self.assertEqual(native["context"]["budget_audit_hash"], request["budget_audit_hash"])
        prompt = native["prompt"]["prompt_text"]
        self.assertEqual(request["prompt_hash"], "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest())
        self.assertEqual(prompt, ai.render_invocation_prompt(request))
        self.assertEqual(prompt, ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)))
        self.assertNotIn("PRIMARY_PROPOSAL_ONLY", prompt)
        view = request["repository_map"]["self_features"]
        self.assertEqual(view["qualification"]["status"], "available")
        self.assertEqual(view["discovery"]["cycle_id"], cycle_id)
        feature = view["features"]["knowledge_graph.conventions_for_paths"]
        self.assertIn("knowledge_graph.conventions_for_paths", prompt)
        self.assertEqual(feature["demonstrated"]["status"], "unknown")
        self.assertEqual(feature["runtime"]["status"], "unknown")
        for filename, key in (("SNAPSHOT.json", "snapshot"), ("COMPLETION_PROOF.json", "completion_proof")):
            stored = json.loads((self.base / "discovery" / cycle_id / filename).read_text())
            self.assertEqual(stored, observed["discovery"][key])
        self.assertTrue(observed["discovery"]["completion_proof"]["complete"])
        self.assertEqual(read_twin_map(base_dir=self.base)["self_features"], observed["twin"]["self_features"])

    def test_outer_cycle_reaches_real_challenger_with_discovery_context(self) -> None:
        self._run_with_native_planner_source(adopted=False)

    def test_outer_adopted_plan_uses_recorded_body_with_unchanged_caller_scope(self) -> None:
        self._run_with_native_planner_source(adopted=True)

    def _run_with_real_memory(
        self, *, plan_state: str = "converged", signer: str = "cycle",
    ) -> dict[str, Any]:
        """Real MemoryHookImpl under the orchestrator's `standard` profile.

        ``signer="cycle"`` lets the B7 knowledge seam mint the cycle's real
        key, so the CONVERGED plan's hypothesis is signed in this cycle.
        ``signer="unavailable"`` makes the mint fail the way a host without
        ssh-keygen fails: the seam records `knowledge_signer_mint_failed`
        and the hook takes its `needs_signing` disclosure path, which is the
        pending-observation contract the reporting tests pin.
        """
        from contextlib import ExitStack
        from aria_kernel import gh_token_factory
        from aria_kernel.cycle_phases import select_memory_hook
        from aria_kernel.plan_convergence import start_plan

        seed_reviewer_agent(self.tmp)
        plan_content = {
            "schema_version": 1,
            "title": "Canonical memory fixture",
            "summary": "Read the plan whose reviewed revision is in the ledger.",
            "affected_surfaces": ["fixture/canonical.py"],
            "key_changes": [{"id": "memory-owner", "description": "Refactor the memory owner",
                             "paths": ["fixture/canonical.py"]}],
            # Driven to CONVERGED through the real gate, so the body carries
            # what the plan contract requires of a converging body.
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": [f"fixture/canonical.py:{line}" for line in range(1, 6)],
            "architectural_tier": 2,
        }

        def converge(**kwargs: Any) -> dict[str, Any]:
            plan_id = kwargs["plan_id"]
            if plan_state in {"converged", "tampered"}:
                drive_plan_to_converged(
                    plan_id=plan_id, tools=self.base, workspace_root=self.tmp,
                    plan_content=plan_content,
                )
            elif plan_state == "started":
                start_plan(plan_id=plan_id, initial_revision_id="rev-0",
                           plan_content=plan_content, base_dir=self.base)
            if plan_state == "tampered":
                ledger = self.base / "plans" / "events.jsonl"
                ledger.write_text(
                    ledger.read_text(encoding="utf-8").replace(
                        "Canonical memory fixture", "Tampered memory fixture"
                    ), encoding="utf-8",
                )
            # The envelope is deliberately not a second plan-body source.
            result = _fake_convergence_runner(**kwargs)
            result.pop("converged_plan")
            return result

        with ExitStack() as stack:
            if signer == "unavailable":
                stack.enter_context(patch.object(
                    gh_token_factory, "mint_signing_key",
                    side_effect=RuntimeError("ssh-keygen not on PATH; fixture host"),
                ))
            return self._run(
                convergence_runner=converge,
                memory_hook=select_memory_hook(profile="standard"),
            )

    def test_standard_profile_signs_the_converged_hypothesis_in_the_same_cycle(self) -> None:
        """B7 — the integration proof for the live defect.

        Every live run was `standard`, and `knowledge-graph/conventions.jsonl`
        was never created because the only signer lived in the V9 runner
        that `pr_create` selects. The real orchestrator seam, the real
        MemoryHookImpl and a real ed25519 key: the row lands in the cycle
        that converged, carries the cycle's fingerprint, verifies, and the
        key is gone afterwards.
        """
        import json
        from aria_kernel.knowledge_graph import verify_chain_or_quarantine
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        result = self._run_with_real_memory()
        self.assertTrue(result["exits_clean"])
        summary = result["per_cycle"][0]
        memory = summary["memory_hook"]
        # Pre-seam this read "needs_signing" on every standard cycle.
        self.assertEqual(memory["status"], "memory_hook_recorded")
        self.assertTrue(memory["convention_recorded"])
        self.assertTrue(memory["chain_verified"])
        signer = summary["knowledge_signer"]
        self.assertEqual(signer["status"], "minted")
        self.assertEqual(signer["signer_cycle_id"], summary["cycle_id"])
        self.assertTrue(signer["signer_key_fp"].startswith("SHA256:"))
        self.assertEqual(memory["signer_cycle_id"], summary["cycle_id"])
        self.assertEqual(memory["signer_key_fp"], signer["signer_key_fp"])
        self.assertEqual(memory["plan_revision_id"], "rev-0")
        # The V9 runner is the NoOp under standard; that no longer decides
        # whether the cycle may remember what it converged on.
        self.assertEqual(summary["v9_implementation"]["rejection_class"], "no_op_v9_runner")
        self.assertEqual(summary["memory_completion"]["status"], "completed")
        self.assertEqual(summary["memory_completion"]["attempted"], 0)

        path = self.base / "knowledge-graph" / "conventions.jsonl"
        rows = load_jsonl(path)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["signer_key_fp"], signer["signer_key_fp"])
        self.assertEqual(row["discovered_by_cycle_id"], summary["cycle_id"])
        self.assertEqual(row["plan_id"], summary["convergence"]["plan_id"])
        self.assertEqual(row["outcome_status"], "hypothesis")
        self.assertEqual(row["confidence"], 0.5)
        self.assertEqual(verify_chain_or_quarantine(path), (True, 1))
        self.assertTrue(path.exists(), "verification must not quarantine a valid chain")

        governance = load_jsonl(self.base / "governance.jsonl")
        kinds = [r.get("kind") for r in governance]
        self.assertNotIn("memory_hook_failed", kinds)
        self.assertNotIn("knowledge_signer_mint_failed", kinds)
        self.assertNotIn("convention_record_needs_signing", kinds)
        recorded = [r["details"] for r in governance if r.get("kind") == "convention_recorded"]
        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["signer_key_fp"], signer["signer_key_fp"])
        self.assertEqual(recorded[0]["signer_cycle_id"], summary["cycle_id"])
        transitions = [r for r in load_jsonl(autonomy_state_path(self.base))
                       if r.get("phase") == "memory_hook_recorded"]
        self.assertEqual(transitions[-1]["details"]["knowledge_signer"], "minted")
        self.assertEqual(transitions[-1]["details"]["signer_key_fp"], signer["signer_key_fp"])
        # The key did not outlive the cycle.
        for suffix in ("", ".pub", ".token"):
            self.assertFalse((self.tmp / "aria-debts" / "keys" / (summary["cycle_id"] + suffix)).exists())
        # And the public summary discloses the signed result, not a pending one.
        encoded = json.dumps(autonomy_output_summary(result, base_dir=self.base, workspace_root=self.tmp), sort_keys=True)
        self.assertIn('"memory_hook_recorded"', encoded)
        self.assertIn(signer["signer_key_fp"], encoded)
        self.assertNotIn("needs_signing", encoded)

    def test_selected_memory_discloses_needs_signing_when_the_cycle_signer_is_unavailable(self) -> None:
        """The disclosure path is reached only when there really is no signer."""
        result = self._run_with_real_memory(signer="unavailable")
        summary = result["per_cycle"][0]
        self.assertEqual(summary["knowledge_signer"], {
            "status": "mint_failed", "signer_cycle_id": None,
            "signer_key_fp": None, "error_class": "RuntimeError",
        })
        memory = summary["memory_hook"]
        self.assertEqual(memory["status"], "needs_signing")
        self.assertFalse(memory["convention_recorded"])
        self.assertIsNone(memory["chain_verified"])
        self.assertIsNone(memory["signer_key_fp"])
        self.assertEqual(memory["plan_revision_id"], "rev-0")
        self.assertTrue(memory["plan_content_hash"].startswith("sha256:"))
        self.assertIsNotNone(memory["pattern_signature"])
        self.assertEqual(summary["memory_completion"], {"status": "not_attempted"})
        governance = load_jsonl(self.base / "governance.jsonl")
        self.assertFalse(any(row.get("kind") == "memory_hook_failed" for row in governance))
        failed = [row["details"] for row in governance if row.get("kind") == "knowledge_signer_mint_failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["cycle_id"], summary["cycle_id"])
        self.assertEqual(failed[0]["error_class"], "RuntimeError")
        pending = [row for row in governance if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["details"]["plan_content_hash"], memory["plan_content_hash"])
        self.assertFalse((self.base / "knowledge-graph" / "conventions.jsonl").exists())

    def test_pending_memory_reaches_real_operator_summary(self) -> None:
        """The public summary must disclose the real outer memory result."""
        import json
        from aria_kernel.runtime_artifacts import (
            SUMMARY_STDOUT_MAX_BYTES,
            autonomy_output_summary,
        )

        result = self._run_with_real_memory(signer="unavailable")
        outer = result["per_cycle"][0]
        memory = outer["memory_hook"]
        self.assertEqual(memory["status"], "needs_signing")
        self.assertFalse(memory["convention_recorded"])
        pending = [row["details"] for row in load_jsonl(self.base / "governance.jsonl")
                   if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["plan_content_hash"], memory["plan_content_hash"])

        full = autonomy_output_summary(
            result, result_detail="full", base_dir=self.base, workspace_root=self.tmp,
        )
        self.assertEqual(full["full_result"]["per_cycle"][0]["memory_hook"], memory)
        summary = autonomy_output_summary(
            result, base_dir=self.base, workspace_root=self.tmp,
        )
        self.assertNotIn("full_result", summary)
        encoded = json.dumps(summary, sort_keys=True)
        self.assertLessEqual(len(encoded.encode("utf-8")), SUMMARY_STDOUT_MAX_BYTES)
        # Require the status value, not a governance-kind substring such as
        # convention_record_needs_signing. The receipt must identify its source.
        self.assertIn('"needs_signing"', encoded)
        self.assertIn('"convention_recorded": false', encoded)
        for value in (outer["cycle_id"], pending[0]["plan_id"], memory["plan_content_hash"]):
            self.assertIn(value, encoded)

    def test_pending_memory_reaches_persisted_reflection_and_daily_report(self) -> None:
        """Post-drain reflection must carry the pending observation itself."""
        import json

        result = self._run_with_real_memory(signer="unavailable")
        outer = result["per_cycle"][0]
        memory = outer["memory_hook"]
        self.assertEqual(memory["status"], "needs_signing")
        self.assertFalse(memory["convention_recorded"])
        reflection = outer["reflection"]
        self.assertEqual(reflection["cycle_id"], outer["cycle_id"])
        persisted = [row for row in load_jsonl(self.base / "reflections.jsonl")
                     if row.get("cycle_id") == outer["cycle_id"]]
        self.assertEqual(len(persisted), 1)
        report_path = self.base / "reports/daily" / (reflection["recorded_at"][:10] + ".md")
        report = report_path.read_text(encoding="utf-8")

        with self.subTest(output="persisted_reflection"):
            encoded = json.dumps(persisted[0], sort_keys=True)
            self.assertIn('"needs_signing"', encoded)
            self.assertIn('"convention_recorded": false', encoded)
            self.assertIn(memory["plan_content_hash"], encoded)
        with self.subTest(output="daily_report"):
            # Gate Activity can already mention the governance event kind;
            # it is not a cycle-bound observation receipt or completion report.
            heading = "## Memory Learning\n"
            self.assertIn(heading, report)
            section = report.split(heading, 1)[1].split("\n## ", 1)[0]
            self.assertIn("needs_signing", section)
            self.assertIn(outer["cycle_id"], section)
            self.assertIn(memory["plan_content_hash"], section)

    def test_memory_projection_survives_persisted_reflection_to_local_anchor(self) -> None:
        import json
        from aria_kernel.report import emit_anchor_to_path
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        result = self._run_with_real_memory(signer="unavailable")
        outer = result["per_cycle"][0]
        projection = autonomy_output_summary(result, base_dir=self.base, workspace_root=self.tmp)["memory_learning"]
        initial = projection["cycles"][0]["initial"]
        self.assertEqual(initial["status"], "needs_signing")
        self.assertIs(initial["convention_recorded"], False)
        self.assertIsNone(initial["chain_verified"])
        self.assertEqual(initial["cycle_id"], outer["cycle_id"])
        self.assertEqual(initial["plan_id"], outer["convergence"]["plan_id"])
        self.assertEqual(initial["plan_content_hash"], outer["memory_hook"]["plan_content_hash"])
        self.assertEqual(projection["reported_observation_counts"]["recorded_receipts"], 0)
        self.assertEqual(outer["reflection"]["memory_learning"], projection)
        persisted = [row for row in load_jsonl(self.base / "reflections.jsonl") if row.get("cycle_id") == outer["cycle_id"]]
        self.assertEqual(len(persisted), 1)
        self.assertEqual(persisted[0]["memory_learning"], projection)

        day = outer["reflection"]["recorded_at"][:10]
        report = (self.base / "reports/daily" / (day + ".md")).read_text(encoding="utf-8")
        section = report.split("## Memory Learning\n", 1)[1].split("\n## ", 1)[0]
        self.assertEqual(json.loads(section.split("```json\n", 1)[1].split("```", 1)[0]), projection)
        anchor = self.tmp / "published-locally" / (day + ".md")
        emitted = emit_anchor_to_path(date=day, workspace_root=self.tmp, tools_root=self.base, output_path=anchor)
        self.assertEqual(emitted["report_body"], "reflection")
        # The existing publisher normalizes only outer body whitespace.
        published_body = anchor.read_text(encoding="utf-8").split("\n---\n\n", 1)[1]
        self.assertEqual(published_body, report.strip() + "\n")
        before = anchor.read_bytes()
        replay = emit_anchor_to_path(date=day, workspace_root=self.tmp, tools_root=self.base, output_path=anchor)
        self.assertEqual(replay["status"], "already_anchored")
        self.assertEqual(anchor.read_bytes(), before)

    def _run_with_selected_memory_signer(
        self, *, profile: str, cycles: int = 1, mint_failures: int = 0,
        action_permissions: dict | None = None, acquired: list[dict] | None = None,
    ) -> tuple[dict, Path, list[dict]]:
        """The real orchestrator seam with the production-selected hooks.

        B7 — the knowledge signer is minted by the orchestrator's own seam
        for every profile holding `knowledge_record`, before the memory
        hook records, so no `needs_signing` disclosure precedes the key.
        ``mint_failures`` makes the first N mints fail the way a host
        without ssh-keygen fails, which is how a pending disclosure is
        produced for the replay path. ``action_permissions`` substitutes
        the runtime table so a profile can be stripped of the cell.
        ``acquired`` lets the caller watch the keys as they are minted
        (cycle id + fingerprint), so a fixture can tell one cycle's signer
        from the next while the run is still going.
        """
        import os
        import subprocess
        from contextlib import ExitStack

        from aria_kernel import gh_token_factory, validation
        from aria_kernel.cycle_phases import select_memory_hook, select_v9_implementation_runner
        from aria_kernel.tools_binding import bind_tools_root
        from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit
        from tests._helpers.production_shaped import production_converged_plan

        source_path = "apps/farm-service/src/farm/services/water-quality.service.ts"
        workspace = make_repo_with_initial_commit(
            self.tmp, name="source",
            files={
                source_path: "export const interval = 60000;\n",
                "docs/aria/SPEC.md": "one\ntwo\nthree\nfour\nfive\n",
                ".gitignore": "/aria-debts/keys/\n/aria-tools/\n",
            },
        )
        bind_tools_root(tools_dir=self.base, workspace_root=workspace, reason="signer handoff fixture")
        set_profile(
            profile, operator_approval_ref="test:memory-signer-owner",
            set_by="operator", scheduler_ceiling=profile, base_dir=self.base,
        )
        acquired = [] if acquired is None else acquired
        mints_remaining_to_fail = mint_failures

        def converge(**kwargs: Any) -> dict[str, Any]:
            plan = production_converged_plan(
                tools_dir=self.base, workspace_root=workspace, plan_id=kwargs["plan_id"],
                affected_paths=[source_path],
                evidence_refs=[f"docs/aria/SPEC.md:{line}" for line in range(1, 6)],
            )
            # The helper installs its reviewer. Commit that fixture source
            # before the real runner acquires its key and validates HEAD.
            if _git(["status", "--porcelain", "--", ".claude/agents/farm-expert.md"], cwd=workspace).stdout:
                _git(["add", ".claude/agents/farm-expert.md"], cwd=workspace)
                _git(["commit", "-q", "-m", "fixture: reviewed plan owner"], cwd=workspace)
            result = _fake_convergence_runner(**kwargs)
            result["convergence_id"] = plan.revision_id
            result.pop("converged_plan")
            return result

        real_mint = gh_token_factory.mint_signing_key

        def mint_key(*, cycle_id: str, workspace_root: Path):
            nonlocal mints_remaining_to_fail
            self.assertEqual(workspace_root, workspace)
            if mints_remaining_to_fail > 0:
                mints_remaining_to_fail -= 1
                raise RuntimeError("ssh-keygen not on PATH; fixture host")
            key = real_mint(cycle_id=cycle_id, workspace_root=workspace_root)
            self.assertTrue(key.private_key_path.is_relative_to(workspace))
            self.assertTrue(key.private_key_path.is_file())
            self.assertTrue(key.public_key_path.is_file())
            # The cycle's ONE mint in this process is the knowledge seam's,
            # BEFORE the memory hook records: this cycle has disclosed
            # nothing yet, and its plan is CONVERGED. The V9 runner mints
            # nothing (ARIA-HIGH-115): the implementer's identity is the
            # executor child's, in the request worktree.
            self.assertFalse(any(item["cycle_id"] == cycle_id for item in acquired),
                             "one mint per cycle in the orchestrator process: the knowledge seam's")
            pending = [row for row in load_jsonl(self.base / "governance.jsonl")
                       if row.get("kind") == "convention_record_needs_signing"]
            self.assertEqual([row for row in pending if row["details"]["cycle_id"] == cycle_id], [])
            state = fold_plan_state(plan_id="plan-" + cycle_id, base_dir=self.base)
            self.assertEqual(state["state"], "CONVERGED")
            acquired.append({"cycle_id": cycle_id, "fingerprint": key.fingerprint})
            return key

        def mint_token(*, cycle_id: str, workspace_root: Path):
            # The delivery token is the spawn's (`delivery_credentials`), and
            # this process spawns no implementer: a runner that reached for a
            # token here again would fail by name (ARIA-HIGH-115).
            raise AssertionError("the orchestrator process mints no installation token")

        # ARIA-HIGH-124 (round 4) — the substitute is the runner's ONE spawn
        # seam (`validation._run_to_completion`, which leads its own process
        # group so a timeout kills the whole tree), not the module's
        # `subprocess.run`: every validation child goes through it, and the
        # module's git calls stay real without an argv test.
        real_spawn = validation._run_to_completion
        # The canonical suite staging runs as baseline, read from its one
        # tuple (ARIA-HIGH-104 (2) grew it) rather than enumerated here.
        from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

        validation_children = {tuple(command.split()) for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE}

        def child_run(argv, **kwargs):
            # Preserve real Git, ssh-keygen, validation records, staging and
            # envelope minting. The expensive validation children are fixtures.
            command = tuple(str(arg) for arg in argv)
            if command in validation_children:
                return subprocess.CompletedProcess(argv, 0, "fixture validation\n", "")
            if command and command[0] in {"npx", "npm", "cargo", "gh"}:
                raise AssertionError("unexpected external child in signer handoff fixture")
            return real_spawn(argv, **kwargs)

        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"GH_TOKEN": "", "GITHUB_TOKEN": ""}))
            stack.enter_context(patch.object(gh_token_factory, "mint_signing_key", side_effect=mint_key))
            stack.enter_context(patch.object(gh_token_factory, "mint_installation_token", side_effect=mint_token))
            stack.enter_context(patch.object(validation, "_run_to_completion", side_effect=child_run))
            if action_permissions is not None:
                stack.enter_context(patch("aria_kernel.runtime_profile.ACTION_PERMISSIONS", action_permissions))
            result = self._run(
                workspace_root=str(workspace), profile=profile,
                max_cycles=cycles,
                convergence_runner=converge,
                memory_hook=select_memory_hook(profile=profile),
                v9_implementation_runner=select_v9_implementation_runner(profile=profile),
            )
        return result, workspace, acquired

    def _assert_keys_revoked(self, workspace: Path, cycle_ids: list[str]) -> None:
        for cycle_id in cycle_ids:
            for suffix in ("", ".pub", ".token"):
                self.assertFalse((workspace / "aria-debts/keys" / (cycle_id + suffix)).exists())

    def test_strict_signs_the_hypothesis_and_the_runner_mints_no_identity(self) -> None:
        """B7 + ARIA-HIGH-115 — under `pr_create` the seam signs the row with
        the cycle's knowledge key, and the V9 runner mints NOTHING.

        The runner used to re-mint the seam's identity and revoke it in its
        `finally` — before the implementer had been claimed, so the key
        never reached the commit it was for. The implementer's identity is
        the executor child's, minted in the request worktree; this process
        holds exactly one key, the seam's, and registers exactly one.
        """
        from aria_kernel.knowledge_graph import lookup_pattern

        result, workspace, acquired = self._run_with_selected_memory_signer(profile="strict")
        self.assertTrue(result["exits_clean"])
        summary = result["per_cycle"][0]
        self.assertEqual(summary["v9_implementation"]["terminal_state"], "IMPLEMENTATION_DISPATCHED")
        self.assertIsNone(summary["v9_implementation"]["rejection_class"])
        governance = load_jsonl(self.base / "governance.jsonl")
        self.assertFalse(any(row.get("kind") in {
            "memory_hook_failed", "v9_implementation_phase_failed",
            "knowledge_signer_mint_failed", "convention_record_needs_signing",
        } for row in governance))
        # The seam minted once; the runner minted nothing.
        self.assertEqual([item["cycle_id"] for item in acquired], [summary["cycle_id"]])
        fingerprint = acquired[0]["fingerprint"]
        self.assertEqual(summary["knowledge_signer"]["signer_key_fp"], fingerprint)
        self.assertEqual(summary["memory_hook"]["status"], "memory_hook_recorded")
        self.assertEqual(summary["memory_hook"]["signer_key_fp"], fingerprint)
        self.assertEqual(summary["memory_completion"]["status"], "completed")
        self.assertEqual(summary["memory_completion"]["attempted"], 0)
        plan_id = summary["convergence"]["plan_id"]
        self.assertEqual(fold_plan_state(plan_id=plan_id, base_dir=self.base)["state"],
                         "IMPLEMENTATION_REQUESTED")
        self._assert_keys_revoked(workspace, [summary["cycle_id"]])
        for ledger in ("conventions.jsonl", "anti-patterns.jsonl"):
            self.assertFalse((workspace / "aria-tools/knowledge-graph" / ledger).exists())

        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1, "the cycle signer must record the hypothesis in its own cycle")
        self.assertEqual(rows[0]["outcome_status"], "hypothesis")
        self.assertEqual(rows[0]["confidence"], 0.5)
        self.assertEqual(rows[0]["plan_id"], plan_id)
        self.assertEqual(rows[0]["discovered_by_cycle_id"], summary["cycle_id"])
        self.assertEqual(rows[0]["signer_key_fp"], fingerprint)
        self.assertIsNone(lookup_pattern(rows[0]["pattern_id"], base_dir=self.base))

    def test_standard_signs_the_hypothesis_without_implementation_authority(self) -> None:
        """B7 — the live defect, under the production-selected hooks.

        `standard` selects the NoOp V9 runner and used to leave the memory
        hook signer-less forever. The seam mints the key from the
        `knowledge_record` cell, the hook signs the row, the key is revoked.
        """
        result, workspace, acquired = self._run_with_selected_memory_signer(profile="standard")
        self.assertTrue(result["exits_clean"])
        summary = result["per_cycle"][0]
        self.assertEqual(summary["v9_implementation"]["rejection_class"], "no_op_v9_runner")
        self.assertEqual(len(acquired), 1)
        fingerprint = acquired[0]["fingerprint"]
        self.assertEqual(summary["knowledge_signer"]["status"], "minted")
        self.assertEqual(summary["knowledge_signer"]["signer_key_fp"], fingerprint)
        self.assertEqual(summary["memory_hook"]["status"], "memory_hook_recorded")
        self.assertTrue(summary["memory_hook"]["convention_recorded"])
        self.assertTrue(summary["memory_hook"]["chain_verified"])
        self.assertEqual(summary["memory_hook"]["signer_key_fp"], fingerprint)
        self._assert_keys_revoked(workspace, [summary["cycle_id"]])
        for ledger in ("conventions.jsonl", "anti-patterns.jsonl"):
            self.assertFalse((workspace / "aria-tools/knowledge-graph" / ledger).exists())
        pending = [row for row in load_jsonl(self.base / "governance.jsonl")
                   if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(pending, [])
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["signer_key_fp"], fingerprint)
        self.assertEqual(rows[0]["discovered_by_cycle_id"], summary["cycle_id"])
        self.assertEqual(rows[0]["plan_id"], summary["convergence"]["plan_id"])
        # The key files are revoked; the row's fingerprint still resolves to
        # the registered public key of THIS cycle, and re-derives to itself.
        from aria_kernel.knowledge_graph import lookup_convention_signer, verify_convention_signer
        self.assertTrue(verify_convention_signer(rows[0], base_dir=self.base))
        self.assertEqual(lookup_convention_signer(fingerprint, base_dir=self.base)["cycle_id"], summary["cycle_id"])

    def test_profile_without_knowledge_record_keeps_memory_unsigned(self) -> None:
        """B7 — the seam follows the table, not the profile name.

        Strip `standard` of `knowledge_record` in the runtime table only:
        no key is minted, the hook discloses `needs_signing`, nothing is
        appended, and the replay is not attempted.
        """
        from aria_kernel.runtime_profile import ACTION_PERMISSIONS
        narrowed = dict(ACTION_PERMISSIONS)
        narrowed["knowledge_record"] = frozenset({"strict", "autonomous"})
        result, workspace, acquired = self._run_with_selected_memory_signer(
            profile="standard", action_permissions=narrowed,
        )
        self.assertTrue(result["exits_clean"])
        summary = result["per_cycle"][0]
        self.assertEqual(acquired, [])
        self.assertEqual(summary["knowledge_signer"], {
            "status": "not_permitted", "signer_cycle_id": None,
            "signer_key_fp": None, "error_class": None,
        })
        self.assertEqual(summary["memory_hook"]["status"], "needs_signing")
        self.assertFalse(summary["memory_hook"]["convention_recorded"])
        self.assertIsNone(summary["memory_hook"]["signer_key_fp"])
        self.assertEqual(summary["memory_completion"], {"status": "not_attempted"})
        self.assertFalse((workspace / "aria-debts/keys").exists())
        pending = [row for row in load_jsonl(self.base / "governance.jsonl")
                   if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["details"]["plan_content_hash"],
                         summary["memory_hook"]["plan_content_hash"])
        self.assertFalse((self.base / "knowledge-graph/conventions.jsonl").exists())

    def _run_signed_memory_with_failing_audits(self, failing_kinds: set[str]) -> tuple[dict, Path, list[dict], str]:
        from aria_kernel import apply_engine, tool_registry
        append = tool_registry.append_tools_governance
        sentinel = "harmless-private-diagnostic-sentinel"

        def audit(base, kind, details, **kwargs):
            if kind in failing_kinds:
                raise OSError(sentinel)
            return append(base, kind, details, **kwargs)

        with (
            patch.object(tool_registry, "append_tools_governance", side_effect=audit),
            patch.object(apply_engine, "stage_converged_plan_for_pr", side_effect=RuntimeError("fixture stage failure")),
        ):
            result, workspace, acquired = self._run_with_selected_memory_signer(profile="strict")
        return result, workspace, acquired, sentinel

    def test_signed_memory_survives_runner_and_scoped_audit_failure(self) -> None:
        """The append is the truth; a failed audit of it does not unrecord it,
        and a V9 phase failure in the same cycle leaves the signed row alone."""
        import json
        result, workspace, acquired, sentinel = self._run_signed_memory_with_failing_audits(
            {"convention_recorded", "v9_implementation_phase_failed"},
        )
        self.assertTrue(result["exits_clean"])
        summary = result["per_cycle"][0]
        self.assertEqual(summary["memory_hook"]["status"], "convention_audit_failed")
        self.assertTrue(summary["memory_hook"]["convention_recorded"])
        self.assertTrue(summary["memory_hook"]["chain_verified"])
        self.assertEqual(summary["memory_hook"]["signer_key_fp"], acquired[0]["fingerprint"])
        self.assertEqual(summary["memory_completion"]["status"], "completed")
        self.assertEqual(summary["memory_completion"]["attempted"], 0)
        self.assertEqual(summary["v9_implementation"]["terminal_state"], "IMPLEMENTATION_REQUEST_REFUSED")
        self.assertEqual(summary["v9_implementation"]["rejection_class"], "runner_exception:RuntimeError")
        self.assertEqual(summary["v9_implementation"]["specialist_review_signal"], "review_converged_plan")
        self.assertEqual(summary["v9_implementation"]["audit_error_class"], "OSError")
        self.assertNotIn(sentinel, json.dumps(summary))
        audits = [row for row in load_jsonl(self.base / "governance.jsonl")
                  if str(row.get("kind")).startswith("convention_")]
        self.assertEqual([row["kind"] for row in audits], ["convention_audit_failed"])
        self.assertEqual(audits[0]["details"]["signer_key_fp"], acquired[0]["fingerprint"])
        self.assertEqual(len(load_jsonl(self.base / "knowledge-graph/conventions.jsonl")), 1)
        # One mint in this process: the seam's. The V9 runner mints nothing
        # (ARIA-HIGH-115), so a runner failure has no key of its own to lose.
        self.assertEqual(len(acquired), 1)
        self._assert_keys_revoked(workspace, [summary["cycle_id"]])

    def test_signed_memory_row_survives_when_both_audits_fail_and_the_hook_escapes(self) -> None:
        """The direct hook propagates when BOTH audit writes fail (its own
        pinned contract); the orchestrator records memory_hook_failed, the
        appended row is still there, and the key is still revoked."""
        import json
        result, workspace, acquired, sentinel = self._run_signed_memory_with_failing_audits(
            {"convention_recorded", "convention_audit_failed", "v9_implementation_phase_failed"},
        )
        self.assertTrue(result["exits_clean"])
        summary = result["per_cycle"][0]
        self.assertNotIn("memory_hook", summary)
        self.assertEqual(summary["knowledge_signer"]["status"], "minted")
        failed = [row["details"] for row in load_jsonl(self.base / "governance.jsonl")
                  if row.get("kind") == "memory_hook_failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["error_class"], "OSError")
        self.assertNotIn(sentinel, json.dumps(summary))
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["signer_key_fp"], acquired[0]["fingerprint"])
        self.assertEqual(summary["memory_completion"]["status"], "completed")
        self.assertEqual(summary["memory_completion"]["attempted"], 0)
        self._assert_keys_revoked(workspace, [summary["cycle_id"]])

    def test_signed_memory_preserves_initial_output_and_stability_once(self) -> None:
        from copy import deepcopy
        from aria_kernel.cycle_phases.memory import MemoryHookImpl
        initial = []
        record = MemoryHookImpl.record

        def capture(hook, **kwargs):
            output = record(hook, **kwargs)
            initial.append(deepcopy(output))
            return output

        with (
            patch.object(MemoryHookImpl, "record", new=capture),
            patch("aria_kernel.skill_genesis_drainer.check_pattern_signature_stability",
                  return_value={"stable": True, "matching_cycles": ["prior"]}) as stability,
        ):
            result, _workspace, _acquired = self._run_with_selected_memory_signer(profile="strict")
        summary = result["per_cycle"][0]
        self.assertEqual(summary["memory_hook"], initial[0])
        self.assertEqual(summary["memory_hook"]["status"], "memory_hook_recorded")
        self.assertTrue(summary["memory_hook"]["skill_genesis_dispatched"])
        self.assertEqual(stability.call_count, 1)
        self.assertEqual(summary["memory_completion"]["attempted"], 0)
        dispatched = [row for row in load_jsonl(self.base / "governance.jsonl")
                      if row.get("kind") == "skill_genesis_human_required_dispatched"]
        self.assertEqual(len(dispatched), 1)

    def test_later_cycle_signer_replays_the_observation_a_signerless_cycle_disclosed(self) -> None:
        """B7 — the replay path, now owned by the seam under `standard`.

        Cycle 1 has no signer (its mint fails), so the hook discloses
        `needs_signing` — the same row every pre-seam run left behind.
        Cycle 2 mints its key, signs its own hypothesis, and completes the
        earlier disclosure under that key without opening a PR lane.
        """
        result, workspace, acquired = self._run_with_selected_memory_signer(
            profile="standard", cycles=2, mint_failures=1,
        )
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 2)
        first, second = result["per_cycle"]
        self.assertEqual(first["knowledge_signer"]["status"], "mint_failed")
        self.assertEqual(first["memory_hook"]["status"], "needs_signing")
        self.assertEqual(first["memory_completion"], {"status": "not_attempted"})
        self.assertEqual(len(acquired), 1)
        self.assertEqual(acquired[0]["cycle_id"], second["cycle_id"])
        fingerprint = acquired[0]["fingerprint"]
        self.assertEqual(second["knowledge_signer"]["status"], "minted")
        self.assertEqual(second["memory_hook"]["status"], "memory_hook_recorded")
        self.assertEqual(second["memory_hook"]["signer_key_fp"], fingerprint)
        completion = second["memory_completion"]
        self.assertEqual(completion["status"], "completed")
        self.assertEqual(completion["attempted"], 1)
        recovered = completion["observations"][0]
        self.assertEqual(recovered["cycle_id"], first["cycle_id"])
        self.assertEqual(recovered["signer_cycle_id"], second["cycle_id"])
        self.assertEqual(recovered["signer_key_fp"], fingerprint)
        self.assertTrue(recovered["convention_recorded"])
        self.assertTrue(recovered["convergence_event_hash"].startswith("sha256:"))
        pending = [row["details"] for row in load_jsonl(self.base / "governance.jsonl")
                   if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual([row["cycle_id"] for row in pending], [first["cycle_id"]])
        self.assertEqual(recovered["plan_revision_id"], pending[0]["plan_revision_id"])
        self.assertEqual(recovered["plan_content_hash"], pending[0]["plan_content_hash"])
        self._assert_keys_revoked(workspace, [first["cycle_id"], second["cycle_id"]])
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 2, "the later signer must complete the signerless cycle's observation")
        by_cycle = {row["discovered_by_cycle_id"]: row for row in rows}
        self.assertEqual(set(by_cycle), {first["cycle_id"], second["cycle_id"]})
        original = by_cycle[first["cycle_id"]]
        self.assertEqual(original["pattern_id"], f"conv_{pending[0]['cycle_id']}_{pending[0]['pattern_signature'][:16]}")
        self.assertEqual(original["plan_id"], pending[0]["plan_id"])
        self.assertEqual(original["signer_key_fp"], fingerprint)
        self.assertEqual(by_cycle[second["cycle_id"]]["signer_key_fp"], fingerprint)


    def test_later_production_signer_recovers_original_observation_after_dispatch(self) -> None:
        """A transient append failure is recovered by a LATER signer.

        Cycle 1 holds a real signer and dispatches its implementation, but
        every `record_convention` attempt under cycle 1's key fails — the
        transient outlasts the cycle. The hook audits
        `convention_record_failed` and discloses the observation pending
        under `cycle_append_failed`; the same-cycle replay retries once
        under the same key and fails too; the plan still proceeds to
        IMPLEMENTATION_REQUESTED. Before B7's durable-retry fix that was the
        end of the observation. Cycle 2's signer completes it under the
        ORIGINAL cycle's identity, alongside its own hypothesis.
        """
        from aria_kernel import knowledge_graph
        record = knowledge_graph.record_convention
        acquired: list[dict] = []
        attempts: list[tuple[str, str]] = []

        def transient(pattern, **kwargs):
            attempts.append((pattern.discovered_by_cycle_id, kwargs["signer_key_fp"]))
            if kwargs["signer_key_fp"] == acquired[0]["fingerprint"]:
                raise OSError("fixture: observation store unavailable for the whole first cycle")
            return record(pattern, **kwargs)

        with patch.object(knowledge_graph, "record_convention", side_effect=transient):
            result, workspace, acquired = self._run_with_selected_memory_signer(
                profile="strict", cycles=2, acquired=acquired,
            )
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 2)
        first, second = result["per_cycle"]
        # strict: the seam mints once per cycle and the runner mints nothing
        # (ARIA-HIGH-115), so two cycles show two distinct fingerprints.
        self.assertEqual(len(acquired), 2)
        first_fp = acquired[0]["fingerprint"]
        second_fp = acquired[1]["fingerprint"]
        self.assertEqual([item["cycle_id"] for item in acquired], [first["cycle_id"], second["cycle_id"]])
        self.assertNotEqual(first_fp, second_fp)
        for summary in (first, second):
            self.assertEqual(summary["v9_implementation"]["terminal_state"], "IMPLEMENTATION_DISPATCHED")
            self.assertEqual(summary["knowledge_signer"]["status"], "minted")

        # Cycle 1: the append failed under its own signer, twice — the direct
        # path and the same-cycle replay — and the observation is disclosed
        # pending, not lost.
        self.assertEqual(first["memory_hook"]["status"], "convention_record_failed")
        self.assertFalse(first["memory_hook"]["convention_recorded"])
        self.assertEqual(first["memory_hook"]["pending_reason"], "cycle_append_failed")
        self.assertEqual(first["memory_hook"]["signer_key_fp"], first_fp)
        self.assertEqual(first["memory_completion"]["status"], "completed_with_errors")
        self.assertEqual(first["memory_completion"]["attempted"], 1)
        retried = first["memory_completion"]["observations"][0]
        self.assertFalse(retried["convention_recorded"])
        self.assertEqual(retried["error_class"], "OSError")
        self.assertEqual(retried["signer_key_fp"], first_fp)

        # Cycle 2: its own hypothesis lands, and the replay recovers cycle
        # 1's observation under cycle 2's signer.
        self.assertEqual(second["memory_hook"]["status"], "memory_hook_recorded")
        self.assertIsNone(second["memory_hook"]["pending_reason"])
        self.assertEqual(second["memory_completion"]["status"], "completed")
        self.assertEqual(second["memory_completion"]["attempted"], 1)
        recovered = second["memory_completion"]["observations"][0]
        self.assertTrue(recovered["convention_recorded"])
        self.assertEqual(recovered["cycle_id"], first["cycle_id"])
        self.assertEqual(recovered["signer_cycle_id"], second["cycle_id"])
        self.assertEqual(recovered["signer_key_fp"], second_fp)
        self.assertEqual(
            [fp for _cycle, fp in attempts], [first_fp, first_fp, second_fp, second_fp],
        )
        self.assertEqual(
            [cycle for cycle, _fp in attempts],
            [first["cycle_id"], first["cycle_id"], second["cycle_id"], first["cycle_id"]],
        )

        governance = load_jsonl(self.base / "governance.jsonl")
        pending = [row["details"] for row in governance if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["cycle_id"], first["cycle_id"])
        self.assertEqual(pending[0]["reason"], "cycle_append_failed")
        self.assertEqual(pending[0]["error_class"], "OSError")
        failed = [row["details"] for row in governance if row.get("kind") == "convention_record_failed"]
        self.assertEqual([row["cycle_id"] for row in failed], [first["cycle_id"], first["cycle_id"]])
        for summary in (first, second):
            self.assertEqual(
                fold_plan_state(plan_id=summary["convergence"]["plan_id"], base_dir=self.base)["state"],
                "IMPLEMENTATION_REQUESTED",
            )
        self._assert_keys_revoked(workspace, [first["cycle_id"], second["cycle_id"]])

        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 2, "the later signer must recover the earlier dispatched plan's observation")
        by_cycle = {row["discovered_by_cycle_id"]: row for row in rows}
        self.assertEqual(set(by_cycle), {first["cycle_id"], second["cycle_id"]})
        original = by_cycle[first["cycle_id"]]
        self.assertEqual(original["pattern_id"], f"conv_{pending[0]['cycle_id']}_{pending[0]['pattern_signature'][:16]}")
        self.assertEqual(original["plan_id"], pending[0]["plan_id"])
        self.assertEqual(original["signer_key_fp"], second_fp)
        self.assertEqual(recovered["plan_revision_id"], pending[0]["plan_revision_id"])
        self.assertEqual(recovered["plan_content_hash"], pending[0]["plan_content_hash"])
        self.assertTrue(recovered["convergence_event_hash"].startswith("sha256:"))

    def test_selected_memory_refuses_missing_unconverged_or_tampered_plan(self) -> None:
        for plan_state, reason in (
            ("missing", "memory_requires_converged_plan"),
            ("started", "memory_requires_converged_plan"),
            ("tampered", "ledger_hash_mismatch"),
        ):
            with self.subTest(plan_state=plan_state):
                result = self._run_with_real_memory(plan_state=plan_state)
                self.assertNotIn("memory_hook", result["per_cycle"][0])
                failures = [row for row in load_jsonl(self.base / "governance.jsonl")
                            if row.get("kind") == "memory_hook_failed"]
                self.assertTrue(failures)
                self.assertIn(reason, failures[-1]["details"]["error_message"])
                self.assertFalse((self.base / "knowledge-graph" / "conventions.jsonl").exists())
                # Each case owns a new store; a corrupt ledger must not leak
                # into the next orchestrator's pre-cycle reconciliation.
                shutil.rmtree(self.base)
                set_profile("standard", operator_approval_ref="f1-t", base_dir=self.base)

    def test_memory_hook_programming_error_is_not_laundered_into_governance(self) -> None:
        """B1 (2026-09-12 audit residual) — MemoryHookImpl.record once required
        a kwonly ``converged_plan`` the orchestrator never passed. The
        TypeError was swallowed by ``except Exception`` into a
        memory_hook_failed governance row night after night, so the V10
        memory pillar was dead while the cycle summary read as healthy. A
        signature drift is a programming error: it must raise, not be
        recorded as a runtime fault."""

        class DriftedHook:
            def record(self, **kwargs):
                raise TypeError("record() got an unexpected keyword argument 'converged_plan'")

            def complete_pending_observations(self, **kwargs):
                return {"status": "unreached", "observations": []}

        with self.assertRaises(TypeError):
            self._run(memory_hook=DriftedHook())
        governance = self.base / "governance.jsonl"
        rows = load_jsonl(governance) if governance.exists() else []
        self.assertFalse(any(row.get("kind") == "memory_hook_failed" for row in rows),
                         "a TypeError must not become a memory_hook_failed row")

    def test_memory_hook_runtime_fault_stays_the_governance_row(self) -> None:
        """The narrowed guard still keeps the night alive on a real runtime
        fault: an unwritable ledger is recorded as memory_hook_failed and
        the cycle proceeds to implementation + review + auto_merge."""

        class UnwritableHook:
            def record(self, **kwargs):
                raise OSError(28, "No space left on device")

            def complete_pending_observations(self, **kwargs):
                return {"status": "unreached", "observations": []}

        result = self._run(memory_hook=UnwritableHook())
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 1)
        self.assertNotIn("memory_hook", result["per_cycle"][0])
        failures = [row for row in load_jsonl(self.base / "governance.jsonl")
                    if row.get("kind") == "memory_hook_failed"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["details"]["error_class"], "OSError")
        self.assertIn("v9_implementation", result["per_cycle"][0])

    def test_effectiveness_ledger_lands_in_the_bound_tools_root_not_the_checkout(self) -> None:
        """B4 root cause (2026-09-12) — the live lane binds
        ARIA_TOOLS_DIR=<store>/tools and passes --workspace-root=<checkout>.
        The effectiveness writer resolved its ledger under
        <workspace_root>/aria-tools, i.e. into the checkout that dies with
        the runner; origin/aria/state never carried
        knowledge-graph/pressure-source-effectiveness.jsonl in any commit.
        The store layout used here is the lane's, not the coincidental
        <workspace>/aria-tools one every other test relies on."""
        store_tools = self.tmp / "store" / "tools"
        checkout = self.tmp / "checkout"
        checkout.mkdir()
        set_profile("standard", operator_approval_ref="f1-t", base_dir=store_tools)
        result = self._run(base_dir=store_tools, workspace_root=str(checkout))
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 1)
        ledger = store_tools / "knowledge-graph" / "pressure-source-effectiveness.jsonl"
        self.assertTrue(ledger.is_file(), "the effectiveness row must land in the bound tools root")
        self.assertFalse((checkout / "aria-tools").exists(),
                         "nothing may bootstrap a shadow tools root inside the checkout")
        self.assertEqual(self._funnel_counters(store_tools), {
            "git_diff": {"cycles_minted": 1, "cycles_converged": 1, "cycles_merged": 0, "cycles_rejected": 0},
        })

    def test_a_tampered_effectiveness_ledger_does_not_cost_the_night(self) -> None:
        """The writer's guard used to be (OSError, ValueError, KeyError,
        TypeError): programming errors were swallowed while a tampered
        ledger raised KnowledgeGraphTamper straight through the cycle. A
        corrupt row is a runtime fault: the night finishes, each refused
        fact (the mint, then the convergence) is a governance row with its
        class and its counters, and the writer leaves the tampered bytes
        for the reader's quarantine rather than appending behind them."""
        ledger = self.base / "knowledge-graph" / "pressure-source-effectiveness.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text("{not json\n", encoding="utf-8")
        result = self._run()
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 1)
        failures = [row for row in load_jsonl(self.base / "governance.jsonl")
                    if row.get("kind") == "pressure_source_outcome_failed"]
        self.assertEqual(
            [(row["details"]["error_class"], row["details"]["counters"]) for row in failures],
            [
                ("KnowledgeGraphTamper", {"minted": 1, "converged": 0, "merged": 0, "rejected": 0}),
                ("KnowledgeGraphTamper", {"minted": 0, "converged": 1, "merged": 0, "rejected": 0}),
            ],
        )
        self.assertEqual(ledger.read_text(encoding="utf-8"), "{not json\n")

    @staticmethod
    def _funnel_counters(tools: Path) -> dict[str, dict[str, int]]:
        from aria_kernel.knowledge_graph import rank_pressure_sources

        return {
            str(row["source_type"]): {
                field: int(row[field])
                for field in ("cycles_minted", "cycles_converged", "cycles_merged", "cycles_rejected")
            }
            for row in rank_pressure_sources(base_dir=tools)
        }

    def _funnel_writes(self, tools: Path) -> list[dict[str, int]]:
        """Every row the orchestrator appended, in order, as its deltas."""
        from aria_kernel.knowledge_graph import _read_jsonl_strict, effectiveness_ledger_path

        rows = list(_read_jsonl_strict(effectiveness_ledger_path(base_dir=tools)))
        deltas: list[dict[str, int]] = []
        previous = {"cycles_minted": 0, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 0}
        for row in rows:
            deltas.append({field: int(row[field]) - previous[field] for field in previous})
            previous = {field: int(row[field]) for field in previous}
        return deltas

    def test_a_blocked_convergence_counts_the_minted_plan_as_rejected(self) -> None:
        """B4 root cause (2026-09-12) — the writer sat after auto_merge, on
        the converged path only. The live lane took the convergence_blocked
        exit every night, so the ledger was never written, the funnel
        detector had nothing to count for the one stall the store had, and
        the doctor could not tell bootstrap from loss. The mint is recorded
        at the funnel's entry and the blocked exit records the rejection:
        the ledger exists from the first minted plan."""
        def _split(**kwargs):
            return {**_fake_convergence_runner(**kwargs), "arbiter_verdict": "split"}

        result = self._run(convergence_runner=_split)
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["per_cycle"][0]["dispatch_blocked_reason"], "convergence_split")
        self.assertEqual(self._funnel_counters(self.base), {
            "git_diff": {"cycles_minted": 1, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 1},
        })
        self.assertEqual(self._funnel_writes(self.base), [
            {"cycles_minted": 1, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 0},
            {"cycles_minted": 0, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 1},
        ])

    def test_an_invalid_plan_counts_the_minted_plan_as_rejected(self) -> None:
        """The other non-converged exit: convergence_runner refuses the plan
        with GovernanceError. The plan was minted (the synthesizer yielded
        it) and left the funnel without converging."""
        from aria_kernel.tool_registry import GovernanceError

        def _refuse(**kwargs):
            raise GovernanceError("plan content missing required field(s): title")

        result = self._run(convergence_runner=_refuse)
        self.assertTrue(result["exits_clean"])
        self.assertIn("convergence_invalid_plan", result["per_cycle"][0])
        self.assertEqual(self._funnel_counters(self.base), {
            "git_diff": {"cycles_minted": 1, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 1},
        })

    def test_a_specialist_blocked_converged_plan_still_counts_as_converged(self) -> None:
        """Convergence is recorded at the verdict, not after auto_merge: a
        plan that converged and was then stopped by specialist review is
        still a converged plan that did not merge — the merge-stage stall
        (converged in, nothing out) is only countable if this exit counts."""
        def _remediation(**kwargs):
            return {**_fake_specialist_review_runner(**kwargs),
                    "consolidated_verdict": "consolidated_remediation_required"}

        result = self._run(specialist_review_runner=_remediation)
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["per_cycle"][0]["dispatch_blocked_reason"],
                         "specialist_consolidated_remediation_required")
        self.assertEqual(self._funnel_counters(self.base), {
            "git_diff": {"cycles_minted": 1, "cycles_converged": 1, "cycles_merged": 0, "cycles_rejected": 0},
        })

    def test_a_merge_counts_the_cycle_once_however_many_prs_landed(self) -> None:
        class _TwoMerges(_FakeAutoMergeRunner):
            def __call__(self, *, base_dir, workspace_root):
                return {**super().__call__(base_dir=base_dir, workspace_root=workspace_root),
                        "status": "ok", "merges_completed": 2}

        result = self._run(auto_merge_runner=_TwoMerges())
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["per_cycle"][0]["auto_merge"]["merges_completed"], 2)
        self.assertEqual(self._funnel_counters(self.base), {
            "git_diff": {"cycles_minted": 1, "cycles_converged": 1, "cycles_merged": 1, "cycles_rejected": 0},
        })

    def test_the_mint_is_recorded_before_the_state_ledger_says_so(self) -> None:
        """The doctor's funnel organ judges an absent effectiveness ledger
        against the PLAN_MINTED_PHASE rows in autonomy_state.jsonl. That
        implication — state says minted => effectiveness ledger has the
        mint — holds by construction only if the ledger write precedes the
        transition and is the single site that records a mint. Pinned on
        the orchestrator's source order."""
        import inspect
        import re
        from aria_kernel import autonomy_orchestrator as mod

        src = inspect.getsource(mod.run_autonomy_orchestrator)
        mint_sites = [m.start() for m in re.finditer(r"_record_funnel_counter\([^)]*minted=1", src)]
        self.assertEqual(len(mint_sites), 1, "exactly one site records a mint")
        transition = src.find("phase=PLAN_MINTED_PHASE")
        self.assertNotEqual(transition, -1, "the transition names the shared phase constant")
        self.assertLess(mint_sites[0], transition, "the mint row precedes the state transition")
        self.assertEqual(src.count("phase=PLAN_MINTED_PHASE"), 1)

    def test_the_doctor_reads_blocked_only_cycles_as_counted_never_as_loss(self) -> None:
        """The live store's shape, produced by the real orchestrator: two
        nights, both convergence-blocked. The funnel organ is ok with the
        counters in its detail (the stall threshold is ten). Only when the
        ledger the mints fed is gone while the state ledger still says
        "minted" does the organ fail — that is a ledger that existed and
        vanished, never bootstrap."""
        from aria_kernel import doctor

        def _split(**kwargs):
            return {**_fake_convergence_runner(**kwargs), "arbiter_verdict": "split"}

        result = self._run(convergence_runner=_split, max_cycles=2)
        self.assertEqual(result["cycles_completed"], 2)
        check = doctor._check_funnel(self.base)
        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual(check.detail["plans_minted"], 2)
        self.assertEqual(check.detail["counters"], {
            "git_diff": {"cycles_minted": 2, "cycles_converged": 0, "cycles_merged": 0, "cycles_rejected": 2},
        })
        (self.base / "knowledge-graph" / "pressure-source-effectiveness.jsonl").unlink()
        check = doctor._check_funnel(self.base)
        self.assertEqual((check.status, check.reason), ("fail", "funnel_ledger_missing_with_minted_plans"))
        self.assertEqual((check.detail["plans_minted"], check.detail["sources"]), (2, 0))

    def test_the_doctor_fails_a_converged_store_whose_ledger_is_gone(self) -> None:
        from aria_kernel import doctor

        result = self._run()
        self.assertEqual(result["cycles_completed"], 1)
        self.assertEqual(doctor._check_funnel(self.base).status, "ok")
        (self.base / "knowledge-graph" / "pressure-source-effectiveness.jsonl").unlink()
        check = doctor._check_funnel(self.base)
        self.assertEqual((check.status, check.reason), ("fail", "funnel_ledger_missing_with_minted_plans"))

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
        # Plan ARIA-V3.1-E — profile kwarg is the SSoT; the CLI
        # surface routes through set_profile() so kwarg == persisted
        # in production. Match the persisted "frozen" via the
        # operator-intent kwarg so the test exercises the frozen-
        # profile_frozen exit path under the V3.1-E contract.
        result = self._run(max_cycles=3, profile="frozen")
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
        self.assertEqual(result["exit_reason"], "cycle_failed")
        self.assertFalse(result["exits_clean"])
        # Fail-closed: planner/bridge/worker drains do not run after a failed cycle.
        self.assertFalse(
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


    # ------------------------------------------------------------------
    # ORPHAN-HIGH-455 — the specialist gate, at the CALLSITE.
    #
    # ORPHAN-HIGH-423 extracted `specialist_verdict_blocks_cycle` so the
    # policy could be tested on its own, and the test that claimed to cover
    # the orchestrator's use of it patched the function and then called the
    # thing it had just patched, asserting the wrapper recorded the call.
    # The orchestrator was never imported. So the policy was pinned, the
    # delegation was not, and an adversarial audit demonstrated that
    # reverting `autonomy_orchestrator.py` wholesale left all 2805 tests
    # green.
    #
    # These drive the real orchestrator through the real callsite. Each was
    # confirmed to fail against `git show bdaf00bf:...autonomy_orchestrator.py`.
    # ------------------------------------------------------------------

    def _specialist_runner_returning(self, verdict: str):
        def _runner(**kwargs):
            row = _fake_specialist_review_runner(**kwargs)
            row["consolidated_verdict"] = verdict
            return row
        return _runner

    def test_specialist_unavailable_blocks_the_cycle_in_standard(self) -> None:
        """The ORPHAN-HIGH-423 fix, observed where it takes effect.

        Pre-fix only `strict` blocked, so `standard` and `autonomous` — the
        write-capable profiles — proceeded on an unreviewed domain.
        """
        result = self._run(
            max_cycles=1,
            profile="standard",
            specialist_review_runner=self._specialist_runner_returning(
                "specialists_unavailable",
            ),
        )
        self.assertEqual(result["worker_assignments_dispatched"], 0)
        self.assertEqual(result["auto_merges_completed"], 0)
        phases = {row["phase"] for row in load_jsonl(autonomy_state_path(self.base))}
        self.assertIn("specialist_review_blocked", phases)

    def test_unrecognised_specialist_verdict_blocks_too(self) -> None:
        """ORPHAN-HIGH-443's allowlist, also at the callsite.

        A verdict this build has never heard of must not read as a clean
        review. The seam is genuinely untyped: `specialist_review_runner` is
        an injected kwarg and the orchestrator reads the verdict with
        `dict.get()`, which is exactly what this injects.

        Run under `standard`, not `autonomous`: the autonomous profile's
        preflight demands a GitHub App installation, a signing-key directory
        and a `gh` binary, none of which exist in a test environment, so it
        raises before ever reaching the specialist gate. `standard` is
        write-capable — the property under test — and
        `specialist_verdict_blocks_cycle` applies the identical rule to both.
        """
        for verdict in ("", "consolidated_no_gap", "CONSOLIDATED_NO_GAPS"):
            with self.subTest(verdict=verdict):
                # A fresh base per verdict, so one iteration's ledger cannot
                # satisfy the next one's assertion. Not `self.setUp()`:
                # tearDown runs once, and re-entering setUp would leak every
                # temp directory but the last.
                tmp = Path(tempfile.mkdtemp(prefix="aria-f1-verdict-"))
                self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
                self.tmp, self.base = tmp, tmp / "aria-tools"
                set_profile(
                    "standard", operator_approval_ref="f1-t", base_dir=self.base,
                )
                result = self._run(
                    max_cycles=1,
                    profile="standard",
                    specialist_review_runner=self._specialist_runner_returning(verdict),
                )
                self.assertEqual(
                    result["worker_assignments_dispatched"],
                    0,
                    msg=f"verdict {verdict!r} let the cycle reach worker_drainer",
                )

    def test_a_clean_specialist_verdict_still_lets_the_cycle_through(self) -> None:
        """Guards the guard: if the block fired unconditionally, the two
        tests above would pass for the wrong reason."""
        result = self._run(max_cycles=1, profile="standard")
        self.assertGreater(result["worker_assignments_dispatched"], 0)
        phases = {row["phase"] for row in load_jsonl(autonomy_state_path(self.base))}
        self.assertNotIn("specialist_review_blocked", phases)


class BoundedCycleSummaryCarriesWhatThePublisherReads(unittest.TestCase):
    """ORPHAN-HIGH-456 — the summary literal is closed, so it is a contract.

    `_bounded_cycle_summary` names its keys explicitly and therefore DELETES
    every key it does not name. Two consumers in `runtime_artifacts` read
    keys that could not survive it, so both were unreachable in production
    while their tests passed against the raw cycle dict — a shape production
    never emits. That is the same defect as a control with no caller, one
    layer down.
    """

    def test_the_lifecycle_snapshot_survives_the_summary(self) -> None:
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary

        summary = _bounded_cycle_summary({
            "cycle_id": "c1",
            "status": "completed",
            "incomplete_lifecycle_count": 0,
            "cycle_lifecycle": {
                "valid": False,
                "incomplete_count": 0,
                "incomplete_cycles": [],
                "lifecycle_read_error": "cycles.jsonl unreadable",
            },
        })
        lifecycle = summary.get("cycle_lifecycle")
        self.assertIsInstance(lifecycle, dict)
        assert isinstance(lifecycle, dict)  # narrowing
        self.assertIs(lifecycle["valid"], False)
        self.assertEqual(lifecycle["lifecycle_read_error"], "cycles.jsonl unreadable")

    def test_the_unreadable_warning_can_actually_fire(self) -> None:
        """End-to-end: the publisher's own condition, on a real summary.

        This is the distinction ORPHAN-HIGH-424's commit message sold as the
        feature — "zero incomplete cycles" versus "the ledger could not be
        read" — and it was unreachable.
        """
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary

        summary = _bounded_cycle_summary({
            "cycle_id": "c1",
            "status": "completed",
            "incomplete_lifecycle_count": 0,
            "cycle_lifecycle": {"valid": False, "incomplete_count": 0},
        })
        lifecycle = summary.get("cycle_lifecycle")
        self.assertTrue(
            isinstance(lifecycle, dict)
            and lifecycle.get("valid") is False
            and not summary["incomplete_lifecycle_count"],
            msg="cycle_lifecycle_unreadable still cannot fire on a real summary",
        )

    def test_the_phase_outcome_ledger_survives_the_summary(self) -> None:
        # ARIA-HIGH-140 — on 2026-09-15 two deadline-cut cycles left no
        # ledger naming the phase the alarm interrupted: the outcomes lived
        # only in the cycle's in-memory state and this literal dropped them.
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary

        phases = {
            "discovery": {"outcome": "ran"},
            "fixture_refresh": {"outcome": "interrupted", "reason": "phase_deadline_exceeded"},
            "judgment_pipeline": {"outcome": "skipped", "reason": "job_deadline_reached"},
            "artifact_integrity": {"outcome": "ran"},
        }
        summary = _bounded_cycle_summary({"cycle_id": "c1", "status": "failed", "phases": phases})
        self.assertEqual(summary["phases"], phases)
        # A cycle dict without the ledger (or with a malformed one) still
        # summarises: the key is present and empty, never absent.
        self.assertEqual(_bounded_cycle_summary({"cycle_id": "c1", "status": "completed"})["phases"], {})
        self.assertEqual(
            _bounded_cycle_summary({"cycle_id": "c1", "status": "completed", "phases": ["not", "a", "dict"]})["phases"],
            {},
        )

    def test_cycle_level_markers_survive(self) -> None:
        from aria_kernel.autonomy_orchestrator import _bounded_cycle_summary
        from aria_kernel.runtime_artifacts import _marker_total, _SUPPRESSED_MARKER_KEYS

        summary = _bounded_cycle_summary({
            "cycle_id": "c1", "status": "completed", "findings_suppressed": 3,
        })
        self.assertEqual(_marker_total(summary, _SUPPRESSED_MARKER_KEYS), 3)

    def test_the_mirrored_marker_key_list_has_not_drifted(self) -> None:
        """The orchestrator keeps its own copy of the publisher's key names.

        A copy is acceptable here — the modules are deliberately decoupled —
        but only if drift is detectable, which is what this asserts.
        """
        from aria_kernel.autonomy_orchestrator import _CYCLE_MARKER_KEYS
        from aria_kernel.runtime_artifacts import (
            _SUPPRESSED_MARKER_KEYS,
            _TRUNCATED_MARKER_KEYS,
        )

        self.assertEqual(
            set(_CYCLE_MARKER_KEYS),
            set(_SUPPRESSED_MARKER_KEYS) | set(_TRUNCATED_MARKER_KEYS),
        )

    def test_incomplete_cycles_is_capped(self) -> None:
        """Operator evidence, not a data feed: an unbounded list from a
        damaged ledger is how a summary becomes unpublishable."""
        from aria_kernel.autonomy_orchestrator import (
            _MAX_INCOMPLETE_CYCLES_IN_SUMMARY,
            _bounded_cycle_summary,
        )

        summary = _bounded_cycle_summary({
            "cycle_id": "c1",
            "status": "completed",
            "cycle_lifecycle": {
                "valid": False,
                "incomplete_count": 500,
                "incomplete_cycles": [f"c{i}" for i in range(500)],
            },
        })
        lifecycle = summary["cycle_lifecycle"]
        self.assertEqual(
            len(lifecycle["incomplete_cycles"]), _MAX_INCOMPLETE_CYCLES_IN_SUMMARY,
        )
        # The true count is still reported, so the cap cannot hide scale.
        self.assertEqual(lifecycle["incomplete_count"], 500)

class TheStartupReaperCollectsAbandonmentNotLateness(unittest.TestCase):
    """ORPHAN-HIGH-729 — the reap window, exercised through the orchestrator.

    The reaper was written for a topology where minting and draining an
    implementation envelope happened in ONE process, so "still REQUESTED at
    startup" could only mean crash debris. It is two workflow runs now — the
    cycle lane mints, the `workflow_run`-chained executor lane drains — and
    an unbounded reaper in that world rejects the plan the executor is on its
    way to implement, every time the window slips.

    Both tests drive a REAL plan to IMPLEMENTATION_REQUESTED through the
    transition functions and then let the real `record_implementation_rejected`
    decide whether it lands. Only the scanner's reported `last_event_at` is
    substituted, because a clock is the one thing a test cannot honestly wait
    for: patching it is supplying data, patching `_older_than_hours` would be
    replacing the mechanism under test.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-729-"))
        self.base = self.tmp / "aria-tools"
        self.workspace = self.tmp / "workspace"
        seed_reviewer_agent(self.workspace)
        set_profile(
            "standard", operator_approval_ref="orphan-729", base_dir=self.base,
        )
        drive_plan_to_implementation_requested(
            plan_id="plan-729",
            tools=self.base,
            workspace_root=self.workspace,
        )
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REQUESTED",
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_with_orphan_stamps(
        self, *, last_event_at: Any, first_event_at: Any = None,
    ) -> list[dict[str, Any]]:
        orphan = [{
            "plan_id": "plan-729",
            "state": "IMPLEMENTATION_REQUESTED",
            "last_event_at": last_event_at,
            "first_event_at": first_event_at,
        }]
        with patch(
            "aria_kernel.plan_convergence.scan_orphan_implementation_requests",
            return_value=orphan,
        ):
            run_autonomy_orchestrator(
                base_dir=self.base,
                workspace_root=str(self.workspace),
                max_cycles=0,
                max_iterations_per_phase=1,
                cycle_runner=_fake_cycle_runner,
                planner_drainer=_fake_planner_drainer,
                worker_drainer=_fake_worker_drainer,
                bridge_drainer=_fake_bridge_drainer,
                auto_merge_runner=_fake_auto_merge_runner,
                github_adapter=_fake_github_adapter,
                convergence_runner=_fake_convergence_runner,
                review_runner=_fake_review_runner,
                specialist_review_runner=_fake_specialist_review_runner,
                plan_synthesizer=_fake_plan_synthesizer,
                skill_genesis_drainer=_fake_skill_genesis_drainer,
                profile="standard",
            )
        return load_jsonl(ensure_tools_dir(self.base) / "governance.jsonl")

    @staticmethod
    def _hours_ago(hours: float) -> str:
        from datetime import datetime, timedelta, timezone

        return (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

    def _run_with_orphan_age(self, hours: float) -> list[dict[str, Any]]:
        return self._run_with_orphan_stamps(last_event_at=self._hours_ago(hours))

    def test_a_one_hour_old_request_survives_startup(self) -> None:
        events = self._run_with_orphan_age(1)
        self.assertNotIn(
            "implementation_orphan_reaped", [row.get("kind") for row in events],
        )
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REQUESTED",
            "the executor's own envelope was rejected before the executor ran",
        )
        summaries = [
            row for row in events
            if row.get("kind") == "implementation_orphans_reaped_summary"
        ]
        self.assertEqual(len(summaries), 1, "sparing must not be silent")
        payload = summaries[0]["details"]
        self.assertEqual(payload["reaped_count"], 0)
        self.assertEqual(payload["spared_recent_count"], 1)
        self.assertEqual(payload["reap_after_hours"], 24)

    def test_a_thirty_hour_old_request_is_reaped_with_its_disclosure_row(self) -> None:
        events = self._run_with_orphan_age(30)
        reaped = [
            row for row in events
            if row.get("kind") == "implementation_orphan_reaped"
        ]
        self.assertEqual(len(reaped), 1)
        payload = reaped[0]["details"]
        self.assertEqual(payload["plan_id"], "plan-729")
        self.assertEqual(payload["prior_state"], "IMPLEMENTATION_REQUESTED")
        self.assertTrue(payload["last_event_at"])
        self.assertEqual(payload["reap_after_hours"], 24)
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REJECTED",
        )

    def test_a_corrupt_newest_stamp_is_dated_from_the_plans_birth(self) -> None:
        """A mangled `recorded_at` used to read as `spared_recent`: the bound
        asked a bool that answers False for "unparseable" and for "young"
        alike. The age now falls back to the plan's first event, so a corrupt
        row cannot buy immunity — and the reap row says which clock it used
        rather than leaving an auditor to infer it."""
        events = self._run_with_orphan_stamps(
            last_event_at="not-a-date", first_event_at=self._hours_ago(30),
        )
        reaped = [
            row for row in events
            if row.get("kind") == "implementation_orphan_reaped"
        ]
        self.assertEqual(len(reaped), 1)
        self.assertEqual(reaped[0]["details"]["age_source"], "first_event_at")
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REJECTED",
        )

    def test_an_undateable_request_reaches_a_human_instead_of_immortality(self) -> None:
        """No readable stamp ANYWHERE in the plan's event stream is a corrupt
        ledger, not a late executor — `_append_event` always stamps, so the
        writer cannot produce this shape.

        Sparing it was the defect: the earlier note claimed
        `resume_candidate_plan_id` would eventually abandon such a plan, and
        it cannot — it `continue`s past `_IMPLEMENTATION_PHASE_STATES`, the
        only states this scanner returns, so nothing in the kernel would ever
        have collected it. A machine with no clock cannot honestly choose
        between "abandoned" and "in flight", so it stops choosing: the plan is
        left intact AND handed to the operator queue, which is a terminal path
        a human can actually walk.
        """
        events = self._run_with_orphan_stamps(
            last_event_at=None, first_event_at=None,
        )
        summaries = [
            row for row in events
            if row.get("kind") == "implementation_orphans_reaped_summary"
        ]
        self.assertEqual(len(summaries), 1)
        payload = summaries[0]["details"]
        self.assertEqual(payload["escalated_undateable_count"], 1)
        self.assertEqual(payload["reaped_count"], 0)
        self.assertEqual(
            fold_plan_state(plan_id="plan-729", base_dir=self.base)["state"],
            "IMPLEMENTATION_REQUESTED",
            "an undateable plan must not be destroyed on a guess either",
        )
        from aria_kernel.human_required import list_human_required

        escalations = [
            row for row in list_human_required(base_dir=self.base)
            if row.get("context", {}).get("plan_id") == "plan-729"
        ]
        self.assertEqual(len(escalations), 1, escalations)
        self.assertEqual(escalations[0]["status"], "open")

    def test_the_escalation_does_not_multiply_across_scans(self) -> None:
        """Every startup re-scans, and an operator queue that grows one row
        per night for the same plan is a queue nobody reads. The request_id
        is derived from the plan, so `record_human_required`'s own
        idempotency collapses the repeats."""
        for _ in range(3):
            self._run_with_orphan_stamps(last_event_at=None, first_event_at=None)
        from aria_kernel.human_required import list_human_required

        escalations = [
            row for row in list_human_required(base_dir=self.base)
            if row.get("context", {}).get("plan_id") == "plan-729"
        ]
        self.assertEqual(len(escalations), 1, escalations)


if __name__ == "__main__":
    unittest.main()
