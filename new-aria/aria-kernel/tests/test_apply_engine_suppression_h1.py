"""Plan 022 H-1 — gate_apply_action suppression scan fail-closed when diff_text=None.

Pre-Plan-022: gate_apply_action(diff_text=None) silently skipped the
suppression scanner. Caller could omit diff_text and the gate would
pass solely on validation_gate output, even if the diff contained
banned suppression patterns (test skips, CI masking, ts-ignore).

Fix: when diff_text is None, _read_diff_from_action() recovers the
unified diff via `git diff base_sha..branch`. If recovery fails,
GovernanceError('suppression_scan_requires_diff_content') is raised.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.apply_engine import _read_diff_from_action


class ReadDiffFromActionTests(unittest.TestCase):
    def test_returns_none_when_workspace_root_missing(self) -> None:
        action = {"branch": "aria/x", "base_sha": "abc"}
        self.assertIsNone(_read_diff_from_action(action))

    def test_returns_none_when_branch_missing(self) -> None:
        action = {"workspace_root": "/tmp/x", "base_sha": "abc"}
        self.assertIsNone(_read_diff_from_action(action))

    def test_returns_none_when_base_sha_missing(self) -> None:
        action = {"workspace_root": "/tmp/x", "branch": "aria/x"}
        self.assertIsNone(_read_diff_from_action(action))

    def test_returns_none_when_git_fails(self) -> None:
        action = {
            "workspace_root": "/tmp/nonexistent-aria-h1",
            "branch": "aria/x",
            "base_sha": "abc",
        }
        # Path doesn't exist -> git command fails -> None.
        self.assertIsNone(_read_diff_from_action(action))

    def test_returns_diff_string_on_success(self) -> None:
        # Plan 023 v3 §P-1 changed _read_diff_from_action to a 3-diff
        # union (committed branch history + staged + unstaged) plus a
        # git-status dirty-worktree gate. With allow_dirty_worktree=True
        # the gate is skipped; the three diff sources are unioned and
        # joined with newlines. The legacy test pinned a single-call
        # shape; updated below to match the union shape.
        action = {
            "workspace_root": "/tmp/repo",
            "branch": "aria/x",
            "base_sha": "abc1234",
            "allow_dirty_worktree": True,
        }
        with patch("aria_kernel.apply_engine.subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            mock_run.return_value.stdout = "+++ b/file\n+const x = 1;\n"
            mock_run.return_value.stderr = ""
            result = _read_diff_from_action(action)
        # Three diff invocations, each returning the same mocked stdout;
        # the result is the three sources joined with \n.
        self.assertIsNotNone(result)
        self.assertIn("+++ b/file", result)
        self.assertIn("+const x = 1;", result)
        # Verify the first git diff invocation hits base..branch.
        diff_calls = [
            c for c in mock_run.call_args_list
            if c[0] and c[0][0][:2] == ["git", "diff"]
        ]
        self.assertGreaterEqual(len(diff_calls), 1)
        first_diff_argv = diff_calls[0][0][0]
        self.assertEqual(first_diff_argv[2], "abc1234..aria/x")


if __name__ == "__main__":
    unittest.main()
