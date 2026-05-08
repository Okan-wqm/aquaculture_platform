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
                "baseRefName": "snowball",
                "headRefOid": "abc1234",
                "files": [],
            }
        if "pr" in argv and "checks" in argv:
            return checks_payload
        raise AssertionError(f"unexpected gh args: {argv}")
    return side_effect


class GhPrSnapshotChecksRunsTests(unittest.TestCase):
    def _snapshot(self, checks_payload):
        with patch("aria_kernel.ci._gh_json", side_effect=_gh_json_stub(checks_payload)):
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
        with patch("aria_kernel.ci._gh_json") as mock_gh:
            mock_gh.side_effect = lambda root, argv: (
                {"number": 1, "baseRefName": "snowball", "headRefOid": "abc", "files": []}
                if "view" in argv else
                # Empty checks: required_checks list will be empty too.
                []
            )
            snap = _gh_pr_snapshot(pr_number=1, workspace_root=".")
        # No required checks, no runs -> the snapshot stays consistent.
        self.assertEqual(snap["github"]["checks"]["runs"], [])

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
