"""PV corrective round 1 — the roots the appellate accepted against the first
PV implementation (/root/aria-handover/2026-10-21/build/PV/appellate-r1.md),
one class per root, each a property the first implementation broke:

* R1 every HEAD, empty-tree and diff read of the verdict binding goes through
  the kernel's one hermetic git owner (``workspace_view``): a caller's
  ``GIT_DIR`` never answers for the store's checkout;
* R2 the verdict is bound to the commit the reviewer reviewed (the answered
  request's ``target_sha``), not to HEAD when the round is evaluated;
* R3 the event law types ``reviewed_commit_sha``: an option-shaped ledger
  value never reaches ``git diff``;
* R4 a git failure is not "no commit": the HEAD owner raises, and the
  staleness check answers ``plan_verdict_unverifiable``;
* R5 the freshness path set is every path the plan body names
  (``plan_origin.body_paths``: surfaces AND key-change paths);
* R6 a prior risk's clearing answer counts only from a round whose reviewer
  seat passes independence;
* R7 the reviewer verdict vocabulary is closed, and the dissent gate fails
  closed on anything but ``agreed``;
* R8 one id names one risk in a round;
* R9 the duel row counts material risks with the material gate's definition.

Source: SPEC.md (PV P1, P3, P5); findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.plan_convergence import (
    _reviewer_dissent_gate,
    content_hash,
    evaluate_plan,
    events_path,
    fold_plan_state,
    plan_verdict_anchor,
    plan_verdict_staleness,
    record_cross_review,
    request_cross_review,
    round_reviewed_commit,
    submit_cross_review_v8,
)
from aria_kernel.plan_convergence_bridge import _dispatch_cross_review
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace_view import WorkspaceViewRefused, workspace_head_sha
from tests.test_plan_verdict_integrity import (
    SURFACE,
    UNRELATED,
    _disposition,
    _git,
    _PlanFixture,
    _risk,
    _terminal,
)

KEY_CHANGE_FILE = "apps/farm-service/src/feed/feed.mapper.ts"
INDEPENDENT = (True, [])


def _foreign_checkout(root: Path) -> Path:
    """A second repository with its own history, for an inherited GIT_DIR to name."""
    foreign = root / "foreign"
    foreign.mkdir()
    _git(foreign, "init", "-q", "-b", "main")
    _git(foreign, "-c", "user.email=f@example.invalid", "-c", "user.name=f",
         "commit", "-q", "--allow-empty", "-m", "foreign root")
    return foreign


class R1OneHermeticGitOwner(_PlanFixture):
    def test_the_binding_source_reads_the_named_checkout_under_a_foreign_git_dir(self) -> None:
        foreign = _foreign_checkout(Path(self.tmp.name))
        with mock.patch.dict(os.environ, {"GIT_DIR": str(foreign / ".git")}):
            self.assertEqual(plan_verdict_anchor(self.tools), self.commit_a)

    def test_a_fresh_verdict_stays_fresh_under_a_foreign_git_dir(self) -> None:
        self.converged_at_a()
        self.commit(UNRELATED, "export const leave = 2;\n")
        foreign = _foreign_checkout(Path(self.tmp.name))
        with mock.patch.dict(os.environ, {"GIT_DIR": str(foreign / ".git")}):
            self.assertTrue(self.request_implementation_of_plan()["event_appended"])


class R2BoundToTheReviewedCommit(_PlanFixture):
    def test_a_commit_between_review_and_evaluation_is_not_bound_as_reviewed(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed", reviewed_at=self.commit_a)
        self.commit(SURFACE, "export const feed = 2;\n")
        result = self.evaluate(1)
        self.assertEqual(_terminal(result), "CONVERGED")
        self.assertEqual(result["event"]["payload"]["reviewed_commit_sha"], self.commit_a)
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{SURFACE}"):
            self.request_implementation_of_plan()

    def test_the_bridge_records_the_answered_requests_target_sha(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.commit(UNRELATED, "export const leave = 2;\n")
        _dispatch_cross_review(
            request={"request_id": "req-cr-1", "target_sha": self.commit_a,
                     "target_agent": "aria-cross-reviewer", "workspace_root": str(self.repo)},
            response={}, details={"cross_review": {"verdict": "agreed", "risks": []}},
            plan_id="plan-1", base_dir=self.tools,
        )
        reviews = fold_plan_state(plan_id="plan-1", base_dir=self.tools)["cross_reviews"][1]["reviews"]
        self.assertEqual([review["reviewed_commit_sha"] for review in reviews], [self.commit_a, self.commit_a])

    def test_a_request_without_target_sha_is_refused_at_the_bridge(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        with self.assertRaisesRegex(GovernanceError, "cross_review_request_unanchored"):
            _dispatch_cross_review(
                request={"request_id": "req-cr-1", "target_agent": "aria-cross-reviewer",
                         "workspace_root": str(self.repo)},
                response={}, details={"cross_review": {"verdict": "agreed", "risks": []}},
                plan_id="plan-1", base_dir=self.tools,
            )

    def test_directions_that_disagree_or_name_no_commit_leave_the_round_unbound(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(round_reviewed_commit(state, 1), self.commit_a)
        reviews = state["cross_reviews"][1]["reviews"]
        reviews[1]["reviewed_commit_sha"] = "b" * 40
        with self.assertRaisesRegex(GovernanceError, "plan_verdict_unbound:plan-1"):
            round_reviewed_commit(state, 1)
        del reviews[1]["reviewed_commit_sha"]
        reviews[0]["reviewed_commit_sha"] = self.commit_a
        with self.assertRaisesRegex(GovernanceError, "plan_verdict_unbound:plan-1"):
            round_reviewed_commit(state, 1)

    def test_a_review_recorded_without_a_reviewed_commit_is_refused(self) -> None:
        # PV R10 — the reviewed commit is the record function's required
        # argument, so a review cannot be recorded without one.
        self.start()
        self.challenger("challenger-rev-0")
        tasks = _request_round_tasks(self)
        with self.assertRaisesRegex(TypeError, "reviewed_commit_sha"):
            record_cross_review(plan_id="plan-1", review=_direction_review(self, tasks[0], risks=[]),
                                workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEW_REQUESTED")


class R3TheEventLawTypesTheReviewedCommit(_PlanFixture):
    def test_an_option_shaped_reviewed_commit_never_reaches_git(self) -> None:
        self.converged_at_a()
        self.commit(UNRELATED, "export const leave = 2;\n")
        written = Path(self.tmp.name) / "written-by-git.txt"
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        [verdict] = [event for event in state["events"] if event["event_type"] == "plan_evaluated"]
        forged = {**verdict, "event_id": "forged-1",
                  "idempotency_key": "sha256:" + hashlib.sha256(b"plan-1:forged-verdict").hexdigest(),
                  "payload": {**verdict["payload"], "reviewed_commit_sha": f"--output={written}"}}
        # Below the law: even a state that carries the value never hands it to git as an option.
        in_memory = copy.deepcopy(state)
        in_memory["events"] = [forged if event is verdict else event for event in state["events"]]
        self.assertTrue(str(plan_verdict_staleness(in_memory, base_dir=self.tools)).startswith("plan_verdict_unverifiable"))
        self.assertFalse(written.exists())
        append_declared_jsonl(events_path(self.tools), forged, expected_surface="plan_convergence_events")
        with self.assertRaisesRegex(GovernanceError, "reviewed_commit_sha must be null or a full git object id"):
            fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            self.request_implementation_of_plan()
        self.assertFalse(written.exists())

    def test_an_option_shaped_reviewed_commit_is_refused_at_submit(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        with self.assertRaisesRegex(GovernanceError, "reviewed_commit_sha must be null"):
            self.cross_review([], verdict="agreed", reviewed_at="--output=/tmp/x")
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")


class R4AGitFailureIsNotTheEmptyTree(_PlanFixture):
    def _break_checkout(self) -> None:
        # The checkout's git directory is gone: `.git` points nowhere.
        shutil.move(str(self.repo / ".git"), str(Path(self.tmp.name) / "moved-git"))
        (self.repo / ".git").write_text(f"gitdir: {Path(self.tmp.name) / 'missing'}\n", encoding="utf-8")

    def test_the_head_owner_tells_no_commit_from_a_failure(self) -> None:
        plain = Path(self.tmp.name) / "plain"
        plain.mkdir()
        unborn = Path(self.tmp.name) / "unborn"
        unborn.mkdir()
        _git(unborn, "init", "-q")
        self.assertIsNone(workspace_head_sha(plain))
        self.assertIsNone(workspace_head_sha(unborn))
        self._break_checkout()
        with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
            workspace_head_sha(self.repo)
        with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
            plan_verdict_anchor(self.tools)

    def test_a_verdict_is_unverifiable_in_a_broken_checkout(self) -> None:
        # A null (empty-tree) verdict exists only in a checkout with no commit
        # (PV R11); its broken-checkout case is
        # test_plan_verdict_binding.AVerdictReachedBeforeAnyCommit.
        self.start()
        self.challenger("challenger-rev-0")
        submit_cross_review_v8(plan_id="plan-1", review={"verdict": "agreed", "risks": []},
                               workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=self.commit_a)
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        self._break_checkout()
        with self.assertRaisesRegex(GovernanceError, "plan_verdict_unverifiable:workspace_head_unreadable"):
            self.request_implementation_of_plan()

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "chown to another uid needs root")
    def test_a_dubious_ownership_checkout_is_unverifiable(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        submit_cross_review_v8(plan_id="plan-1", review={"verdict": "agreed", "risks": []},
                               workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=self.commit_a)
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SUDO_UID", None)
            subprocess.run(["chown", "-R", "65534:65534", str(self.repo / ".git")], check=True)
            with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
                plan_verdict_anchor(self.tools)
            with self.assertRaisesRegex(GovernanceError, "plan_verdict_unverifiable:workspace_head_unreadable"):
                self.request_implementation_of_plan()


class R5EveryPathTheBodyNames(_PlanFixture):
    def plan(self, **overrides) -> dict:
        # The key change writes a file no surface names.
        key_changes = [{"description": "rewrite the feed mapper", "paths": [KEY_CHANGE_FILE], "imports": []}]
        return super().plan(**{"key_changes": key_changes, **overrides})

    def test_a_key_change_path_outside_the_surfaces_goes_stale(self) -> None:
        (self.repo / KEY_CHANGE_FILE).write_text("export const map = 1;\n", encoding="utf-8")
        _git(self.repo, "add", KEY_CHANGE_FILE)
        _git(self.repo, "commit", "-q", "-m", "fixture: key-change file")
        self.converged_at_a()
        self.commit(KEY_CHANGE_FILE, "export const map = 2;\n")
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{KEY_CHANGE_FILE}"):
            self.request_implementation_of_plan()


class R6OnlyAnIndependentSeatClearsARisk(_PlanFixture):
    def _three_rounds(self, *, round_two_independent: bool) -> dict:
        def verdict(*, challenger, **_dispatches):
            if challenger.revision_id == "challenger-rev-1" and not round_two_independent:
                return False, ["cross_review_echoes_plans"]
            return INDEPENDENT

        with mock.patch("aria_kernel.round_independence.verify_independence", side_effect=verdict):
            self.start()
            self.challenger("challenger-rev-0")
            self.cross_review([_risk("CR-001", "blocking")], verdict="material_risks_present")
            self.assertEqual(_terminal(evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools)),
                             "NEXT_ROUND_REQUIRED")
            self.revise("rev-1", addresses=["CR-R1-CR-001"])
            self.challenger("challenger-rev-1")
            self.cross_review([_risk("CR-002", "material")], verdict="material_risks_present",
                              dispositions=[_disposition("CR-R1-CR-001", "resolved", [f"{SURFACE}:1"])])
            self.assertEqual(_terminal(evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools)),
                             "NEXT_ROUND_REQUIRED")
            self.revise("rev-2", addresses=["CR-R2-CR-002"])
            self.challenger("challenger-rev-2")
            self.cross_review([], verdict="agreed",
                              dispositions=[_disposition("CR-R2-CR-002", "resolved", [f"{SURFACE}:1"])])
            return evaluate_plan(plan_id="plan-1", round_number=3, base_dir=self.tools)

    def test_a_risk_cleared_by_a_non_independent_round_does_not_converge(self) -> None:
        result = self._three_rounds(round_two_independent=False)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertEqual(payload["reason_codes"], ["cross_review_self_agreement"])
        [gate] = [gate for gate in payload["gate_decisions"] if gate["gate"] == "cross_review_independence"]
        self.assertEqual((gate["passed"], gate["judged_rounds"], gate["failed_rounds"]), (False, [2, 3], [2]))
        self.assertEqual(gate["violation_reasons"], ["round_2:cross_review_echoes_plans"])

    def test_risks_cleared_by_independent_rounds_converge(self) -> None:
        payload = self._three_rounds(round_two_independent=True)["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "CONVERGED")


class R7AClosedVerdictVocabulary(_PlanFixture):
    def test_a_verdict_outside_the_vocabulary_or_none_is_refused_at_submit(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        for review in (
            {"verdict": "reject"},
            {"verdict": "revise"},
            {},
            {"verdict": "agreed", "verdicts": {"challenger_to_primary": "revise"}},
            {"verdicts": {"primary_to_challenger": "agreed"}},
        ):
            with self.subTest(review=review):
                with self.assertRaisesRegex(GovernanceError, "cross-review verdict is"):
                    submit_cross_review_v8(
                        plan_id="plan-1", review={**review, "risks": [_risk("CR-001", "nice_to_have")]},
                        workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=self.commit_a,
                    )
                self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_dissent_gate_fails_closed_on_a_recorded_non_agreed_verdict(self) -> None:
        for verdict in ("reject", "revise", None):
            with self.subTest(verdict=verdict):
                cross = {"reviews": [{"review_direction": "primary_to_challenger", "verdict": "agreed"},
                                     {"review_direction": "challenger_to_primary", "verdict": verdict}]}
                gate = _reviewer_dissent_gate(cross, [])
                self.assertEqual((gate["passed"], gate["dissenting_directions"]),
                                 (False, ["challenger_to_primary"]))

    def test_agreed_still_converges(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([_risk("CR-001", "nice_to_have")], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")


class R8OneIdNamesOneRisk(_PlanFixture):
    def test_an_envelope_that_repeats_a_risk_id_is_refused(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        with self.assertRaisesRegex(GovernanceError, r"repeat risk_id \['CR-001'\]"):
            self.cross_review([_risk("CR-001", "nice_to_have"), _risk("CR-001", "material")],
                              verdict="material_risks_present")
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_a_direction_record_reusing_an_id_with_other_content_is_refused(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        first, second = _request_round_tasks(self)
        record_cross_review(plan_id="plan-1", review=_direction_review(self, first, risks=[_risk("CR-001", "nice_to_have")]),
                            workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=self.commit_a)
        with self.assertRaisesRegex(GovernanceError, "CR-R1-CR-001 is already recorded in round 1 with different content"):
            record_cross_review(plan_id="plan-1", review=_direction_review(self, second, risks=[_risk("CR-001", "material")]),
                                workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=self.commit_a)

    def test_identical_rows_of_the_two_directions_are_one_risk(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([_risk("CR-001", "material")], verdict="material_risks_present")
        rows = fold_plan_state(plan_id="plan-1", base_dir=self.tools)["cross_review_risks_by_round"][1]
        self.assertEqual([row["risk_id"] for row in rows], ["CR-R1-CR-001"])


class R9TheDuelRowCountsWithTheGatesDefinition(_PlanFixture):
    def test_every_evaluated_rounds_duel_count_equals_the_gate_count(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([_risk("CR-001", "HIGH"), _risk("CR-002", "nice_to_have")],
                          verdict="material_risks_present")
        with mock.patch("aria_kernel.round_independence.verify_independence", return_value=INDEPENDENT):
            result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools, max_rounds=1)
        payload = result["event"]["payload"]
        duel = self.tools / "knowledge-graph" / "duel-ratings.jsonl"
        rows = [json.loads(line) for line in duel.read_text(encoding="utf-8").splitlines() if line.strip()]
        [row] = [row for row in rows if row.get("plan_id") == "plan-1"]
        self.assertEqual(payload["risks_rollup_summary"]["material_cross_review_risks"], 1)
        self.assertEqual(row["material_risk_count"], payload["risks_rollup_summary"]["material_cross_review_risks"])


def _request_round_tasks(case: _PlanFixture) -> list[dict]:
    """Round 1's two direction tasks through the legacy per-direction door (`plan request-cross-review`)."""
    state = fold_plan_state(plan_id="plan-1", base_dir=case.tools)
    latest = state["latest_revision"]
    tasks = [{
        "task_id": f"legacy-{direction}",
        "task_packet_hash": content_hash({"direction": direction}),
        "target_agent": "aria-cross-reviewer",
        "reviewer_agent": "aria-cross-reviewer",
        "target_revision_id": latest["revision_id"],
        "target_plan_content_hash": latest["content_hash"],
        "review_direction": direction,
        "sla_deadline": "2999-01-01T00:00:00+00:00",
    } for direction in ("challenger_to_primary", "primary_to_challenger")]
    request_cross_review(plan_id="plan-1", request={
        "round_number": 1, "target_revision_id": latest["revision_id"],
        "target_plan_content_hash": latest["content_hash"], "tasks": tasks,
    }, base_dir=case.tools)
    return tasks


def _direction_review(case: _PlanFixture, task: dict, *, risks: list[dict]) -> dict:
    """One direction's answer; the reviewed commit is the record function's argument, not a field."""
    return {
        "task_packet_hash": task["task_packet_hash"],
        "target_revision_id": task["target_revision_id"],
        "target_plan_content_hash": task["target_plan_content_hash"],
        "reviewer_agent": "aria-cross-reviewer",
        "review_direction": task["review_direction"],
        "review_content_hash": content_hash({"risks": risks, "direction": task["review_direction"]}),
        "verdict": "material_risks_present",
        "risks": risks,
    }


if __name__ == "__main__":
    unittest.main()
