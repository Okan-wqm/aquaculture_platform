"""ARIA-MEDIUM-742 (package F3.1) — one subject has one change in flight: the aging F source does not re-plan it.

WHAT BASE DOES TODAY (measured on a fixture, ``V9PressureSourceProvider`` over a plan in ``IMPLEMENTATION_REQUESTED``
for F-100): the F source selects F-100 again. ADR-0003's loop guards (``finding_grounding._loop_refusal``) judge the
subject by what ENDED (a failed plan cools it off, an attributed revert quarantines it, a merge feeds the self-loop
guard); none of them looks at a plan that has not ended. So a subject whose change is requested, in flight or recorded
with an open PR is planned a second time, a full planner-challenger-reviewer debate each, for a change that is already
being made.

WHAT THIS PINS (MEDIUM-742 verbatim: "one subject has one change in flight"):

* a plan whose implementation has been requested and whose change has not ended holds its subject:
  ``IMPLEMENTATION_REQUESTED``, ``IMPLEMENTATION_IN_FLIGHT``, and ``IMPLEMENTATION_RECORDED`` while its PR holds the
  delivered change, refuse the aging candidate by name ``f_finding_subject_change_in_flight`` with
  ``loop_guard == {"plan_id", "state"}``; the subject is the finding's SUBJECT (siblings share it), never its id;
* "its PR holds the change" is asked of the PR lifecycle LEDGER (``merge_record.pr_holds_change``), never inferred from
  the plan state: a PR closed unmerged (or whose merge was refused) frees the subject, a merged PR the reconciler has not
  folded yet, a merge whose head is being read, an open PR, and a missing ``opened`` row (a damaged ledger) all hold it;
* it speaks LAST among the subject guards (a cool-off or a quarantine keeps its own name), never refuses an operator
  request, never fires for a plan that is only CONVERGED, MERGED or of another subject, and costs nothing when the plan
  ledger holds no implementation event (no plan is folded), and a ledger the fold refuses refuses every F candidate by
  name (``f_finding_loop_history_unavailable``), as the existing ledger faults do.

BUILD. Plans are made by the REAL writers (``drive_plan_to_converged`` + ``request_implementation`` +
``record_implementation_started`` + ``record_implementation_outcome``), with the impact graph the fixture checkout
cannot supply stood in for (``plan_origin.compute_admission_scope`` returns None, as for a plan with no finding origin);
every plan asserts its folded state, so a seed that does not fold fails loudly. PR rows are the owner's writers
(``record_pr_unmergeable``, ``record_merge``) over the kernel's ``opened`` row.

NEW API. ``SUBJECT_CHANGE_IN_FLIGHT`` and ``PlanRecord.in_flight_state`` are reached through helpers that raise
``AssertionError`` at base; the reason is also spelled as a literal here, so base is red by assertion.
"""
from __future__ import annotations

import ast
import contextlib
import dataclasses
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import finding_grounding as fg
from aria_kernel import merge_record
from aria_kernel import plan_convergence as pc
from aria_kernel.implementation_reconciler import reconcile_recorded_implementations
from aria_kernel.plan_convergence import (
    _record_implementation_merged,
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
    request_implementation,
)
from tests._helpers.operator_requests import GROUNDED_FILE
from tests.test_f_finding_loop_guards import _OTHER_FILE, _LoopFixture
from tests.test_implementation_lifecycle_continuity import (
    converging_plan_content,
    drive_plan_to_converged,
    seed_reviewer_agent,
)
from tests.test_merge_record import MERGE_SHA, PR, TIP, Reader, _opened

IN_FLIGHT = "f_finding_subject_change_in_flight"
_PREVIOUS_GUARD_REASONS = (
    "f_finding_loop_history_unavailable", "f_finding_self_loop_origin_surface", "f_finding_self_loop_own_change",
    "f_finding_self_loop_watchdog_recent", "f_finding_global_cap_exceeded", "f_finding_subject_quarantined",
    "f_finding_subject_cool_off", "f_finding_watchdog_resolution_streak",
)


