"""PV — the implementation laws that sit around the writer's red tests
(``tests/test_plan_verdict_integrity.py``): what the reviewed-commit binding
does with a verdict reached before any commit or before the binding existed,
how a surface that is a directory or a glob goes stale, where the delivery
door and the mint refuse a stale verdict, and the parts of the
prior-risk-disposition law the red tests leave open (``withdrawn``, a second
answer for one risk, an answer for a risk no earlier round raised, the
revision prompt).

Source: /root/aria-handover/2026-10-21/build/PV/SPEC.md (P1, P3);
findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import converged_delivery
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.cross_review_bridge import _primary_revision_prompt_from_state, issue_implementation_envelope
from aria_kernel.failure_attribution import KERNEL_FORCED_CODES
from aria_kernel.plan_convergence import (
    _append_event,
    counted_delivery_attempts,
    evaluate_plan,
    fold_plan_state,
    plan_verdict_staleness,
    request_implementation,
    start_plan,
    submit_challenger_plan,
    submit_cross_review_v8,
)
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.git_fixtures import commit_files
from tests.test_converged_delivery_scope_precheck import FARM, FORCER, _ScopeCase
from tests.test_plan_verdict_integrity import SURFACE, _disposition, _PlanFixture, _risk, _terminal

# Persisted tokens, pinned by value.
STALE = "plan_verdict_stale"
UNBOUND = "plan_verdict_unbound"
WITHHELD = "plan_verdict_stale"
KIND = "converged_delivery_plan_verdict_stale"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


class AVerdictReachedBeforeAnyCommit(unittest.TestCase):
    """A checkout with no commit yet: the verdict records null, i.e. the
    reviewed tree is the empty tree, and staleness is measured from it."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "checkout"
        agents = self.repo / ".claude" / "agents"
        agents.mkdir(parents=True)
        (agents / "aria-cross-reviewer.md").write_text(
            "---\nname: aria-cross-reviewer\ndescription: CR.\n---\n\nBody.\n", encoding="utf-8",
        )
        _git(self.repo, "init", "-q")
        # The store sits in the checkout, unbound: its parent is its workspace.
        self.tools = self.repo / "aria-tools"
        (self.repo / ".gitignore").write_text("aria-tools/\n", encoding="utf-8")

    def converge(self, surfaces: list[str]) -> dict:
        body = {
            "schema_version": 1, "title": "Feed plan", "summary": "Tighten the feed service.",
            "affected_surfaces": [{"paths": surfaces}], "key_changes": ["tighten"],
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 2,
        }
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        submit_challenger_plan(plan_id="plan-1", challenger={
            "challenger_agent": "aria-challenger-planner", "challenger_revision_id": "c-0",
            "source_revision_id": "rev-0", "source_plan_content_hash": state["latest_revision"]["content_hash"],
            "plan_content": {**body, "title": "Challenger"},
        }, base_dir=self.tools)
        submit_cross_review_v8(plan_id="plan-1", review={"reviewer_agent": "aria-cross-reviewer",
                                                         "verdict": "agreed", "risks": []},
                               workspace_root=self.repo, base_dir=self.tools)
        with mock.patch("aria_kernel.round_independence.verify_independence", return_value=(True, [])):
            result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "CONVERGED")
        return result["event"]["payload"]

    def commit(self, rel: str) -> None:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("export const x = 1;\n", encoding="utf-8")
        _git(self.repo, "add", rel)
        _git(self.repo, "commit", "-q", "-m", f"fixture: add {rel}")

    def request(self) -> dict:
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        return request_implementation(
            plan_id="plan-1", implementer_agent="aria-implementer",
            converged_plan_revision_id=state["latest_revision"]["revision_id"],
            converged_plan_content_hash=state["latest_revision"]["content_hash"], base_dir=self.tools,
        )

    def test_the_verdict_names_no_commit(self) -> None:
        payload = self.converge([SURFACE])
        self.assertIn("reviewed_commit_sha", payload)
        self.assertIsNone(payload["reviewed_commit_sha"])

    def test_with_still_no_commit_the_verdict_holds(self) -> None:
        self.converge([SURFACE])
        self.assertTrue(self.request()["event_appended"])

    def test_a_first_commit_that_adds_a_named_path_makes_it_stale(self) -> None:
        self.converge([SURFACE])
        self.commit(SURFACE)
        with self.assertRaisesRegex(GovernanceError, f"{STALE}:{SURFACE}"):
            self.request()

    def test_a_first_commit_elsewhere_keeps_it_fresh(self) -> None:
        self.converge([SURFACE])
        self.commit("apps/hr-service/src/leave/leave.service.ts")
        self.assertTrue(self.request()["event_appended"])


class SurfacesThatAreDirectoriesOrGlobs(_PlanFixture):
    def _converged(self, surface: str) -> None:
        body = self.plan(affected_surfaces=[{"paths": [surface]}])
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")

    def test_a_commit_under_a_directory_surface_is_stale(self) -> None:
        self._converged("apps/farm-service/src/feed")
        self.commit(SURFACE, "export const feed = 2;\n")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(plan_verdict_staleness(state, base_dir=self.tools), f"{STALE}:{SURFACE}")

    def test_a_commit_a_glob_surface_matches_is_stale(self) -> None:
        self._converged("apps/farm-service/**/*.service.ts")
        self.commit(SURFACE, "export const feed = 2;\n")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(plan_verdict_staleness(state, base_dir=self.tools), f"{STALE}:{SURFACE}")


