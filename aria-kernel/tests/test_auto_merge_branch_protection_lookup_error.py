"""Plan 023 v3.1 §P-2-followup — branch_protection.lookup_error enforcement.

Plan 023 v3 §P-2 added _fetch_branch_protection_contexts() which
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


if __name__ == "__main__":
    unittest.main()