def _reason_constant() -> str:
    if not hasattr(fg, "SUBJECT_CHANGE_IN_FLIGHT"):
        raise AssertionError("F3.1: finding_grounding.SUBJECT_CHANGE_IN_FLIGHT does not exist (the guard does not exist)")
    return fg.SUBJECT_CHANGE_IN_FLIGHT


def plan_record(**fields):
    """A ``PlanRecord`` that may carry ``in_flight_state`` (absent at base: an assertion, not a ``TypeError``)."""
    if "in_flight_state" in fields and "in_flight_state" not in {item.name for item in dataclasses.fields(fg.PlanRecord)}:
        raise AssertionError("F3.1: finding_grounding.PlanRecord has no in_flight_state (the in-flight fold does not exist)")
    return fg.PlanRecord(**fields)


class InFlightFixture(_LoopFixture):
    """``_LoopFixture`` with real, in-flight plans and the PR rows the kernel writes for them."""

    def setUp(self) -> None:
        super().setUp()
        # A plan started a moment ago would trip the daily cap (one F plan per 24h) before any subject guard speaks.
        self.policy({"max_plans_per_24h": 24})
        seed_reviewer_agent(self.fx.repo)

    # -- plans, built by the real writers ------------------------------------------------------------------------
    def plan_at(self, plan_id: str, finding_id: str, state: str, *, tip: str = TIP, pr: int = PR) -> None:
        tools, repo = self.fx.tools, self.fx.repo
        content = converging_plan_content(plan_id, finding_id=finding_id)
        with mock.patch("aria_kernel.plan_origin.compute_admission_scope", return_value=None):
            drive_plan_to_converged(plan_id=plan_id, tools=tools, workspace_root=repo, plan_content=content)
        if state != "CONVERGED":
            request_implementation(
                plan_id=plan_id, implementer_agent="aria-implementer", converged_plan_revision_id="rev-0",
                converged_plan_content_hash=fold_plan_state(plan_id=plan_id, base_dir=tools)["latest_revision"]["content_hash"],
                base_dir=tools)
        if state in ("IMPLEMENTATION_IN_FLIGHT", "IMPLEMENTATION_RECORDED", "IMPLEMENTATION_MERGED"):
            record_implementation_started(plan_id=plan_id, claim_id=f"claim-{plan_id}", implementer_agent="aria-implementer",
                                          started_at="2026-08-12T10:00:00Z", base_dir=tools)
        if state in ("IMPLEMENTATION_RECORDED", "IMPLEMENTATION_MERGED"):
            record_implementation_outcome(
                plan_id=plan_id, claim_id=f"claim-{plan_id}", pr_url=f"https://github.com/o/r/pull/{pr}",
                diff_hash="sha256:" + "c" * 64, branch_tip_sha=tip, base_branch_sha="e" * 40, validation_results=[],
                signer_key_fp="fp-1", completed_at="2026-08-12T10:30:00Z", base_dir=tools)
        if state == "IMPLEMENTATION_MERGED":
            _record_implementation_merged(plan_id=plan_id, merge_sha=MERGE_SHA, merged_at="2026-08-12T12:00:00Z",
                                          idempotency_key_hash="sha256:" + "a" * 64, head_lineage="delivered", base_dir=tools)
        self.assertEqual(fold_plan_state(plan_id=plan_id, base_dir=tools)["state"], state, "the seed did not fold to its state")

    # -- PR lifecycle rows, written by their owners ----------------------------------------------------------------
    def opened(self, *, head_sha: str = TIP, pr: int = PR) -> None:
        _opened(self.fx.tools, change_id=f"chg-{pr}", head_sha=head_sha, pr_number=pr)

    def _opened_row(self, pr: int = PR) -> dict:
        row = merge_record.opened_row(merge_record.lifecycle_rows(self.fx.tools), pr_number=pr)
        self.assertIsNotNone(row, "no opened row was seeded")
        return row

    def pr_observation(self, event: str, reason: str, *, pr: int = PR) -> None:
        self.assertTrue(merge_record.record_pr_unmergeable(pr=self._opened_row(pr), event=event, reason=reason,
                                                           base_dir=self.fx.tools))

    def closed(self) -> None:
        self.pr_observation(merge_record.EVENT_CLOSED_UNMERGED, "closed_unmerged_on_github")

    def unproven(self) -> None:
        self.pr_observation(merge_record.EVENT_MERGE_UNPROVEN, "merged_head_is_not_the_delivered_change:head_diverged")

    def lineage_unverified(self) -> None:
        self.pr_observation(merge_record.EVENT_LINEAGE_UNVERIFIED, "merged_head_unreadable")

    def pr_merged(self) -> None:
        merge_record.record_merge(pr=self._opened_row(), merged_by=merge_record.MERGED_BY_OBSERVED, base_dir=self.fx.tools,
                                  merge_sha=MERGE_SHA, merged_at="2026-10-09T12:00:00Z", merged_head_sha=TIP,
                                  head_lineage=merge_record.LINEAGE_DELIVERED)

    # -- what the F source does ------------------------------------------------------------------------------------
    def admission(self, finding_id: str) -> fg.FindingAdmission:
        context = fg.load_grounding_context(self.fx.repo, tools_root=self.fx.tools)
        return fg.admit_candidate({"source_type": "f_finding", "candidate_id": finding_id}, context)

    def assert_refused(self, finding_id: str, plan_id: str, state: str) -> None:
        admission = self.admission(finding_id)
        self.assertEqual((admission.reason, admission.loop_guard), (IN_FLIGHT, {"plan_id": plan_id, "state": state}))

    def assert_not_in_flight(self, finding_id: str, *, reason: str | None = None) -> None:
        admission = self.admission(finding_id)
        self.assertEqual(admission.reason, reason, admission.loop_guard)

    def assert_the_guard_is_alive(self, *, plan_id: str = "plan-ctl", finding_id: str = "F-300") -> None:
        """The control of a near-miss test: ANOTHER subject's requested plan is refused by name, in this very store."""
        self.finding(finding_id, _OTHER_FILE)
        self.plan_at(plan_id, finding_id, "IMPLEMENTATION_REQUESTED")
        self.assert_refused(finding_id, plan_id, "IMPLEMENTATION_REQUESTED")


