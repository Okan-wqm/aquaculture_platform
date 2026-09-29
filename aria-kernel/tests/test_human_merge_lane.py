"""ARIA-HIGH-211 — work outside L1 becomes a pull request marked for a person.

The finding: a finding whose fix lives outside L1 (``docs/aria/**``,
``docs/adr/**``: code-owned, L3) was planned, implemented and opened as a pull
request the merge gate could only refuse, and the merge lane evaluated that
refusal again every run. ORPHAN candidates also copied ``path:line`` evidence
into ``affected_surfaces``, a string no risk lane is written for.

Operator decision 2026-09-26 (plan 037): such findings still produce pull
requests. The PR opens with the ``aria:human-merge`` label, decided from the
change git holds by the merge gate's own classifier, and the merge lane names
it (``human_merge_lane``) instead of evaluating it. An L1 PR is unlabelled.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import pr_manager
from aria_kernel.auto_merge import human_merge_decision, record_pr_lifecycle
from aria_kernel.auto_merge_runners import select_auto_merge_runner
from aria_kernel.plan_synthesizer import convert_candidate_to_plan_content
from aria_kernel.risk_policy import HUMAN_MERGE_DECISION, HUMAN_MERGE_LABEL, classify_change
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.installation_credential import LANE_CREDENTIAL_ENV


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


class AnL3FindingIsStillPlannedTests(unittest.TestCase):
    def test_an_l3_finding_is_planned_on_bare_path_surfaces(self) -> None:
        envelope = convert_candidate_to_plan_content({
            "source_type": "orphan_finding",
            "candidate_id": "ORPHAN-MEDIUM-901",
            "severity": "MEDIUM",
            "raw_id": "901",
            "title_hint": "Address ORPHAN-MEDIUM-901",
            "evidence": ["docs/aria/runbook.md:12", "docs/adr/030-x.md:4"],
        })
        self.assertIsNotNone(envelope, "an L3 finding is planned, not routed away")
        assert envelope is not None
        self.assertEqual(envelope.content["evidence_refs"], ["docs/aria/runbook.md:12", "docs/adr/030-x.md:4"])
        # The surfaces are the paths the fix touches — the line is not part
        # of a path, and the classifier can place them.
        self.assertEqual(envelope.content["affected_surfaces"], ["docs/aria/runbook.md", "docs/adr/030-x.md"])
        self.assertEqual(classify_change(envelope.content["affected_surfaces"]).lane, "L3")


class ThePullRequestCarriesItsRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.repo = make_local_git_repo(root)
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        self.gh_argv: list[list[str]] = []
        real_run = subprocess.run

        def fake_run(argv: Any, *args: Any, **kwargs: Any) -> Any:
            if isinstance(argv, list) and argv[:3] == ["gh", "pr", "create"]:
                self.gh_argv.append(list(argv))
                return subprocess.CompletedProcess(argv, 0, "https://github.com/o/r/pull/41\n", "")
            return real_run(argv, *args, **kwargs)

        patcher = mock.patch.object(pr_manager.subprocess, "run", side_effect=fake_run)
        patcher.start()
        self.addCleanup(patcher.stop)
        # The lane opens the PR on its installation token (ARIA-CRITICAL-246).
        credential = mock.patch.dict("os.environ", LANE_CREDENTIAL_ENV)
        credential.start()
        self.addCleanup(credential.stop)

    def _open(self, path: str, *, base_sha: str | None = None) -> dict[str, Any]:
        base = _git(self.repo, "rev-parse", "HEAD")
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("changed\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "change")
        head = _git(self.repo, "rev-parse", "HEAD")
        payload = {
            "number": None, "base_branch": "main", "head_sha": head,
            "base_sha": base if base_sha is None else base_sha, "branch": "aria/impl/x",
            "task_id": None, "proposal_id": "P-1", "assignment_id": None, "change_id": "chg-1",
            "changed_files": [path], "title": "t", "body": "b", "dry_run": False,
            "perimeter_observation": None,
        }
        return pr_manager._create_pull_request(
            payload=payload, branch="aria/impl/x", title="t", body="b", workspace_path=self.repo,
            effect_request_id="REQ-1", intended_postcondition={"head_ref": "aria/impl/x"},
            command_environment=None, base_dir=self.tools, assignment_id=None,
        )

    def _opened_rows(self) -> list[dict[str, Any]]:
        path = self.tools / "pr-lifecycle.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def test_an_l3_change_opens_a_labelled_pr(self) -> None:
        opened = self._open("docs/aria/runbook.md")
        self.assertEqual(len(self.gh_argv), 1, "the PR is still opened")
        argv = self.gh_argv[0]
        self.assertEqual(argv[argv.index("--label") + 1], HUMAN_MERGE_LABEL)
        self.assertEqual(opened["pr_number"], 41)
        self.assertTrue(opened["merge_route"]["human_merge"])
        self.assertEqual(opened["merge_route"]["lane"], "L3")
        self.assertTrue(self._opened_rows()[-1]["merge_route"]["human_merge"])

    def test_an_l1_change_opens_an_unlabelled_pr(self) -> None:
        opened = self._open("docs/runbooks/guide.md")
        self.assertNotIn("--label", self.gh_argv[0])
        self.assertFalse(opened["merge_route"]["human_merge"])
        self.assertEqual(opened["merge_route"]["lane"], "L1")

    def test_a_change_that_cannot_be_read_is_routed_to_a_person(self) -> None:
        opened = self._open("docs/runbooks/guide.md", base_sha="")
        self.assertIn("--label", self.gh_argv[0])
        self.assertEqual(opened["merge_route"]["reason_codes"], ["risk_change_paths_unavailable"])


class TheMergeLaneNamesItTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _opened(self, number: int, *, human_merge: bool) -> None:
        record_pr_lifecycle(
            {"number": number, "base_branch": "main", "head_sha": "e" * 40, "change_id": f"chg-{number}",
             "changed_files": ["docs/aria/x.md" if human_merge else "docs/runbooks/x.md"],
             "merge_route": {"human_merge": human_merge, "lane": "L3" if human_merge else "L1"}},
            event="opened", base_dir=self.tools,
        )

    def test_the_merge_lane_skips_a_human_merge_pr_by_name(self) -> None:
        self._opened(5, human_merge=True)
        self._opened(6, human_merge=False)
        resolved: list[int] = []

        def resolver(_adapter: Any, pr_number: int, _base: Any) -> str:
            resolved.append(pr_number)
            return f"claim-{pr_number}"

        def evaluate(**kwargs: Any) -> dict[str, Any]:
            self.assertNotEqual(kwargs["pr_number"], 5, "a human-merge PR was evaluated")
            return {"decision": "blocked", "eligible": False, "pr_number": kwargs["pr_number"], "reasons": []}

        runner = select_auto_merge_runner(
            profile="strict", executes_merges=True, adapter_factory=lambda: object(),
            pr_enumerator=lambda _adapter: [5, 6], readiness_claim_resolver=resolver,
        )
        with mock.patch("aria_kernel.auto_merge.merge_if_green", side_effect=evaluate):
            result = runner(base_dir=self.tools, workspace_root=self._tmp.name)
        by_pr = {decision["pr_number"]: decision for decision in result["decisions"]}
        self.assertEqual(by_pr[5]["decision"], "skipped")
        self.assertEqual(by_pr[5]["reasons"], [HUMAN_MERGE_DECISION])
        self.assertEqual(by_pr[6]["decision"], "blocked")
        self.assertEqual(resolved, [6])

    def test_the_merge_authority_skips_a_labelled_pr_before_any_gate(self) -> None:
        from aria_kernel.merge_authority import merge_pr_if_ready

        class _Adapter:
            def get_pr(self, number: int) -> dict[str, Any]:
                return {"number": number, "state": "OPEN", "head_sha": "e" * 40,
                        "labels": [{"name": HUMAN_MERGE_LABEL}]}

        with mock.patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"), \
                mock.patch("aria_kernel.merge_authority.assert_merge_not_watchdog_frozen", return_value=None):
            result = merge_pr_if_ready(adapter=_Adapter(), pr_number=9, base_dir=self.tools, readiness_claim_id="claim-9")
        self.assertEqual(result["decision"], "skipped")
        self.assertEqual(result["reasons"], [HUMAN_MERGE_DECISION])
        self.assertFalse((self.tools / "enterprise" / "risk-decisions.jsonl").exists())

    def test_an_l1_pr_is_not_skipped(self) -> None:
        self._opened(6, human_merge=False)
        self.assertIsNone(human_merge_decision(6, base_dir=self.tools, live_pr={"labels": []}))
        self.assertIsNone(human_merge_decision(7, base_dir=self.tools))


if __name__ == "__main__":
    unittest.main()