class AVerdictFromBeforeTheBinding(_PlanFixture):
    def test_is_refused_unbound(self) -> None:
        # A CONVERGED row written before PV (the 18 on aria/state @ 8e39b2eeb):
        # no reviewed_commit_sha field at all.
        self.converged_at_a()
        _append_event(root=self.tools, plan_id="plan-1", event_type="plan_evaluated", payload={
            "round_number": 1, "terminal_state": "CONVERGED", "risks_rollup_summary": {},
            "gate_decisions": [], "reason_codes": [],
        }, idempotency_key="sha256:" + hashlib.sha256(b"plan-1:legacy-verdict").hexdigest())
        with self.assertRaisesRegex(GovernanceError, f"{UNBOUND}:plan-1"):
            self.request_implementation_of_plan()


class TheDoorAndTheMintRefuseAStaleVerdict(_ScopeCase):
    def stale(self, plan_id: str) -> str:
        self.converge(plan_id, [FARM])
        commit_files(self.repo, {FARM: "export const INTERVAL_MS = 30000;\n"}, message="fixture: after review")
        return plan_id

    def test_the_first_offer_parks_it_before_staging(self) -> None:
        plan_id = self.stale("plan-stale")
        summary = self.deliver(plan_id, cycle_id="cyc-1")
        state = self.state(plan_id)
        self.assertEqual(summary["delivery"]["withheld"], WITHHELD)
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertEqual((*self.staged(), len(counted_delivery_attempts(state))), (0, 0, 0, 0))
        [row] = self.human_required_evaluations(plan_id)
        self.assertEqual((row["reason_codes"], row["forced_by"]), ([STALE], FORCER))
        [governance] = self.governance(KIND)
        self.assertEqual(governance["refusal"], f"{STALE}:{FARM}")

    def test_a_commit_elsewhere_is_still_staged_and_dispatched(self) -> None:
        plan_id = self.converge("plan-fresh", [FARM])
        commit_files(self.repo, {"docs/notes.md": "unrelated\n"}, message="fixture: unrelated")
        summary = self.deliver(plan_id, cycle_id="cyc-1")
        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED", summary)
        self.assertEqual(self.governance(KIND), [])

    def test_the_mint_refuses_before_any_envelope_is_appended(self) -> None:
        plan_id = self.stale("plan-stale")
        with self.assertRaisesRegex(GovernanceError, f"{STALE}:{FARM}"):
            issue_implementation_envelope(
                plan_id=plan_id, cross_review_revision_id="cr-1", cross_review_summary_text="{}",
                proposal_id="prop-1", change_id="chg-1", branch="aria/stale", base_sha="0" * 40,
                cycle_id="cyc-1", base_dir=self.tools,
                admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
            )
        rows = list_agent_invocation_requests(base_dir=self.tools)
        self.assertEqual([row for row in rows if row.get("role") == "implementation"], [])
        self.assertEqual(self.state(plan_id)["state"], "CONVERGED")

    def test_the_persisted_tokens(self) -> None:
        self.assertEqual((converged_delivery.WITHHELD_STALE_VERDICT, converged_delivery.STALE_VERDICT_KIND),
                         (WITHHELD, KIND))
        self.assertTrue({STALE, UNBOUND} <= KERNEL_FORCED_CODES)


class TheDispositionLawBeyondTheRedTests(_PlanFixture):
    def test_a_withdrawn_objection_with_evidence_no_longer_blocks(self) -> None:
        self.round_one_blocking_then_claimed()
        self.cross_review([], verdict="agreed",
                          dispositions=[_disposition("CR-R1-CR-001", "withdrawn", [f"{SURFACE}:1"])])
        self.assertEqual(_terminal(self.evaluate(2)), "CONVERGED")
        # Withdrawn is not resolved: the resolved set names only fixed risks.
        self.assertNotIn("CR-R1-CR-001", fold_plan_state(plan_id="plan-1", base_dir=self.tools)["resolved_review_risk_ids"])

    def test_an_unanswered_prior_material_risk_stays_open(self) -> None:
        self.round_one_blocking_then_claimed()
        self.cross_review([], verdict="agreed")
        result = self.evaluate(2)
        self.assertNotEqual(_terminal(result), "CONVERGED")
        self.assertIn("prior_review_risks_open", result["reason_codes"])

    def test_refused_answers_leave_the_round_unrequested(self) -> None:
        self.round_one_blocking_then_claimed()
        for dispositions in (
            [_disposition("CR-R1-CR-001", "withdrawn", [])],
            [_disposition("CR-R1-CR-001", "open"), _disposition("CR-R1-CR-001", "resolved", [f"{SURFACE}:1"])],
            [_disposition("CR-R2-CR-001", "resolved", [f"{SURFACE}:1"])],
            [_disposition("CR-001", "resolved", [f"{SURFACE}:1"])],
        ):
            with self.subTest(dispositions=dispositions):
                with self.assertRaisesRegex(GovernanceError, "prior_risk_disposition"):
                    self.cross_review([], verdict="agreed", dispositions=dispositions)
                self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_revision_prompt_carries_a_prior_risk_the_reviewer_held_open(self) -> None:
        self.round_one_blocking_then_claimed()
        self.cross_review([_risk("CR-007", "nice_to_have")], verdict="agreed",
                          dispositions=[_disposition("CR-R1-CR-001", "open", [f"{SURFACE}:1"])])
        self.assertEqual(_terminal(self.evaluate(2)), "NEXT_ROUND_REQUIRED")
        prompt = _primary_revision_prompt_from_state(
            fold_plan_state(plan_id="plan-1", base_dir=self.tools), plan_id="plan-1", round_number=3,
        )
        risks = prompt[prompt.index("<untrusted_cross_review_risks"):]
        self.assertIn('"risk_id": "CR-R2-CR-007"', risks)
        self.assertIn('"risk_id": "CR-R1-CR-001"', risks)
        self.assertIn("is your CLAIM", prompt)


if __name__ == "__main__":
    unittest.main()