class AnInFlightChangeHoldsItsSubjectTests(InFlightFixture):
    """The five shapes of "the subject's change is in flight", refused by name through the F source's own provider."""

    def _refused_by_the_provider(self, state: str, *, rows) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", state)
        rows()
        self.assertIsNone(self.synthesize("cyc-held"))
        self.assertEqual(self.skips("cyc-held"), [("F-100", IN_FLIGHT)])
        self.assertEqual(self.skip_detail("F-100")["loop_guard"], {"plan_id": "plan-a", "state": state})

    def test_a_requested_implementation_holds_the_subject(self) -> None:
        self._refused_by_the_provider("IMPLEMENTATION_REQUESTED", rows=lambda: None)

    def test_an_implementation_in_flight_holds_the_subject(self) -> None:
        self._refused_by_the_provider("IMPLEMENTATION_IN_FLIGHT", rows=lambda: None)

    def test_a_recorded_plan_with_its_pr_open_holds_the_subject(self) -> None:
        self._refused_by_the_provider("IMPLEMENTATION_RECORDED", rows=self.opened)

    def test_a_recorded_plan_whose_merge_head_is_being_read_holds_the_subject(self) -> None:
        def rows() -> None:
            self.opened()
            self.lineage_unverified()

        self._refused_by_the_provider("IMPLEMENTATION_RECORDED", rows=rows)

    def test_a_recorded_plan_whose_pr_merged_before_the_reconciler_folded_it_holds_the_subject(self) -> None:
        def rows() -> None:
            self.opened()
            self.pr_merged()

        self._refused_by_the_provider("IMPLEMENTATION_RECORDED", rows=rows)


