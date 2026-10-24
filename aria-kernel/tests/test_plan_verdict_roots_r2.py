"""PV corrective round 2 — the roots the appellate accepted against the
round-1 corrective (/root/aria-handover/2026-10-21/build/PV/appellate-r2.md),
one class per root, each a property round 1 left broken:

* R10 the commit a review is bound to has one source, the kernel: the record
  functions take it as an argument (the answered request row's
  ``target_sha``), and a review or critique payload that names one is refused;
* R11 the cross-review anchor is minted from, and a null anchor admitted only
  for, the checkout the store is bound to — the one the staleness check reads;
* R12 the HEAD owner raises on an unreadable checkout, and every caller reads
  it before it writes: no plan is wedged half-requested, the executor fails
  the one plan, the doctor names the refusal;
* R13 the staleness check judges coverage with the kernel's one repo-glob
  matcher, never with a git pathspec built from plan text;
* R14 the evidence a standing ``resolved``/``withdrawn`` answer cites is in the
  verdict's freshness path set.

Source: SPEC.md (PV P1, P3, P5); findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from aria_kernel import convergence_drainer
from aria_kernel import executor_convergence as ec
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.cli import main as cli_main
from aria_kernel.digest import sha256_digest
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.plan_convergence import (
    content_hash,
    events_path,
    fold_plan_state,
    plan_verdict_paths,
    plan_verdict_staleness,
    record_critique,
    record_cross_review,
    request_critics,
)
from aria_kernel.plan_convergence_bridge import _dispatch_cross_review
from aria_kernel.plan_round_controller import advance_plan_rounds
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace_view import WorkspaceViewRefused
from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore
from tests.test_plan_verdict_integrity import SURFACE, _disposition, _git, _PlanFixture, _terminal

GUARD = "apps/farm-service/src/feed/feed.guard.ts"
UNANCHORED = "cross_review_request_unanchored"
PAYLOAD_NAMES_COMMIT = "review_payload_names_reviewed_commit"


def _event_count(case: _PlanFixture) -> int:
    path = events_path(case.tools)
    return len(path.read_text(encoding="utf-8").splitlines()) if path.exists() else 0


def _break_checkout(case: _PlanFixture) -> None:
    """The checkout's git directory is gone: `.git` points nowhere."""
    shutil.move(str(case.repo / ".git"), str(Path(case.tmp.name) / "moved-git"))
    (case.repo / ".git").write_text(f"gitdir: {Path(case.tmp.name) / 'missing'}\n", encoding="utf-8")


def _heal_checkout(case: _PlanFixture) -> None:
    (case.repo / ".git").unlink()
    shutil.move(str(Path(case.tmp.name) / "moved-git"), str(case.repo / ".git"))


