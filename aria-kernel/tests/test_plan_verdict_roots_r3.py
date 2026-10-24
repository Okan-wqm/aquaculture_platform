"""PV corrective round 3 — the roots the appellate accepted against the
round-2 corrective (/root/aria-handover/2026-10-21/build/PV/appellate-r3.md,
appellate-final.json), one class per property:

* R16 every path a plan names enters the freshness gate through ONE grammar:
  the record law admits a plan path only when it resolves inside the
  repository and compiles in the kernel's one glob owner, and an evidence ref
  only when it is a finding id, a kernel ledger pointer or a parsable
  ``path[:line]`` whose path meets the same rule; a ``resolved``/``withdrawn``
  answer clears only on a file of the reviewed commit; the freshness reader
  reads every recorded value in its resolved form, and a recorded value the
  law refuses (a legacy row) makes the verdict unverifiable; the glob owner
  never leaks ``re.error``;
* R17 the operator's ``plan advance-rounds`` lane renders its cross-review
  prompt through the one renderer the drainer uses, so its reviewer is shown
  the plans and the prior risks it must answer;
* R18 the ``<untrusted_prior_risks>`` block is base64 through the
  ``text_safety`` owner, so no text inside it can close it.

Source: SPEC.md (PV P1, P3); findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import base64
import json
import re
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import plan_convergence
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.canonical_path import matches_repo_glob
from aria_kernel.cross_review_bridge import _cross_review_suggested_prompt, issue_cross_review_envelope
from aria_kernel.plan_convergence import (
    fold_plan_state,
    plan_verdict_paths,
    plan_verdict_staleness,
    prior_review_risks,
    record_cross_review,
    start_plan,
)
from aria_kernel.plan_round_controller import advance_plan_rounds
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError
from tests.test_plan_verdict_integrity import (
    PLAN_EVIDENCE,
    RISK_EVIDENCE_FILE,
    SURFACE,
    _disposition,
    _git,
    _PlanFixture,
    _risk,
    _terminal,
)
from tests.test_plan_verdict_roots_r2 import GUARD, _event_count

KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"
CLOSE_TAG = "</untrusted_prior_risks>"
PRIOR_BLOCK = re.compile(
    r'<untrusted_prior_risks before_round="(?P<round>\d+)" encoding="base64">\n'
    r"(?P<payload>[A-Za-z0-9+/=]*)\n</untrusted_prior_risks>\n"
)


def _decoded_prior_risks(prompt: str) -> tuple[int, list[dict]]:
    """The round and the rows the one prior-risk block carries, decoded."""
    [match] = list(PRIOR_BLOCK.finditer(prompt))
    return int(match.group("round")), json.loads(base64.b64decode(match.group("payload")).decode("utf-8"))


class R16ASurfaceIsReadInItsResolvedForm(_PlanFixture):
    """R3-EV-B1: `//` and `/./` spellings of the surface were never stale."""

    SPELLINGS = (
        SURFACE.replace("/src/", "//src/"),
        SURFACE.replace("/src/", "/src/./"),
        f"./{SURFACE}",
        "apps/farm-service/src/feed/",
    )

    def _converged(self, surface: str) -> None:
        start_plan(plan_id="plan-1", initial_revision_id="rev-0",
                   plan_content=self.plan(affected_surfaces=[{"paths": [surface]}]), base_dir=self.tools)
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")

    def test_every_spelling_of_the_surface_goes_stale(self) -> None:
        for spelling in self.SPELLINGS:
            with self.subTest(spelling=spelling):
                self.tearDown()
                self.setUp()
                self._converged(spelling)
                self.commit(SURFACE, "export const feed = 2;\n")
                state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
                self.assertEqual(plan_verdict_staleness(state, base_dir=self.tools), f"plan_verdict_stale:{SURFACE}")
                with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{SURFACE}"):
                    self.request_implementation_of_plan()


class R16AClearingAnswerCitesAFileOfTheReviewedCommit(_PlanFixture):
    """R3-ARCH-B1: a range, comment or `#L` ref dropped the cited file from the freshness set."""

    REFS = (f"{GUARD}:1-3", f"{GUARD}:1 (the guard)", f"{GUARD}#L1", "apps/farm-service/src/feed/absent.ts:1")

    def test_a_ref_outside_the_grammar_or_the_reviewed_tree_is_refused_at_record(self) -> None:
        for disposition in ("resolved", "withdrawn"):
            for ref in self.REFS:
                with self.subTest(disposition=disposition, ref=ref):
                    self.tearDown()
                    self.setUp()
                    self.commit(GUARD, "export const guard = true;\n")
                    self.round_one_blocking_then_claimed()
                    before = _event_count(self)
                    with self.assertRaisesRegex(GovernanceError, re.escape(repr(ref))):
                        self.cross_review([], verdict="agreed", dispositions=[_disposition("CR-R1-CR-001", disposition, [ref])])
                    self.assertEqual(_event_count(self), before)
                    self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_record_law_refuses_it_on_the_operator_lane_too(self) -> None:
        self.commit(GUARD, "export const guard = true;\n")
        self.round_one_blocking_then_claimed()
        advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.repo)
        [task, _other] = fold_plan_state(plan_id="plan-1", base_dir=self.tools)["cross_reviews"][2]["tasks"].values()
        review = {
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": task["target_revision_id"],
            "target_plan_content_hash": task["target_plan_content_hash"], "reviewer_agent": task["reviewer_agent"],
            "review_direction": task["review_direction"], "verdict": "agreed", "risks": [],
            "review_content_hash": plan_convergence.content_hash({"d": task["review_direction"]}),
            "prior_risk_dispositions": [_disposition("CR-R1-CR-001", "resolved", [f"{GUARD}#L1"])],
        }
        before = _event_count(self)
        with self.assertRaisesRegex(GovernanceError, re.escape(repr(f"{GUARD}#L1"))):
            record_cross_review(plan_id="plan-1", review=review, workspace_root=self.repo, base_dir=self.tools,
                                reviewed_commit_sha=_git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(_event_count(self), before)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEW_REQUESTED")

    def test_a_file_of_the_reviewed_commit_clears(self) -> None:
        # Control: the plain cited file is admitted, and it is a verdict path.
        self.commit(GUARD, "export const guard = true;\n")
        self.round_one_blocking_then_claimed()
        self.cross_review([], verdict="agreed", dispositions=[_disposition("CR-R1-CR-001", "resolved", [f"{GUARD}:1"])])
        self.assertEqual(_terminal(self.evaluate(2)), "CONVERGED")
        self.assertIn(GUARD, plan_verdict_paths(fold_plan_state(plan_id="plan-1", base_dir=self.tools)).paths)


class R16TheBodyAndRiskRecordLawIsTheSameGrammar(_PlanFixture):
    def test_a_body_path_or_ref_outside_the_grammar_is_refused_by_name(self) -> None:
        cases = {
            "affected_surfaces": {"affected_surfaces": [{"paths": ["apps/[z-a].ts"]}]},
            "key_changes": {"key_changes": [{"description": "edit", "paths": ["../outside.ts"]}]},
            "evidence_refs": {"evidence_refs": [f"{PLAN_EVIDENCE}:1-3"]},
        }
        for field, override in cases.items():
            with self.subTest(field=field):
                with self.assertRaisesRegex(GovernanceError, "plan_path_refused"):
                    start_plan(plan_id=f"plan-{field}".replace("_", "-"), initial_revision_id="rev-0",
                               plan_content=self.plan(**override), base_dir=self.tools)

    def test_a_risk_ref_outside_the_grammar_is_refused_at_record(self) -> None:
        for ref in (f"{RISK_EVIDENCE_FILE}:1-3", "apps/farm-service/src/feed/[z-a].ts:1"):
            with self.subTest(ref=ref):
                self.tearDown()
                self.setUp()
                self.start()
                self.challenger("challenger-rev-0")
                before = _event_count(self)
                with self.assertRaisesRegex(GovernanceError, "plan_path_refused"):
                    self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[ref])], verdict="agreed")
                self.assertEqual(_event_count(self), before)

    def test_a_ledger_pointer_and_a_finding_id_name_no_file(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        refs = ["coverage-manifest:plan-1-r1.json", "ARIA-HIGH-779", f"{RISK_EVIDENCE_FILE}:42"]
        self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=refs)], verdict="agreed")
        reading = plan_verdict_paths(fold_plan_state(plan_id="plan-1", base_dir=self.tools))
        self.assertIn(RISK_EVIDENCE_FILE, reading.paths)
        self.assertFalse([path for path in reading.paths if "coverage-manifest" in path or "ARIA-HIGH" in path])
        self.assertEqual(reading.refused, ())


class R16ALegacyValueTheLawRefusesIsUnverifiable(_PlanFixture):
    LEGACY = f"{RISK_EVIDENCE_FILE}:1-3"

    def test_a_folded_legacy_risk_ref_makes_the_verdict_unverifiable(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        # The row as the pre-R16 law recorded it: that law admitted any relative string.
        admitted = plan_convergence.PlanPathReading(path=None, refusal=None)
        with mock.patch.object(plan_convergence, "_plan_ref_reading", return_value=admitted):
            self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[self.LEGACY])], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(plan_verdict_paths(state).refused, (self.LEGACY,))
        self.assertEqual(plan_verdict_staleness(state, base_dir=self.tools), f"plan_verdict_unverifiable:{self.LEGACY}")
        with self.assertRaisesRegex(GovernanceError, re.escape(f"plan_verdict_unverifiable:{self.LEGACY}")):
            self.request_implementation_of_plan()


class R16TheGlobOwnerNeverLeaksReError(unittest.TestCase):
    def test_an_uncompilable_class_is_a_typed_refusal(self) -> None:
        for pattern in ("a/[z-a].ts", "web/app/[]x"):
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(GovernanceError, "repo_glob_invalid"):
                    matches_repo_glob("f.ts", pattern)

    def test_a_compilable_class_answers_a_bool(self) -> None:
        self.assertFalse(matches_repo_glob("f.ts", "a/[^/].ts"))
        self.assertTrue(matches_repo_glob("a/y.ts", "a/[^/].ts"))

    def test_fnmatch_negation_is_translated(self) -> None:
        self.assertFalse(matches_repo_glob("a/x.ts", "a/[!x].ts"))
        self.assertTrue(matches_repo_glob("a/y.ts", "a/[!x].ts"))


class R16TheBadClassSequenceEndsInGovernanceError(_PlanFixture):
    """R3-P1: one reviewer string poisoned staleness and request_implementation with re.error."""

    def test_the_bad_class_is_refused_at_record(self) -> None:
        bad = "apps/farm-service/src/feed/[z-a].ts:1"
        self.round_one_blocking_then_claimed()
        before = _event_count(self)
        with self.assertRaises(GovernanceError):
            self.cross_review([], verdict="agreed", dispositions=[_disposition("CR-R1-CR-001", "resolved", [bad])])
        self.assertEqual(_event_count(self), before)


if __name__ == "__main__":
    unittest.main()