class WhatDoesNotHoldASubjectTests(InFlightFixture):
    """Each near-miss is admitted AND the guard is shown alive in the same store (so base is red for the guard, not green)."""

    def test_a_pr_closed_unmerged_frees_the_subject_until_it_is_merged_after_all(self) -> None:
        # The deadlock case: RECORDED is a plan state, and a person closing the PR never writes the plan ledger.
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_RECORDED")
        self.opened()
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_RECORDED")
        self.closed()
        self.assert_not_in_flight("F-100")
        # A closed PR that is reopened and merged holds the change again (merged outranks closed).
        self.pr_merged()
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_RECORDED")

    def test_a_merge_the_kernel_refused_as_unproven_frees_the_subject(self) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_RECORDED")
        self.opened()
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_RECORDED")
        self.unproven()
        self.assert_not_in_flight("F-100")

    def test_a_recorded_plan_whose_tip_has_no_opened_row_holds_the_subject_even_beside_another_heads_rows(self) -> None:
        # Fail closed: a damaged ledger (pr_manager writes `opened` at `gh pr create`) must not free the subject, and
        # the rows of ANOTHER head (a different PR, closed) say nothing about this plan's change.
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_RECORDED")
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_RECORDED")
        self.opened(head_sha="9" * 40, pr=PR + 1)
        self.pr_observation(merge_record.EVENT_CLOSED_UNMERGED, "closed_unmerged_on_github", pr=PR + 1)
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_RECORDED")

    def test_a_merged_plan_holds_nothing(self) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_MERGED")
        self.opened()
        self.assert_not_in_flight("F-100")
        self.assert_the_guard_is_alive()

    def test_a_plan_that_is_only_converged_holds_nothing(self) -> None:
        # FP-5 (a parked converged plan holds its candidate's identity) is a policy ruling this guard does not make.
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "CONVERGED")
        self.assert_not_in_flight("F-100")
        # ... until its implementation is requested.
        request_implementation(plan_id="plan-a", implementer_agent="aria-implementer", converged_plan_revision_id="rev-0",
                               converged_plan_content_hash=fold_plan_state(plan_id="plan-a", base_dir=self.fx.tools)[
                                   "latest_revision"]["content_hash"], base_dir=self.fx.tools)
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_REQUESTED")

    def test_a_plan_a_human_has_to_decide_is_not_a_change_in_flight(self) -> None:
        # HUMAN_REQUIRED is terminal and a FAILED plan: the existing cool-off speaks for the subject; this guard does not.
        self.finding("F-100", GROUNDED_FILE)
        with mock.patch("aria_kernel.plan_origin.compute_admission_scope", return_value=None):
            from aria_kernel.plan_convergence import start_plan

            start_plan(plan_id="plan-h", initial_revision_id="rev-0", plan_content=converging_plan_content(
                "plan-h", finding_id="F-100"), base_dir=self.fx.tools, workspace_root=self.fx.repo)
        pc._append_event(root=self.fx.tools, plan_id="plan-h", event_type="plan_evaluated", idempotency_key="sha256:" + "8" * 64,
                         payload={"terminal_state": "HUMAN_REQUIRED", "risks_rollup_summary": {}, "gate_decisions": [],
                                  "reason_codes": ["needs_a_human"]})
        self.assertEqual(fold_plan_state(plan_id="plan-h", base_dir=self.fx.tools)["state"], "HUMAN_REQUIRED")
        self.assert_not_in_flight("F-100", reason=fg.SUBJECT_COOL_OFF)
        self.assert_the_guard_is_alive()

    def test_another_subjects_change_in_flight_does_not_hold_this_one(self) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.finding("F-200", _OTHER_FILE)
        self.plan_at("plan-b", "F-200", "IMPLEMENTATION_RECORDED")
        self.opened()
        self.assert_not_in_flight("F-100")
        self.assert_refused("F-200", "plan-b", "IMPLEMENTATION_RECORDED")


