"""ARIA-HIGH-370 — kernel-attributed failure modes gate candidate admission.

THE DEFECT. The 2026-10-06 loop RCA (blocker 7): the synthesizer admitted the
same failing_ci candidate cycle after cycle because nothing between the
recorded failures and the next admission read them.

Pinned here, through the production provider (``V9PressureSourceProvider``,
after #1826's slot policy) and on :class:`AdmissionHistory` directly:

1. three plan-attributed failures of one identity in one mode refuse it
   unchanged, with one named skip carrying the lesson;
2. (review of #1829, HIGH-3) the breaker is half-open: one probe after
   ``PROBE_INTERVAL`` or when the gate epoch moved; a challenger's or a
   critic's refused output never refuses the drafter's candidate; a failing-CI
   identity is its workflow and failing ``job::step`` signature, not the run;
   an F identity is its ARIA-HIGH-363 subject;
3. a converged episode, a mixed window or a short history admit it.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

from aria_kernel.admission_lessons import (
    RECURRING_ATTRIBUTED_FAILURE,
    RECURRING_FAILURE_PROBE,
    AdmissionHistory,
    admission_verdict,
    candidate_identity,
)
from aria_kernel.agent_eval import observe_agent_performance
from aria_kernel.plan_convergence import start_plan

from tests._helpers.plan_evaluations import evaluator_escalation
from tests.test_plan_evidence_admissibility import (
    EPISODE_16_JOBS,
    EPISODE_16_RUN_ROW,
    EPISODE_16_WORKFLOWS,
    _Checkout,
    _scan,
)

NOW = datetime(2026, 10, 20, tzinfo=timezone.utc)


def episode(plan: str, days_ago: float, *, role: str = "drafter", mode: str = "coverage_gaps_present",
            success: bool = False, epoch: str | None = None) -> dict[str, Any]:
    return {"plan_id": plan, "role": "drafter", "success": success, "attributable": True,
            "failure_mode": None if success else mode, "attribution": None if success else {"role": role},
            "occurred_at": (NOW - timedelta(days=days_ago)).isoformat(), "gate_epoch": epoch}


def history(*rows: dict[str, Any], identity: str = "id-1") -> AdmissionHistory:
    return AdmissionHistory({row["plan_id"]: identity for row in rows}, tuple(rows), None, NOW)


CONTENT = {"evidence_refs": ["x"]}


class BreakerTests(unittest.TestCase):
    def verdict(self, *rows: dict[str, Any]) -> dict[str, Any] | None:
        with patch("aria_kernel.admission_lessons.candidate_identity", return_value="id-1"):
            return admission_verdict(history(*rows), CONTENT)

    def test_three_recent_failures_in_one_mode_open_the_breaker(self) -> None:
        found = self.verdict(episode("a", 3), episode("b", 2), episode("c", 1))
        self.assertEqual((found["reason"], found["breaker"]), (RECURRING_ATTRIBUTED_FAILURE, "breaker_open"))

    def test_after_the_probe_interval_one_probe_is_admitted(self) -> None:
        found = self.verdict(episode("a", 10), episode("b", 9), episode("c", 8))
        self.assertEqual((found["reason"], found["breaker"]), (RECURRING_FAILURE_PROBE, "probe_interval_elapsed"))

    def test_a_moved_gate_epoch_admits_one_probe(self) -> None:
        found = self.verdict(episode("a", 3), episode("b", 2), episode("c", 1, epoch="sha256:old"))
        self.assertEqual(found["breaker"], "gate_epoch_changed")

    def test_challenger_and_critic_failures_never_refuse_the_drafters_candidate(self) -> None:
        self.assertIsNone(self.verdict(episode("a", 3, role="challenger_plan"),
                                       episode("b", 2, role="completeness_critique"),
                                       episode("c", 1, role="challenger_plan")))

    def test_a_success_or_a_mixed_window_admits(self) -> None:
        self.assertIsNone(self.verdict(episode("a", 3), episode("b", 2, success=True), episode("c", 1)))
        self.assertIsNone(self.verdict(episode("a", 3), episode("b", 2, mode="high_risks_present"), episode("c", 1)))
        self.assertIsNone(self.verdict(episode("b", 2), episode("c", 1)))


class IdentityTests(unittest.TestCase):
    def test_a_failing_ci_identity_is_its_workflow_and_failing_steps_not_its_run(self) -> None:
        sig = {"workflow_path": ".github/workflows/ci.yml", "failed": ["build::lint"]}
        run_a = {"failing_signature": sig, "evidence_refs": [".github/workflows/ci.yml:10"],
                 "provenance_refs": ["gh-run-list:ci-run-1"]}
        run_b = {**run_a, "evidence_refs": [".github/workflows/ci.yml:12"], "provenance_refs": ["gh-run-list:ci-run-2"]}
        other_step = {**run_a, "failing_signature": {**sig, "failed": ["test::unit"]}}
        self.assertEqual(candidate_identity(run_a, None), candidate_identity(run_b, None))
        self.assertNotEqual(candidate_identity(run_a, None), candidate_identity(other_step, None))

    def test_an_f_identity_is_its_subject_whatever_its_id_and_refs(self) -> None:
        def drift(line: int) -> dict[str, Any]:
            return {"originating_skill": "seed:drift-scan", "claim_summary": "ui_option_drift: 'x'",
                    "evidences": [{"ref": f"web/a.tsx:{line}", "summary": "statusOptions values: a"},
                                  {"ref": "apps/b.ts:3", "summary": "LeaveStatus values: A"}]}

        findings = {"F-1": drift(10), "F-2": drift(99)}
        one = candidate_identity({"finding_id": "F-1", "evidence_refs": ["web/a.tsx:10"]}, findings)
        two = candidate_identity({"finding_id": "F-2", "evidence_refs": ["web/a.tsx:99", "apps/b.ts:3"]}, findings)
        self.assertEqual(one, two)



class TheSynthesizerRecordsTheSignatureTests(_Checkout):
    def test_the_synthesizer_records_the_failing_signature(self) -> None:
        candidates, _ = _scan(self.repo, runs=[EPISODE_16_RUN_ROW], workflows=EPISODE_16_WORKFLOWS,
                              jobs=EPISODE_16_JOBS)
        envelope = self.synthesize(candidates)
        self.assertEqual(envelope.content["failing_signature"]["failed"],
                         ["verify::Observe production WAL archive runtime"])


class TheProviderRefusesARecurringCandidateTests(_Checkout):
    def setUp(self) -> None:
        super().setUp()
        self.candidates, _ = _scan(self.repo, runs=[EPISODE_16_RUN_ROW], workflows=EPISODE_16_WORKFLOWS,
                                   jobs=EPISODE_16_JOBS)
        envelope = self.synthesize(self.candidates, cycle_id="cyc-first")
        assert envelope is not None
        self.content: dict[str, Any] = dict(envelope.content)

    def fail(self, plan_id: str, code: str, content: dict[str, Any] | None = None) -> None:
        start_plan(plan_id=plan_id, initial_revision_id="rev-0", plan_content=content or self.content,
                   base_dir=self.tools, workspace_root=self.repo)
        evaluator_escalation(self.tools, plan_id, code)

    def no_cooling(self) -> Any:
        # #1826's slot policy cools this workflow for three days after any
        # failed plan; this brake is judged on what the slot policy kept.
        return patch("aria_kernel.plan_slot_policy._cooling_plan", return_value=None)

    def test_three_attributed_failures_in_one_mode_refuse_the_unchanged_candidate(self) -> None:
        for n in (1, 2, 3):
            self.fail(f"plan-ci-{n}", "coverage_gaps_present")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")

        with self.no_cooling():
            self.assertIsNone(self.synthesize(self.candidates, cycle_id="cyc-again"))

        skipped = [s for s in self.governance("plan_candidate_conversion_skipped") if "lesson" in s]
        self.assertEqual(len(skipped), 1)
        self.assertEqual((skipped[0]["reason"], skipped[0]["runner_fault"]), (RECURRING_ATTRIBUTED_FAILURE, False))
        self.assertEqual((skipped[0]["lesson"]["failure_mode"], skipped[0]["lesson"]["plan_ids"]),
                         ("coverage_gaps_present", ["plan-ci-1", "plan-ci-2", "plan-ci-3"]))

    def test_inside_the_slot_policys_cool_off_only_the_slot_policy_speaks(self) -> None:
        # The two brakes compose: #1826 drops the cooling workflow before
        # admission, so this brake never adds a second refusal for it.
        for n in (1, 2, 3):
            self.fail(f"plan-ci-{n}", "coverage_gaps_present")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")

        self.assertIsNone(self.synthesize(self.candidates, cycle_id="cyc-again"))

        self.assertEqual([s for s in self.governance("plan_candidate_conversion_skipped") if "lesson" in s], [])
        dropped = self.governance("plan_slot_policy_applied")[-1]["dropped"]
        self.assertEqual([d["reason"] for d in dropped], ["failing_ci_subject_cool_off"])

    def test_a_different_failing_step_is_another_candidate(self) -> None:
        other = {**self.content, "failing_signature": {**self.content["failing_signature"], "failed": ["verify::x"]}}
        for n in (1, 2, 3):
            self.fail(f"plan-other-{n}", "coverage_gaps_present", content=other)
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")
        with self.no_cooling():
            self.assertIsNotNone(self.synthesize(self.candidates, cycle_id="cyc-again"))

    def test_the_probe_is_admitted_and_disclosed(self) -> None:
        for n in (1, 2, 3):
            self.fail(f"plan-ci-{n}", "coverage_gaps_present")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")
        later = datetime.now(timezone.utc) + timedelta(days=8)
        real_load = AdmissionHistory.load.__func__

        def load(cls: type, base_dir: Any, *, findings: Any, now: Any = None) -> AdmissionHistory:
            return real_load(cls, base_dir, findings=findings, now=later)

        with self.no_cooling(), patch.object(AdmissionHistory, "load", classmethod(load)):
            self.assertIsNotNone(self.synthesize(self.candidates, cycle_id="cyc-probe"))
        selected = self.governance("plan_candidate_source_selected")
        self.assertEqual(selected[-1]["lesson_probe"]["breaker"], "probe_interval_elapsed")


if __name__ == "__main__":
    unittest.main()
