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

import unittest

from aria_kernel.auto_merge import (
    GhCliGitHubAdapter,
    SnapshotGitHubAdapter,
    evaluate_auto_merge,
)


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
        result = adapter.get_pr_diff(42)
        self.assertIn("+++ b/x", result)

    def test_snapshot_adapter_get_pr_diff_returns_none_when_missing(self) -> None:
        adapter = SnapshotGitHubAdapter({
            "pr": {"number": 42},
            "github": {},
        })
        self.assertIsNone(adapter.get_pr_diff(42))

    def test_gh_cli_adapter_declares_get_pr_diff_method(self) -> None:
        """Live GhCliGitHubAdapter has the get_pr_diff method available
        on the class. Actual subprocess invocation is operator-driven
        (live gh CLI); the test just pins the Protocol contract."""
        self.assertTrue(callable(getattr(GhCliGitHubAdapter, "get_pr_diff", None)))


if __name__ == "__main__":
    unittest.main()
