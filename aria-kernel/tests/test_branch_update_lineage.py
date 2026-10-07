"""ARIA-HIGH-374 — a self-merge after ARIA's own branch updates, and nothing else.

Main is strict, so an ARIA PR is mergeable only after main is merged into it,
and every self-merge gate bound the PR head to the delivered commit. The
shared verifier (``branch_update_lineage.verify_branch_update_lineage``)
accepts a head only as the delivered commit plus updates ARIA recorded and
GitHub made purely; the merge lane reads ``mergeStateStatus`` and asks for the
update instead of attempting a merge GitHub refuses.

The repository is real (git merges, ``merge-tree``); GitHub is a fake.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel.auto_merge import _evaluate_triple_gate, record_pr_lifecycle
from aria_kernel.branch_update_lineage import BranchUpdateLineageRefused, verify_branch_update_lineage
from aria_kernel.pr_branch_update import update_request_id
from aria_kernel.recovery import record_intent, record_receipt
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.installation_credential import LANE_CREDENTIAL_ENV

PR = 7


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


class _Branch(unittest.TestCase):
    """main → delivered (on the ARIA branch) → main moves → GitHub's update merge."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-374-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = make_local_git_repo(self.root)
        _git(self.repo, "branch", "-M", "main")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        _git(self.repo, "switch", "-q", "-c", "aria-impl-0a1b2c3d")
        self._commit("docs/runbooks/guide.md", "delivered\n", "docs(runbooks): the delivered change")
        self.delivered = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "switch", "-q", "main")
        self._commit("docs/other.md", "main moved\n", "docs: main moves")
        self.main = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")

    def _commit(self, path: str, body: str, message: str) -> str:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", message)
        return _git(self.repo, "rev-parse", "HEAD")

    def _github_update(self, *, foreign: bool = False) -> str:
        """What `update-branch` makes: main merged into the branch (optionally tampered)."""
        _git(self.repo, "merge", "-q", "--no-ff", "--no-commit", "main")
        if foreign:
            (self.repo / "docs" / "smuggled.md").write_text("not from main\n", encoding="utf-8")
            _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "Merge branch 'main' into aria-impl-0a1b2c3d")
        return _git(self.repo, "rev-parse", "HEAD")

    def _record_update(self, *, expected_head: str, base: str, status: str = "confirmed") -> None:
        intent = record_intent(
            request_id=update_request_id(PR), effect_kind="gh_api_write", target=f"pr#{PR}",
            intended_postcondition={"pr_number": PR, "expected_head_sha": expected_head, "base_sha": base},
            base_dir=self.tools,
        )
        record_receipt(operation_id=str(intent["operation_id"]), request_id=update_request_id(PR),
                       observed={"returncode": 0}, status=status, base_dir=self.tools)

    def _verify(self, head: str) -> Any:
        return verify_branch_update_lineage(workspace=self.repo, base_dir=self.tools, pr_number=PR, head_sha=head,
                                            delivered_sha=self.delivered, live_base_sha=self.main)


class LineageTests(_Branch):
    def test_a_recorded_pure_update_is_the_delivered_commit_plus_main(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main)
        head = self._github_update()
        lineage = self._verify(head)
        self.assertEqual(lineage.updates, ((self.delivered, self.main, head),))

    def test_an_unrecorded_commit_on_the_branch_is_refused(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main)
        pushed = self._commit("docs/runbooks/guide.md", "someone else\n", "docs: a push nobody recorded")
        with self.assertRaises(BranchUpdateLineageRefused) as refused:
            self._verify(pushed)
        self.assertTrue(refused.exception.reason.startswith(f"unrecorded_commit:{pushed[:12]}:parents=1"))

    def test_an_update_aria_never_asked_for_is_refused(self) -> None:
        head = self._github_update()
        with self.assertRaises(BranchUpdateLineageRefused) as refused:
            self._verify(head)
        self.assertIn("unrecorded_commit", refused.exception.reason)

    def test_a_failed_request_does_not_record_an_update(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main, status="failed")
        with self.assertRaises(BranchUpdateLineageRefused):
            self._verify(self._github_update())

    def test_a_recorded_update_whose_tree_carries_foreign_content_is_refused(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main)
        head = self._github_update(foreign=True)
        with self.assertRaises(BranchUpdateLineageRefused) as refused:
            self._verify(head)
        self.assertEqual(refused.exception.reason, f"tree_differs_from_pure_merge:{head[:12]}")

    def test_a_merged_parent_that_is_not_main_is_refused(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main)
        _git(self.repo, "switch", "-q", "-c", "side", self.main)
        self._commit("docs/side.md", "side\n", "docs: not on main")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")
        _git(self.repo, "merge", "-q", "--no-ff", "-m", "merge side", "side")
        with self.assertRaises(BranchUpdateLineageRefused) as refused:
            self._verify(_git(self.repo, "rev-parse", "HEAD"))
        self.assertTrue(refused.exception.reason.startswith("merged_base_not_main:"))


class TripleGateTests(_Branch):
    def setUp(self) -> None:
        super().setUp()
        record_pr_lifecycle({"number": PR, "base_branch": "main", "head_sha": self.delivered, "change_id": "chg-7",
                             "changed_files": []}, event="opened", base_dir=self.tools)
        append_declared_fixture(self.tools / "change-ledger" / "committed.jsonl",
                                {"change_id": "chg-7", "commit_sha": self.delivered},
                                expected_surface="change_committed")

    def _head_reasons(self, head: str) -> list[str]:
        triple = _evaluate_triple_gate(pr_number=PR, head_sha=head, base_dir=self.tools,
                                       workspace_root=self.repo, live_base_sha=self.main)
        return [reason for reason in triple["reasons"] if reason.startswith("triple_gate_head_sha_commit_sha_mismatch")]

    def test_a_recorded_pure_update_passes_the_head_gate(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main)
        self.assertEqual(self._head_reasons(self._github_update()), [])

    def test_foreign_content_is_refused_by_name(self) -> None:
        self._record_update(expected_head=self.delivered, base=self.main)
        reasons = self._head_reasons(self._github_update(foreign=True))
        self.assertEqual(len(reasons), 1)
        self.assertIn("tree_differs_from_pure_merge", reasons[0])