class TheSubjectNotTheIdIsHeldTests(unittest.TestCase):
    """Unit level, on constructed history: the guard compares SUBJECTS (``_subject_ids``), as every subject guard does."""

    NOW = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)

    def _history(self, *plans, reverted=None) -> fg.LoopHistory:
        return fg.LoopHistory(self.NOW, tuple(plans), reverted or {}, (), 24, timedelta(days=7))

    def _judge(self, history: fg.LoopHistory, finding_id: str, findings: dict) -> fg.FindingAdmission:
        admission = fg.FindingAdmission(finding_id, None, evidence_refs=(f"{GROUNDED_FILE}:3",), affected_surfaces=(GROUNDED_FILE,))
        context = fg.GroundingContext(Path("."), None, findings, None, history)
        return fg.judge_loop_guards(context, admission)

    @staticmethod
    def _findings() -> dict:
        shared = {"originating_skill": "ai_consensus:judgment_pipeline", "facts": ["subject=tool:defect:apps/a.ts"]}
        return {"F-100": dict(shared), "F-101": dict(shared), "F-200": {"originating_skill": "manual:operator"}}

    def _held(self, **extra) -> fg.PlanRecord:
        return plan_record(plan_id="plan-a", finding_id="F-100", operator_sourced=False, started_at=self.NOW - timedelta(days=3),
                           surfaces=frozenset(), in_flight_state="IMPLEMENTATION_RECORDED", **extra)

    def test_a_sibling_finding_of_the_same_subject_is_refused_and_an_unrelated_one_is_not(self) -> None:
        history = self._history(self._held())
        sibling = self._judge(history, "F-101", self._findings())
        self.assertEqual((sibling.reason, sibling.loop_guard), (IN_FLIGHT, {"plan_id": "plan-a", "state": "IMPLEMENTATION_RECORDED"}))
        self.assertIsNone(self._judge(history, "F-200", self._findings()).reason)
        # A plan carrying no in-flight state holds nothing, the sibling or the finding itself.
        idle = self._history(plan_record(plan_id="plan-a", finding_id="F-100", operator_sourced=False,
                                         started_at=self.NOW - timedelta(days=3), surfaces=frozenset(), in_flight_state=None))
        self.assertIsNone(self._judge(idle, "F-101", self._findings()).reason)
        self.assertTrue(self._held().change_in_flight)
        self.assertFalse(plan_record(plan_id="p", finding_id="F-1", operator_sourced=False, started_at=self.NOW, surfaces=frozenset(),
                                     in_flight_state=None).change_in_flight)

    def test_a_cool_off_keeps_its_name_when_the_subject_also_has_a_change_in_flight(self) -> None:
        failed = plan_record(plan_id="plan-old", finding_id="F-100", operator_sourced=False, started_at=self.NOW - timedelta(days=10),
                             surfaces=frozenset(), failed_at=self.NOW - timedelta(days=1))
        refused = self._judge(self._history(failed, self._held()), "F-100", self._findings())
        self.assertEqual(refused.reason, fg.SUBJECT_COOL_OFF)
        self.assertEqual(refused.loop_guard["cause"], "plan_failed")
        # ... and the in-flight plan alone names the new reason: the pair above is the guard's position, not its absence.
        self.assertEqual(self._judge(self._history(self._held()), "F-100", self._findings()).reason, IN_FLIGHT)

    def test_a_quarantine_keeps_its_name_when_the_subject_also_has_a_change_in_flight(self) -> None:
        merged = plan_record(plan_id="plan-old", finding_id="F-100", operator_sourced=False, started_at=self.NOW - timedelta(days=12),
                             surfaces=frozenset(), merged_at=self.NOW - timedelta(days=11), merge_sha="b" * 40)
        history = self._history(merged, self._held(), reverted={"b" * 40: self.NOW - timedelta(days=10)})
        refused = self._judge(history, "F-100", self._findings())
        self.assertEqual(refused.reason, fg.SUBJECT_QUARANTINED)
        self.assertEqual(self._judge(self._history(self._held()), "F-100", self._findings()).reason, IN_FLIGHT)


