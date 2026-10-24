"""Plan 023 v3 §P-6 — auto-merge diff integrity + get_pr_diff Protocol.

Pre-Plan-023 evaluate_auto_merge accepted any non-None diff_text:

    if diff_text is None:
        reasons.append("diff_text missing — auto_merge_requires_diff_content")
    else:
        ... scan_unified_diff_text(diff_text) ...

`scan_unified_diff_text("")` returns an empty list of matches. An empty
string therefore passes through the suppression-scan loop with zero hits
and the gate concludes "diff is clean". A caller that fetched the diff
via a broken adapter, or maliciously passed `diff_text=""`, defeated
the path-class + content-class AND-merge that auto-merge enforces for
low-risk classification.

Plus the GitHubAdapter Protocol (auto_merge.py:77) lacked a
`get_pr_diff(number)` method. Adapters could omit diff fetching
entirely; live mode (GhCliGitHubAdapter) had no canonical way to
retrieve the unified diff.

Plan 023 v3 §P-6 fix:

* Empty / whitespace-only diff_text → auto_merge_blocked with
  reason "auto_merge_requires_nonempty_unified_diff".
* Malformed unified diff (no `+++ b/<path>` header line) → blocked
  with "auto_merge_diff_unparseable_or_empty".
* GitHubAdapter Protocol gains `get_pr_diff(number) -> str | None`.
  GhCliGitHubAdapter implements via `gh pr diff <number>`.
  SnapshotGitHubAdapter reads `payload.github.pr_diff`.

Tests:
1. Valid non-empty diff → no diff-integrity blocking reason.
2. diff_text="" → blocked with auto_merge_requires_nonempty_unified_diff.
3. diff_text="   \n" (whitespace only) → blocked.
4. Malformed unified diff (no +++ b/ header) → blocked
   with auto_merge_diff_unparseable_or_empty.
5. SnapshotGitHubAdapter implements get_pr_diff (Protocol coverage).
6. GhCliGitHubAdapter has the method declared (Protocol coverage).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.auto_merge import (
    GhCliGitHubAdapter,
    SnapshotGitHubAdapter,
    evaluate_auto_merge,
    merge_if_green,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.operator_stop import operator_stop_clear


def _make_pr(*, head_sha: str = "abc1234567890abc1234567890abc1234567890a") -> dict:
    return {
        "number": 42,
        "base_branch": "main",
        "head_sha": head_sha,
        "changed_files": [{"path": "apps/x.ts"}],
    }


def _make_github(*, latest_head_sha: str | None = None) -> dict:
    return {
        "latest_head_sha": latest_head_sha or "abc1234567890abc1234567890abc1234567890a",
        "branch_protection": {
            "readable": True,
            "required_checks": ["ci-affected"],
        },
        "checks": {
            "readable": True,
            "runs": [
                {"name": "ci-affected", "status": "completed", "conclusion": "success"},
            ],
        },
        "workflow_runs": [],
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
    }


def _make_policy() -> dict:
    return {
        "enabled": True,
        "base_branch": "main",
        "merge_method": "squash",
        "low_risk_paths": ["apps/**/*.ts"],
        "high_risk_paths": [],
        "forbidden_paths": [],
    }


def _valid_diff() -> str:
    return (
        "diff --git a/apps/x.ts b/apps/x.ts\n"
        "index 1234567..abcdefa 100644\n"
        "--- a/apps/x.ts\n"
        "+++ b/apps/x.ts\n"
        "@@ -1 +1 @@\n"
        "-export const a = 1;\n"
        "+export const a = 2;\n"
    )


class DiffIntegrityTests(unittest.TestCase):
    def test_valid_diff_no_integrity_block(self) -> None:
        result = evaluate_auto_merge(
            pr=_make_pr(),
            github=_make_github(),
            policy=_make_policy(),
            diff_text=_valid_diff(),
            workspace_root=None,
        )
        # No P-6 blocking reasons fire on the happy path.
        for reason in result["reasons"]:
            self.assertNotIn("auto_merge_requires_nonempty_unified_diff", reason)
            self.assertNotIn("auto_merge_diff_unparseable_or_empty", reason)

    def test_empty_string_blocks(self) -> None:
        """Plan 023 v3 §P-6: diff_text='' must NOT pass through with 0
        scanner hits; the auto-merge gate rejects empty diffs explicitly."""
        result = evaluate_auto_merge(
            pr=_make_pr(),
            github=_make_github(),
            policy=_make_policy(),
            diff_text="",
            workspace_root=None,
        )
        self.assertTrue(
            any("auto_merge_requires_nonempty_unified_diff" in r
                for r in result["reasons"]),
            f"missing empty-diff reason: {result['reasons']!r}",
        )

    def test_whitespace_only_blocks(self) -> None:
        result = evaluate_auto_merge(
            pr=_make_pr(),
            github=_make_github(),
            policy=_make_policy(),
            diff_text="   \n\n  \t  \n",
            workspace_root=None,
        )
        self.assertTrue(
            any("auto_merge_requires_nonempty_unified_diff" in r
                for r in result["reasons"]),
            f"missing whitespace-diff reason: {result['reasons']!r}",
        )

    def test_malformed_diff_blocks(self) -> None:
        """A diff blob without any `+++ b/<path>` header lines is not a
        unified diff. Pre-fix the suppression scanner would parse it as
        zero file_changes and report 'clean'."""
        result = evaluate_auto_merge(
            pr=_make_pr(),
            github=_make_github(),
            policy=_make_policy(),
            diff_text="this is not a unified diff at all",
            workspace_root=None,
        )
        self.assertTrue(
            any("auto_merge_diff_unparseable_or_empty" in r
                for r in result["reasons"]),
            f"missing malformed-diff reason: {result['reasons']!r}",
        )


class GitHubAdapterProtocolGetPrDiffTests(unittest.TestCase):
    def test_snapshot_adapter_implements_get_pr_diff(self) -> None:
        """SnapshotGitHubAdapter exposes get_pr_diff per Plan 023 §P-6."""
        adapter = SnapshotGitHubAdapter({
            "pr": {"number": 42},
            "github": {"pr_diff": "diff --git a/x b/x\n+++ b/x\n+x\n"},
        })
        self.assertTrue(hasattr(adapter, "get_pr_diff"))
        diff, lookup_error = adapter.get_pr_diff(42)
        self.assertIn("+++ b/x", diff)
        self.assertIsNone(lookup_error)

    def test_snapshot_adapter_get_pr_diff_names_a_missing_fixture(self) -> None:
        adapter = SnapshotGitHubAdapter({
            "pr": {"number": 42},
            "github": {},
        })
        self.assertEqual(adapter.get_pr_diff(42), (None, "fixture_pr_diff_absent"))

    def test_recording_adapter_names_that_it_fetched_nothing(self) -> None:
        from aria_kernel.github_adapters import RecordingGitHubAdapter

        with tempfile.TemporaryDirectory(prefix="aria-581-recording-") as tmp:
            adapter = RecordingGitHubAdapter(base_dir=ensure_tools_dir(Path(tmp) / "aria-tools"), profile="observe")
            self.assertEqual(adapter.get_pr_diff(42), (None, "recording_adapter_no_fetch"))

    def test_gh_cli_adapter_declares_get_pr_diff_method(self) -> None:
        """Live GhCliGitHubAdapter has the get_pr_diff method available
        on the class. Actual subprocess invocation is operator-driven
        (live gh CLI); the test just pins the Protocol contract."""
        self.assertTrue(callable(getattr(GhCliGitHubAdapter, "get_pr_diff", None)))


# ARIA-MEDIUM-581 — a fake `gh` on PATH: `repo view` names the repository,
# `pr view` serves the fixture's PR, `pr diff` answers as the fixture says
# (GitHub's own refusal text on stderr). Any other call fails, so the reads
# the merge evaluation makes beside the diff are unreadable, by name.
_FAKE_GH = """#!{python}
import json, os, sys
argv = sys.argv[1:]
with open(os.environ["ARIA_FAKE_GH_FIXTURE"], encoding="utf-8") as handle:
    fixture = json.load(handle)
