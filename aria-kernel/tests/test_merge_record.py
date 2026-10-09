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

import ast
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.implementation_reconciler import reconcile_recorded_implementations
from aria_kernel.ledger import load_jsonl
from aria_kernel.merge_record import (
    MERGED_BY_MERGE_LANE,
    MergeNotProven,
    lifecycle_rows,
    record_merge,
    verify_merge_after_rejection,
)
from aria_kernel.plan_convergence import (
    events_path,
    fold_plan_state,
    record_implementation_merged,
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
        self.assertEqual([(row["pr_number"], row["head_sha"], row["change_id"]) for row in merged],
                         [(PR, TIP, "chg-r")])
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
        self.assertEqual(len(_merged_rows(self.tools)), 1)
        self.assertEqual(self.reconcile(Unreadable())["lifecycle_backfilled"], [])
        self.assertEqual(len(_merged_rows(self.tools)), 1)

    def test_an_unmerged_pr_changes_nothing(self) -> None:
        self.reconcile(Reader(state="OPEN", mergedAt=None, mergeCommit=None))
        self.assertEqual(fold_plan_state(plan_id="plan-r", base_dir=self.tools)["state"], "IMPLEMENTATION_RECORDED")
        self.assertEqual(_merged_rows(self.tools), [])


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

    def test_a_merge_at_another_head_is_refused(self) -> None:
        result = self.reconcile(Reader(headRefOid="9" * 40))
        self.assertEqual(result["merge_refusals"], [{"plan_id": "plan-1",
                                                     "reason": "merged_head_is_not_the_delivered_head"}])
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        self.assertEqual(_merged_rows(self.tools), [])

    def test_an_unmerged_or_another_pr_changes_nothing(self) -> None:
        self.reconcile(Reader(state="CLOSED", mergedAt=None, mergeCommit=None))
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        self.assertEqual(self.reconcile(Reader(number=9999))["merge_refusals"][0]["reason"],
                         "github_answered_another_pr")
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")

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
            "merged_head_is_not_the_delivered_head": (opened, {**Reader().answer, "headRefOid": "0" * 40}),
        }
        for reason, (row, remote) in cases.items():
            with self.subTest(reason=reason), self.assertRaisesRegex(MergeNotProven, reason):
                verify_merge_after_rejection(opened=row, remote=remote)

    def test_the_merge_lane_records_one_row_per_pr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            pr = {"number": PR, "headRefOid": TIP, "baseRefName": "main"}
            self.assertTrue(record_merge(pr=pr, merged_by=MERGED_BY_MERGE_LANE, base_dir=tools)["lifecycle_row"])
            self.assertFalse(record_merge(pr=pr, merged_by=MERGED_BY_MERGE_LANE, base_dir=tools)["lifecycle_row"])
            self.assertEqual(len(_merged_rows(tools)), 1)


class NothingElseWritesMerged(unittest.TestCase):
    """Tier-3: a second writer of either "merged" fact fails the build."""

    def test_only_merge_record_writes_a_merged_lifecycle_row_or_a_plan_merge(self) -> None:
        offenders: list[str] = []
        for root in ("aria-kernel/aria_kernel", "tools/aria-poc", "tools/aria"):
            for path in sorted((_REPO_ROOT / root).rglob("*.py")):
                relative = path.relative_to(_REPO_ROOT).as_posix()
                if "/tests/" in relative or relative.endswith("aria_kernel/merge_record.py"):
                    continue
                for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                    if not isinstance(node, ast.Call):
                        continue
                    name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
                    if name == "record_implementation_merged":
                        offenders.append(f"{relative}:{node.lineno}")
                    elif name == "record_pr_lifecycle" and any(
                            keyword.arg == "event" and not (isinstance(keyword.value, ast.Constant)
                                                            and keyword.value.value != "merged")
                            for keyword in node.keywords):
                        offenders.append(f"{relative}:{node.lineno}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
