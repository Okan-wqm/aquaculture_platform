"""PV corrective round 1 — the roots the appellate accepted against the first
PV implementation (/root/aria-handover/2026-10-21/build/PV/appellate-r1.md),
one class per root, each a property the first implementation broke (the P3
binding roots; R6-R9 join with the P1/P5 corrections):

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
  (``plan_origin.body_paths``: surfaces AND key-change paths).

Source: SPEC.md (PV P1, P3, P5); findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import copy
import hashlib
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.convergence_drainer import _resolve_workspace_head_sha
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.plan_convergence import (
    content_hash,
    events_path,
    fold_plan_state,
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
    _git,
    _PlanFixture,
    _terminal,
)

KEY_CHANGE_FILE = "apps/farm-service/src/feed/feed.mapper.ts"


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
            self.assertEqual(_resolve_workspace_head_sha(self.repo), self.commit_a)

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
        self.start()
        self.challenger("challenger-rev-0")
        tasks = _request_round_tasks(self)
        review = _direction_review(self, tasks[0], risks=[])
        del review["reviewed_commit_sha"]
        with self.assertRaisesRegex(GovernanceError, "reviewed_commit_sha required"):
            record_cross_review(plan_id="plan-1", review=review, workspace_root=self.repo, base_dir=self.tools)


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
            _resolve_workspace_head_sha(self.repo)

    def test_a_verdict_on_the_empty_tree_is_unverifiable_in_a_broken_checkout(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        submit_cross_review_v8(plan_id="plan-1", review={"verdict": "agreed", "risks": []},
                               workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=None)
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        self._break_checkout()
        with self.assertRaisesRegex(GovernanceError, "plan_verdict_unverifiable:workspace_head_unreadable"):
            self.request_implementation_of_plan()

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "chown to another uid needs root")
    def test_a_dubious_ownership_checkout_is_unverifiable(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        submit_cross_review_v8(plan_id="plan-1", review={"verdict": "agreed", "risks": []},
                               workspace_root=self.repo, base_dir=self.tools, reviewed_commit_sha=None)
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SUDO_UID", None)
            subprocess.run(["chown", "-R", "65534:65534", str(self.repo / ".git")], check=True)
            with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_head_unreadable"):
                _resolve_workspace_head_sha(self.repo)
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
    return {
        "task_packet_hash": task["task_packet_hash"],
        "target_revision_id": task["target_revision_id"],
        "target_plan_content_hash": task["target_plan_content_hash"],
        "reviewer_agent": "aria-cross-reviewer",
        "review_direction": task["review_direction"],
        "review_content_hash": content_hash({"risks": risks, "direction": task["review_direction"]}),
        "verdict": "material_risks_present",
        "risks": risks,
        "reviewed_commit_sha": case.commit_a,
    }


if __name__ == "__main__":
    unittest.main()
