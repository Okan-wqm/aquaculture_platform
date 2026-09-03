"""Plan 023 v3 §P-2 — branch protection required_checks (fail-closed).

Pre-Plan-023 _gh_pr_snapshot derived `required_checks` from
`gh pr checks` stdout — that lists checks that have ALREADY RUN on
the PR, not the checks that branch protection REQUIRES. Result: a PR
with 0 check runs against a base branch whose protection requires
`ci-affected` returned `required = []`, and auto-merge then saw "all
required checks satisfied" and proceeded.

Plan 023 v3 §P-2 fix: fetch the real protection contexts via
`gh api /repos/{owner}/{repo}/branches/{base}/protection/required_status_checks`.
Parse failure modes explicitly:
* HTTP 200, contexts populated → required_checks = contexts.
* HTTP 200, contexts empty → branch_protection.lookup_error =
  'branch_protection_no_required_checks_configured'.
* HTTP 404 → 'branch_protection_disabled_on_base'.
* HTTP 401/403 → 'branch_protection_lookup_permission_denied'.
* Other failure (network, gh CLI subprocess error) →
  'branch_protection_lookup_failed'.

The auto-merge consumer reads `branch_protection.required_checks` and
`branch_protection.lookup_error` to decide eligibility (P-4 scope).
This test covers the snapshot layer only.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.ci import _fetch_branch_protection_contexts


class FetchBranchProtectionContextsTests(unittest.TestCase):
    def _mock_gh_run(self, *, returncode: int, stdout: str = "", stderr: str = ""):
        """Helper: patch subprocess.run to return a configured result."""
        from unittest.mock import MagicMock
        result = MagicMock()
        result.returncode = returncode
        result.stdout = stdout
        result.stderr = stderr
        return result

    def test_protection_with_required_contexts_returns_list(self) -> None:
        """HTTP 200, real protection list → (contexts, None)."""
        from pathlib import Path
        gh_response = '{"contexts": ["ci-affected", "security-snyk"]}'
        with patch("aria_kernel.ci.subprocess.run") as mock_run:
            mock_run.return_value = self._mock_gh_run(returncode=0, stdout=gh_response)
            contexts, error = _fetch_branch_protection_contexts(
                root=Path("/tmp"), base_branch="main",
            )
        self.assertEqual(contexts, ["ci-affected", "security-snyk"])
        self.assertIsNone(error)

    def test_protection_with_empty_contexts_returns_specific_error(self) -> None:
        """HTTP 200, contexts=[] → branch_protection_no_required_checks_configured."""
        from pathlib import Path
        gh_response = '{"contexts": []}'
        with patch("aria_kernel.ci.subprocess.run") as mock_run:
            mock_run.return_value = self._mock_gh_run(returncode=0, stdout=gh_response)
            contexts, error = _fetch_branch_protection_contexts(
                root=Path("/tmp"), base_branch="main",
            )
        self.assertEqual(contexts, [])
        self.assertEqual(error, "branch_protection_no_required_checks_configured")

    def test_http_404_returns_disabled_error(self) -> None:
        """gh api returns non-zero with 'HTTP 404' in stderr → branch
        protection disabled on the base branch."""
        from pathlib import Path
        with patch("aria_kernel.ci.subprocess.run") as mock_run:
            mock_run.return_value = self._mock_gh_run(
                returncode=1, stderr="gh: Branch not protected (HTTP 404)",
            )
            contexts, error = _fetch_branch_protection_contexts(
                root=Path("/tmp"), base_branch="main",
            )
        self.assertIsNone(contexts)
        self.assertEqual(error, "branch_protection_disabled_on_base")

    def test_http_403_returns_permission_denied(self) -> None:
        """gh api returns non-zero with 'HTTP 403' → permission denied."""
        from pathlib import Path
        with patch("aria_kernel.ci.subprocess.run") as mock_run:
            mock_run.return_value = self._mock_gh_run(
                returncode=1, stderr="gh: Forbidden (HTTP 403)",
            )
            contexts, error = _fetch_branch_protection_contexts(
                root=Path("/tmp"), base_branch="main",
            )
        self.assertIsNone(contexts)
        self.assertEqual(error, "branch_protection_lookup_permission_denied")

    def test_http_401_returns_permission_denied(self) -> None:
        """gh api returns non-zero with 'HTTP 401' → also permission
        denied (auth missing/expired)."""
        from pathlib import Path
        with patch("aria_kernel.ci.subprocess.run") as mock_run:
            mock_run.return_value = self._mock_gh_run(
                returncode=1, stderr="gh: Authentication required (HTTP 401)",
            )
            contexts, error = _fetch_branch_protection_contexts(
                root=Path("/tmp"), base_branch="main",
            )
        self.assertIsNone(contexts)
        self.assertEqual(error, "branch_protection_lookup_permission_denied")

    def test_subprocess_failure_returns_lookup_failed(self) -> None:
        """gh CLI subprocess raises (FileNotFoundError, network error,
        etc.) → branch_protection_lookup_failed (the operator-actionable
        catch-all)."""
        from pathlib import Path
        with patch("aria_kernel.ci.subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError("gh: not found")
            contexts, error = _fetch_branch_protection_contexts(
                root=Path("/tmp"), base_branch="main",
            )
        self.assertIsNone(contexts)
        self.assertEqual(error, "branch_protection_lookup_failed")


if __name__ == "__main__":
    unittest.main()