class R10TheKernelIsTheOneBindingSource(_PlanFixture):
    """SSOT-R2-001: rounds minted by `plan advance-rounds` are anchored at A; the
    operator's `plan record-cross-review` must bind A whatever the file names."""

    def _opened_round(self) -> list[dict]:
        self.start()
        self.challenger("challenger-rev-0")
        advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.repo)
        rows = list_agent_invocation_requests(base_dir=self.tools, convergence_id="plan-1", role="cross_review")
        self.assertEqual({row["target_sha"] for row in rows}, {self.commit_a})
        tasks = fold_plan_state(plan_id="plan-1", base_dir=self.tools)["cross_reviews"][1]["tasks"].values()
        by_direction = {task["review_direction"]: task for task in tasks}
        answered = []
        for row in rows:
            direction = json.loads(row["suggested_prompt"])["task"]["review_direction"]
            answered.append({"request_id": row["request_id"], "task": by_direction[direction]})
        return answered

    def _review_file(self, answered: dict, **extra) -> Path:
        task = answered["task"]
        review = {
            "task_packet_hash": task["task_packet_hash"],
            "target_revision_id": task["target_revision_id"],
            "target_plan_content_hash": task["target_plan_content_hash"],
            "reviewer_agent": task["reviewer_agent"],
            "review_direction": task["review_direction"],
            "verdict": "agreed",
            "risks": [],
            "agent_invocation_request_id": answered["request_id"],
            **extra,
        }
        path = Path(self.tmp.name) / f"review-{task['review_direction']}.json"
        data = json.dumps(review, sort_keys=True).encode("utf-8")
        path.write_bytes(data)
        # The agent's answer the request row received (the CLI hashes the file).
        append_declared_jsonl(
            self.tools / "agent-invocations" / "results.jsonl",
            {"request_id": answered["request_id"], "content_hash": sha256_digest(data)},
            expected_surface="agent_invocation_results",
        )
        return path

    def _record(self, review_file: Path) -> None:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = cli_main(["plan", "record-cross-review", "--plan-id", "plan-1", "--tools-dir", str(self.tools),
                             "--workspace-root", str(self.repo), "--review-file", str(review_file),
                             "--workspace-base", str(Path(self.tmp.name) / "workspaces")])
        self.assertEqual(code, 0)

    def test_a_review_file_naming_a_later_commit_never_binds_it(self) -> None:
        answered = self._opened_round()
        commit_b = self.commit(SURFACE, "export const feed = 2;\n")
        for row in answered:
            with self.assertRaisesRegex(GovernanceError, PAYLOAD_NAMES_COMMIT):
                self._record(self._review_file(row, reviewed_commit_sha=commit_b))
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEW_REQUESTED")

    def test_the_cli_binds_the_answered_request_rows_target_sha(self) -> None:
        answered = self._opened_round()
        self.commit(SURFACE, "export const feed = 2;\n")
        for row in answered:
            self._record(self._review_file(row))
        result = self.evaluate(1)
        self.assertEqual(_terminal(result), "CONVERGED")
        self.assertEqual(result["event"]["payload"]["reviewed_commit_sha"], self.commit_a)
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{SURFACE}"):
            self.request_implementation_of_plan()

    def test_a_review_file_naming_no_request_is_unanchored(self) -> None:
        answered = self._opened_round()
        review_file = self._review_file(answered[0])
        review = json.loads(review_file.read_text(encoding="utf-8"))
        del review["agent_invocation_request_id"]
        review_file.write_text(json.dumps(review, sort_keys=True), encoding="utf-8")
        before = _event_count(self)
        with self.assertRaisesRegex(GovernanceError, UNANCHORED):
            self._record(review_file)
        self.assertEqual(_event_count(self), before)

    def test_a_critique_payload_naming_the_reviewed_commit_is_refused(self) -> None:
        self.start()
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        latest = state["latest_revision"]
        task = {
            "task_id": "critic-1", "task_packet_hash": content_hash({"critic": 1}), "target_agent": "aria-cross-reviewer",
            "target_revision_id": latest["revision_id"], "target_plan_content_hash": latest["content_hash"],
            "sla_deadline": "2999-01-01T00:00:00+00:00",
        }
        request_critics(plan_id="plan-1", request={"round_number": 1, "target_revision_id": latest["revision_id"],
                                                   "target_plan_content_hash": latest["content_hash"],
                                                   "tasks": [task]}, base_dir=self.tools)
        critique = {
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "reviewer": "aria-cross-reviewer", "risks": [],
            "critique_content_hash": content_hash({"reviewer": "aria-cross-reviewer", "risks": []}),
        }
        with self.assertRaisesRegex(GovernanceError, PAYLOAD_NAMES_COMMIT):
            record_critique(plan_id="plan-1", critique={**critique, "reviewed_commit_sha": self.commit_a},
                            workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=self.commit_a)
        record_critique(plan_id="plan-1", critique=critique, workspace_root=self.repo, base_dir=self.tools,
                        reviewed_commit_sha=self.commit_a)
        [answer] = fold_plan_state(plan_id="plan-1", base_dir=self.tools)["rounds"][1]["critiques"]
        self.assertEqual(answer["reviewed_commit_sha"], self.commit_a)


