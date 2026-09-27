"""ARIA-HIGH-098 — a tool failure is a TOOL status, not a cycle integrity failure.

Trial eleven (``cyc-20260912T221237Z-auto``, 2026-09-12 22:12–22:52Z): nine of
ten tools ok, artifact index 10/10 verified, a CONVERGED plan in the store —
and ``agent-harness-security-adapter``'s ``evidence_error`` made
``cycle._runtime_status`` say ``integrity_failed``, the orchestrator failed
closed, and the funnel, knowledge signer, memory hook and V9 implementation
never ran. These tests pin the rule that replaces it, at every layer that
reads a cycle's verdict.

ARIA-HIGH-140 sharpened the third fact: ``integrity_valid`` is tri-state, and
``None`` (the phase never ran) is decided by the tools alone — a filtered or
deadline-skipped artifact_integrity now reads OK/DEGRADED, not integrity_failed.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from aria_kernel import register_tool, run_tool
from aria_kernel.autonomy_state import autonomy_state_path
from aria_kernel.cycle_runtime_status import (
    ARTIFACT_MISSING_CLASS,
    RUNTIME_DEGRADED,
    RUNTIME_FAILED,
    RUNTIME_INTEGRITY_FAILED,
    RUNTIME_OK,
    degraded_tool_records,
    non_ok_runs,
    runtime_status,
    tool_run_degradation_class,
)
from aria_kernel.human_required import list_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_artifacts import _cycle_result_status, autonomy_output_summary
from aria_kernel.tool_degradation import (
    TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK,
    consecutive_degraded_cycles,
    degradation_report,
)
from tests._helpers.production_shaped import cycle_workspace
from tests.test_enterprise_cycle import fake_tool_argv, self_output_tool, shadow_tool, tool_output

OK_RUN = {"tool_id": "ok-tool", "run_id": "r-ok", "status": "ok", "artifact_status": "present"}
EVIDENCE_ERROR_RUN = {"tool_id": "harness", "run_id": "r-ev", "status": "evidence_error", "artifact_status": "present"}
BUDGET_RUN = {"tool_id": "test-gap", "run_id": "r-bud", "status": "budget_exceeded", "artifact_status": "present"}
ARTIFACT_LOST_RUN = {"tool_id": "lost", "run_id": "r-lost", "status": "ok", "artifact_status": "missing"}
WRITE_FAILED_RUN = {"tool_id": "unwritten", "run_id": "r-wf", "status": "integrity_failed", "artifact_status": "write_failed"}


class RuleTests(unittest.TestCase):
    def test_the_class_is_the_run_status_or_the_lost_artifact(self) -> None:
        self.assertIsNone(tool_run_degradation_class(OK_RUN))
        self.assertEqual(tool_run_degradation_class(EVIDENCE_ERROR_RUN), "evidence_error")
        self.assertEqual(tool_run_degradation_class(BUDGET_RUN), "budget_exceeded")
        self.assertEqual(tool_run_degradation_class(ARTIFACT_LOST_RUN), ARTIFACT_MISSING_CLASS)
        self.assertEqual(non_ok_runs([OK_RUN, EVIDENCE_ERROR_RUN]), [EVIDENCE_ERROR_RUN])

    def test_one_non_ok_tool_with_a_valid_index_is_degraded_not_integrity_failed(self) -> None:
        # The trial-eleven shape.
        verdict = runtime_status(phase_failed=False, integrity_valid=True, non_ok=[EVIDENCE_ERROR_RUN])
        self.assertEqual(verdict, RUNTIME_DEGRADED)
        # The 2026-09-04 shape (the finding's original evidence).
        self.assertEqual(
            runtime_status(phase_failed=False, integrity_valid=True, non_ok=[BUDGET_RUN]), RUNTIME_DEGRADED,
        )

    def test_the_store_still_fails_closed(self) -> None:
        self.assertEqual(
            runtime_status(phase_failed=False, integrity_valid=False, non_ok=[]), RUNTIME_INTEGRITY_FAILED,
        )
        for lost in (ARTIFACT_LOST_RUN, WRITE_FAILED_RUN):
            with self.subTest(run=lost["tool_id"]):
                self.assertEqual(
                    runtime_status(phase_failed=False, integrity_valid=True, non_ok=[lost]),
                    RUNTIME_INTEGRITY_FAILED,
                )
        self.assertEqual(runtime_status(phase_failed=True, integrity_valid=True, non_ok=[]), RUNTIME_FAILED)
        self.assertEqual(runtime_status(phase_failed=False, integrity_valid=True, non_ok=[]), RUNTIME_OK)

    def test_an_unverified_store_is_not_a_failed_store(self) -> None:
        # ARIA-HIGH-140 — trial eleven, 2026-09-15: two cycles cut by their
        # deadline inside fixture_refresh never reached artifact_integrity,
        # and the EMPTY verdict read as integrity_failed over a store whose
        # index verified 9/9. ``None`` is "nobody looked", and it is decided
        # by the tools alone.
        self.assertEqual(runtime_status(phase_failed=False, integrity_valid=None, non_ok=[]), RUNTIME_OK)
        self.assertEqual(
            runtime_status(phase_failed=False, integrity_valid=None, non_ok=[EVIDENCE_ERROR_RUN]),
            RUNTIME_DEGRADED,
        )
        # A verdict that was actually reached still fails closed.
        self.assertEqual(runtime_status(phase_failed=False, integrity_valid=False, non_ok=[]), RUNTIME_INTEGRITY_FAILED)

    def test_a_deadline_cut_is_a_failed_cycle_never_an_untrustworthy_store(self) -> None:
        # The phase the alarm interrupted did not finish: the cycle is
        # ``failed`` (and names the phase elsewhere), whatever the store's
        # verdict — the one thing it must never say is integrity_failed,
        # because that is the verdict the orchestrator fails closed on.
        for integrity_valid in (True, None):
            self.assertEqual(
                runtime_status(phase_failed=False, integrity_valid=integrity_valid, non_ok=[], phase_interrupted=True),
                RUNTIME_FAILED,
            )
        self.assertEqual(
            runtime_status(phase_failed=False, integrity_valid=None, non_ok=[EVIDENCE_ERROR_RUN], phase_interrupted=True),
            RUNTIME_FAILED,
        )

    def test_degraded_records_name_the_tool_and_its_class(self) -> None:
        records = degraded_tool_records([EVIDENCE_ERROR_RUN, ARTIFACT_LOST_RUN])
        self.assertEqual(
            [(r["tool_id"], r["degradation_class"], r["integrity_class"]) for r in records],
            [("harness", "evidence_error", False), ("lost", ARTIFACT_MISSING_CLASS, True)],
        )


class ProjectionTests(unittest.TestCase):
    def test_a_claimed_ok_cycle_with_non_ok_tools_projects_by_class(self) -> None:
        # Pre-fix: "failed" for both — and the orchestrator failed closed on the word.
        self.assertEqual(
            _cycle_result_status({"status": "completed", "runtime_status": "ok", "non_ok_tools": [BUDGET_RUN]}),
            RUNTIME_DEGRADED,
        )
        self.assertEqual(
            _cycle_result_status({"status": "completed", "runtime_status": "ok", "non_ok_tools": [ARTIFACT_LOST_RUN]}),
            RUNTIME_INTEGRITY_FAILED,
        )
        self.assertEqual(
            _cycle_result_status({"status": "completed", "runtime_status": "degraded", "non_ok_tools": [BUDGET_RUN]}),
            RUNTIME_DEGRADED,
        )

    def test_the_output_summary_is_degraded_with_the_tool_counted_not_failed(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-098-summary-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        result = {
            "exits_clean": True,
            "exit_reason": "max_cycles",
            "cycles_completed": 1,
            "per_cycle": [{"cycle": {
                "cycle_id": "cyc-1", "status": "completed", "runtime_status": "degraded",
                "tool_run_summary": [OK_RUN, EVIDENCE_ERROR_RUN],
                "non_ok_tools": [EVIDENCE_ERROR_RUN],
            }}],
        }
        summary = autonomy_output_summary(result, base_dir=tmp)
        self.assertEqual(summary["overall_status"], "degraded")
        self.assertEqual(summary["exit_code"], 2)
        self.assertEqual(summary["cycle_status_counts"], {"degraded": 1})
        self.assertEqual(summary["tool_status_counts"], {"evidence_error": 1, "ok": 1})
        self.assertEqual(summary["error_count"], 1)
        self.assertEqual(summary["evidence_errors"], 1)
        # A lost artifact is still the store's failure.
        result["per_cycle"][0]["cycle"]["tool_run_summary"] = [OK_RUN, ARTIFACT_LOST_RUN]
        result["per_cycle"][0]["cycle"]["non_ok_tools"] = [ARTIFACT_LOST_RUN]
        result["per_cycle"][0]["cycle"]["runtime_status"] = "integrity_failed"
        self.assertEqual(autonomy_output_summary(result, base_dir=tmp)["overall_status"], "failed")


class OrchestratorTests(unittest.TestCase):
    """The orchestrator continues on ``degraded`` and fails closed on the store."""

    def setUp(self) -> None:
        # The orchestrator's required-runner roster is long and pinned by its
        # own suite; that suite's harness (`_run`) is the one way to build a
        # production-shaped invocation, so it is reused rather than copied.
        from tests.test_autonomy_orchestrator import AutonomyOrchestratorTests

        self._harness = AutonomyOrchestratorTests()
        self._harness.setUp()
        self.addCleanup(self._harness.tearDown)
        self.base = self._harness.base

    def _run_with(self, cycle_fields: dict, **overrides):
        from tests.test_autonomy_orchestrator import _fake_planner_drainer

        def cycle_output(*, workspace_root, cycle_id, base_dir, defer_reflection=False):
            return {"schema_version": 2, "cycle_id": cycle_id, **cycle_fields}

        planner = Mock(wraps=_fake_planner_drainer)
        # No plan is minted unless the test asks for the harness's synthesizer:
        # the first two pins are about the verdict, the convergence pin passes
        # its own.
        overrides.setdefault("plan_synthesizer", lambda **kwargs: None)
        result = self._harness._run(cycle_runner=cycle_output, planner_drainer=planner, **overrides)
        rows = [row for row in load_jsonl(autonomy_state_path(self.base)) if row.get("phase") == "cycle_completed"]
        return result, planner, rows

    def test_a_degraded_cycle_reaches_the_drainers_and_is_recorded_as_degraded(self) -> None:
        degraded_tools = degraded_tool_records([EVIDENCE_ERROR_RUN])
        result, planner, rows = self._run_with({
            "status": "completed", "runtime_status": "degraded",
            "non_ok_tools": [EVIDENCE_ERROR_RUN], "degraded_tools": degraded_tools,
            "tool_run_summary": [OK_RUN, EVIDENCE_ERROR_RUN],
        })
        self.assertEqual(result["cycles_completed"], 1)
        self.assertEqual(result["exit_reason"], "max_cycles")
        self.assertTrue(result["exits_clean"])
        planner.assert_called_once()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "degraded")
        summary = rows[0]["details"]["summary"]
        self.assertEqual(summary["runtime_status"], "degraded")
        self.assertEqual(summary["degraded_tools"][0]["tool_id"], "harness")
        self.assertEqual(summary["degraded_tools"][0]["degradation_class"], "evidence_error")
        output = autonomy_output_summary(result, base_dir=self.base)
        self.assertEqual(output["overall_status"], "degraded")
        self.assertEqual(output["cycle_status_counts"], {"degraded": 1})

    def test_a_degraded_cycle_converges_and_runs_every_post_converged_phase(self) -> None:
        """The trial-eleven loss, phase by phase: with the plan CONVERGED the
        funnel counter, the knowledge signer, the memory hook and the V9
        implementation phase all ran on a night one adapter degraded."""
        from tests.test_autonomy_orchestrator import (
            AutonomyOrchestratorTests,
            _fake_plan_synthesizer,
        )

        v9_runner = Mock()
        v9_runner.run.return_value = Mock(
            terminal_state="IMPLEMENTATION_SKIPPED", pr_url=None,
            rejection_class="fixture_v9_runner", specialist_review_signal=None,
        )
        result, planner, rows = self._run_with(
            {
                "status": "completed", "runtime_status": "degraded",
                "non_ok_tools": [EVIDENCE_ERROR_RUN],
                "degraded_tools": degraded_tool_records([EVIDENCE_ERROR_RUN]),
                "tool_run_summary": [OK_RUN, EVIDENCE_ERROR_RUN],
            },
            plan_synthesizer=_fake_plan_synthesizer,
            v9_implementation_runner=v9_runner,
        )
        self.assertTrue(result["exits_clean"])
        self.assertEqual(result["cycles_completed"], 1)
        self.assertEqual(rows[0]["status"], "degraded")
        outer = result["per_cycle"][0]
        # Convergence ran and the arbiter's verdict was recorded on a degraded night.
        self.assertEqual(outer["convergence"]["arbiter_verdict"], "converged")
        # The funnel counter: minted and converged, both on this night.
        self.assertEqual(
            AutonomyOrchestratorTests._funnel_counters(self.base),
            {"git_diff": {"cycles_minted": 1, "cycles_converged": 1, "cycles_merged": 0, "cycles_rejected": 0}},
        )
        # The post-CONVERGED chain, each by its own receipt.
        self.assertIn("status", outer["knowledge_signer"])
        self.assertIn("status", outer["memory_hook"])
        v9_runner.run.assert_called_once()
        self.assertEqual(outer["v9_implementation"]["rejection_class"], "fixture_v9_runner")
        # The drainers past convergence ran too: worker assignments and auto-merge.
        self.assertEqual(result["worker_assignments_dispatched"], 3)
        self.assertIn("auto_merge", outer)

    def test_an_integrity_failed_cycle_still_fails_closed(self) -> None:
        result, planner, rows = self._run_with({"status": "failed", "runtime_status": "integrity_failed"})
        self.assertEqual(result["cycles_completed"], 0)
        self.assertEqual(result["exit_reason"], "cycle_failed")
        planner.assert_not_called()
        self.assertEqual(rows[0]["status"], "failed")


class FullCycleTests(unittest.TestCase):
    """``run_enterprise_cycle`` on a real store: one evidence_error tool, one ok tool."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        fixture = cycle_workspace(Path(self.tmp.name))
        self.root = fixture.workspace_root
        self.tools_dir = fixture.tools_dir

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _cycle(self, cycle_id: str):
        from aria_kernel.cycle import run_enterprise_cycle

        return run_enterprise_cycle(workspace_root=self.root, cycle_id=cycle_id, base_dir=self.tools_dir)

    def test_one_evidence_error_tool_degrades_the_cycle_and_names_it(self) -> None:
        register_tool(shadow_tool(), base_dir=self.tools_dir)
        register_tool(self_output_tool(), base_dir=self.tools_dir)
        result = self._cycle("cyc-098-degraded")

        self.assertEqual(result["runtime_status"], "degraded")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["artifact_integrity"]["valid"], True)
        self.assertEqual(
            [(t["tool_id"], t["degradation_class"]) for t in result["degraded_tools"]],
            [("self-output-tool", "evidence_error")],
        )
        # The cycle sealed as completed, and every post-tool phase ran.
        cycle_rows = load_jsonl(self.tools_dir / "cycles.jsonl")
        self.assertEqual((cycle_rows[-1]["event"], cycle_rows[-1]["status"]), ("completed", "completed"))
        self.assertEqual(result["phases"]["pressure"]["outcome"], "ran")
        self.assertEqual(result["phases"]["tool_degradation"]["outcome"], "ran")
        # The tool phase named it and the governance ledger carries it.
        recorded = result["tool_degradation"]["recorded"]
        self.assertEqual(recorded[0]["tool_id"], "self-output-tool")
        self.assertEqual(recorded[0]["degradation_class"], "evidence_error")
        self.assertEqual(recorded[0]["consecutive_cycles"], 1)
        governance = [row for row in load_jsonl(self.tools_dir / "governance.jsonl") if row.get("kind") == "tool_run_degraded"]
        self.assertEqual(len(governance), 1)
        self.assertEqual(governance[0]["details"]["tool_id"], "self-output-tool")
        # The metrics row says degraded, not failed.
        metrics = load_jsonl(self.tools_dir / "observability" / "cycle-metrics.jsonl")
        self.assertEqual(metrics[-1]["status"], "degraded")
        # The quarantine machinery did its job on the tool AND its findings
        # (``feedback_store.record_raw_findings_for_run`` flags an
        # evidence_error run's raw findings ``invalid_evidence``, as it did
        # the 48 on trial eleven); the cycle did not die of it.
        self.assertEqual(result["tool_degradation"]["escalated"], [])
        self.assertEqual(degradation_report(self.tools_dir)["quarantined"], ["self-output-tool"])
        raw = [
            row for row in load_jsonl(self.tools_dir / "raw-findings.jsonl")
            if row.get("tool_id") == "self-output-tool" and row.get("cycle_id") == "cyc-098-degraded"
        ]
        self.assertTrue(raw, "the degraded tool's raw findings are recorded, not dropped")
        self.assertEqual({row["status"] for row in raw}, {"invalid_evidence"})

    def test_an_invalid_artifact_index_still_fails_closed(self) -> None:
        register_tool(shadow_tool(), base_dir=self.tools_dir)
        with patch(
            "aria_kernel.cycle.verify_artifacts",
            return_value={"status": "drift", "valid": False, "artifact_count": 1, "verified_count": 0, "issues": [{"code": "run_artifact_missing"}]},
        ):
            result = self._cycle("cyc-098-integrity")
        self.assertEqual(result["runtime_status"], "integrity_failed")
        self.assertEqual(result["status"], "failed")
        cycle_rows = load_jsonl(self.tools_dir / "cycles.jsonl")
        self.assertEqual(cycle_rows[-1]["status"], "failed")
        metrics = load_jsonl(self.tools_dir / "observability" / "cycle-metrics.jsonl")
        self.assertEqual(metrics[-1]["status"], "integrity_failed")

    def test_n_consecutive_degraded_cycles_reach_an_operator(self) -> None:
        # A crashing tool is the class the quarantine trigger does NOT price
        # (no ledger corruption), so it stays in the roster and stays dark.
        crashing = shadow_tool()
        crashing["tool_id"] = "crashing-tool"
        crashing["runner"] = {
            **crashing["runner"],
            "argv": [*fake_tool_argv(tool_output()), "--exit-code", "3"],
        }
        register_tool(crashing, base_dir=self.tools_dir)
        cycle_ids = [f"cyc-098-streak-{n}" for n in range(TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK)]
        # The earlier nights are the runner's own rows (`run_tool` → `record_run`),
        # not synthetic ledger lines; only the night that crosses the streak
        # is driven through the whole cycle.
        for cycle_id in cycle_ids[:-1]:
            decision = run_tool("crashing-tool", {}, cycle_id, workspace_root=self.root, base_dir=self.tools_dir)
            self.assertEqual(decision["envelope"]["status"], "crash")
            self.assertEqual(decision["action"], "none", "a plain crash does not quarantine")
        self.assertEqual(
            consecutive_degraded_cycles("crashing-tool", base_dir=self.tools_dir),
            list(reversed(cycle_ids[:-1])),
        )
        self.assertEqual(list_human_required(base_dir=self.tools_dir), [])
        result = self._cycle(cycle_ids[-1])
        self.assertEqual(result["runtime_status"], "degraded")
        recorded = result["tool_degradation"]["recorded"][0]
        self.assertEqual(recorded["consecutive_cycles"], TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK)
        self.assertEqual(consecutive_degraded_cycles("crashing-tool", base_dir=self.tools_dir), list(reversed(cycle_ids)))
        escalated = result["tool_degradation"]["escalated"]
        self.assertEqual(escalated[0]["tool_id"], "crashing-tool")
        self.assertEqual(escalated[0]["degradation_class"], "crash")
        open_records = list_human_required(base_dir=self.tools_dir)
        self.assertEqual(len(open_records), 1)
        record = open_records[0]
        self.assertEqual(record["request_id"], f"tool-degraded:crashing-tool:{cycle_ids[0]}")
        self.assertEqual(record["severity"], "HIGH")
        self.assertEqual(record["context"]["kind"], "tool_degradation")
        self.assertEqual(record["context"]["tool_id"], "crashing-tool")
        self.assertEqual(record["context"]["degradation_class"], "crash")
        self.assertEqual(record["context"]["cycle_ids"], list(reversed(cycle_ids)))
        # The doctor's organ reports it as a FAIL naming the tool.
        from aria_kernel.doctor import _check_tools

        check = _check_tools(self.tools_dir)
        self.assertEqual(check.status, "fail")
        self.assertIn("crashing-tool", check.reason)
        # A further night on the same streak does not open a second record.
        from aria_kernel.tool_degradation import record_cycle_degradation

        run_tool("crashing-tool", {}, "cyc-098-streak-again", workspace_root=self.root, base_dir=self.tools_dir)
        again = record_cycle_degradation(
            cycle_id="cyc-098-streak-again", base_dir=self.tools_dir,
            degraded=degraded_tool_records([{"tool_id": "crashing-tool", "run_id": "r", "status": "crash", "artifact_status": "present"}]),
        )
        self.assertEqual(again["escalated"][0]["consecutive_cycles"], TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK + 1)
        self.assertEqual(len(list_human_required(base_dir=self.tools_dir)), 1)
        # The exit the escalation names: the operator archives the tool. A
        # tool the cycle will never dispatch again has no standing in the
        # organ (the doctor clears; the scheduler stops paging), while the
        # record the escalation opened stays with the operator to resolve.
        from aria_kernel.tool_degradation import degradation_report
        from aria_kernel.tool_registry import transition_tool

        transition_tool("crashing-tool", "ARCHIVED", reason="retired after the streak",
                        operator_approval=True, base_dir=self.tools_dir)
        self.assertEqual(degradation_report(self.tools_dir)["degraded"], [])
        self.assertEqual(_check_tools(self.tools_dir).status, "ok")
        self.assertEqual([row["request_id"] for row in list_human_required(base_dir=self.tools_dir)],
                         [f"tool-degraded:crashing-tool:{cycle_ids[0]}"])
        again = record_cycle_degradation(cycle_id="cyc-098-after-archive", base_dir=self.tools_dir, degraded=[])
        self.assertEqual(again, {"recorded": [], "escalated": []}, "an archived tool is not a sat-out tool")

    def test_a_quarantined_tool_sitting_out_cycles_reaches_an_operator(self) -> None:
        # The trial-eleven class itself: an evidence_error run quarantines the
        # tool on the spot (``tool_health.immediate_quarantine_reason``) and
        # ``_phase_tools`` never dispatches a QUARANTINED tool again, so its
        # run history ends at one degraded run. Verifier defect 2: a streak
        # read off runs.jsonl alone froze at 1 for exactly this class, and the
        # only readout was a doctor WARN. The cycles it sits out ARE its streak.
        from aria_kernel.doctor import _check_tools
        from aria_kernel.tool_registry import get_tool, unquarantine_tool
        from aria_kernel.tool_sit_out import QUARANTINED_CLASS

        register_tool(shadow_tool(), base_dir=self.tools_dir)
        register_tool(self_output_tool(), base_dir=self.tools_dir)

        first = self._cycle("cyc-098-q1")
        self.assertEqual(first["runtime_status"], "degraded")
        self.assertEqual(get_tool("self-output-tool", self.tools_dir)["status"], "QUARANTINED")
        recorded = first["tool_degradation"]["recorded"]
        self.assertEqual([(r["tool_id"], r["degradation_class"], r["consecutive_cycles"]) for r in recorded],
                         [("self-output-tool", "evidence_error", 1)])
        self.assertEqual(first["tool_degradation"]["escalated"], [])
        report = degradation_report(self.tools_dir)
        self.assertEqual(report["quarantined"], ["self-output-tool"])
        self.assertEqual(
            [(d["tool_id"], d["degradation_class"], d["consecutive_cycles"], d["human_required"]) for d in report["degraded"]],
            [("self-output-tool", "evidence_error", 1, False)],
        )

        second = self._cycle("cyc-098-q2")
        # The cycle itself is fine — the tool did not run, so nothing ran
        # wrong tonight; the tool's standing is what degraded.
        self.assertEqual(second["runtime_status"], "ok")
        self.assertEqual(second["degraded_tools"], [])
        recorded = second["tool_degradation"]["recorded"]
        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["tool_id"], "self-output-tool")
        self.assertEqual(recorded[0]["degradation_class"], QUARANTINED_CLASS)
        self.assertEqual(recorded[0]["consecutive_cycles"], 2)
        self.assertIsNone(recorded[0]["run_id"])
        self.assertIn("self-output evidence", recorded[0]["quarantine_reason"])
        self.assertEqual(second["tool_degradation"]["escalated"], [])
        self.assertEqual(consecutive_degraded_cycles("self-output-tool", base_dir=self.tools_dir), ["cyc-098-q2", "cyc-098-q1"])
        self.assertEqual(list_human_required(base_dir=self.tools_dir), [])
        check = _check_tools(self.tools_dir)
        self.assertEqual(check.status, "warn")
        self.assertIn(f"self-output-tool={QUARANTINED_CLASS}x2", check.reason)

        third = self._cycle("cyc-098-q3")
        self.assertEqual(third["runtime_status"], "ok")
        recorded = third["tool_degradation"]["recorded"][0]
        self.assertEqual((recorded["degradation_class"], recorded["consecutive_cycles"]), (QUARANTINED_CLASS, 3))
        escalated = third["tool_degradation"]["escalated"]
        self.assertEqual(
            [(e["tool_id"], e["degradation_class"], e["consecutive_cycles"]) for e in escalated],
            [("self-output-tool", QUARANTINED_CLASS, 3)],
        )
        records = list_human_required(base_dir=self.tools_dir)
        self.assertEqual(len(records), 1)
        record = records[0]
        # Keyed on the quarantining cycle: the streak began the night the tool
        # last answered, and that is the night the operator needs to look at.
        self.assertEqual(record["request_id"], "tool-degraded:self-output-tool:cyc-098-q1")
        self.assertEqual(record["severity"], "HIGH")
        self.assertEqual(record["context"]["kind"], "tool_degradation")
        self.assertEqual(record["context"]["degradation_class"], QUARANTINED_CLASS)
        self.assertEqual(record["context"]["cycle_ids"], ["cyc-098-q3", "cyc-098-q2", "cyc-098-q1"])
        self.assertIn("self-output evidence", record["context"]["quarantine_reason"])
        self.assertIn("unquarantine_tool", record["reason"])
        self.assertEqual(_check_tools(self.tools_dir).status, "fail")
        governance = [row for row in load_jsonl(self.tools_dir / "governance.jsonl") if row.get("kind") == "tool_run_degraded"]
        self.assertEqual([row["details"]["consecutive_cycles"] for row in governance], [1, 2, 3])

        # The operator's release is the intervention the record asked for, so
        # it ends the streak it was asked about: a tool released with a fix
        # that did NOT take breaks again on night 4 and is re-quarantined —
        # and that is a NEW streak of one, keyed on night 4, not night 5 of
        # the old one under a record id the operator may have resolved.
        unquarantine_tool(
            "self-output-tool", operator_approval_ref="op-098", reason="adapter fixed",
            root_cause_note="evidence pointed at the run ledger", fixture_update_ref="fixtures/self-output-tool@2",
            base_dir=self.tools_dir,
        )
        fourth = self._cycle("cyc-098-q4")
        self.assertEqual(fourth["runtime_status"], "degraded")
        self.assertEqual(get_tool("self-output-tool", self.tools_dir)["status"], "QUARANTINED")
        recorded = fourth["tool_degradation"]["recorded"][0]
        self.assertEqual((recorded["degradation_class"], recorded["consecutive_cycles"]), ("evidence_error", 1))
        self.assertEqual(fourth["tool_degradation"]["escalated"], [])
        self.assertEqual(consecutive_degraded_cycles("self-output-tool", base_dir=self.tools_dir), ["cyc-098-q4"])
        self.assertEqual(len(list_human_required(base_dir=self.tools_dir)), 1)
        self.assertEqual(_check_tools(self.tools_dir).status, "warn")

        # Released again with a fix that takes: back in the roster, answering
        # ok, the streak is over and the doctor's organ is clean again.
        unquarantine_tool(
            "self-output-tool", operator_approval_ref="op-098-2", reason="adapter fixed",
            root_cause_note="evidence pointed at the run ledger", fixture_update_ref="fixtures/self-output-tool@3",
            base_dir=self.tools_dir,
        )
        repaired = shadow_tool()
        repaired["tool_id"] = "self-output-tool"
        repaired["status"] = "CALIBRATE"
        register_tool(repaired, base_dir=self.tools_dir)
        fifth = self._cycle("cyc-098-q5")
        self.assertEqual(fifth["runtime_status"], "ok")
        self.assertEqual(fifth["tool_degradation"], {"status": "completed", "recorded": [], "escalated": []})
        self.assertEqual(consecutive_degraded_cycles("self-output-tool", base_dir=self.tools_dir), [])
        self.assertEqual(degradation_report(self.tools_dir)["degraded"], [])
        self.assertEqual(_check_tools(self.tools_dir).status, "ok")


if __name__ == "__main__":
    unittest.main()