if argv[:2] == ["repo", "view"]:
    print(json.dumps({{"owner": {{"login": "okan"}}, "name": "aqua"}}))
    sys.exit(0)
if argv[:2] == ["pr", "view"]:
    print(json.dumps(fixture["pr_view"]))
    sys.exit(0)
if argv[:2] == ["pr", "diff"]:
    answer = fixture["pr_diff"]
    sys.stdout.write(answer.get("stdout", ""))
    sys.stderr.write(answer.get("stderr", ""))
    sys.exit(answer["code"])
sys.stderr.write("fake gh: unexpected call " + " ".join(argv) + "\\n")
sys.exit(1)
"""

_HEAD = "b" * 40
_TOO_LARGE = (
    "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number "
    "of files (300). Consider using 'List pull requests files' API or locally cloning the "
    "repository instead. (https://api.github.com/repos/okan/aqua/pulls/42)\n"
)
_REFUSED_403 = (
    "could not find pull request diff: HTTP 403: Resource not accessible by integration "
    "(https://api.github.com/repos/okan/aqua/pulls/42)\n"
)
_MISSING_DIFF = "diff_text missing — auto_merge_requires_diff_content"


class _FakeGh:
    def __init__(self, test: unittest.TestCase) -> None:
        directory = tempfile.TemporaryDirectory(prefix="aria-581-gh-")
        test.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text(_FAKE_GH.format(python=sys.executable), encoding="utf-8")
        gh.chmod(0o755)
        self.fixture = self.root / "fixture.json"
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.serve_diff(code=0, stdout=_valid_diff())
        environment = patch.dict(os.environ, {
            "PATH": f"{self.bin}:{os.defpath}", "ARIA_FAKE_GH_FIXTURE": str(self.fixture),
        })
        environment.start()
        test.addCleanup(environment.stop)
        self.adapter = GhCliGitHubAdapter(cwd=self.root)

    def serve_diff(self, *, code: int, stdout: str = "", stderr: str = "") -> None:
        self.fixture.write_text(json.dumps({
            "pr_view": {
                "number": 42, "state": "OPEN", "baseRefName": "main", "baseRefOid": "c" * 40,
                "headRefName": "aria-impl-0123456789abcdef", "headRefOid": _HEAD, "body": "",
                "url": "https://github.com/okan/aqua/pull/42", "files": [{"path": "apps/x.ts"}],
                "changedFiles": 1, "labels": [], "reviews": [], "reviewDecision": None, "mergeCommit": None,
            },
            "pr_diff": {"code": code, "stdout": stdout, "stderr": stderr},
        }), encoding="utf-8")


class PrDiffLookupErrorTests(unittest.TestCase):
    """ARIA-MEDIUM-581 — a diff the merge lane could not read names why.

    ``gh pr diff`` refuses an oversized diff (HTTP 406) and a token without
    pull-request read (HTTP 403/401) on stderr with a non-zero exit. The
    adapter returned a bare None for all of them, both callers caught any
    exception into None, and the gate blocked as ``diff_text missing`` with
    no way to tell a refusal from an oversized change. The adapter now
    answers ``(diff, lookup_error)``, as ``read_required_status_checks``
    does, and the gate names the code.
    """

    def setUp(self) -> None:
        self.gh = _FakeGh(self)

    def test_the_gh_adapter_names_each_cause(self) -> None:
        cases = (
            ({"code": 1, "stderr": _TOO_LARGE}, (None, "pr_diff_too_large")),
            ({"code": 1, "stderr": _REFUSED_403}, (None, "pr_diff_refused_403")),
            ({"code": 1, "stderr": "could not find pull request diff: HTTP 401: Bad credentials\n"},
             (None, "pr_diff_refused_401")),
            ({"code": 1, "stderr": "could not find pull request diff: HTTP 502: Bad Gateway\n"},
             (None, "pr_diff_lookup_failed:http_502")),
            ({"code": 4, "stderr": "error connecting to api.github.com\n"}, (None, "pr_diff_lookup_failed:exit_4")),
            ({"code": 0, "stdout": "  \n"}, (None, "pr_diff_empty")),
            ({"code": 0, "stdout": _valid_diff()}, (_valid_diff(), None)),
        )
        for answer, expected in cases:
            with self.subTest(answer=answer):
                self.gh.serve_diff(**answer)
                self.assertEqual(self.gh.adapter.get_pr_diff(42), expected)

    def test_a_missing_gh_is_named(self) -> None:
        empty = self.gh.root / "empty-bin"
        empty.mkdir()
        with patch.dict(os.environ, {"PATH": str(empty)}):
            self.assertEqual(self.gh.adapter.get_pr_diff(42), (None, "gh_unavailable"))

    def test_the_merge_lane_evaluation_names_an_oversized_diff(self) -> None:
        self.gh.serve_diff(code=1, stderr=_TOO_LARGE)
        decision = merge_if_green(
            adapter=self.gh.adapter, pr_number=42, base_dir=self.gh.tools, dry_run=True,
            workspace_root=self.gh.root,
        )
        self.assertFalse(decision["eligible"])
        self.assertIn(f"{_MISSING_DIFF}: pr_diff_too_large", decision["reasons"])
        self.assertNotIn(_MISSING_DIFF, decision["reasons"])

    def test_the_merge_lane_evaluation_names_a_refused_diff(self) -> None:
        self.gh.serve_diff(code=1, stderr=_REFUSED_403)
        decision = merge_if_green(
            adapter=self.gh.adapter, pr_number=42, base_dir=self.gh.tools, dry_run=True,
            workspace_root=self.gh.root,
        )
        self.assertIn(f"{_MISSING_DIFF}: pr_diff_refused_403", decision["reasons"])

    def test_an_adapter_fault_is_raised_not_read_as_a_missing_diff(self) -> None:
        class Broken(SnapshotGitHubAdapter):
            def get_pr_diff(self, number: int) -> tuple[str | None, str | None]:
                raise RuntimeError("adapter bug")

        adapter = Broken({"pr": _make_pr(), "github": _make_github()})
        with self.assertRaisesRegex(RuntimeError, "adapter bug"):
            merge_if_green(adapter=adapter, pr_number=42, base_dir=self.gh.tools, dry_run=True,
                           workspace_root=self.gh.root)

    def test_the_claim_time_review_names_why_the_diff_is_absent(self) -> None:
        from aria_kernel.merge_authority import request_implementation_expert_review

        self.gh.serve_diff(code=1, stderr=_TOO_LARGE)
        review = request_implementation_expert_review(
            adapter=self.gh.adapter, pr_number=42, base_dir=self.gh.tools, workspace_root=self.gh.root,
        )
        self.assertEqual(review["requested"], [])
        self.assertEqual(review["reasons"], ["pr_diff_unavailable:pr_diff_too_large"])


class PreMergeReEvaluationNamesTheDiffCauseTests(unittest.TestCase):
    """The merge authority's fresh re-read, immediately before the merge,
    names why the diff it re-fetched is missing; the merge is not called."""

    class _Adapter:
        def __init__(self, sha: str) -> None:
            self.sha = sha
            self.merge_calls: list[dict[str, Any]] = []

        def get_pr(self, number: int) -> dict[str, Any]:
            return {
                "number": number, "state": "OPEN", "repository": "okan/aqua", "base_branch": "main",
                "head_ref": "feat/x", "head_sha": self.sha, "changed_files": ["apps/x.ts"],
            }

        def get_pr_diff(self, number: int) -> tuple[str | None, str | None]:
            return None, "pr_diff_refused_403"

        def merge_pr(self, number: int, **kwargs: Any) -> dict[str, Any]:
            self.merge_calls.append({"number": number, **kwargs})
            return {"merged": True}

        def get_open_issues(self, *, labels: list[str]) -> dict[str, Any]:
            return {"readable": True, "issues": []}

    def test_the_fresh_re_evaluation_names_a_refused_diff(self) -> None:
        from aria_kernel.merge_authority import merge_pr_if_ready
        from tests.test_merge_authority_pre_merge_perimeter import _SHA, _gate_patches

        # Every gate before the fresh re-evaluation passes; the re-evaluation
        # itself is the real one.
        patches = [item for item in _gate_patches() if item.attribute != "evaluate_auto_merge"]
        adapter = self._Adapter(_SHA)
        with tempfile.TemporaryDirectory(prefix="aria-581-fresh-") as tmp:
            tools = ensure_tools_dir(Path(tmp) / "aria-tools")
            for item in patches:
                item.start()
            try:
                result = merge_pr_if_ready(
                    adapter=adapter, pr_number=77, base_dir=tools,
                    readiness_claim_id="claim:77:aaaaaaaaaaaa",
                    intent_publisher=lambda intent: {"published": True},
                    operator_stop=operator_stop_clear(),
                )
            finally:
                for item in reversed(patches):
                    item.stop()
        self.assertEqual(result["stage"], "pre_merge_re_evaluation")
        self.assertIn(f"{_MISSING_DIFF}: pr_diff_refused_403", result["reasons"])
        self.assertEqual(adapter.merge_calls, [])


if __name__ == "__main__":
    unittest.main()