class AnOperatorRequestOutranksTheGuardTests(InFlightFixture):
    def test_an_operator_request_for_the_subject_in_flight_is_still_admitted(self) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_REQUESTED")
        # The aging source is held ...
        self.assertIsNone(self.synthesize("cyc-held"))
        self.assertEqual(self.skips("cyc-held"), [("F-100", IN_FLIGHT)])
        # ... and the operator's request for the same finding is not (ADR-0003: requests outrank the loop guards).
        self.fx.record(finding_id="F-100", request_id="OP-1")
        envelope = self.synthesize("cyc-operator")
        self.assertEqual(self.selected(envelope), ("operator_feedback", "OP-1"))
        self.assertEqual(self.skips("cyc-operator"), [])


class TheGuardCostsNothingWhenNothingIsInFlightTests(InFlightFixture):
    @staticmethod
    def _patched_everywhere(name: str, replacement):
        """``plan_convergence.<name>`` and, if the grounding module bound the name, its own binding."""
        patches = [mock.patch.object(pc, name, replacement)]
        if hasattr(fg, name):
            patches.append(mock.patch.object(fg, name, replacement))
        return patches

    def test_a_ledger_with_no_implementation_event_folds_no_plan(self) -> None:
        def refuse(*args, **kwargs):  # noqa: ANN002, ANN003
            raise AssertionError("a plan was folded for a ledger that holds no implementation event")

        # Plans the old way: started, merged, nothing implemented that is still going.
        self.finding("F-100", GROUNDED_FILE)
        self.plan("plan-old", "F-005", started=_ago_days(10))
        self.merged_event("plan-old", "a" * 40)
        with contextlib.ExitStack() as stack:
            for patch in (*self._patched_everywhere("fold_plan_state", refuse),
                          *self._patched_everywhere("list_active_plans", refuse)):
                stack.enter_context(patch)
            context = fg.load_grounding_context(self.fx.repo, tools_root=self.fx.tools)
            self.assertIsNone(context.loop_fault)
            self.assertIsNone(fg.admit_candidate({"source_type": "f_finding", "candidate_id": "F-100"}, context).reason)
        # The contrast, in a store of its own: the same source DOES fold a plan once an implementation was requested.
        self.fx = self.fresh_store()
        seed_reviewer_agent(self.fx.repo)
        self.policy({"max_plans_per_24h": 24})
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_REQUESTED")
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_REQUESTED")

    def merged_event(self, plan_id: str, sha: str) -> None:
        self.merged(plan_id, _ago_days(9), sha)

    def test_only_the_active_plans_that_saw_an_implementation_request_are_folded(self) -> None:
        for number, finding in ((1, "F-110"), (2, "F-120")):
            self.finding(finding, _OTHER_FILE)
            self.plan_at(f"plan-m{number}", finding, "IMPLEMENTATION_MERGED", tip=f"{number}" * 40, pr=PR + number)
        # An ACTIVE plan that never saw an implementation request: started, still being planned.
        self.finding("F-130", _OTHER_FILE)
        with mock.patch("aria_kernel.plan_origin.compute_admission_scope", return_value=None):
            from aria_kernel.plan_convergence import start_plan

            start_plan(plan_id="plan-c", initial_revision_id="rev-0",
                       plan_content=converging_plan_content("plan-c", finding_id="F-130"),
                       base_dir=self.fx.tools, workspace_root=self.fx.repo)
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_RECORDED")
        self.opened()
        # Warm the active-plan cache, so the counted calls are the guard's own and not that read's cold folds.
        self.assertEqual(sorted(pc.list_active_plans(base_dir=self.fx.tools)), ["plan-a", "plan-c"])
        folded: list[str] = []
        real_fold = pc.fold_plan_state

        def counting(*, plan_id, base_dir=None):  # noqa: ANN001
            folded.append(plan_id)
            return real_fold(plan_id=plan_id, base_dir=base_dir)

        with contextlib.ExitStack() as stack:
            for patch in self._patched_everywhere("fold_plan_state", counting):
                stack.enter_context(patch)
            context = fg.load_grounding_context(self.fx.repo, tools_root=self.fx.tools)
        self.assertIsNone(context.loop_fault)
        # Two merged plans (history) and one active plan still being planned: none is folded. One active plan that
        # saw an implementation request, once.
        self.assertEqual(folded, ["plan-a"])
        self.assertEqual(sorted(plan.plan_id for plan in context.loop_history.plans if plan.change_in_flight), ["plan-a"])