class R11OneCheckoutAnchorsAndCompares(_PlanFixture):
    def _dispatch(self, target_sha) -> None:
        _dispatch_cross_review(
            request={"request_id": "req-cr-1", "target_sha": target_sha,
                     "target_agent": "aria-cross-reviewer", "workspace_root": str(self.repo)},
            response={}, details={"cross_review": {"verdict": "agreed", "risks": []}},
            plan_id="plan-1", base_dir=self.tools,
        )

    def test_a_null_anchor_while_the_checkout_has_a_commit_is_refused_and_appends_nothing(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        before = _event_count(self)
        with self.assertRaisesRegex(GovernanceError, UNANCHORED):
            self._dispatch(None)
        self.assertEqual(_event_count(self), before)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_pa2_sequence_ends_in_a_refusal(self) -> None:
        # PA2: the round is minted by a process whose cwd is not the store's
        # checkout, the round converges, then the covered surface is deleted.
        self.start()
        self.challenger("challenger-rev-0")
        with tempfile.TemporaryDirectory() as plain:
            cwd = os.getcwd()
            os.chdir(plain)
            try:
                advance_plan_rounds(plan_id="plan-1", base_dir=self.tools)
            finally:
                os.chdir(cwd)
        rows = list_agent_invocation_requests(base_dir=self.tools, convergence_id="plan-1", role="cross_review")
        self.assertEqual([row["target_sha"] for row in rows], [self.commit_a, self.commit_a])
        tasks = list(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["cross_reviews"][1]["tasks"].values())

        def review(task: dict) -> dict:
            return {
                "task_packet_hash": task["task_packet_hash"], "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"], "reviewer_agent": task["reviewer_agent"],
                "review_direction": task["review_direction"], "verdict": "agreed", "risks": [],
                "review_content_hash": content_hash({"d": task["review_direction"]}),
            }

        # The null such a mint used to write is refused at record time.
        with self.assertRaisesRegex(GovernanceError, UNANCHORED):
            record_cross_review(plan_id="plan-1", review=review(tasks[0]), workspace_root=self.repo,
                                base_dir=self.tools, reviewed_commit_sha=None)
        for task, row in zip(tasks, rows):
            record_cross_review(plan_id="plan-1", review=review(task), workspace_root=self.repo,
                                base_dir=self.tools, reviewed_commit_sha=row["target_sha"])
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        _git(self.repo, "rm", "-q", SURFACE)
        _git(self.repo, "commit", "-q", "-m", "delete the covered surface")
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{SURFACE}"):
            self.request_implementation_of_plan()

    def test_the_drainer_anchors_the_cross_review_at_the_stores_checkout(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        with tempfile.TemporaryDirectory() as plain:
            convergence_drainer.run_convergence_drainer(
                cycle_id="cyc-1", base_dir=self.tools, workspace_root=plain, plan_id="plan-1", plan_seed={},
            )
        [row] = list_agent_invocation_requests(base_dir=self.tools, convergence_id="plan-1", role="cross_review")
        self.assertEqual(row["target_sha"], self.commit_a)


class R12TheHeadOwnerIsReadBeforeAnyWrite(_PlanFixture):
    def test_the_delegate_is_gone(self) -> None:
        self.assertFalse(hasattr(convergence_drainer, "_resolve_workspace_head_sha"))

    def test_an_unreadable_checkout_leaves_the_plan_unrequested_and_the_heal_mints_the_round(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        before = _event_count(self)
        _break_checkout(self)
        with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
            advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.repo)
        self.assertEqual(_event_count(self), before)
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(state["state"], "CHALLENGER_DRAFTED")
        self.assertNotIn("cross_review_tasks_requested", [event["event_type"] for event in state["events"]])
        _heal_checkout(self)
        advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.repo)
        rows = list_agent_invocation_requests(base_dir=self.tools, convergence_id="plan-1", role="cross_review")
        self.assertEqual([row["target_sha"] for row in rows], [self.commit_a, self.commit_a])

    def test_the_executor_fails_the_one_plan_on_an_unreadable_checkout(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        _break_checkout(self)
        outcome = ec.advance_after_accepted_step(
            request={"request_id": "req-ch-1", "role": "challenger_plan", "convergence_id": "plan-1"},
            tools_dir=self.tools, workspace_root=self.repo, run_id="run-1", budget=ec.AdvanceBudget(),
            drain_remaining=None, environ={ec.WRITER_LEASE_ENV: ec.WRITER_LEASE_HELD},
        )
        self.assertEqual((outcome["status"], outcome["error_class"]), (ec.ADVANCE_FAILED, "WorkspaceViewRefused"))
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_operator_start_reads_head_before_it_opens_the_plan(self) -> None:
        from aria_kernel.convergent_planning_bridge import start_convergent_plan_with_challenger
        from aria_kernel.request_admission import admit_request

        _break_checkout(self)
        with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
            start_convergent_plan_with_challenger(
                plan_id="plan-op", plan_content=self.plan(), initial_revision_id="rev-0", operator_must_satisfy=[],
                admission=admit_request("operator_cli.convergent_plan", "challenger_plan", base_dir=self.tools),
                base_dir=self.tools, workspace_root=self.repo,
            )
        self.assertIsNone(fold_plan_state(plan_id="plan-op", base_dir=self.tools).get("state"))

    def test_the_doctor_names_the_refusal(self) -> None:
        from aria_kernel.doctor import _check_learning_funnel

        _break_checkout(self)
        check = _check_learning_funnel(self.tools, self.repo)
        self.assertEqual(check.status, "warn")
        self.assertTrue(check.reason.startswith("workspace_head_unreadable"), check.reason)


class R12AnExpiredJudgeIsReMintedOnlyOnAReadableHead(AnchorStaleStore):
    """The anchor-stale sweep anchors a re-minted judge at HEAD: an unreadable
    checkout stops the sweep before its first write, so the next sweep decides
    the request again, instead of closing it as an operator's failed effect."""

    def test_the_refusal_writes_nothing_and_the_next_sweep_remints(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        head = self.commit()
        self.expire(dead)
        refused = WorkspaceViewRefused("workspace_head_unreadable:git_exit_128")
        with mock.patch("aria_kernel.workspace_view.workspace_head_sha", side_effect=refused):
            with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
                self.sweep()
        self.assertFalse(self.record_path(dead).exists())
        self.assertEqual(self.successors(dead), [])
        self.sweep()
        [successor] = self.successors(dead)
        self.assertEqual(successor["target_sha"], head)


class R13CoverageIsTheKernelsGlobMatcher(_PlanFixture):
    def _converged(self, surface: str) -> None:
        from aria_kernel.plan_convergence import start_plan

        start_plan(plan_id="plan-1", initial_revision_id="rev-0",
                   plan_content=self.plan(affected_surfaces=[{"paths": [surface]}]), base_dir=self.tools)
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")

    def test_a_brace_surface_goes_stale(self) -> None:
        self._converged("apps/farm-service/src/feed/feed.{service,controller}.ts")
        self.commit(SURFACE, "export const feed = 2;\n")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(plan_verdict_staleness(state, base_dir=self.tools), f"plan_verdict_stale:{SURFACE}")
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{SURFACE}"):
            self.request_implementation_of_plan()


class R14TheClearingEvidenceIsInThePathSet(_PlanFixture):
    def _cleared(self, disposition: str) -> None:
        self.commit(GUARD, "export const guard = true;\n")
        self.round_one_blocking_then_claimed()
        self.cross_review([], verdict="agreed", dispositions=[_disposition("CR-R1-CR-001", disposition, [f"{GUARD}:1"])])
        self.assertEqual(_terminal(self.evaluate(2)), "CONVERGED")

    def test_the_answers_evidence_is_a_verdict_path(self) -> None:
        for disposition in ("withdrawn", "resolved"):
            with self.subTest(disposition=disposition):
                self.tearDown()
                self.setUp()
                self._cleared(disposition)
                state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
                self.assertIn(GUARD, plan_verdict_paths(state).paths)

    def test_a_commit_to_the_cited_evidence_makes_the_verdict_stale(self) -> None:
        for disposition in ("withdrawn", "resolved"):
            with self.subTest(disposition=disposition):
                self.tearDown()
                self.setUp()
                self._cleared(disposition)
                self.commit(GUARD, "export const guard = false;\n")
                with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{GUARD}"):
                    self.request_implementation_of_plan()


class R14AnOpenAnswersEvidenceClearsNothing(_PlanFixture):
    def test_an_open_answer_cites_no_verdict_path(self) -> None:
        self.round_one_blocking_then_claimed()
        self.cross_review([], verdict="agreed",
                          dispositions=[_disposition("CR-R1-CR-001", "open", [f"{GUARD}:1"])])
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertNotIn(GUARD, plan_verdict_paths(state).paths)


if __name__ == "__main__":
    unittest.main()