class BranchTipLockTests(unittest.TestCase):
    def test_the_lock_reads_the_merged_pair_when_the_capture_names_one(self) -> None:
        from aria_kernel.implementation_safety import HardFailContext, _check_branch_tip_lock_and_recheck, _PreMergeEvidence

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo = make_local_git_repo(Path(tmp.name))
        _git(repo, "branch", "-M", "main")
        base = _git(repo, "rev-parse", "HEAD")
        _git(repo, "switch", "-q", "-c", "aria-impl-0a1b2c3d")
        (repo / "x.md").write_text("x\n", encoding="utf-8")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "x")
        head = _git(repo, "rev-parse", "HEAD")
        bound = {name: "h" for name in ("repo_identity", "snapshot_hash", "pr_row_hash", "planned_row_hash",
                                        "committed_row_hash", "request_id", "claim_id", "request_row_hash",
                                        "claim_row_hash", "result_row_hash", "implementation_event_hash")}
        evidence = _PreMergeEvidence((), **bound, branch="aria-impl-0a1b2c3d", base_sha="a" * 40, head_sha="b" * 40,
                                     implementation_base_sha="a" * 40, implementation_head_sha="b" * 40,
                                     merge_base_sha=base, merge_head_sha=head)
        context = HardFailContext(workspace_root=repo, base_branch="main", pre_merge_evidence=evidence)
        self.assertTrue(_check_branch_tip_lock_and_recheck(context).passed)


class MergeLaneMergeStateTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "gh.log"
        gh = self.bin / "gh"
        gh.write_text(f"#!/bin/sh\necho \"$@\" >> {self.calls}\n", encoding="utf-8")
        gh.chmod(0o755)

    def _merge(self, status: str) -> dict[str, Any]:
        from aria_kernel.merge_authority import merge_pr_if_ready

        class _Adapter:
            def get_pr(self, number: int) -> dict[str, Any]:
                return {"number": number, "state": "OPEN", "head_sha": "e" * 40, "labels": []}

            def get_merge_state(self, number: int) -> dict[str, Any]:
                return {"state": "OPEN", "head_sha": "e" * 40, "merge_state_status": status, "base_sha": "f" * 40}

        with mock.patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"), \
                mock.patch("aria_kernel.merge_authority.assert_merge_not_watchdog_frozen", return_value=None), \
                mock.patch("aria_kernel.merge_authority.assert_self_merge_not_frozen", return_value=None), \
                mock.patch.dict(os.environ, {**LANE_CREDENTIAL_ENV, "PATH": f"{self.bin}:{os.defpath}"}):
            return merge_pr_if_ready(adapter=_Adapter(), pr_number=PR, base_dir=self.tools,
                                     readiness_claim_id="claim-7", workspace_root=self.root)

    def _no_merge_work(self) -> None:
        self.assertFalse((self.tools / "enterprise" / "risk-decisions.jsonl").exists(), "a gate ran")
        self.assertFalse(any(self.tools.rglob("*incident*")), "an incident row was written")

    def test_behind_requests_the_update_once_and_writes_no_incident(self) -> None:
        first = self._merge("BEHIND")
        self.assertEqual((first["decision"], first["branch_update"]["outcome"]), ("skipped_branch_behind_base", "accepted"))
        self.assertIn(f"api -X PUT repos/{{owner}}/{{repo}}/pulls/{PR}/update-branch -f expected_head_sha={'e' * 40}",
                      self.calls.read_text(encoding="utf-8"))
        again = self._merge("BEHIND")
        self.assertEqual(again["branch_update"]["outcome"], "already_requested_for_this_head_and_base")
        self.assertEqual(len(self.calls.read_text(encoding="utf-8").splitlines()), 1)
        self._no_merge_work()

    def test_dirty_and_blocked_are_named_skips(self) -> None:
        for status in ("DIRTY", "BLOCKED"):
            result = self._merge(status)
            self.assertEqual(result["decision"], f"skipped_merge_state_{status.lower()}")
        self.assertFalse(self.calls.exists())
        self._no_merge_work()


class RedChecksOnTheNewHeadTests(unittest.TestCase):
    def test_a_red_run_on_the_live_head_blocks_the_merge(self) -> None:
        # The lineage never stands in for CI: the evaluation reads every
        # check run on the CURRENT head (ORPHAN-717), whatever its lineage.
        from aria_kernel.auto_merge import _all_check_runs_result

        head = "d" * 40
        github = {"checks": {"readable": True, "runs": [
            {"name": "merge-gate", "status": "completed", "conclusion": "success", "head_sha": head},
            {"name": "build-status", "status": "completed", "conclusion": "failure", "head_sha": head},
        ]}}
        result = _all_check_runs_result(github, head)
        self.assertEqual(result["red"], ["build-status"])
        # Green runs of the DELIVERED commit say nothing about the updated head.
        delivered_green = {"checks": {"readable": True, "runs": [
            {"name": "merge-gate", "status": "completed", "conclusion": "success", "head_sha": "c" * 40},
        ]}}
        self.assertEqual(_all_check_runs_result(delivered_green, head)["total"], 0)


if __name__ == "__main__":
    unittest.main()