class AFoldTheLedgerRefusesRefusesEveryCandidateByNameTests(InFlightFixture):
    def test_a_plan_that_saw_an_implementation_request_out_of_order_makes_the_history_unreadable(self) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.finding("F-300", _OTHER_FILE)
        with mock.patch("aria_kernel.plan_origin.compute_admission_scope", return_value=None):
            from aria_kernel.plan_convergence import start_plan

            start_plan(plan_id="plan-bad", initial_revision_id="rev-0", plan_content=converging_plan_content(
                "plan-bad", finding_id="F-100"), base_dir=self.fx.tools, workspace_root=self.fx.repo)
        # An implementation request on a plan that never converged: the fold refuses it (invalid_transition).
        pc._append_event(root=self.fx.tools, plan_id="plan-bad", event_type="implementation_requested",
                         idempotency_key="sha256:" + "7" * 64,
                         payload={"implementer_agent": "aria-implementer", "converged_plan_revision_id": "rev-0",
                                  "converged_plan_content_hash": "sha256:" + "6" * 64})
        context = fg.load_grounding_context(self.fx.repo, tools_root=self.fx.tools)
        self.assertEqual(context.loop_fault, "loop_ledger_unreadable")
        self.assertIsNone(context.loop_history)
        self.assertIsNone(self.synthesize("cyc-fault"))
        self.assertEqual(sorted(self.skips("cyc-fault")), [("F-100", fg.LOOP_HISTORY_UNAVAILABLE),
                                                           ("F-300", fg.LOOP_HISTORY_UNAVAILABLE)])


class TheTwoHalvesCloseTheDeadlockTests(InFlightFixture):
    """The guard (this file) and the lifecycle half (``test_merge_record``) end to end: a RECORDED plan holds its subject
    until the PR ledger says the PR was closed, and the ledger says so because the RECONCILER wrote it, not a seed.

    Without the reconciler recording CLOSED for a RECORDED plan the subject below is held forever (the plan never leaves
    ``IMPLEMENTATION_RECORDED`` when a person closes the PR): the guard alone would be a permanent block.
    """

    def test_a_closed_pr_observed_by_the_reconciler_frees_the_subject_for_the_f_source(self) -> None:
        self.finding("F-100", GROUNDED_FILE)
        self.plan_at("plan-a", "F-100", "IMPLEMENTATION_RECORDED")
        self.opened()
        self.assert_refused("F-100", "plan-a", "IMPLEMENTATION_RECORDED")
        result = reconcile_recorded_implementations(
            base_dir=self.fx.tools, workspace_root=self.fx.repo, reader=Reader(state="CLOSED", mergedAt=None, mergeCommit=None))
        self.assertEqual(result["merged"], [])
        self.assertEqual(fold_plan_state(plan_id="plan-a", base_dir=self.fx.tools)["state"], "IMPLEMENTATION_RECORDED")
        self.assertEqual([row["event"] for row in merge_record.lifecycle_rows(self.fx.tools) if row.get("pr_number") == PR],
                         ["opened", "closed_unmerged"])
        self.assert_not_in_flight("F-100")
        # The F source itself plans the subject again.
        self.assertEqual(self.selected(self.synthesize("cyc-freed")), ("f_finding", "F-100"))


