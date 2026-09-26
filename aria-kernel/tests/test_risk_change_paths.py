"""ARIA-CRITICAL-214 — a rename is classified by BOTH of its paths.

Pre-fix, the merge authority's risk decision classified the PR's file list
as ``gh pr view --json files`` reported it: the new side of a rename only,
and at most 100 entries. ``git mv .github/workflows/x.yml docs/x.yml`` was
therefore judged by ``docs/x.yml`` alone, and a code-owned workflow could
leave the repository through the unreviewed lane.

The decision now reads the change from git with rename sources kept
(``change_paths.read_change_paths``), and the platform's list is only a
cross-check whose disagreement is refused by name.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.change_paths import (
    GH_PR_FILES_LIST_CAP,
    ChangePaths,
    parse_name_status_z,
    platform_file_list_disagreement,
    read_change_paths,
)
from aria_kernel.risk_policy import classify_change, record_risk_decision_for_pr
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.git_fixtures import make_local_git_repo


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def _write(repo: Path, relative: str, text: str) -> None:
    target = repo / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def _commit(repo: Path, message: str) -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


def _pr(base: str, head: str, listed: list[str], count: int | None) -> dict:
    payload: dict = {
        "number": 7,
        "repository": "okan/aqua",
        "base_branch": "main",
        "head_ref": "aria/impl/x",
        "base_sha": base,
        "head_sha": head,
        # `gh pr view --json files` shape.
        "changed_files": [{"path": path, "additions": 1, "deletions": 0} for path in listed],
    }
    if count is not None:
        payload["changed_files_count"] = count
    return payload


class _RepoCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.repo = make_local_git_repo(root)
        # The repository's own rename detection must not decide what the
        # classifier sees.
        _git(self.repo, "config", "diff.renames", "copies")
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _decide(self, pr: dict) -> dict:
        return record_risk_decision_for_pr(pr, workspace_root=self.repo, base_dir=self.tools)


class RenameSourceIsClassifiedTests(_RepoCase):
    def _rename(self, target: str) -> tuple[str, str]:
        _write(self.repo, ".github/workflows/x.yml", "name: gate\non: push\njobs: {}\n")
        base = _commit(self.repo, "base")
        (self.repo / target).parent.mkdir(parents=True, exist_ok=True)
        _git(self.repo, "mv", ".github/workflows/x.yml", target)
        return base, _commit(self.repo, "move the workflow")

    def test_git_reader_reports_both_sides_of_a_rename(self) -> None:
        base, head = self._rename("docs/x.yml")
        change = read_change_paths(self.repo, base, head)
        self.assertEqual(change.paths, (".github/workflows/x.yml", "docs/x.yml"))
        self.assertEqual(change.deleted, frozenset({".github/workflows/x.yml"}))
        self.assertEqual(change.added, frozenset({"docs/x.yml"}))

    def test_moving_a_workflow_into_docs_is_not_l1(self) -> None:
        base, head = self._rename("docs/x.yml")
        row = self._decide(_pr(base, head, ["docs/x.yml"], 1))
        self.assertNotEqual(row["lane"], "L1")
        self.assertFalse(row["valid"])
        self.assertIn(".github/workflows/x.yml", row["changed_files"])
        self.assertIsNone(row["platform_disagreement"])

    def test_the_new_name_alone_would_have_been_l1(self) -> None:
        # The control: judged by its target only (the pre-fix input), the
        # same move lands in the unreviewed lane.
        base, head = self._rename("docs/runbooks/moved.md")
        self.assertEqual(classify_change([("A", "docs/runbooks/moved.md")]).lane, "L1")
        row = self._decide(_pr(base, head, ["docs/runbooks/moved.md"], 1))
        self.assertNotEqual(row["lane"], "L1")
        self.assertEqual(row["changed_files"], [".github/workflows/x.yml", "docs/runbooks/moved.md"])


class PlatformListIsACrossCheckTests(_RepoCase):
    def _many_docs(self, count: int, *, extra: str | None = None) -> tuple[str, str, list[str]]:
        base = _git(self.repo, "rev-parse", "HEAD")
        names = [f"docs/runbooks/f{index:03d}.md" for index in range(count)]
        for name in names:
            _write(self.repo, name, f"# {name}\n")
        if extra is not None:
            _write(self.repo, extra, "x\n")
            names.append(extra)
        return base, _commit(self.repo, "many"), sorted(names)

    def test_more_than_the_platform_cap_is_classified_from_git(self) -> None:
        base, head, names = self._many_docs(150)
        listed = names[:GH_PR_FILES_LIST_CAP]
        row = self._decide(_pr(base, head, listed, len(names)))
        self.assertTrue(row["valid"], row["reason_codes"])
        self.assertEqual(row["lane"], "L1")
        self.assertEqual(len(row["changed_files"]), 150)

    def test_a_path_past_the_platform_cap_still_decides_the_lane(self) -> None:
        # `zz/` sorts after every docs path, so the platform's first page
        # never shows it; git does.
        base, head, names = self._many_docs(120, extra=".github/workflows/zz.yml")
        listed = [name for name in names if name.startswith("docs/")][:GH_PR_FILES_LIST_CAP]
        self.assertNotIn(".github/workflows/zz.yml", listed)
        row = self._decide(_pr(base, head, listed, len(names)))
        self.assertIsNone(row["platform_disagreement"])
        self.assertNotEqual(row["lane"], "L1")
        self.assertIn(".github/workflows/zz.yml", row["changed_files"])

    def test_a_count_mismatch_is_refused_by_name(self) -> None:
        base, head, names = self._many_docs(2)
        row = self._decide(_pr(base, head, names, 3))
        self.assertFalse(row["valid"])
        self.assertEqual(row["lane"], "blocked")
        self.assertIn("risk_pr_files_disagree_with_git", row["reason_codes"])
        self.assertEqual(row["platform_disagreement"], "platform_file_count_exceeds_git:3>2")

    def test_a_listed_path_git_does_not_hold_is_refused(self) -> None:
        base, head, names = self._many_docs(2)
        row = self._decide(_pr(base, head, [names[0], "docs/runbooks/elsewhere.md"], 2))
        self.assertIn("risk_pr_files_disagree_with_git", row["reason_codes"])
        self.assertEqual(row["platform_disagreement"], "platform_path_not_in_git_diff:docs/runbooks/elsewhere.md")

    def test_an_absent_platform_count_is_refused(self) -> None:
        base, head, names = self._many_docs(2)
        row = self._decide(_pr(base, head, names, None))
        self.assertIn("risk_pr_files_disagree_with_git", row["reason_codes"])
        self.assertEqual(row["platform_disagreement"], "platform_file_count_unavailable")

    def test_a_checkout_without_the_change_is_refused(self) -> None:
        row = record_risk_decision_for_pr(_pr("a" * 40, "b" * 40, ["docs/x.md"], 1), workspace_root=self.repo, base_dir=self.tools)
        self.assertFalse(row["valid"])
        self.assertEqual(row["reason_codes"], ["risk_change_paths_unavailable"])

    def test_no_workspace_is_refused(self) -> None:
        row = record_risk_decision_for_pr(_pr("a" * 40, "b" * 40, ["docs/x.md"], 1), workspace_root=None, base_dir=self.tools)
        self.assertFalse(row["valid"])
        self.assertEqual(row["reason_codes"], ["risk_change_paths_unavailable"])


class DisagreementArithmeticTests(unittest.TestCase):
    def _change(self, *entries: tuple[str, str]) -> ChangePaths:
        return ChangePaths(base_rev="a" * 40, head_rev="b" * 40, entries=tuple(entries))

    def test_a_rename_is_one_platform_entry_and_two_git_entries(self) -> None:
        change = self._change(("D", "a/x.md"), ("A", "b/x.md"), ("M", "c.md"))
        self.assertIsNone(platform_file_list_disagreement(change, listed_paths=["b/x.md", "c.md"], listed_count=2))

    def test_an_unlisted_addition_in_a_complete_list_disagrees(self) -> None:
        change = self._change(("D", "a/x.md"), ("A", "b/x.md"), ("A", "c.md"))
        self.assertEqual(
            platform_file_list_disagreement(change, listed_paths=["a/x.md", "b/x.md"], listed_count=2),
            "git_path_missing_from_platform_list:c.md",
        )

    def test_more_renames_than_deletions_disagrees(self) -> None:
        change = self._change(("A", "a.md"), ("A", "b.md"))
        self.assertEqual(
            platform_file_list_disagreement(change, listed_paths=["a.md"], listed_count=1),
            "platform_file_count_below_git:1<2",
        )

    def test_the_parser_refuses_what_it_cannot_place(self) -> None:
        self.assertEqual(parse_name_status_z("D\0a\0A\0b\0"), (("D", "a"), ("A", "b")))
        for malformed in ("R100\0a\0b\0", "M\0", "Q\0a\0"):
            with self.subTest(output=malformed), self.assertRaises(GovernanceError):
                parse_name_status_z(malformed)

    def test_a_revision_cannot_become_an_option(self) -> None:
        with self.assertRaises(GovernanceError):
            read_change_paths(Path("."), "--output=/tmp/x", "b" * 40)


class AdapterCarriesTheUncappedCountTests(unittest.TestCase):
    def test_gh_adapter_asks_for_and_maps_changed_files(self) -> None:
        from aria_kernel.auto_merge import GhCliGitHubAdapter

        adapter = GhCliGitHubAdapter.__new__(GhCliGitHubAdapter)
        adapter.owner, adapter.repo = "okan", "aqua"
        seen: list[list[str]] = []

        def fake_json(args: list[str]) -> dict:
            seen.append(args)
            return {"number": 7, "files": [{"path": "docs/x.md"}], "changedFiles": 250}

        with patch.object(adapter, "_gh_json", side_effect=fake_json):
            pr = adapter.get_pr(7)
        self.assertIn("changedFiles", seen[0][seen[0].index("--json") + 1].split(","))
        self.assertEqual(pr["changed_files_count"], 250)


class MergeAuthorityReadsTheChangeFromGitTests(unittest.TestCase):
    def test_merge_authority_refuses_without_a_checkout(self) -> None:
        from aria_kernel.merge_authority import merge_pr_if_ready

        class _Adapter:
            def get_pr(self, number: int) -> dict:
                return _pr("a" * 40, "b" * 40, ["docs/runbooks/x.md"], 1)

            def get_open_issues(self, *, labels: list[str]) -> dict:
                # No freeze notice is open (ARIA-MEDIUM-227): the gates before
                # the risk decision pass, so the decision is what is tested.
                return {"readable": True, "issues": []}

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"), \
                    patch("aria_kernel.merge_authority.assert_merge_not_watchdog_frozen", return_value=None), \
                    self.assertRaises(GovernanceError) as caught:
                merge_pr_if_ready(adapter=_Adapter(), pr_number=7, base_dir=tools, readiness_claim_id="claim:7")
            rows = [
                json.loads(line)
                for line in (tools / "enterprise" / "risk-decisions.jsonl").read_text(encoding="utf-8").splitlines()
            ]
        self.assertIn("risk_change_paths_unavailable", str(caught.exception))
        self.assertEqual(rows[-1]["reason_codes"], ["risk_change_paths_unavailable"])

    def test_merge_authority_hands_its_workspace_to_the_decision(self) -> None:
        from aria_kernel import merge_authority

        seen: dict = {}

        def fake_decision(pr: dict, **kwargs: object) -> dict:
            seen.update(kwargs)
            return {"valid": False, "reason_codes": ["stop_here"]}

        class _Adapter:
            def get_pr(self, number: int) -> dict:
                return _pr("a" * 40, "b" * 40, ["docs/runbooks/x.md"], 1)

            def get_open_issues(self, *, labels: list[str]) -> dict:
                # No freeze notice is open (ARIA-MEDIUM-227): the gates before
                # the risk decision pass, so the decision is what is tested.
                return {"readable": True, "issues": []}

        with tempfile.TemporaryDirectory() as tmp, \
                patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"), \
                patch("aria_kernel.merge_authority.assert_merge_not_watchdog_frozen", return_value=None), \
                patch("aria_kernel.merge_authority.record_risk_decision_for_pr", side_effect=fake_decision):
            with self.assertRaises(GovernanceError):
                merge_authority.merge_pr_if_ready(
                    adapter=_Adapter(), pr_number=7, base_dir=Path(tmp) / "t",
                    readiness_claim_id="claim:7", workspace_root=Path(tmp),
                )
        self.assertEqual(seen.get("workspace_root"), Path(tmp))


class OneChangePathReaderTests(unittest.TestCase):
    """Every consumer that decides something from a change's path set reads
    it through ``change_paths`` — a second, rename-blind reader is how the
    risk decision and the scope verdict came to disagree with git."""

    def test_the_consumers_read_through_the_one_reader(self) -> None:
        import re

        kernel = Path(__file__).resolve().parents[1] / "aria_kernel"
        rename_blind = re.compile(r'\["diff", "--name-only"(?!, "--diff-filter=U")')
        for module in ("merge_authority", "implementation_delivery", "self_revert", "risk_policy"):
            source = (kernel / f"{module}.py").read_text(encoding="utf-8")
            with self.subTest(module=module):
                self.assertIsNone(rename_blind.search(source))
                self.assertRegex(source, r"read_change_paths|name_status_args")


if __name__ == "__main__":
    unittest.main()
