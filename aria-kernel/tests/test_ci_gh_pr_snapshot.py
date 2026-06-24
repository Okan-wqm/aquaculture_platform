"""Plan 022 C-7 — _gh_pr_snapshot real check state derivation tests.

Pre-Plan-022 _gh_pr_snapshot synthesized github.checks.runs as
[{name, status:'completed', conclusion:'success'} for name in required]
regardless of the real gh state. Auto-merge gates reading
github.checks.runs saw pending/failing checks as success.

Fix: derive github.checks.runs from real gh pr checks state per name:
  PENDING/QUEUED -> status='in_progress', conclusion=None
  SUCCESS        -> status='completed', conclusion='success'
  FAILURE        -> status='completed', conclusion='failure'
  SKIPPED        -> status='completed', conclusion='skipped'
  CANCELLED      -> status='completed', conclusion='cancelled'
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.ci import _gh_pr_snapshot


def _gh_json_stub(checks_payload: list[dict]):
    """Build a side_effect for _gh_json that returns pr_view payload then
    the supplied checks_payload."""
    def side_effect(root, argv):
        if "pr" in argv and "view" in argv:
            return {
                "number": 42,
                "baseRefName": "main",
                "headRefOid": "abc1234",
                "files": [],
            }
        if "pr" in argv and "checks" in argv:
            return checks_payload
        raise AssertionError(f"unexpected gh args: {argv}")
    return side_effect


class GhPrSnapshotChecksRunsTests(unittest.TestCase):
    def _snapshot(self, checks_payload):
        # Plan ARIA-V10.3-B prereq fix — also mock
        # `_fetch_branch_protection_contexts` so the test does not
        # depend on the main branch's live protection state. Pre-
        # V10.3-B prereq the branch was unprotected (404), the helper
        # returned (None, "branch_protection_disabled_on_base"), and
        # `_gh_pr_snapshot` fell back to the `required` list derived
        # from the checks payload. Post-V10.3-B prereq the branch IS
        # protected and the helper returns ([], None) because the
        # operator-acknowledged Tier-1 rules deliberately leave
        # `required_status_checks.contexts=[]` (Free-plan public repo;
        # main is the ARIA experimental branch — see
        # aria-tools/preflight/main-branch-protection-v4.json
        # compatibility_decision=compatible_without_push_restrictions).
        # That empty list shrank `required_runs` to zero + every
        # checks-payload-derived assertion broke. Mocking the helper
        # restores the pre-V10.3-B environment-independent contract:
        # the test exercises the checks-state mapping logic, NOT the
        # branch-protection-discovery logic.
        with patch(
            "aria_kernel.ci._gh_json",
            side_effect=_gh_json_stub(checks_payload),
        ), patch(
            "aria_kernel.ci._fetch_branch_protection_contexts",
            return_value=(None, "branch_protection_disabled_on_base"),
        ):
            return _gh_pr_snapshot(pr_number=42, workspace_root=".")

    def test_pending_check_surfaces_as_in_progress(self) -> None:
        snap = self._snapshot([{"name": "ci-affected", "state": "PENDING", "workflow": "CI"}])
        runs = snap["github"]["checks"]["runs"]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["status"], "in_progress")
        self.assertIsNone(runs[0]["conclusion"])

    def test_failure_check_surfaces_as_completed_failure(self) -> None:
        snap = self._snapshot([{"name": "ci-affected", "state": "FAILURE", "workflow": "CI"}])
        runs = snap["github"]["checks"]["runs"]
        self.assertEqual(runs[0]["status"], "completed")
        self.assertEqual(runs[0]["conclusion"], "failure")

    def test_success_check_surfaces_as_completed_success(self) -> None:
        snap = self._snapshot([{"name": "ci-affected", "state": "SUCCESS", "workflow": "CI"}])
        runs = snap["github"]["checks"]["runs"]
        self.assertEqual(runs[0]["status"], "completed")
        self.assertEqual(runs[0]["conclusion"], "success")

    def test_skipped_and_cancelled_states_propagated(self) -> None:
        snap = self._snapshot([
            {"name": "skipped-check", "state": "SKIPPED", "workflow": "CI"},
            {"name": "cancelled-check", "state": "CANCELLED", "workflow": "CI"},
        ])
        by_name = {r["name"]: r for r in snap["github"]["checks"]["runs"]}
        self.assertEqual(by_name["skipped-check"]["conclusion"], "skipped")
        self.assertEqual(by_name["cancelled-check"]["conclusion"], "cancelled")

    def test_required_check_without_run_surfaces_as_in_progress(self) -> None:
        # Required check name listed but no entry in checks payload (rare
        # gh state) -> must NOT default to success.
        with patch("aria_kernel.ci._gh_json") as mock_gh, patch(
            "aria_kernel.ci._fetch_branch_protection_contexts",
            return_value=(["ci-required"], None),
        ):
            mock_gh.side_effect = lambda root, argv: (
                {"number": 1, "baseRefName": "main", "headRefOid": "abc", "files": []}
                if "view" in argv else
                # Empty checks payload: branch protection still declares
                # a required check that has not produced a run yet.
                []
            )
            snap = _gh_pr_snapshot(pr_number=1, workspace_root=".")
        self.assertEqual(
            snap["github"]["checks"]["runs"],
            [{"name": "ci-required", "status": "in_progress", "conclusion": None}],
        )

    def test_pre_fix_synthetic_success_is_gone(self) -> None:
        # Pre-fix, ANY state would have been mapped to completed/success
        # in github.checks.runs. Confirm the post-fix snapshot does NOT
        # exhibit that behaviour for a FAILURE check.
        snap = self._snapshot([{"name": "ci-affected", "state": "FAILURE", "workflow": "CI"}])
        for run in snap["github"]["checks"]["runs"]:
            self.assertNotEqual(
                (run["status"], run["conclusion"]),
                ("completed", "success"),
                "Plan 022 C-7: failure must NOT be reported as completed/success",
            )


if __name__ == "__main__":
    unittest.main()
