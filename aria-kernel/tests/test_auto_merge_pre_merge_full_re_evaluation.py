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
2. merge_authority source carries the pre_merge_re_evaluation_blocked
   tag and re-runs collect_github_snapshot at the real merge boundary.
   auto_merge remains evaluation-only and rejects dry_run=False.
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
    def test_pre_merge_re_evaluation_path_wired_via_ast(self) -> None:
        """Plan 024 §B-6 + Plan 026R §H.1 — AST-backed conversion.

        Pre-§H.1 this test scanned auto_merge.py for substring markers.
        The converted form parses the module with ``ast`` and asserts:

        * ``_merge_if_green_with_executor`` exists in auto_merge as an
          evaluation-only gate and contains the direct-real-merge rejection
          literal.
        * ``merge_authority.merge_pr_if_ready`` is the real merge boundary.
        * Its body contains a Call to ``collect_github_snapshot`` with
          ``fresh_pr`` as the second positional argument (the re-eval
          collection site), and a Call to ``adapter.merge_pr``.
        * The authority body contains a string constant
          ``pre_merge_re_evaluation_blocked`` (the block-row tag) AND
          a string constant ``pre_merge_re_evaluation`` (the stage
          indicator). AST-level constant lookup proves these literals
          are in the function body, not just somewhere in the file.
        * The class ``SnapshotGitHubAdapter`` defines
          ``get_latest_head_sha`` and its body does NOT contain
          ``self.payload.get("pr", ...)`` access (strict head-SHA
          accessor must not fall back to pr.head_sha).
        """
        import ast as _ast
        auto_merge_path = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "auto_merge.py"
        )
        tree = _ast.parse(auto_merge_path.read_text(encoding="utf-8"))
        merge_fn = next(
            (
                n for n in _ast.walk(tree)
                if isinstance(n, _ast.FunctionDef)
                and n.name == "_merge_if_green_with_executor"
            ),
            None,
        )
        self.assertIsNotNone(
            merge_fn, "auto_merge.py: _merge_if_green_with_executor not found",
        )
        evaluator_consts = {
            node.value for node in _ast.walk(merge_fn)
            if isinstance(node, _ast.Constant)
            and isinstance(node.value, str)
        }
        self.assertIn(
            "direct_real_merge_forbidden: call merge_authority.merge_pr_if_ready() "
            "for dry_run=False",
            evaluator_consts,
            "_merge_if_green_with_executor must fail closed on dry_run=False",
        )
        authority_path = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "merge_authority.py"
        )
        authority_tree = _ast.parse(authority_path.read_text(encoding="utf-8"))
        authority_fn = next(
            (
                n for n in _ast.walk(authority_tree)
                if isinstance(n, _ast.FunctionDef)
                and n.name == "merge_pr_if_ready"
            ),
            None,
        )
        self.assertIsNotNone(
            authority_fn, "merge_authority.py: merge_pr_if_ready not found",
        )
        body_consts = {
            node.value for node in _ast.walk(authority_fn)
            if isinstance(node, _ast.Constant)
            and isinstance(node.value, str)
        }
        self.assertIn(
            "pre_merge_re_evaluation_blocked", body_consts,
            "merge_pr_if_ready: missing distinguishing tag literal",
        )
        self.assertIn(
            "pre_merge_re_evaluation", body_consts,
            "merge_pr_if_ready: missing stage indicator literal",
        )
        found_fresh_pr_call = False
        found_real_merge_call = False
        for node in _ast.walk(authority_fn):
            if not isinstance(node, _ast.Call):
                continue
            func = node.func
            if isinstance(func, _ast.Attribute) and func.attr == "merge_pr":
                receiver = func.value
                if isinstance(receiver, _ast.Name) and receiver.id == "adapter":
                    found_real_merge_call = True
            is_target = (
                isinstance(func, _ast.Name)
                and func.id == "collect_github_snapshot"
            ) or (
                isinstance(func, _ast.Attribute)
                and func.attr == "collect_github_snapshot"
            )
            if not is_target:
                continue
            if any(
                isinstance(arg, _ast.Name) and arg.id == "fresh_pr"
                for arg in node.args
            ):
                found_fresh_pr_call = True
        self.assertTrue(
            found_fresh_pr_call,
            "merge_pr_if_ready: no "
            "collect_github_snapshot(..., fresh_pr) call — Plan 024 §B-6 "
            "fresh snapshot site missing",
        )
        self.assertTrue(
            found_real_merge_call,
            "merge_pr_if_ready: adapter.merge_pr call missing from authority boundary",
        )
        # Strict head-SHA accessor invariant.
        adapter_cls = next(
            (
                n for n in _ast.walk(tree)
                if isinstance(n, _ast.ClassDef)
                and n.name == "SnapshotGitHubAdapter"
            ),
            None,
        )
        self.assertIsNotNone(
            adapter_cls,
            "auto_merge.py: SnapshotGitHubAdapter not found",
        )
        head_sha_fn = next(
            (
                n for n in adapter_cls.body
                if isinstance(n, _ast.FunctionDef)
                and n.name == "get_latest_head_sha"
            ),
            None,
        )
        self.assertIsNotNone(
            head_sha_fn,
            "SnapshotGitHubAdapter: get_latest_head_sha not found",
        )
        head_sha_src = _ast.unparse(head_sha_fn)
        self.assertNotIn(
            'self.payload.get("pr"', head_sha_src,
            "get_latest_head_sha must not fall back to pr.head_sha",
        )


if __name__ == "__main__":
    unittest.main()
