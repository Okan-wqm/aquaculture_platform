"""ARIA-HIGH-372 / ARIA-HIGH-373 — what happens to an ARIA PR after it opens.

372: main requires an up-to-date branch and ARIA never updated its own PR
branches, so every ARIA PR became unmergeable the hour main moved. The cycle
now asks GitHub's ``update-branch`` (``expected_head_sha``) for each behind,
green ARIA PR, on the delivery credential path, once per (head, base).

373: a PR the merge lane cannot merge got a label and nothing else. It is now
ONE HUMAN_REQUIRED item carrying the PR URL, its CI state and why it is not
self-mergeable, refreshed while it waits, resolved when GitHub reports it
merged or closed, and listed in the daily report.

Every collaborator that would reach GitHub is a fake that records; the
ledgers are the real ones.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator
from unittest import mock

from aria_kernel import cycle
from aria_kernel.auto_merge import record_pr_lifecycle
from aria_kernel.human_merge_surface import (
    daily_report_lines,
    human_merge_request_id,
    surface_human_merge_prs,
)
from aria_kernel.human_required import list_human_required
from aria_kernel.pr_branch_update import update_behind_aria_prs
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.operator_acts import operator_set_profile

BRANCH = "aria-impl-0a1b2c3d"
HEAD = "a" * 40
DELIVERED = HEAD
MAIN = "b" * 40
URL = "https://github.com/fixture/repo/pull/7"
GREEN = [{"name": "merge-gate", "status": "COMPLETED", "conclusion": "SUCCESS"},
         {"context": "build-status", "state": "SUCCESS"}]


class FakeReader:
    def __init__(self, live: dict[str, Any] | None) -> None:
        self.live = live

    def readable(self) -> tuple[bool, str]:
        return True, "ok"

    def list_own_prs(self) -> list[dict[str, Any]]:
        if self.live is None or self.live.get("state") != "OPEN":
            return []
        return [{"number": 7, "headRefName": self.live["headRefName"]}]

    def pr_delivery_state(self, pr_number: int) -> dict[str, Any] | None:
        return dict(self.live) if self.live is not None and pr_number == 7 else None


def _live(**overrides: Any) -> dict[str, Any]:
    return {"number": 7, "state": "OPEN", "url": URL, "headRefName": BRANCH, "headRefOid": HEAD,
            "baseRefOid": MAIN, "mergeStateStatus": "BEHIND", "statusCheckRollup": GREEN, "labels": [],
            **overrides}


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-372-373-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        operator_set_profile("strict", base_dir=self.tools)

    def _opened(self, *, human_merge: bool, lane: str) -> None:
        record_pr_lifecycle(
            {"number": 7, "base_branch": "main", "head_sha": DELIVERED, "change_id": "chg-7", "changed_files": [],
             "merge_route": {"human_merge": human_merge, "lane": lane, "valid": True,
                             "reason_codes": [] if not human_merge else ["lane_L2"], "policy_hash": "sha256:x"}},
            event="opened", base_dir=self.tools,
        )
        append_declared_fixture(self.tools / "change-ledger" / "committed.jsonl",
                                {"change_id": "chg-7", "commit_sha": DELIVERED}, expected_surface="change_committed")


class BranchUpdateTests(_Store):
    def setUp(self) -> None:
        super().setUp()
        self._opened(human_merge=True, lane="L2")
        self.calls: list[dict[str, Any]] = []
        self.holds: list[dict[str, Any]] = []

    @contextmanager
    def _hold(self, **kwargs: Any) -> Iterator[SimpleNamespace]:
        self.holds.append(kwargs)
        yield SimpleNamespace(env={"GH_TOKEN": "ghs_fixture_installation"})

    def _runner(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"argv": argv, "token": kwargs["env"].get("GH_TOKEN"), "timeout": kwargs.get("timeout")})
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    def _update(self, live: dict[str, Any] | None, *, profile: str = "strict") -> dict[str, Any]:
        return update_behind_aria_prs(
            cycle_id="cyc-372", base_dir=self.tools, workspace_root=self.root, reader=FakeReader(live),
            profile=profile, credential_hold=self._hold, runner=self._runner,
        )

    def test_a_behind_green_aria_pr_is_updated_once_per_head_and_base(self) -> None:
        first = self._update(_live())
        self.assertEqual([row["outcome"] for row in first["requested"]], ["accepted"], first)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["argv"], [
            "gh", "api", "-X", "PUT", "repos/{owner}/{repo}/pulls/7/update-branch", "-f", f"expected_head_sha={HEAD}",
        ])
        self.assertEqual(self.calls[0]["token"], "ghs_fixture_installation")
        self.assertEqual([hold["consumer"] for hold in self.holds], ["pr_branch_update"])
        # The same head against the same main is never asked twice.
        again = self._update(_live())
        self.assertEqual(again["requested"], [])
        self.assertEqual(again["skipped"], [{"pr_number": 7, "reason": "already_requested_for_this_head_and_base"}])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.holds), 1, "no credential is minted when nothing qualifies")
        # Main moved: one more request, bound to the head it judged.
        self._update(_live(baseRefOid="c" * 40))
        self.assertEqual(len(self.calls), 2)

    def test_pending_red_dirty_clean_or_foreign_heads_are_never_updated(self) -> None:
        for live, why in (
            (_live(statusCheckRollup=[{"name": "ci", "status": "IN_PROGRESS", "conclusion": None}]),
             "head_checks_not_green:pending"),
            (_live(statusCheckRollup=[{"name": "ci", "status": "COMPLETED", "conclusion": "FAILURE"}]),
             "head_checks_not_green:red"),
            (_live(mergeStateStatus="DIRTY"), "merge_state:DIRTY"),
            (_live(mergeStateStatus="CLEAN"), "merge_state:CLEAN"),
            (_live(headRefName="feature/someone-else"), "not_an_aria_implementation_branch"),
        ):
            result = self._update(live)
            self.assertEqual(result["skipped"], [{"pr_number": 7, "reason": why}], live)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.holds, [])

    def test_a_profile_that_may_not_open_a_pr_moves_none(self) -> None:
        result = self._update(_live(), profile="standard")
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(self.calls, [])


class HumanMergeSurfaceTests(_Store):
    def _records(self, *, include_resolved: bool = False) -> list[dict[str, Any]]:
        return [row for row in list_human_required(base_dir=self.tools, include_resolved=include_resolved)
                if row["request_id"] == human_merge_request_id(7)]

    def test_an_l2_pr_is_one_item_with_url_ci_and_why_refreshed_then_resolved_on_merge(self) -> None:
        self._opened(human_merge=True, lane="L2")
        surface_human_merge_prs(cycle_id="cyc-373", base_dir=self.tools,
                                reader=FakeReader(_live(mergeStateStatus="BLOCKED", statusCheckRollup=[])))
        records = self._records()
        self.assertEqual(len(records), 1)
        context = records[0]["context"]
        self.assertTrue(records[0]["reason"].startswith(URL))
        self.assertEqual((context["kind"], context["pr_url"], context["ci"]["state"]), ("human_merge_pr", URL, "none"))
        why = context["not_self_mergeable_because"]
        self.assertTrue(why[0].startswith("merge_route_human:lane=L2:lane_L2"), why)
        self.assertTrue(any(reason.startswith("merge_authority:") for reason in why), why)
        # CI turns green and main moves: the SAME item carries the new facts.
        surface_human_merge_prs(cycle_id="cyc-373b", base_dir=self.tools, reader=FakeReader(_live()))
        records = self._records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["context"]["ci"]["state"], "green")
        self.assertIn("behind_base_under_strict_protection", records[0]["context"]["not_self_mergeable_because"])
        lines = daily_report_lines(records)
        self.assertIn(f"#7 {URL} — CI green", lines[-1])
        self.assertIn("why: merge_route_human:lane=L2", lines[-1])
        # A person merged it: resolved by observation, nothing left open.
        surface_human_merge_prs(cycle_id="cyc-373c", base_dir=self.tools, reader=FakeReader(_live(state="MERGED")))
        self.assertEqual(self._records(), [])
        resolved = self._records(include_resolved=True)
        self.assertEqual((resolved[0]["status"], resolved[0]["resolved_by"]), ("resolved", "github_observation"))

    def test_an_updated_head_is_named_and_a_closed_pr_resolves(self) -> None:
        self._opened(human_merge=False, lane="L1")
        surface_human_merge_prs(cycle_id="cyc-373", base_dir=self.tools,
                                reader=FakeReader(_live(headRefOid="d" * 40, mergeStateStatus="CLEAN")))
        why = self._records()[0]["context"]["not_self_mergeable_because"]
        self.assertFalse(any(reason.startswith("merge_route_human") for reason in why), why)
        self.assertIn(f"head_is_not_the_delivered_commit:head={'d' * 12}:delivered={'a' * 12}:ARIA-HIGH-374", why)
        surface_human_merge_prs(cycle_id="cyc-373b", base_dir=self.tools, reader=FakeReader(_live(state="CLOSED")))
        self.assertEqual(self._records(), [])


class CycleWiringTests(unittest.TestCase):
    def test_the_pr_ci_scan_runs_the_update_and_the_surface_with_its_reader(self) -> None:
        reader = object()
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("aria_kernel.github_adapters.select_checks_reader", return_value=reader), \
                mock.patch("aria_kernel.github_adapters.select_issue_writer", return_value=object()), \
                mock.patch.object(cycle, "get_profile", return_value="strict"), \
                mock.patch("aria_kernel.own_pr_ci.scan_own_prs", return_value={}), \
                mock.patch("aria_kernel.own_pr_ci.scan_merged_own_prs", return_value={}), \
                mock.patch("aria_kernel.own_pr_ci.scan_repo_pr_health", return_value={}), \
                mock.patch("aria_kernel.self_revert.run_self_revert_producer", return_value={}), \
                mock.patch("aria_kernel.implementation_reconciler.reconcile_recorded_implementations",
                           return_value={}), \
                mock.patch("aria_kernel.pr_branch_update.update_behind_aria_prs",
                           return_value={"status": "ran"}) as update, \
                mock.patch("aria_kernel.human_merge_surface.surface_human_merge_prs",
                           return_value={"status": "ran"}) as surface:
            context = SimpleNamespace(cycle_id="cyc-w", base_dir=Path(tmp) / "aria-tools", workspace_root=Path(tmp))
            result = cycle._phase_pr_ci_scan(context)
        self.assertEqual((result["branch_updates"], result["human_merge"]), ({"status": "ran"}, {"status": "ran"}))
        self.assertIs(update.call_args.kwargs["reader"], reader)
        self.assertEqual(update.call_args.kwargs["profile"], "strict")
        self.assertIs(surface.call_args.kwargs["reader"], reader)


if __name__ == "__main__":
    unittest.main()
