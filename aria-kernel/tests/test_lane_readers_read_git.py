"""ARIA-CRITICAL-215 — every reader of a PR's lane reads the change from git.

After L1 became status-aware (ddc377f85), the readers that were never handed
the git change — the nightly dry-run ``merge_if_green``, the CI gate
``evaluate_pr_ci_gate`` — could only classify the platform's status-blind
file list, so every docs or test PR read ``risk_change_status_unknown``: the
burn-in and operator reports lost their lane even where the checkout held
the change. Each reader now takes the checkout and reads the PR's change
through the one entry point the merge authority uses
(``risk_policy.classify_pr_change``: ``change_paths`` against the PR's base
and head, then the platform-list cross-check). Only a change the checkout
does not hold is refused, by name (``risk_change_paths_unavailable``).

``human_required_adjudication`` is the other case: its input is a stored
HUMAN_REQUIRED record whose ``context.changed_files`` are bare paths with no
commits, so there is no change to read; an L1-eligible bare path is refused
by a name that says so, and every other path keeps its real lane.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.auto_merge import SnapshotGitHubAdapter, merge_if_green
from aria_kernel.ci import evaluate_pr_ci_gate
from aria_kernel.human_required_adjudication import escalation_adjudicability
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.git_fixtures import make_local_git_repo

SPEC = "apps/farm-service/src/batch/__tests__/batch.spec.ts"
NEW_SPEC = "apps/farm-service/src/batch/__tests__/harvest.spec.ts"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def _github(head: str) -> dict[str, Any]:
    return {
        "latest_head_sha": head,
        "branch_protection": {"readable": True, "required_checks": ["ci/test"]},
        "checks": {"readable": True, "runs": [
            {"name": "ci/test", "head_sha": head, "status": "completed", "conclusion": "success"},
        ]},
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
    }


class _PrCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.repo = make_local_git_repo(root)
        self.elsewhere = make_local_git_repo(root, name="other-checkout")
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        target = self.repo / SPEC
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("it('holds', () => expect(1).toBe(1));\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "base")
        self.base = _git(self.repo, "rev-parse", "HEAD")

    def _pr(self, *, weaken: bool) -> dict[str, Any]:
        path = SPEC if weaken else NEW_SPEC
        target = self.repo / path
        target.write_text("it('changed', () => {});\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "change")
        head = _git(self.repo, "rev-parse", "HEAD")
        diff = _git(self.repo, "diff", self.base, head) + "\n"
        return {
            "number": 12, "base_branch": "main", "head_ref": "aria/impl/x",
            "base_sha": self.base, "head_sha": head,
            "changed_files": [{"path": path}], "changed_files_count": 1, "diff_text": diff,
        }


class NightlyDryRunReadsGitTests(_PrCase):
    def _dry_run(self, pr: dict[str, Any], workspace: Path | None) -> dict[str, Any]:
        adapter = SnapshotGitHubAdapter({"pr": pr, "github": _github(pr["head_sha"])})
        return merge_if_green(
            adapter=adapter, pr_number=12, policy={"enabled": True}, base_dir=self.tools,
            dry_run=True, workspace_root=workspace,
        )

    def test_a_new_spec_pr_records_l1(self) -> None:
        decision = self._dry_run(self._pr(weaken=False), self.repo)
        risk = decision["risk"]["enterprise_risk"]
        self.assertEqual((risk["valid"], risk["lane"]), (True, "L1"), risk)
        self.assertNotIn("risk_change_status_unknown", risk["reason_codes"])
        self.assertTrue(decision["eligible"], decision["reasons"])

    def test_a_modified_spec_pr_records_l2(self) -> None:
        decision = self._dry_run(self._pr(weaken=True), self.repo)
        risk = decision["risk"]["enterprise_risk"]
        self.assertEqual((risk["valid"], risk["lane"]), (True, "L2"), risk)
        self.assertIn("enterprise risk lane L2 is not auto-merge eligible", decision["reasons"])

    def test_a_checkout_without_the_commits_is_refused_by_name(self) -> None:
        pr = self._pr(weaken=False)
        for workspace in (self.elsewhere, None):
            with self.subTest(workspace=workspace):
                decision = self._dry_run(pr, workspace)
                self.assertEqual(decision["risk"]["enterprise_risk"]["reason_codes"], ["risk_change_paths_unavailable"])
                self.assertIn(
                    "enterprise risk policy rejected diff: risk_change_paths_unavailable", decision["reasons"],
                )


class CiGateReadsGitTests(_PrCase):
    def _gate(self, pr: dict[str, Any], workspace: Path | None) -> dict[str, Any]:
        return evaluate_pr_ci_gate(
            pr=pr, github=_github(pr["head_sha"]), workflow_inventory={"workflows": []},
            base_dir=self.tools, workspace_root=workspace,
        )

    def test_a_new_spec_pr_records_l1(self) -> None:
        gate = self._gate(self._pr(weaken=False), self.repo)
        self.assertEqual((gate["enterprise_risk"]["valid"], gate["enterprise_risk"]["lane"]), (True, "L1"))
        self.assertTrue(gate["ready_for_human_merge"], gate["blocked_by"])

    def test_a_modified_spec_pr_records_l2(self) -> None:
        gate = self._gate(self._pr(weaken=True), self.repo)
        self.assertEqual((gate["enterprise_risk"]["valid"], gate["enterprise_risk"]["lane"]), (True, "L2"))

    def test_a_checkout_without_the_commits_is_refused_by_name(self) -> None:
        gate = self._gate(self._pr(weaken=False), self.elsewhere)
        self.assertEqual(gate["enterprise_risk"]["reason_codes"], ["risk_change_paths_unavailable"])
        self.assertIn("enterprise risk policy rejected diff: risk_change_paths_unavailable", gate["blocked_by"])


class HumanRequiredStoredPathsTests(unittest.TestCase):
    def _verdict(self, changed_files: list[str]):
        return escalation_adjudicability(
            {"request_id": "hr-1", "context": {"kind": "lease_lifecycle", "changed_files": changed_files}},
        )

    def test_an_l1_eligible_stored_path_is_refused_by_what_it_lacks(self) -> None:
        # A stored record names bare paths and no commits: whether the file
        # was added or changed is not recorded, so the lane cannot be read.
        verdict = self._verdict(["docs/runbooks/x.md"])
        self.assertFalse(verdict.adjudicable)
        self.assertEqual(verdict.reason, "changed_files_status_unknown:stored_paths_name_no_change")

    def test_a_stored_path_whose_lane_needs_no_status_keeps_it(self) -> None:
        self.assertEqual(self._verdict(["docs/aria/x.md"]).reason, "irreducible_risk_lane:L3")
        self.assertTrue(self._verdict(["apps/farm-service/src/app.module.ts"]).adjudicable)


if __name__ == "__main__":
    unittest.main()