class TheVocabularyAndTheOwnersTests(InFlightFixture):
    def test_the_new_reason_is_the_last_of_the_closed_vocabulary_and_exported(self) -> None:
        self.assertEqual(_reason_constant(), IN_FLIGHT)
        self.assertEqual(fg.LOOP_GUARD_REASONS, (*_PREVIOUS_GUARD_REASONS, IN_FLIGHT))
        self.assertEqual(fg.LOOP_GUARD_REASONS.count(IN_FLIGHT), 1)
        self.assertIn("SUBJECT_CHANGE_IN_FLIGHT", fg.__all__)

    def test_the_phase_set_is_imported_from_the_plan_ledger_never_retyped(self) -> None:
        source = Path(fg.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        retyped = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)
                   and node.value.startswith("IMPLEMENTATION_") and node.value.replace("_", "").isalpha() and node.value.isupper()]
        self.assertEqual(retyped, [], "an IMPLEMENTATION_* state name is spelled in finding_grounding")
        # RED AT BASE: the module reads the set the plan ledger owns.
        named = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)} | {
            node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)} | {
            alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) for alias in node.names}
        self.assertIn("IMPLEMENTATION_PHASE_STATES", named)

    def test_pr_holds_change_is_the_ledgers_answer_and_agrees_with_the_states_the_ledger_already_names(self) -> None:
        if not hasattr(merge_record, "pr_holds_change"):
            raise AssertionError("F3.1: merge_record.pr_holds_change does not exist (the PR lifecycle owner is not asked)")
        head, other = "d" * 40, "e" * 40

        def row(event: str, pr: int = 1, head_sha: str = head, **extra: object) -> dict:
            return {"event": event, "pr_number": pr, "head_sha": head_sha, "proposal_id": "prop-1", "change_id": "chg-1", **extra}

        table = {
            "an open PR": ([row("opened")], True),
            "closed unmerged": ([row("opened"), row("closed_unmerged")], False),
            "closed, then reopened and merged": ([row("opened"), row("closed_unmerged"), row("merged")], True),
            "closed, then merged at another head": ([row("opened"), row("closed_unmerged"), row("merged", head_sha=other)], True),
            "a merge refused as unproven": ([row("opened"), row("merge_unproven")], False),
            "a merged head being read": ([row("opened"), row("merge_lineage_unverified")], True),
            "merged": ([row("opened"), row("merged")], True),
            "no row at all (a damaged ledger)": ([], True),
            "only another head's rows": ([row("opened", head_sha=other), row("closed_unmerged", head_sha=other)], True),
            "another head's closed PR beside this head's open one": (
                [row("opened", pr=1), row("opened", pr=2, head_sha=other), row("closed_unmerged", pr=2, head_sha=other)], True),
            "this head's closed PR beside another head's open one": (
                [row("opened", pr=1), row("closed_unmerged", pr=1), row("opened", pr=2, head_sha=other)], False),
            "two PRs of this head, one still open": (
                [row("opened", pr=1), row("closed_unmerged", pr=1), row("opened", pr=2)], True),
            "two PRs of this head, both closed": (
                [row("opened", pr=1), row("closed_unmerged", pr=1), row("opened", pr=2), row("closed_unmerged", pr=2)], False),
        }
        for name, (rows, holds) in table.items():
            with self.subTest(case=name):
                self.assertIs(merge_record.pr_holds_change(rows, head_sha=head), holds)
        # The same ledger's own reading of those PRs' states is untouched by the extraction the guard rests on.
        states = {
            "open": ([row("opened")], "open"),
            "closed": ([row("opened"), row("closed_unmerged")], "closed_unmerged"),
            "unproven": ([row("opened"), row("merge_unproven")], "merge_unproven"),
            "unverified": ([row("opened"), row("merge_lineage_unverified")], "merge_lineage_unverified"),
            "merged outranks closed": ([row("opened"), row("closed_unmerged"), row("merged")], "merged"),
            "unproven outranks unverified": ([row("opened"), row("merge_lineage_unverified"), row("merge_unproven")], "merge_unproven"),
        }
        for name, (rows, state) in states.items():
            with self.subTest(state=name):
                self.assertEqual(merge_record.pull_requests_for_change(rows, proposal_id="prop-1", change_id="chg-1"),
                                 [{"pr_number": 1, "pr_state": state}])


def _ago_days(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).replace(microsecond=0).isoformat()


if __name__ == "__main__":
    unittest.main()
