"""PV-R4 corrective round 1 — the roots the appellate accepted against the
R16-R18 round (/root/aria-handover/2026-10-21/build/PV-R4/appellate-r1.md),
one class per property:

* R19 the glob owner reads how many alternatives a brace pattern expands to
  before it builds one, and refuses a pattern over its named bound
  (``repo_glob_too_many_alternatives``): a 24-group reviewer ref once cost
  minutes and hundreds of MB on every record and every freshness read;
* R20 a recorded value the record law refuses is a fact of the ledger, so the
  freshness owner names it by its own token (``plan_verdict_path_refused``)
  and delivery parks it on the first offer; only the checkout's own failure
  to answer is ``plan_verdict_unverifiable``, withheld uncounted;
* R21 every path an evidence ref names (the body's, a risk's, a clearing
  answer's) is a file of the reviewed commit: a risk ref that names none is
  refused at record, and a body ref that names none refuses the verdict;
  ``workspace_view.commit_blob_paths`` leaves a path out only for a commit
  the checkout holds.

Source: SPEC.md (PV P1, P3); findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import re
import sys
import time
import unittest
from unittest import mock

from aria_kernel import canonical_path, converged_delivery, plan_convergence
from aria_kernel.canonical_path import (
    MAX_REPO_GLOB_ALTERNATIVES,
    expand_repo_glob,
    matches_repo_glob,
    require_repo_glob,
)
from aria_kernel.convergence_outcome import parked_plan_request_id
from aria_kernel.failure_attribution import KERNEL_FORCED_CODES
from aria_kernel.human_required import list_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    fold_plan_state,
    plan_verdict_paths,
    plan_verdict_staleness,
    record_cross_review,
    start_plan,
)
from aria_kernel.plan_round_controller import advance_plan_rounds
from aria_kernel.self_improvement import kernel_authority_set
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace_view import WorkspaceViewRefused, commit_blob_paths
from tests._helpers.production_shaped import production_converged_plan
from tests.test_converged_delivery_scope_precheck import FARM, FORCER, _ScopeCase
from tests.test_plan_verdict_integrity import (
    PLAN_EVIDENCE,
    RISK_EVIDENCE_FILE,
    SURFACE,
    _git,
    _PlanFixture,
    _risk,
    _terminal,
)
from tests.test_plan_verdict_roots_r2 import _event_count

PATH_REFUSED = "plan_verdict_path_refused"
UNVERIFIABLE = "plan_verdict_unverifiable"
STALE = "plan_verdict_stale"
TOO_MANY = "repo_glob_too_many_alternatives"
NOT_IN_TREE = "evidence_ref_not_in_reviewed_tree"
# Pinned by value: the reason lands on the plan ledger and the kind on governance.
KIND = "converged_delivery_plan_verdict_stale"
WITHHELD = "plan_verdict_stale"
BRACES_24 = "{a,b}" * 24


class _DeliveryReading(_PlanFixture):
    """What one offer of the delivery remedy left behind."""

    def state(self) -> dict:
        return fold_plan_state(plan_id="plan-1", base_dir=self.tools)

    def offer(self) -> str | None:
        """One offer through the delivery remedy the door and the sweep ask."""
        return converged_delivery._withhold_stale_verdict("plan-1", state=self.state(), base_dir=self.tools)

    def governance(self) -> list[dict]:
        path = self.tools / "governance.jsonl"
        return [row["details"] for row in load_jsonl(path) if row.get("kind") == KIND] if path.exists() else []

    def operator_items(self) -> list[str]:
        return sorted(row["request_id"] for row in list_human_required(base_dir=self.tools).rows)

    def forced_reasons(self) -> list[list[str]]:
        return [event["payload"]["reason_codes"] for event in self.state()["events"]
                if event["event_type"] == "plan_evaluated"
                and event["payload"].get("terminal_state") == "HUMAN_REQUIRED"]

    def assert_parked(self, refusal: str) -> None:
        self.assertEqual(self.offer(), WITHHELD)
        self.assertEqual(self.state()["state"], "HUMAN_REQUIRED")
        self.assertEqual(self.forced_reasons(), [[PATH_REFUSED]])
        self.assertEqual([row["refusal"] for row in self.governance()], [refusal])
        self.assertEqual(self.operator_items(), [parked_plan_request_id("plan-1")])

    def assert_withheld_uncounted(self) -> None:
        for _ in range(2):
            self.assertEqual(self.offer(), converged_delivery.WITHHELD_VERDICT_UNVERIFIABLE)
        self.assertEqual(self.state()["state"], "CONVERGED")
        self.assertEqual((self.governance(), self.operator_items(), self.forced_reasons()), ([], [], []))


class R19TheGlobOwnerBoundsTheAlternativesBeforeBuildingAny(_PlanFixture):
    """SEC-R4-B1: 12/16/18/20 groups cost 3.6/12/41/174 s and 3/47/194/792 MB."""

    def test_a_24_group_glob_is_refused_before_any_alternative_is_built(self) -> None:
        pattern = f"a/{BRACES_24}.ts"
        with mock.patch.object(canonical_path, "_expand_braces", side_effect=AssertionError("built")) as built:
            started = time.monotonic()
            with self.assertRaisesRegex(GovernanceError, TOO_MANY):
                require_repo_glob(pattern)
            with self.assertRaisesRegex(GovernanceError, TOO_MANY):
                matches_repo_glob("a/a.ts", pattern)
            self.assertLess(time.monotonic() - started, 1.0)
        built.assert_not_called()

    def test_a_risk_ref_of_24_groups_is_refused_at_record(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        before = _event_count(self)
        ref = f"apps/farm-service/src/feed/{BRACES_24}.ts:1"
        started = time.monotonic()
        with self.assertRaisesRegex(GovernanceError, f"plan_path_refused.*{TOO_MANY}"):
            self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[ref])], verdict="agreed")
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(_event_count(self), before)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_count_is_the_expanders_own(self) -> None:
        for pattern in ("a.ts", "a.{b,c}.{d,e,f}", "x/{a,{b,c}}/y", "{a,b", "a{}b", "{a,b}}{c,d}", "{,x}/{y}"):
            with self.subTest(pattern=pattern):
                self.assertEqual(canonical_path._brace_alternative_count(pattern),
                                 len(canonical_path._expand_braces(pattern)))

    def test_the_authority_sets_stdlib_glob_expands_and_matches_as_before(self) -> None:
        names = sorted(sys.stdlib_module_names)
        glob = "aria-tools/{" + ",".join(names) + "}.py"
        self.assertLessEqual(len(names), MAX_REPO_GLOB_ALTERNATIVES)
        self.assertEqual(expand_repo_glob(glob), tuple(f"aria-tools/{name}.py" for name in names))
        self.assertEqual(expand_repo_glob(glob), tuple(canonical_path._expand_braces(glob)))
        self.assertTrue(matches_repo_glob("aria-tools/os.py", glob))
        self.assertFalse(matches_repo_glob("aria-tools/not_a_stdlib_name.py", glob))
        # Every member the running kernel derives is admitted by the bound.
        for member in kernel_authority_set():
            require_repo_glob(member)


class R20ARefusedRecordedValueIsTheLedgersToken(_DeliveryReading):
    """SSOT-R4-001: the refused legacy ref was withheld as checkout state on every offer."""

    LEGACY = f"{RISK_EVIDENCE_FILE}:1-3"

    def _legacy_converged(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        # The row as the pre-R16 law recorded it: that law admitted any relative string.
        admitted = plan_convergence.PlanPathReading(path=None, refusal=None)
        with mock.patch.object(plan_convergence, "_plan_ref_reading", return_value=admitted):
            self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[self.LEGACY])], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")

    def test_the_first_offer_parks_it_with_one_row_and_one_operator_item(self) -> None:
        self._legacy_converged()
        self.assertEqual(plan_verdict_staleness(self.state(), base_dir=self.tools), f"{PATH_REFUSED}:{self.LEGACY}")
        with self.assertRaisesRegex(GovernanceError, re.escape(f"{PATH_REFUSED}:{self.LEGACY}")):
            self.request_implementation_of_plan()
        self.assert_parked(f"{PATH_REFUSED}:{self.LEGACY}")
        # Parked: a later offer finds no CONVERGED plan and writes nothing more.
        self.assertEqual(self.offer(), converged_delivery.WITHHELD_NOT_CONVERGED)
        self.assertEqual(len(self.governance()), 1)

    def test_the_token_is_a_kernel_forced_code(self) -> None:
        self.assertEqual(plan_convergence.PLAN_VERDICT_PATH_REFUSED, PATH_REFUSED)
        self.assertIn(PATH_REFUSED, KERNEL_FORCED_CODES)

    def test_an_unreadable_head_is_still_withheld_uncounted(self) -> None:
        self.converged_at_a()
        refused = WorkspaceViewRefused("workspace_head_unreadable:git_exit_128")
        with mock.patch.object(plan_convergence, "workspace_head_sha", side_effect=refused):
            self.assertEqual(plan_verdict_staleness(self.state(), base_dir=self.tools),
                             f"{UNVERIFIABLE}:workspace_head_unreadable:git_exit_128")
            self.assert_withheld_uncounted()

    def test_a_reviewed_commit_missing_from_the_checkout_is_still_withheld_uncounted(self) -> None:
        absent = "f" * 40
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed", reviewed_at=absent)
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        refusal = plan_verdict_staleness(self.state(), base_dir=self.tools)
        self.assertTrue(refusal.startswith(f"{UNVERIFIABLE}:workspace_commit_unreadable:{absent}"), refusal)
        self.assert_withheld_uncounted()


class R21CommitBlobPathsKeepsTheCheckoutApartFromTheLedger(_PlanFixture):
    def test_a_path_is_left_out_only_for_a_commit_the_checkout_holds(self) -> None:
        head = _git(self.repo, "rev-parse", "HEAD")
        asked = {SURFACE, "apps/farm-service/src/feed/absent.ts", f"{SURFACE}#L1", "apps/farm-service/src/feed"}
        self.assertEqual(commit_blob_paths(self.repo, head, asked), frozenset({SURFACE}))
        self.assertEqual(commit_blob_paths(self.repo, None, {SURFACE}), frozenset())

    def test_a_commit_the_checkout_does_not_hold_raises(self) -> None:
        with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_commit_unreadable"):
            commit_blob_paths(self.repo, "e" * 40, {SURFACE})


class R21ABodyRefIsAFileOfTheReviewedCommit(_DeliveryReading):
    """EV-R4-B1: a body `#L1` ref watched a name git never reports, so the cited file changed unseen."""

    def _converged_with_body_refs(self, refs: list[str]) -> None:
        start_plan(plan_id="plan-1", initial_revision_id="rev-0",
                   plan_content=self.plan(evidence_refs=refs), base_dir=self.tools)
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")

    def test_a_hash_line_ref_refuses_the_verdict_and_is_parked(self) -> None:
        ref = f"{PLAN_EVIDENCE}#L1"
        self._converged_with_body_refs([ref])
        self.assertEqual(plan_verdict_staleness(self.state(), base_dir=self.tools), f"{PATH_REFUSED}:{ref}")
        with self.assertRaisesRegex(GovernanceError, re.escape(f"{PATH_REFUSED}:{ref}")):
            self.request_implementation_of_plan()
        self.assert_parked(f"{PATH_REFUSED}:{ref}")

    def test_a_ref_to_a_file_the_reviewed_commit_lacks_is_refused(self) -> None:
        ref = "docs/aria/ABSENT.md:3"
        self._converged_with_body_refs([PLAN_EVIDENCE, ref])
        self.assertEqual(plan_verdict_staleness(self.state(), base_dir=self.tools), f"{PATH_REFUSED}:{ref}")

    def test_the_line_ref_still_goes_stale(self) -> None:
        self._converged_with_body_refs([f"{PLAN_EVIDENCE}:1"])
        self.assertIsNone(plan_verdict_staleness(self.state(), base_dir=self.tools))
        self.commit(PLAN_EVIDENCE, "# spec, changed\n")
        self.assertEqual(plan_verdict_staleness(self.state(), base_dir=self.tools), f"{STALE}:{PLAN_EVIDENCE}")


class R21ARiskRefIsAFileOfTheReviewedCommit(_PlanFixture):
    def test_a_hash_line_risk_ref_is_refused_at_record(self) -> None:
        for ref in (f"{RISK_EVIDENCE_FILE}#L1", "apps/farm-service/src/feed/absent.ts:1"):
            with self.subTest(ref=ref):
                self.tearDown()
                self.setUp()
                self.start()
                self.challenger("challenger-rev-0")
                before = _event_count(self)
                with self.assertRaisesRegex(GovernanceError, f"{NOT_IN_TREE}.*{re.escape(repr(ref))}"):
                    self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[ref])], verdict="agreed")
                self.assertEqual(_event_count(self), before)
                self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_record_validator_refuses_it_on_the_operator_lane_too(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.repo)
        [task, _other] = fold_plan_state(plan_id="plan-1", base_dir=self.tools)["cross_reviews"][1]["tasks"].values()
        ref = f"{RISK_EVIDENCE_FILE}#L1"
        review = {
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": task["target_revision_id"],
            "target_plan_content_hash": task["target_plan_content_hash"], "reviewer_agent": task["reviewer_agent"],
            "review_direction": task["review_direction"], "verdict": "agreed",
            "risks": [_risk("CR-001", "nice_to_have", evidence_refs=[ref])],
            "review_content_hash": plan_convergence.content_hash({"d": task["review_direction"]}),
        }
        before = _event_count(self)
        with self.assertRaisesRegex(GovernanceError, f"{NOT_IN_TREE}.*{re.escape(repr(ref))}"):
            record_cross_review(plan_id="plan-1", review=review, workspace_root=self.repo, base_dir=self.tools,
                                reviewed_commit_sha=_git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(_event_count(self), before)

    def test_the_line_ref_is_admitted_and_still_goes_stale(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[f"{RISK_EVIDENCE_FILE}:1"])],
                          verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertIn((f"{RISK_EVIDENCE_FILE}:1", RISK_EVIDENCE_FILE), plan_verdict_paths(state).cited)
        self.commit(RISK_EVIDENCE_FILE, "export const repo = 2;\n")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(plan_verdict_staleness(state, base_dir=self.tools), f"{STALE}:{RISK_EVIDENCE_FILE}")


class R21TheDoorParksABodyRefNamingNoFile(_ScopeCase):
    """Through the real delivery door: parked before staging on the first offer."""

    def test_the_first_offer_parks_it_before_staging(self) -> None:
        ref = f"{FARM}#L1"
        plan = production_converged_plan(tools_dir=self.tools, workspace_root=self.repo, plan_id="plan-hash-ref",
                                         affected_paths=[FARM], evidence_refs=[ref])
        self.commit_reviewer()
        summary = self.deliver(plan.plan_id, cycle_id="cyc-1")
        self.assertEqual(summary["delivery"]["withheld"], WITHHELD)
        self.assertEqual(self.state(plan.plan_id)["state"], "HUMAN_REQUIRED")
        self.assert_nothing_staged()
        [row] = self.human_required_evaluations(plan.plan_id)
        self.assertEqual((row["reason_codes"], row["forced_by"]), ([PATH_REFUSED], FORCER))
        [governance] = self.governance(KIND)
        self.assertEqual(governance["refusal"], f"{PATH_REFUSED}:{ref}")


if __name__ == "__main__":
    unittest.main()
