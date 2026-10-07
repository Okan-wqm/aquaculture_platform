"""ARIA-HIGH-370 — kernel-attributed failure modes gate candidate admission.

THE DEFECT. The 2026-10-06 loop RCA (blocker 7): the synthesizer admitted the
same failing_ci candidate cycle after cycle — four plans on one
``gh-run-list:`` pseudo-ref, each refused for that ref — because nothing
between the recorded failures and the next admission read them. The lesson
reader (ARIA-HIGH-309) tells the next planner; it cannot stop the next
identical plan from being minted.

Pinned here through the production provider (``V9PressureSourceProvider``)
over a real checkout and the kernel's own plan writers:

1. three attributed failures of one candidate in one mode refuse it
   unchanged, with one named skip carrying the lesson as its evidence;
2. a candidate built on different grounds is admitted;
3. a converged episode, a different mode, or fewer than three attributed
   attempts admit it; unattributed episodes (a stall) are skipped, not
   counted.
"""
from __future__ import annotations

from typing import Any

from aria_kernel.admission_lessons import RECURRING_ATTRIBUTED_FAILURE, recurring_attributed_refusal
from aria_kernel.agent_eval import observe_agent_performance
from aria_kernel.plan_convergence import abandon_plan, force_plan_human_required, start_plan

from tests.test_plan_evidence_admissibility import (
    EPISODE_16_JOBS,
    EPISODE_16_RUN_ROW,
    EPISODE_16_WORKFLOWS,
    _Checkout,
    _scan,
)


class RecurringAttributedFailureRefusesTheCandidateTests(_Checkout):
    def setUp(self) -> None:
        super().setUp()
        self.candidates, _ = _scan(self.repo, runs=[EPISODE_16_RUN_ROW], workflows=EPISODE_16_WORKFLOWS,
                                   jobs=EPISODE_16_JOBS)
        envelope = self.synthesize(self.candidates, cycle_id="cyc-first")
        assert envelope is not None
        self.content: dict[str, Any] = dict(envelope.content)

    def fail(self, plan_id: str, reason: str, content: dict[str, Any] | None = None) -> None:
        start_plan(plan_id=plan_id, initial_revision_id="rev-0", plan_content=content or self.content,
                   base_dir=self.tools, workspace_root=self.repo)
        if reason == "stalled":
            abandon_plan(plan_id=plan_id, reason="stalled: no plan event (> 72h at adoption)", base_dir=self.tools)
        else:
            force_plan_human_required(plan_id=plan_id, round_number=1, reason_codes=[reason], base_dir=self.tools)

    def test_three_attributed_failures_in_one_mode_refuse_the_unchanged_candidate(self) -> None:
        for n in (1, 2, 3):
            self.fail(f"plan-ci-{n}", "coverage_gaps_present")
        self.fail("plan-ci-stalled", "stalled")  # a lane failure: skipped, never counted
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")

        self.assertIsNone(self.synthesize(self.candidates, cycle_id="cyc-again"))

        skipped = [s for s in self.governance("plan_candidate_conversion_skipped") if "lesson" in s]
        self.assertEqual(len(skipped), 1)
        self.assertEqual((skipped[0]["reason"], skipped[0]["runner_fault"]), (RECURRING_ATTRIBUTED_FAILURE, False))
        self.assertEqual((skipped[0]["lesson"]["failure_mode"], skipped[0]["lesson"]["plan_ids"]),
                         ("coverage_gaps_present", ["plan-ci-1", "plan-ci-2", "plan-ci-3"]))

    def test_a_candidate_on_other_grounds_is_admitted(self) -> None:
        other = {**self.content, "evidence_refs": ["docs/aria/SPEC.md"]}
        for n in (1, 2, 3):
            self.fail(f"plan-other-{n}", "coverage_gaps_present", content=other)
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")

        self.assertIsNotNone(self.synthesize(self.candidates, cycle_id="cyc-again"))

    def test_a_mixed_window_or_a_short_history_admits_it(self) -> None:
        self.fail("plan-a", "coverage_gaps_present")
        self.fail("plan-b", "coverage_gaps_present")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs")
        self.assertIsNone(recurring_attributed_refusal(base_dir=self.tools, plan_content=self.content))

        self.fail("plan-c", "critical_risks_present")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-obs-2")
        self.assertIsNone(recurring_attributed_refusal(base_dir=self.tools, plan_content=self.content))

    def test_the_identity_ignores_line_numbers_and_run_ids_but_not_files(self) -> None:
        from aria_kernel.admission_lessons import candidate_identity

        base = {"finding_id": None, "evidence_refs": [".github/workflows/x.yml:10", "gh-run-list:ci-run-1"]}
        moved = {"finding_id": None, "evidence_refs": [".github/workflows/x.yml:99", "gh-run-list:ci-run-2"]}
        other = {"finding_id": None, "evidence_refs": [".github/workflows/y.yml:10", "gh-run-list:ci-run-1"]}
        self.assertEqual(candidate_identity(base), candidate_identity(moved))
        self.assertNotEqual(candidate_identity(base), candidate_identity(other))


if __name__ == "__main__":
    import unittest

    unittest.main()
