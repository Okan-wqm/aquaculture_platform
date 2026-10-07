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
from tests._helpers.declared_fixtures import append_declared_fixture, rewrite_declared_fixture
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.installation_credential import LANE_CREDENTIAL_ENV

PR = 7


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


POLICY = '{"targets": {"lint": {"knownUnstableProjects": {"farm-service": {}}}}}\n'


class _Branch(unittest.TestCase):
    """main (with a quarantine policy and one quarantined project) → delivered
    on the ARIA branch → main moves → GitHub's update merge."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-374-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = make_local_git_repo(self.root)
        _git(self.repo, "branch", "-M", "main")
        self._commit("scripts/ci/affected-target-policy.json", POLICY, "ci: the quarantine policy")
        self._commit("apps/farm-service/project.json", '{"name": "farm-service"}\n', "farm: project")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        _git(self.repo, "switch", "-q", "-c", "aria-impl-0a1b2c3d")
        self._commit("docs/runbooks/guide.md", "line one\nline two\n", "docs(runbooks): the delivered change")
        self.delivered = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "switch", "-q", "main")
        self.main_before = _git(self.repo, "rev-parse", "HEAD")
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

    def _github_update(self, *, foreign: bool = False, with_ref: str = "main") -> str:
        """What `update-branch` makes: main merged into the branch (optionally tampered)."""
        _git(self.repo, "merge", "-q", "--no-ff", "--no-commit", with_ref)
        if foreign:
            (self.repo / "docs" / "smuggled.md").write_text("not from main\n", encoding="utf-8")
            _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", f"Merge branch '{with_ref}' into aria-impl-0a1b2c3d")
        return _git(self.repo, "rev-parse", "HEAD")

    def _record_update(self, *, expected_head: str, base: str, result: str | None,
                       status: str = "confirmed") -> None:
        intent = record_intent(
            request_id=update_request_id(PR), effect_kind="gh_api_write", target=f"pr#{PR}",
            intended_postcondition={"pr_number": PR, "expected_head_sha": expected_head, "base_sha": base},
            base_dir=self.tools,
        )
        record_receipt(operation_id=str(intent["operation_id"]), request_id=update_request_id(PR),
                       observed={"returncode": 0, "result_head_sha": result}, status=status, base_dir=self.tools)

    def _verify(self, head: str, *, live_base: str | None = None) -> Any:
        return verify_branch_update_lineage(workspace=self.repo, base_dir=self.tools, pr_number=PR, head_sha=head,
                                            delivered_sha=self.delivered, live_base_sha=live_base or self.main)

    def _refused(self, head: str, **kwargs: Any) -> str:
        with self.assertRaises(BranchUpdateLineageRefused) as refused:
            self._verify(head, **kwargs)
        return refused.exception.reason


class LineageTests(_Branch):
    def test_a_recorded_pure_update_is_the_delivered_commit_plus_main(self) -> None:
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertEqual(self._verify(head).updates, ((self.delivered, self.main, head),))

    def test_an_unrecorded_commit_on_the_branch_is_refused(self) -> None:
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        pushed = self._commit("docs/runbooks/guide.md", "someone else\n", "docs: a push nobody recorded")
        self.assertTrue(self._refused(pushed).startswith(f"unrecorded_commit:{pushed[:12]}:parents=1"))

    def test_an_update_aria_never_asked_for_is_refused(self) -> None:
        self.assertIn("unrecorded_commit", self._refused(self._github_update()))

    def test_an_update_without_a_read_back_result_is_not_recorded(self) -> None:
        # GSEC-MEDIUM-002 — "the head moved" is not "our update landed".
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=None)
        self.assertIn("unrecorded_commit", self._refused(head))

    def test_a_head_other_than_the_recorded_result_is_refused(self) -> None:
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result="9" * 40)
        self.assertTrue(self._refused(head).startswith(f"unrecorded_commit:{head[:12]}:not_a_recorded_update_of"))

    def test_a_failed_request_does_not_record_an_update(self) -> None:
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=head, status="failed")
        self.assertIn("unrecorded_commit", self._refused(head))

    def test_a_recorded_update_whose_tree_carries_foreign_content_is_refused(self) -> None:
        head = self._github_update(foreign=True)
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertEqual(self._refused(head), f"tree_differs_from_pure_merge:{head[:12]}")

    def test_a_merged_parent_that_is_not_main_is_refused(self) -> None:
        _git(self.repo, "switch", "-q", "-c", "side", self.main)
        self._commit("docs/side.md", "side\n", "docs: not on main")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")
        head = self._github_update(with_ref="side")
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertTrue(self._refused(head).startswith("merged_base_not_main:"))

    def test_a_merged_parent_older_than_the_recorded_base_is_refused(self) -> None:
        _git(self.repo, "branch", "-q", "old-main", self.main_before)
        _git(self.repo, "switch", "-q", "-c", "older", self.main_before)
        self._commit("docs/older.md", "older\n", "docs: an older line of main")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")
        head = self._github_update(with_ref="older")
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertTrue(self._refused(head).startswith("merged_base_not_main:"))

    def test_an_octopus_merge_is_refused(self) -> None:
        _git(self.repo, "switch", "-q", "-c", "third", self.main_before)
        self._commit("docs/third.md", "third\n", "docs: third")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")
        _git(self.repo, "merge", "-q", "--no-ff", "-m", "octopus", "main", "third")
        head = _git(self.repo, "rev-parse", "HEAD")
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertEqual(self._refused(head), f"unrecorded_commit:{head[:12]}:parents=3")

    def test_reversed_parents_are_refused(self) -> None:
        _git(self.repo, "switch", "-q", "-c", "reversed", self.main)
        _git(self.repo, "merge", "-q", "--no-ff", "-m", "reversed", "aria-impl-0a1b2c3d")
        head = _git(self.repo, "rev-parse", "HEAD")
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertIn("not_a_recorded_update_of", self._refused(head))

    def test_a_foreign_commit_in_the_middle_of_the_chain_is_refused(self) -> None:
        stranger = self._commit("docs/runbooks/guide.md", "line one\nstranger\n", "docs: a stranger's push")
        head = self._github_update()
        # Even had ARIA recorded an update OF the stranger's head, the walk
        # reaches that non-merge commit before the delivered one.
        self._record_update(expected_head=stranger, base=self.main, result=head)
        self.assertEqual(self._refused(head), f"unrecorded_commit:{stranger[:12]}:parents=1")

    def test_a_conflicted_merge_is_refused(self) -> None:
        _git(self.repo, "switch", "-q", "main")
        self._commit("docs/runbooks/guide.md", "line one\nmain's line\n", "docs: main edits the same line")
        main = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")
        subprocess.run(["git", "merge", "-q", "--no-ff", "main"], cwd=self.repo, capture_output=True)
        (self.repo / "docs" / "runbooks" / "guide.md").write_text("line one\nresolved\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "--no-edit")
        head = _git(self.repo, "rev-parse", "HEAD")
        self._record_update(expected_head=self.delivered, base=main, result=head)
        self.assertTrue(self._refused(head, live_base=main).startswith(f"merge_not_clean:{head[:12]}"))

    def test_git_missing_is_a_refusal_by_name(self) -> None:
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        with mock.patch.dict(os.environ, {"PATH": str(self.root / "no-bin")}):
            self.assertTrue(self._refused(head).startswith(("git_unavailable:", "hermetic_repository_unavailable")))

    def test_an_updated_head_touching_a_quarantined_project_is_refused(self) -> None:
        # GSEC-MEDIUM-003 — the delivery's runs judged the delivered tree;
        # for a project CI runs as a warning nothing judges the merged one.
        _git(self.repo, "switch", "-q", "-c", "aria-impl-0f0f0f0f", self.main_before)
        self._commit("apps/farm-service/src/x.ts", "export const x = 1;\n", "refactor(farm): x")
        self.delivered = _git(self.repo, "rev-parse", "HEAD")
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertEqual(self._refused(head), "updated_head_touches_quarantined_project:farm-service")

    def test_a_merge_driver_in_the_checkout_never_runs_and_never_makes_a_merge_clean(self) -> None:
        # GSEC-MEDIUM-001 — a registered driver + a tracked .gitattributes
        # would run a program and turn a conflict into a "clean" merge.
        marker = self.root / "driver-ran"
        _git(self.repo, "config", "merge.evil.driver", f"touch {marker}; cp %B %A")
        _git(self.repo, "switch", "-q", "main")
        self._commit(".gitattributes", "docs/runbooks/guide.md merge=evil\n", "attrs")
        self._commit("docs/runbooks/guide.md", "line one\nmain's line\n", "docs: main edits the same line")
        main = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "switch", "-q", "aria-impl-0a1b2c3d")
        self._commit(".gitattributes", "docs/runbooks/guide.md merge=evil\n", "attrs")
        delivered_attrs = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "merge", "-q", "--no-ff", "--no-edit", "main")  # the driver resolves it locally
        head = _git(self.repo, "rev-parse", "HEAD")
        marker.unlink(missing_ok=True)
        self.delivered = delivered_attrs
        self._record_update(expected_head=delivered_attrs, base=main, result=head)
        reason = self._refused(head, live_base=main)
        self.assertFalse(marker.exists(), "the checkout's merge driver ran inside the lineage check")
        self.assertTrue(reason.startswith(f"merge_not_clean:{head[:12]}"), reason)


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
        head = self._github_update()
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        self.assertEqual(self._head_reasons(head), [])

    def test_foreign_content_is_refused_by_name(self) -> None:
        head = self._github_update(foreign=True)
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        reasons = self._head_reasons(head)
        self.assertEqual(len(reasons), 1)
        self.assertIn("tree_differs_from_pure_merge", reasons[0])

    def test_an_unreadable_update_ledger_refuses_by_name(self) -> None:
        head = self._github_update()
        ledger = self.tools / "recovery" / "external-effects.jsonl"
        self._record_update(expected_head=self.delivered, base=self.main, result=head)
        effects = next(self.tools.rglob("external-effects*.jsonl"), ledger)
        effects.write_text(effects.read_text(encoding="utf-8") + "{not json\n", encoding="utf-8")
        reasons = self._head_reasons(head)
        self.assertEqual(len(reasons), 1)
        self.assertIn("update_ledger_unreadable", reasons[0])


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
        # The delivered commit IS the live head: the shared predicate admits it.
        record_pr_lifecycle({"number": PR, "base_branch": "main", "head_sha": "e" * 40, "change_id": "chg-7",
                             "changed_files": []}, event="opened", base_dir=self.tools)
        append_declared_fixture(self.tools / "change-ledger" / "committed.jsonl",
                                {"change_id": "chg-7", "commit_sha": "e" * 40}, expected_surface="change_committed")
        gh = self.bin / "gh"
        gh.write_text(f"#!/bin/sh\necho \"$@\" >> {self.calls}\n", encoding="utf-8")
        gh.chmod(0o755)

    def _merge(self, status: str) -> dict[str, Any]:
        from aria_kernel.merge_authority import merge_pr_if_ready

        class _Adapter:
            def get_pr(self, number: int) -> dict[str, Any]:
                return {"number": number, "state": "OPEN", "head_sha": "e" * 40, "labels": []}

            def get_merge_state(self, number: int) -> dict[str, Any]:
                return {"state": "OPEN", "head_sha": "e" * 40, "merge_state_status": status, "base_sha": "f" * 40,
                        "head_ref": "aria-impl-0a1b2c3d", "base_ref": "main", "checks_state": "SUCCESS"}

        with mock.patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"), \
                mock.patch("aria_kernel.pr_branch_update._read_back_head", return_value="9" * 40), \
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

    def test_behind_is_not_updated_when_the_head_is_not_one_aria_can_vouch_for(self) -> None:
        # GSEC-MEDIUM-002 — a head that is neither the delivered commit nor a
        # verified lineage is never merged into by ARIA.
        rewrite_declared_fixture(self.tools / "change-ledger" / "committed.jsonl",
                                 [{"change_id": "chg-7", "commit_sha": "d" * 40}], expected_surface="change_committed")
        result = self._merge("BEHIND")
        self.assertTrue(result["branch_update"]["outcome"].startswith("not_requested:head_lineage_refused:"), result)
        self.assertFalse(self.calls.exists())

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
