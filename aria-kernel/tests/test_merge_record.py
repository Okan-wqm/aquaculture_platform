"""ARIA-HIGH-390 — "this ARIA PR merged" has one writer, and a person's merge reaches the plan.

Pins, in the order the gap was measured (2026-10-09, PR #1906 waiting for a
person's merge):

* a RECORDED plan whose PR a person merged gets its plan merge AND its PR's
  ``pr-lifecycle`` ``merged`` row, once, through ``merge_record``;
* a plan merged before the one owner existed gets exactly one backfilled row;
* a plan the kernel ended after its PR existed folds MERGED only on an
  observed merge of that exact PR at its delivered head; every forgery is
  refused;
* nothing but ``merge_record`` writes either fact.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.implementation_reconciler import reconcile_recorded_implementations
from aria_kernel.ledger import load_jsonl
from aria_kernel.merge_record import (
    LINEAGE_BASE_MERGED,
    LINEAGE_DELIVERED,
    LINEAGE_DIVERGED,
    LINEAGE_PATCH_UNCHANGED,
    LINEAGE_UNVERIFIABLE,
    MERGED_BY_MERGE_LANE,
    MergeNotProven,
    classify_merged_head,
    lifecycle_rows,
    merged_row_is_arias,
    record_merge,
    verify_merge_after_rejection,
)
from aria_kernel.plan_convergence import (
    _record_implementation_merged as record_implementation_merged,
    events_path,
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture
from tests.test_implementation_lifecycle_continuity import drive_plan_to_implementation_requested
from tests.test_implementation_settlement import _ImplementationRequested

PR = 4242
TIP = "d" * 40
MERGE_SHA = "f" * 40
_REPO_ROOT = Path(__file__).resolve().parents[2]


class Reader:
    def __init__(self, **answer: Any) -> None:
        self.answer = {"number": PR, "state": "MERGED", "mergedAt": "2026-10-09T12:00:00Z",
                       "mergeCommit": {"oid": MERGE_SHA}, "headRefOid": TIP, **answer}
        self.asked: list[int] = []

    def readable(self) -> tuple[bool, str]:
        return True, "ok"

    def pr_merge_state(self, pr_number: int) -> dict:
        self.asked.append(pr_number)
        return dict(self.answer)


class Unreadable(Reader):
    def readable(self) -> tuple[bool, str]:
        return False, "no_token"


def _opened(tools: Path, *, change_id: str, head_sha: str = TIP, pr_number: int = PR) -> None:
    append_declared_fixture(tools / "pr-lifecycle.jsonl", {
        "schema_version": 1, "recorded_at": "2026-10-09T10:00:00Z", "cycle_id": None, "event": "opened",
        "pr_number": pr_number, "base_branch": "main", "head_sha": head_sha, "task_id": None,
        "proposal_id": "prop-1", "assignment_id": None, "change_id": change_id, "changed_files": ["a.ts"],
    }, expected_surface="pr_lifecycle")


def _merged_rows(tools: Path) -> list[dict]:
    return [row for row in lifecycle_rows(tools) if row.get("event") == "merged"]


class APersonsMergeOfARecordedPlan(unittest.TestCase):
    """PR #1906's shape: the implementation recorded its PR; a person merges it."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-merge-record-")
        self.addCleanup(tmp.cleanup)
        self.tools = Path(tmp.name) / "aria-tools"
        self.root = Path(tmp.name) / "workspace"
        from tests.test_implementation_lifecycle_continuity import seed_reviewer_agent

        seed_reviewer_agent(self.root)
        drive_plan_to_implementation_requested(plan_id="plan-r", tools=self.tools, workspace_root=self.root)
        record_implementation_started(plan_id="plan-r", claim_id="claim-1", implementer_agent="aria-implementer",
                                      started_at="2026-10-09T10:00:00Z", base_dir=self.tools)
        record_implementation_outcome(
            plan_id="plan-r", claim_id="claim-1", pr_url=f"https://github.com/o/r/pull/{PR}",
            diff_hash="sha256:" + "c" * 64, branch_tip_sha=TIP, base_branch_sha="e" * 40,
            validation_results=[], signer_key_fp="fp-1", completed_at="2026-10-09T10:00:13Z", base_dir=self.tools)
        _opened(self.tools, change_id="chg-r")

    def reconcile(self, reader: Reader) -> dict:
        return reconcile_recorded_implementations(base_dir=self.tools, workspace_root=self.root, reader=reader)

    def test_the_merge_reaches_the_plan_and_the_lifecycle_once(self) -> None:
        result = self.reconcile(Reader())
        self.assertEqual([row["plan_id"] for row in result["merged"]], ["plan-r"], result)
        self.assertEqual(fold_plan_state(plan_id="plan-r", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")
        merged = _merged_rows(self.tools)
        self.assertEqual([(row["pr_number"], row["head_sha"], row["delivered_head_sha"], row["change_id"],
                           row["merge_sha"], row["merged_at"], row["head_lineage"]) for row in merged],
                         [(PR, TIP, TIP, "chg-r", MERGE_SHA, "2026-10-09T12:00:00Z", LINEAGE_DELIVERED)])
        # The finding closure and the convention promotion ran for it.
        self.assertEqual([row["plan_id"] for row in result["finding_closures"]], ["plan-r"])
        self.assertEqual([row["plan_id"] for row in result["promotions"]], ["plan-r"])
        again = self.reconcile(Reader())
        self.assertEqual(again["merged"], [])
        self.assertEqual(len(_merged_rows(self.tools)), 1)
        self.assertEqual(len([row for row in load_jsonl(events_path(self.tools))
                              if row.get("event_type") == "implementation_merged"]), 1)

    def test_a_plan_merged_before_the_owner_gets_exactly_one_backfilled_row(self) -> None:
        # A merge written to the plan ledger alone (the pre-owner shape).
        record_implementation_merged(plan_id="plan-r", merge_sha=MERGE_SHA, merged_at="2026-10-09T12:00:00Z",
                                     idempotency_key_hash="sha256:" + "a" * 64, base_dir=self.tools)
        self.assertEqual(_merged_rows(self.tools), [])
        first = self.reconcile(Unreadable())  # the backfill needs no GitHub read
        self.assertEqual(first["lifecycle_backfilled"], [{"plan_id": "plan-r", "pr_number": PR}])
        [row] = _merged_rows(self.tools)
        # F2 — the plan's own merge facts, never "merged today".
        self.assertEqual((row["merged_at"], row["merge_sha"]), ("2026-10-09T12:00:00Z", MERGE_SHA))
        self.assertEqual(self.reconcile(Unreadable())["lifecycle_backfilled"], [])
        self.assertEqual(len(_merged_rows(self.tools)), 1)

    def test_an_unmerged_pr_changes_nothing(self) -> None:
        self.reconcile(Reader(state="OPEN", mergedAt=None, mergeCommit=None))
        self.assertEqual(fold_plan_state(plan_id="plan-r", base_dir=self.tools)["state"], "IMPLEMENTATION_RECORDED")
        self.assertEqual(_merged_rows(self.tools), [])

    def test_a_backfill_without_the_kernels_opened_row_is_skipped_not_guessed(self) -> None:
        (self.tools / "pr-lifecycle.jsonl").unlink()
        record_implementation_merged(plan_id="plan-r", merge_sha=MERGE_SHA, merged_at="2026-10-09T12:00:00Z",
                                     idempotency_key_hash="sha256:" + "a" * 64, base_dir=self.tools)
        result = self.reconcile(Unreadable())
        self.assertEqual(result["lifecycle_backfill_skipped"],
                         [{"plan_id": "plan-r", "pr_number": PR, "reason": "no_opened_row"}])
        self.assertEqual(_merged_rows(self.tools), [])

    def test_a_person_s_commits_on_the_branch_are_not_credited_to_aria(self) -> None:
        # F1 — the plan's PR merged (the plan folds MERGED), but at a head the
        # kernel cannot prove is its delivered change: the row says so and
        # the readers that credit ARIA refuse it.
        self.reconcile(Reader(headRefOid="7" * 40))
        self.assertEqual(fold_plan_state(plan_id="plan-r", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")
        [row] = _merged_rows(self.tools)
        self.assertEqual((row["head_sha"], row["delivered_head_sha"]), ("7" * 40, TIP))
        self.assertIn(row["head_lineage"], {LINEAGE_DIVERGED, LINEAGE_UNVERIFIABLE})
        self.assertFalse(merged_row_is_arias(row))
        from aria_kernel.pr_tracking import ingest_merged_pr_lifecycle

        self.assertEqual(ingest_merged_pr_lifecycle(base_dir=self.tools)["ingested"], [])


class APersonsMergeOfAHandedOverPlan(_ImplementationRequested):
    """ARIA-HIGH-389's hand-over: the kernel ended the plan beside a live PR; a person merges it."""

    def setUp(self) -> None:
        super().setUp()
        from aria_kernel.implementation_settlement import hand_over_delivered_implementation

        _opened(self.tools, change_id="chg-1")
        outcome = hand_over_delivered_implementation(
            request_id=self.request_id, cause="submit_timeout", pr_number=PR,
            pr_url=f"https://github.com/o/r/pull/{PR}", branch="aria-impl-1", branch_tip_sha=TIP,
            base_dir=self.tools)
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED", outcome)

    def reconcile(self, reader: Reader) -> dict:
        return reconcile_recorded_implementations(base_dir=self.tools, workspace_root=self.root, reader=reader)

    def test_an_observed_merge_of_its_own_pr_at_the_delivered_head_folds_merged(self) -> None:
        result = self.reconcile(Reader())
        self.assertEqual([row["plan_id"] for row in result["merged"]], ["plan-1"], result)
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(state["state"], "IMPLEMENTATION_MERGED")
        self.assertEqual(state["implementation"]["merged_after_rejection"],
                         {"rejection_class": "implementation_result_refused_after_delivery", "pr_number": PR,
                          "head_sha": TIP})
        self.assertEqual(len(_merged_rows(self.tools)), 1)
        self.assertEqual(self.reconcile(Reader())["merged"], [])

    def test_the_merge_supersedes_the_rejection_in_learning(self) -> None:
        # F6 — one change, one verdict: the merged episode supersedes the
        # rejected one, and the loop guard no longer counts the plan failed.
        from datetime import datetime, timezone

        from aria_kernel.finding_grounding import _fold_plans

        self.reconcile(Reader())
        rejected, merged = self.implementer_episodes()
        self.assertEqual((rejected["outcome"], merged["outcome"]), ("rejected", "merged"))
        self.assertEqual(merged["supersedes"], rejected["episode_id"])
        [plan] = [record for record in _fold_plans(self.tools, datetime.now(timezone.utc))
                  if record.plan_id == "plan-1"]
        self.assertIsNotNone(plan.merged_at)
        self.assertEqual((plan.failed_at, plan.unverified_failed_at), (None, None))

    def test_a_merge_at_an_unproven_head_is_refused_once_and_not_asked_again(self) -> None:
        reader = Reader(headRefOid="9" * 40)
        result = self.reconcile(reader)
        self.assertEqual(len(result["merge_refusals"]), 1)
        self.assertTrue(result["merge_refusals"][0]["reason"].startswith("merged_head_is_not_the_delivered_change:"))
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        self.assertEqual(_merged_rows(self.tools), [])
        self.reconcile(reader)
        self.assertEqual(reader.asked, [PR])  # F7: recorded once, never re-polled

    def test_a_pr_closed_unmerged_is_recorded_and_not_asked_again(self) -> None:
        reader = Reader(state="CLOSED", mergedAt=None, mergeCommit=None)
        for _ in range(3):
            self.reconcile(reader)
        self.assertEqual(reader.asked, [PR])
        self.assertEqual([row["event"] for row in lifecycle_rows(self.tools) if row.get("pr_number") == PR][-1],
                         "closed_unmerged")
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")

    def test_github_answering_another_pr_is_refused(self) -> None:
        self.assertEqual(self.reconcile(Reader(number=9999))["merge_refusals"][0]["reason"],
                         "github_answered_another_pr")
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")

    def test_every_pr_opened_for_the_plans_change_is_asked(self) -> None:
        # A second opened row for the same change no longer shadows the first.
        _opened(self.tools, change_id="chg-1", head_sha="9" * 40, pr_number=PR + 1)
        reader = Reader()
        self.reconcile(reader)
        self.assertEqual(reader.asked[0], PR)
        self.assertEqual(self.state(), "IMPLEMENTATION_MERGED")

    def test_a_pr_opened_for_another_change_is_never_this_plans(self) -> None:
        tmp_reader = Reader()
        # Only an opened row for a DIFFERENT change: the plan has no PR to ask about.
        (self.tools / "pr-lifecycle.jsonl").unlink()
        _opened(self.tools, change_id="chg-other")
        self.reconcile(tmp_reader)
        self.assertEqual(tmp_reader.asked, [])
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")

    def test_the_reducer_refuses_a_forged_merge_after_rejection(self) -> None:
        for forged in ({"rejection_class": "implementer_refused", "pr_number": PR, "head_sha": TIP},
                       {"rejection_class": "implementation_result_refused_after_delivery"}):
            with self.subTest(forged=forged), self.assertRaises(GovernanceError):
                record_implementation_merged(plan_id="plan-1", merge_sha=MERGE_SHA, merged_at="2026-10-09T12:00:00Z",
                                             idempotency_key_hash="sha256:" + "a" * 64,
                                             merged_after_rejection=forged, base_dir=self.tools)
        with self.assertRaises(GovernanceError):  # F10: the settlement named PR, not another
            record_implementation_merged(
                plan_id="plan-1", merge_sha=MERGE_SHA, merged_at="2026-10-09T12:00:00Z",
                idempotency_key_hash="sha256:" + "a" * 64, base_dir=self.tools,
                merged_after_rejection={"rejection_class": "implementation_result_refused_after_delivery",
                                        "pr_number": PR + 7, "head_sha": TIP})
        with self.assertRaises(GovernanceError):  # no claim at all: REJECTED never folds MERGED
            record_implementation_merged(plan_id="plan-1", merge_sha=MERGE_SHA, merged_at="2026-10-09T12:00:00Z",
                                         idempotency_key_hash="sha256:" + "a" * 64, base_dir=self.tools)


class TheOwnersVerification(unittest.TestCase):
    def test_every_unproven_fact_is_named(self) -> None:
        opened = {"pr_number": PR, "head_sha": TIP}
        cases = {
            "no_opened_row_for_the_plans_change": (None, Reader().answer),
            "github_unanswered": (opened, None),
            "pr_not_merged": (opened, {**Reader().answer, "state": "OPEN"}),
            "merged_head_is_not_the_delivered_change": (opened, {**Reader().answer, "headRefOid": "0" * 40}),
        }
        for reason, (row, remote) in cases.items():
            with self.subTest(reason=reason), self.assertRaisesRegex(MergeNotProven, reason):
                verify_merge_after_rejection(opened=row, remote=remote, workspace=None)

    def test_only_the_owner_writes_a_merged_lifecycle_row(self) -> None:
        from aria_kernel.auto_merge import record_pr_lifecycle

        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(GovernanceError, "has_one_writer"):
            record_pr_lifecycle({"number": PR}, event="merged", base_dir=Path(tmp) / "aria-tools")

    def test_the_merge_lane_records_one_row_per_pr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            pr = {"number": PR, "headRefOid": TIP, "baseRefName": "main"}
            self.assertTrue(record_merge(pr=pr, merged_by=MERGED_BY_MERGE_LANE, base_dir=tools)["lifecycle_row"])
            self.assertFalse(record_merge(pr=pr, merged_by=MERGED_BY_MERGE_LANE, base_dir=tools)["lifecycle_row"])
            self.assertEqual(len(_merged_rows(tools)), 1)


def _git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null"}
    return subprocess.run(["git", "-c", "commit.gpgsign=false", *args], cwd=repo, check=True, capture_output=True,
                          text=True, env=env).stdout.strip()


class TheMergedHeadsLineage(unittest.TestCase):
    """F1 — main moved (A -> B); ARIA delivered D on A; what merged at S?"""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-lineage-")
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        _git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "base.txt").write_text("a\n")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "A")
        self.a = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "checkout", "-q", "-b", "feature")
        (self.repo / "feature.txt").write_text("aria\n")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "D")
        self.d = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "checkout", "-q", "main")
        (self.repo / "other.txt").write_text("b\n")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "B")
        self.b = _git(self.repo, "rev-parse", "HEAD")

    def _merge_into_main(self, head: str) -> str:
        _git(self.repo, "checkout", "-q", "main")
        _git(self.repo, "merge", "-q", "--no-ff", "-m", "S", head)
        return _git(self.repo, "rev-parse", "HEAD")

    def classify(self, head: str, merge_sha: str) -> str:
        return classify_merged_head(self.repo, pr_number=PR, delivered_sha=self.d, head_sha=head, merge_sha=merge_sha)

    def test_the_delivered_head(self) -> None:
        self.assertEqual(self.classify(self.d, self._merge_into_main(self.d)), LINEAGE_DELIVERED)

    def test_an_update_branch_merge_of_the_base_is_arias(self) -> None:
        _git(self.repo, "checkout", "-q", "feature")
        _git(self.repo, "merge", "-q", "--no-ff", "-m", "update", self.b)
        updated = _git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(self.classify(updated, self._merge_into_main(updated)), LINEAGE_BASE_MERGED)

    def test_the_delivered_patch_rebased_is_arias(self) -> None:
        _git(self.repo, "checkout", "-q", "-b", "rebased", self.b)
        _git(self.repo, "cherry-pick", self.d)
        rebased = _git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(self.classify(rebased, self._merge_into_main(rebased)), LINEAGE_PATCH_UNCHANGED)

    def test_a_persons_commit_on_top_is_not(self) -> None:
        _git(self.repo, "checkout", "-q", "feature")
        (self.repo / "feature.txt").write_text("a person's edit\n")
        _git(self.repo, "commit", "-q", "-am", "E")
        extra = _git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(self.classify(extra, self._merge_into_main(extra)), LINEAGE_DIVERGED)

    def test_without_a_checkout_nothing_is_proven(self) -> None:
        self.assertEqual(classify_merged_head(None, pr_number=PR, delivered_sha=self.d, head_sha="9" * 40,
                                              merge_sha=MERGE_SHA), LINEAGE_UNVERIFIABLE)


if __name__ == "__main__":
    unittest.main()
