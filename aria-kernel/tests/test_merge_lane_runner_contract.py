"""ARIA-MEDIUM-226 (merge-lane parts) — one predicate says may-this-lane-merge,
and every external result the merge lane reads is checked.

* Check runs are read to the last page: the list endpoint returns 30 per
  page by default, so a head with more runs than one page looked green on
  the runs it happened to return. ``total_count`` is the check.
* A PR that is no longer open is not a merge candidate: ``merge_pr_if_ready``
  names the skip and writes nothing.
* Runner and adapter selection read ``runtime_profile.merge_authority_available``
  — the predicate the runner and the merge authority already read — so a
  ``standard`` profile holding an operator's merge-lane grant gets the real
  runner and the real adapter in the merge lane, not a no-op and a recorder.
* The ``merge_authority_decision`` audit event names the grant it merged
  under: lane, expiry and the operator's approval reference.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.auto_merge import GhCliGitHubAdapter
from aria_kernel.auto_merge_runners import (
    NoOpAutoMergeRunner,
    RealAutoMergeRunner,
    select_auto_merge_runner,
)
from aria_kernel.github_adapters import RecordingGitHubAdapter, select_github_adapter
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.runtime_profile import set_merge_lane_grant
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.operator_acts import github_operator_acts, operator_set_profile

_HEAD = "a" * 40


def _in(days: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


class _PagedChecks(GhCliGitHubAdapter):
    """The real adapter's paging over canned pages — no network."""

    def __init__(self, pages: dict[str, list[dict]]) -> None:
        self.owner, self.repo = "okan", "aqua"
        self._pages = pages
        self.paths: list[str] = []

    def _gh_json(self, args):  # type: ignore[override]
        path = args[1]
        self.paths.append(path)
        base, _, query = path.partition("?")
        page = int(dict(item.split("=") for item in query.split("&"))["page"])
        return self._pages[base.rsplit("/", 1)[1]][page - 1]


def _runs(count: int, start: int = 0) -> list[dict]:
    return [
        {"name": f"check-{index}", "head_sha": _HEAD, "status": "completed", "conclusion": "success"}
        for index in range(start, start + count)
    ]


class CheckRunPaginationTests(unittest.TestCase):
    def test_every_page_is_read_to_the_total(self) -> None:
        adapter = _PagedChecks({
            "check-runs": [
                {"total_count": 130, "check_runs": _runs(100)},
                {"total_count": 130, "check_runs": _runs(30, 100)},
            ],
            "status": [{"total_count": 1, "statuses": [{"context": "legacy", "state": "success"}]}],
        })
        checks = adapter.get_checks(_HEAD)
        self.assertTrue(checks["readable"])
        self.assertEqual(len(checks["runs"]), 131)
        self.assertIn(f"repos/okan/aqua/commits/{_HEAD}/check-runs?per_page=100&page=2", adapter.paths)

    def test_a_listing_short_of_its_total_is_unreadable(self) -> None:
        adapter = _PagedChecks({
            "check-runs": [
                {"total_count": 130, "check_runs": _runs(100)},
                {"total_count": 130, "check_runs": []},
            ],
            "status": [{"total_count": 0, "statuses": []}],
        })
        checks = adapter.get_checks(_HEAD)
        self.assertFalse(checks["readable"])
        self.assertEqual(checks["runs"], [])
        self.assertIn("check_runs_incomplete:100/130", checks["reason"])

    def test_a_listing_without_a_total_is_unreadable(self) -> None:
        adapter = _PagedChecks({
            "check-runs": [{"check_runs": _runs(3)}],
            "status": [{"total_count": 0, "statuses": []}],
        })
        self.assertFalse(adapter.get_checks(_HEAD)["readable"])


class _Adapter:
    def __init__(self, state: str) -> None:
        self.state = state
        self.merged: list[int] = []

    def get_open_issues(self, *, labels):
        return {"readable": True, "issues": []}

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number, "state": self.state, "repository": "okan/aqua",
            "base_branch": "main", "head_ref": "feat/x", "head_sha": _HEAD,
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:
        self.merged.append(pr_number)
        return {"merged": True}


class NonOpenPrTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        operator_set_profile("autonomous", base_dir=self.tools, scheduler_ceiling="autonomous")

    def _files(self) -> dict[str, bytes]:
        return {
            str(path.relative_to(self.tools)): path.read_bytes()
            for path in self.tools.rglob("*") if path.is_file()
        }

    def test_a_pr_that_is_not_open_is_skipped_by_name_and_writes_nothing(self) -> None:
        for state in ("MERGED", "CLOSED", "closed"):
            with self.subTest(state=state):
                before = self._files()
                adapter = _Adapter(state)
                result = merge_pr_if_ready(
                    adapter=adapter, pr_number=7, base_dir=self.tools, readiness_claim_id="claim:7:aaaaaaaaaaaa",
                )
                self.assertEqual(result["decision"], "skipped_pr_not_open")
                self.assertEqual(result["pr_state"], state.upper())
                self.assertFalse(result["eligible"])
                self.assertEqual(adapter.merged, [])
                self.assertEqual(self._files(), before)

    def test_a_pr_whose_state_was_not_observed_is_refused(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        adapter = _Adapter("")
        with self.assertRaisesRegex(GovernanceError, "merge_authority_pr_state_unobserved"):
            merge_pr_if_ready(
                adapter=adapter, pr_number=7, base_dir=self.tools, readiness_claim_id="claim:7:aaaaaaaaaaaa",
            )

    def test_the_live_adapter_asks_github_for_the_state(self) -> None:
        seen: list[list[str]] = []

        def transport(args):
            seen.append(args)
            if args[:2] == ["repo", "view"]:
                return {"owner": {"login": "okan"}, "name": "aqua"}
            return {"number": 7, "state": "MERGED", "headRefOid": _HEAD}

        with patch.object(GhCliGitHubAdapter, "_gh_json", side_effect=transport):
            projected = GhCliGitHubAdapter(cwd=self.tmp.name).get_pr(7)
        self.assertEqual(projected["state"], "MERGED")
        self.assertIn("state", seen[-1][4].split(","))


class SelectionFollowsMergeAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        operator_set_profile("standard", base_dir=self.tools)

    def _grant(self) -> None:
        expires_at = _in(7)
        with github_operator_acts() as github:
            set_merge_lane_grant(
                lane="L1", expires_at=expires_at,
                operator_approval_ref=github.approve("merge_lane_grant", {"lane": "L1", "expires": expires_at}),
                base_dir=self.tools,
            )

    def _runner(self, *, executes_merges: bool):
        return select_auto_merge_runner(
            profile="standard", executes_merges=executes_merges, base_dir=self.tools,
            adapter_factory=lambda: object(), pr_enumerator=lambda adapter: [],
            readiness_claim_resolver=lambda adapter, number, root: "claim",
        )

    def test_standard_without_a_grant_stays_a_no_op_and_a_recorder(self) -> None:
        self.assertIsInstance(self._runner(executes_merges=True), NoOpAutoMergeRunner)
        adapter = select_github_adapter(profile="standard", base_dir=self.tools, merge_lane=True)
        self.assertIsInstance(adapter, RecordingGitHubAdapter)

    def test_standard_with_a_grant_gets_the_real_runner_and_adapter_in_the_merge_lane(self) -> None:
        self._grant()
        self.assertIsInstance(self._runner(executes_merges=True), RealAutoMergeRunner)
        with patch.object(GhCliGitHubAdapter, "__init__", return_value=None):
            adapter = select_github_adapter(profile="standard", base_dir=self.tools, merge_lane=True)
        self.assertIsInstance(adapter, GhCliGitHubAdapter)

    def test_the_nightly_cycle_is_unchanged_by_a_grant(self) -> None:
        self._grant()
        self.assertIsInstance(self._runner(executes_merges=False), NoOpAutoMergeRunner)
        self.assertIsInstance(
            select_github_adapter(profile="standard", base_dir=self.tools), RecordingGitHubAdapter,
        )

    def test_the_merge_lane_cli_selects_through_the_predicate(self) -> None:
        from aria_kernel import cli

        seen: dict = {}

        def fake_runner(**kwargs):
            seen["runner"] = kwargs
            return lambda *, base_dir, workspace_root: {"status": "ok", "merges_completed": 0}

        def fake_adapter(**kwargs):
            seen["adapter"] = kwargs
            return object()

        with patch("aria_kernel.auto_merge_runners.select_auto_merge_runner", side_effect=fake_runner), \
             patch("aria_kernel.github_adapters.select_github_adapter", side_effect=fake_adapter), \
             patch("sys.stdout"):
            rc = cli.main(["--tools-dir", str(self.tools), "merge-lane", "run", "--pr", "7"])
        self.assertEqual(rc, 0)
        self.assertTrue(seen["runner"]["executes_merges"])
        self.assertEqual(Path(seen["runner"]["base_dir"]), self.tools)
        self.assertTrue(seen["adapter"]["merge_lane"])


class AuditNamesTheGrantTests(unittest.TestCase):
    def test_the_decision_event_carries_the_grant(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        tools = Path(tmp.name) / "aria-tools"
        ensure_tools_dir(tools)
        operator_set_profile("standard", base_dir=tools)
        expires_at = _in(7)
        with github_operator_acts() as github:
            approval_ref = github.approve("merge_lane_grant", {"lane": "L1", "expires": expires_at})
            set_merge_lane_grant(lane="L1", expires_at=expires_at, operator_approval_ref=approval_ref, base_dir=tools)
        patches = [
            patch("aria_kernel.merge_authority.record_risk_decision_for_pr",
                  return_value={"valid": True, "lane": "L1", "policy_hash": "ph"}),
            patch("aria_kernel.merge_authority.assert_autonomy_unlocked", return_value=SimpleNamespace(counts={})),
            patch("aria_kernel.merge_authority.verify_enterprise_readiness",
                  return_value=SimpleNamespace(valid=True, failure_classes=(), reasons=())),
            patch("aria_kernel.merge_authority.verify_runner_attestation", return_value={}),
            patch("aria_kernel.merge_authority.verify_rollback_bundle", return_value={}),
            patch("aria_kernel.merge_authority.ensure_pre_merge_incident_row", return_value={"ledger_hash": "x"}),
            patch("aria_kernel.merge_authority._merge_if_green_with_executor",
                  return_value={"decision": "blocked", "eligible": False, "reasons": ["fixture"]}),
        ]
        for item in patches:
            item.start()
        try:
            merge_pr_if_ready(adapter=_Adapter("OPEN"), pr_number=7, base_dir=tools, readiness_claim_id="claim")
        finally:
            for item in reversed(patches):
                item.stop()
        rows = [
            row for row in load_declared_jsonl(tools / "governance.jsonl", expected_surface="tools_governance")
            if row.get("kind") == "merge_authority_decision"
        ]
        self.assertEqual(len(rows), 1)
        grant = rows[0]["details"]["merge_lane_grant"]
        self.assertEqual(grant["lane"], "L1")
        self.assertEqual(grant["expires_at"], expires_at)
        self.assertEqual(grant["operator_approval_ref"], approval_ref)


if __name__ == "__main__":
    unittest.main()
