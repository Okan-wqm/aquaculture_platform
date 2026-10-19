"""Plan 023 v3.1 §P-2-followup — branch_protection.lookup_error enforcement.

Plan 023 v3 §P-2 added _fetch_branch_protection_contexts() (now auto_merge.read_required_status_checks) which
populates github.branch_protection.lookup_error on HTTP 404 / 401 /
403 / network failure. The post-sign-off audit found that
auto_merge.evaluate_auto_merge -> _required_checks() never read the
lookup_error field — so a network/HTTP failure during the branch-
protection fetch silently fell through to checks validation as if
protection had been fetched cleanly. The auto-merge gate then
proceeded against a stale or fabricated required-checks list.

Plan 023 v3.1 fix: _required_checks propagates lookup_error;
evaluate_auto_merge surfaces the specific code (not just
"unreadable") so operator audit sees WHY the gate blocked.

Tests:
1. lookup_error='branch_protection_disabled_on_base' → reasons
   include the explicit lookup_error code.
2. lookup_error='branch_protection_lookup_failed' → blocked.
3. No lookup_error + readable contexts → existing pass path
   (regression).
"""
from __future__ import annotations

import unittest

from aria_kernel.auto_merge import _required_checks, evaluate_auto_merge


class BranchProtectionLookupErrorTests(unittest.TestCase):
    def test_required_checks_propagates_lookup_error(self) -> None:
        """_required_checks must surface lookup_error in its return
        dict so the caller can blocking-reason it."""
        github = {
            "branch_protection": {
                "readable": False,
                "lookup_error": "branch_protection_disabled_on_base",
                "required_checks": [],
            },
        }
        result = _required_checks(github)
        self.assertFalse(result["readable"])
        self.assertEqual(result["lookup_error"], "branch_protection_disabled_on_base")

    def test_evaluate_auto_merge_blocks_with_specific_code(self) -> None:
        """Plan 023 v3.1 §P-2-followup: evaluate_auto_merge surfaces
        the lookup_error code in its blocking reasons, not just
        'unreadable'."""
        result = evaluate_auto_merge(
            pr={
                "number": 42,
                "base_branch": "main",
                "head_sha": "abc1234567890abc1234567890abc1234567890a",
                "changed_files": [{"path": "apps/x.ts"}],
            },
            github={
                "latest_head_sha": "abc1234567890abc1234567890abc1234567890a",
                "branch_protection": {
                    "readable": False,
                    "lookup_error": "branch_protection_lookup_failed",
                    "required_checks": [],
                },
                "checks": {"readable": True, "runs": []},
                "workflow_runs": [],
                "reviews": {"readable": True, "items": []},
                "conversations": {"readable": True, "unresolved_count": 0},
            },
            policy={
                "enabled": True,
                "base_branch": "main",
                "merge_method": "squash",
            },
            diff_text=(
                "diff --git a/apps/x.ts b/apps/x.ts\n"
                "+++ b/apps/x.ts\n"
                "@@ -1 +1 @@\n"
                "+const x = 1;\n"
            ),
            workspace_root=None,
        )
        self.assertTrue(
            any("branch_protection_lookup_failed" in r for r in result["reasons"]),
            f"missing lookup_error code: {result['reasons']!r}",
        )

    def test_no_lookup_error_existing_pass_path(self) -> None:
        """Regression: without lookup_error and readable=true, the
        existing pass path is unchanged."""
        result = _required_checks({
            "branch_protection": {
                "readable": True,
                "required_checks": ["ci-affected"],
            },
        })
        self.assertTrue(result["readable"])
        self.assertEqual(result["checks"], ["ci-affected"])
        self.assertNotIn("lookup_error", result)


class MergeLaneAdapterReadsRequiredChecksTests(unittest.TestCase):
    """ARIA-CRITICAL-009 — the merge lane's adapter reads the required checks.

    ``GhCliGitHubAdapter.get_required_checks`` sent its GET through the
    agents' ``gh api`` path guard, whose deny list forbids
    ``branches/*/protection`` outright, so it raised before any call and
    ``collect_github_snapshot`` swallowed that into an unreadable protection
    with no cause: every live merge-lane evaluation blocked on "branch
    protection required checks unreadable" and none reached the pre-merge
    perimeter. The merge token is minted with administration:read for
    exactly this read (gh_token_factory.DEFAULT_INSTALLATION_TOKEN_PERMISSIONS).
    """

    def _adapter(self):
        from pathlib import Path

        from aria_kernel.auto_merge import GhCliGitHubAdapter

        adapter = GhCliGitHubAdapter.__new__(GhCliGitHubAdapter)
        adapter.cwd = Path(".")
        adapter.owner, adapter.repo = "okan", "aqua"
        return adapter

    def _gh(self, *, returncode: int, stdout: str = "", stderr: str = ""):
        import subprocess

        calls: list[list[str]] = []

        def run(argv, **kwargs):
            calls.append(list(argv))
            if list(argv[:2]) == ["gh", "api"] and str(argv[2]).endswith(
                "/branches/main/protection/required_status_checks",
            ):
                return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=stderr)
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="unexpected gh call")

        return run, calls

    def test_the_live_adapter_reads_the_required_status_checks(self) -> None:
        import json
        from unittest.mock import patch

        from aria_kernel.auto_merge import collect_github_snapshot

        run, calls = self._gh(returncode=0, stdout=json.dumps({
            "strict": True, "contexts": ["ci-affected", "invariants-fast"],
            "checks": [{"context": "ci-affected", "app_id": 15368}],
        }))
        adapter = self._adapter()
        with patch("subprocess.run", run):
            protection = adapter.get_required_checks("main")
            snapshot = collect_github_snapshot(
                _NoOtherReads(adapter), {"number": 7, "base_branch": "main", "head_sha": "a" * 40},
            )
        self.assertEqual(protection["readable"], True)
        self.assertEqual(_required_checks({"branch_protection": protection}),
                         {"readable": True, "checks": ["ci-affected", "invariants-fast"]})
        self.assertEqual(_required_checks(snapshot),
                         {"readable": True, "checks": ["ci-affected", "invariants-fast"]})
        self.assertTrue(calls and all(call[:2] == ["gh", "api"] and len(call) == 3 for call in calls),
                        f"a plain GET, no method or field flags: {calls!r}")

    def test_a_refused_read_names_its_cause(self) -> None:
        from unittest.mock import patch

        run, _ = self._gh(returncode=1, stderr="gh: Resource not accessible by integration (HTTP 403)")
        with patch("subprocess.run", run):
            protection = self._adapter().get_required_checks("main")
        self.assertEqual(_required_checks({"branch_protection": protection}), {
            "readable": False, "checks": [],
            "lookup_error": "branch_protection_lookup_permission_denied",
        })


class _NoOtherReads:
    """The snapshot's other reads answer unreadable; only protection is real."""

    def __init__(self, adapter) -> None:
        self._adapter = adapter

    def get_required_checks(self, base_branch: str):
        return self._adapter.get_required_checks(base_branch)

    def __getattr__(self, name: str):
        def unreadable(*args, **kwargs):
            raise RuntimeError(f"{name} is not part of this test")

        return unreadable


if __name__ == "__main__":
    unittest.main()
