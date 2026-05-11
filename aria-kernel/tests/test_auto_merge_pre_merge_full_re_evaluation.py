"""Plan 024 v3 §B-6 — auto-merge pre-merge full re-evaluation tests.

Pre-fix the merge_if_green window between snapshot construction and
adapter.merge_pr only re-fetched the head SHA. Reviews / checks /
conversations / diff were not re-collected, so a force-push between
snapshot and merge invalidated only the head SHA branch — but a
required reviewer dismissal, a check transitioning to failure, or
an unresolved comment added to the PR could not block the merge.

Plus the SnapshotGitHubAdapter.get_latest_head_sha had a fallback
`or pr.head_sha` that masked missing fixture data.

Tests:
1. SnapshotGitHubAdapter.get_latest_head_sha returns None when
   github.latest_head_sha is missing (no fallback to pr.head_sha).
2. merge_if_green source carries the pre_merge_re_evaluation_blocked
   tag and re-runs collect_github_snapshot at the merge boundary
   (source scan; integration coverage is in test_auto_merge.py via
   the head-sha-changed test which now hits the re-eval path).
"""
from __future__ import annotations

import unittest
from pathlib import Path

from aria_kernel.auto_merge import SnapshotGitHubAdapter


class SnapshotAdapterStrictHeadShaTests(unittest.TestCase):
    def test_missing_latest_head_sha_returns_none_no_fallback(self) -> None:
        """Plan 024 §B-6 acceptance (1): no `or pr.head_sha` fallback."""
        payload = {
            "pr": {
                "number": 42,
                "head_sha": "abc1234567890abc1234567890abc1234567890a",
            },
            # github.latest_head_sha intentionally absent.
            "github": {},
        }
        adapter = SnapshotGitHubAdapter(payload)
        # Pre-fix this returned 'abc1234...' via `or pr.head_sha`
        # fallback. Post-fix returns None signalling lookup failure.
        self.assertIsNone(adapter.get_latest_head_sha(42))

    def test_present_latest_head_sha_returned_directly(self) -> None:
        """Plan 024 §B-6 acceptance (1) regression: when the fixture
        seeds latest_head_sha the adapter still returns it."""
        payload = {
            "pr": {
                "number": 42,
                "head_sha": "abc1234567890abc1234567890abc1234567890a",
            },
            "github": {
                "latest_head_sha": "def4567890def4567890def4567890def4567890",
            },
        }
        adapter = SnapshotGitHubAdapter(payload)
        self.assertEqual(
            adapter.get_latest_head_sha(42),
            "def4567890def4567890def4567890def4567890",
        )


class MergeIfGreenReEvaluationSourceTests(unittest.TestCase):
    def test_pre_merge_re_evaluation_path_wired_in_source(self) -> None:
        """Plan 024 §B-6 acceptance (2) source scan: the merge_if_green
        function calls collect_github_snapshot a second time after
        evaluate_auto_merge succeeds; the block emitted from that
        re-evaluation carries the pre_merge_re_evaluation_blocked tag
        and stage='pre_merge_re_evaluation'. Integration coverage in
        tests/test_auto_merge.py exercises the head-SHA-changed path
        which now hits the re-eval branch (the existing test was
        updated to accept either the legacy reason or the re-eval
        tag)."""
        auto_merge_src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "auto_merge.py"
        ).read_text(encoding="utf-8")
        # The fresh re-eval call site must reuse collect_github_snapshot.
        self.assertIn("collect_github_snapshot(adapter, fresh_pr)",
                      auto_merge_src,
            "Plan 024 §B-6 — fresh snapshot must reuse collect_github_snapshot")
        self.assertIn("pre_merge_re_evaluation_blocked", auto_merge_src,
            "Plan 024 §B-6 — re-eval block must carry distinguishing tag")
        self.assertIn('"stage": "pre_merge_re_evaluation"', auto_merge_src,
            "Plan 024 §B-6 — block payload must carry stage indicator")
        # Sanity: the strict head-SHA accessor doesn't fall back to pr.
        # Lines around the SnapshotGitHubAdapter.get_latest_head_sha
        # implementation.
        self.assertNotIn(
            'self.payload.get("pr", {}).get("head_sha")',
            auto_merge_src.split("def get_latest_head_sha")[1].split("def ")[0],
            "Plan 024 §B-6 — get_latest_head_sha must not fall back to pr.head_sha",
        )


if __name__ == "__main__":
    unittest.main()
