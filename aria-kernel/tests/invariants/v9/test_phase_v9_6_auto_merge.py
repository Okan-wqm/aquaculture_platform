"""Plan ARIA-V9.6 — auto_merge_runners V9 implementation-phase
merge surface invariants.

Closes arb CRIT-004, HIGH-006; sec CRIT-003, HIGH-002, MED-004;
ai HIGH-007, MED-016; perf MED-012.
"""
from __future__ import annotations

import json
import subprocess
import unittest
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import auto_merge_runners as _am


class TestV9MergeDecisionDataclass(unittest.TestCase):

    def test_v9_merge_decision_frozen(self):
        d = _am.V9MergeDecision(
            eligible=True, plan_id="p", pr_number=42,
            rejection_class=None,
            idempotency_key_hash="sha256:abc",
            decision_at_utc="2026-05-18T00:00:00Z",
            pre_merge_branch_tip_sha="abc", merge_sha="def",
            check_summary=(),
        )
        with self.assertRaises((AttributeError, Exception)):
            d.eligible = False  # type: ignore[misc]


class TestV9IdempotencyKey(unittest.TestCase):

    def test_key_is_sha256(self):
        k = _am.compute_v9_idempotency_key(
            plan_id="p", diff_hash="sha256:" + "0" * 64,
            pr_number=42, base_branch="main",
            branch_tip_sha="abcdef",
        )
        self.assertTrue(k.startswith("sha256:"))
        self.assertEqual(len(k), len("sha256:") + 64)

    def test_key_changes_on_v9_merge_path_disabled_use_merge_if_green(self):
        """arb HIGH-006 — 5-tuple includes branch_tip_sha so
        force-push between mint + merge produces a DIFFERENT key."""
        k_before = _am.compute_v9_idempotency_key(
            plan_id="p", diff_hash="sha256:" + "0" * 64,
            pr_number=42, base_branch="main",
            branch_tip_sha="abc",
        )
        k_after = _am.compute_v9_idempotency_key(
            plan_id="p", diff_hash="sha256:" + "0" * 64,
            pr_number=42, base_branch="main",
            branch_tip_sha="xyz",  # rebased branch tip
        )
        self.assertNotEqual(k_before, k_after)

    def test_key_changes_on_pr_number(self):
        k1 = _am.compute_v9_idempotency_key(
            plan_id="p", diff_hash="sha256:" + "0" * 64,
            pr_number=42, base_branch="main",
            branch_tip_sha="abc",
        )
        k2 = _am.compute_v9_idempotency_key(
            plan_id="p", diff_hash="sha256:" + "0" * 64,
            pr_number=43, base_branch="main",
            branch_tip_sha="abc",
        )
        self.assertNotEqual(k1, k2)


class TestV9PollPrChecks(unittest.TestCase):
    """sec MED-004 — only SUCCESS advances; SKIPPED/NEUTRAL rejected."""

    def _make_run(self, stdout: str, returncode: int = 0):
        return mock.MagicMock(stdout=stdout, returncode=returncode, stderr="")

    def test_all_success_returns_ok(self):
        rows = [
            {"name": "build", "state": "SUCCESS", "bucket": "pass"},
            {"name": "test",  "state": "SUCCESS", "bucket": "pass"},
        ]
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=self._make_run(json.dumps(rows))):
            status, summary = _am.poll_pr_checks(
                pr_number=42, max_attempts=1, interval_seconds=0,
                sleep_fn=lambda _: None,
            )
            self.assertEqual(status, "all_success")
            self.assertEqual(len(summary), 2)

    def test_red_check_rejected(self):
        rows = [
            {"name": "build", "state": "SUCCESS", "bucket": "pass"},
            {"name": "test",  "state": "FAILURE", "bucket": "fail"},
        ]
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=self._make_run(json.dumps(rows))):
            status, _ = _am.poll_pr_checks(
                pr_number=42, max_attempts=1, interval_seconds=0,
                sleep_fn=lambda _: None,
            )
            self.assertEqual(status, "ci_check_red")

    def test_skipped_check_rejected(self):
        """sec MED-004 — SKIPPED counted as failure (not pass)."""
        rows = [
            {"name": "build",  "state": "SUCCESS", "bucket": "pass"},
            {"name": "secret", "state": "SKIPPED", "bucket": "skipping"},
        ]
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=self._make_run(json.dumps(rows))):
            status, _ = _am.poll_pr_checks(
                pr_number=42, max_attempts=1, interval_seconds=0,
                sleep_fn=lambda _: None,
            )
            self.assertEqual(status, "ci_check_skipped_or_neutral")

    def test_neutral_check_rejected(self):
        rows = [
            {"name": "build",  "state": "NEUTRAL", "bucket": "neutral"},
            {"name": "test",   "state": "SUCCESS", "bucket": "pass"},
        ]
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=self._make_run(json.dumps(rows))):
            status, _ = _am.poll_pr_checks(
                pr_number=42, max_attempts=1, interval_seconds=0,
                sleep_fn=lambda _: None,
            )
            self.assertEqual(status, "ci_check_skipped_or_neutral")

    def test_timeout_when_gh_returns_pending_forever(self):
        rows = [{"name": "build", "state": "IN_PROGRESS", "bucket": "pending"}]
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=self._make_run(json.dumps(rows))):
            status, _ = _am.poll_pr_checks(
                pr_number=42, max_attempts=3, interval_seconds=0,
                sleep_fn=lambda _: None,
            )
            self.assertEqual(status, "ci_check_timeout")

    def test_gh_cli_unavailable(self):
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value=None):
            status, _ = _am.poll_pr_checks(
                pr_number=42, max_attempts=1, interval_seconds=0,
                sleep_fn=lambda _: None,
            )
            self.assertEqual(status, "gh_cli_unavailable")


class TestV9BranchTipVerification(unittest.TestCase):
    """sec HIGH-002 + ai HIGH-007 — headRefOid drift detection."""

    def test_branch_tip_match_returns_true(self):
        payload = json.dumps({"headRefOid": "abc123def456"})
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=mock.MagicMock(stdout=payload, returncode=0)):
            self.assertTrue(_am.verify_branch_tip(
                pr_number=42, expected_branch_tip_sha="abc123def456",
            ))

    def test_v9_merge_path_disabled_use_merge_if_green_returns_false(self):
        payload = json.dumps({"headRefOid": "DIFFERENT_SHA"})
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=mock.MagicMock(stdout=payload, returncode=0)):
            self.assertFalse(_am.verify_branch_tip(
                pr_number=42, expected_branch_tip_sha="abc123def456",
            ))

    def test_gh_unavailable_fails_closed(self):
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value=None):
            self.assertFalse(_am.verify_branch_tip(
                pr_number=42, expected_branch_tip_sha="abc",
            ))

    def test_empty_expected_fails_closed(self):
        self.assertFalse(_am.verify_branch_tip(
            pr_number=42, expected_branch_tip_sha="",
        ))


class TestV9MergeOrchestration(unittest.TestCase):
    """4-gate evaluation: profile, checks, branch_tip, evaluate_auto_merge."""

    def test_strict_profile_rejected(self):
        """Legacy V9 merge surface is disabled before profile gates."""
        d = _am.evaluate_v9_implementation_merge(
            plan_id="p", pr_number=42,
            diff_hash="sha256:" + "0" * 64,
            branch_tip_sha="abc", base_branch="main",
            profile="strict",
            sleep_fn=lambda _: None,
        )
        self.assertFalse(d.eligible)
        self.assertEqual(d.rejection_class, "v9_merge_path_disabled_use_merge_if_green")

    def test_ci_red_rejected(self):
        """Legacy V9 merge surface is disabled before CI gates."""
        rows = [{"name": "test", "state": "FAILURE", "bucket": "fail"}]
        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run",
                        return_value=mock.MagicMock(stdout=json.dumps(rows), returncode=0)):
            d = _am.evaluate_v9_implementation_merge(
                plan_id="p", pr_number=42,
                diff_hash="sha256:" + "0" * 64,
                branch_tip_sha="abc", base_branch="main",
                profile="autonomous",
                sleep_fn=lambda _: None,
            )
            self.assertFalse(d.eligible)
            self.assertEqual(d.rejection_class, "v9_merge_path_disabled_use_merge_if_green")

    def test_v9_merge_path_disabled_use_merge_if_green_rejected(self):
        """Legacy V9 merge surface is disabled before branch-tip gates."""
        green_rows = [{"name": "test", "state": "SUCCESS", "bucket": "pass"}]
        drift_payload = {"headRefOid": "DIFFERENT_TIP"}

        call_count = {"n": 0}
        def _side_effect(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                # First call = poll_pr_checks
                return mock.MagicMock(stdout=json.dumps(green_rows), returncode=0)
            else:
                # Second call = verify_branch_tip
                return mock.MagicMock(stdout=json.dumps(drift_payload), returncode=0)

        with mock.patch("aria_kernel.auto_merge_runners.shutil.which", return_value="/usr/bin/gh"), \
             mock.patch("aria_kernel.auto_merge_runners.subprocess.run", side_effect=_side_effect):
            d = _am.evaluate_v9_implementation_merge(
                plan_id="p", pr_number=42,
                diff_hash="sha256:" + "0" * 64,
                branch_tip_sha="EXPECTED_TIP",
                base_branch="main",
                profile="autonomous",
                sleep_fn=lambda _: None,
            )
            self.assertFalse(d.eligible)
            self.assertEqual(d.rejection_class, "v9_merge_path_disabled_use_merge_if_green")


class TestV9PublicApi(unittest.TestCase):

    def test_v96_exports(self):
        canonical_additions = {
            "compute_v9_idempotency_key", "verify_branch_tip",
            "poll_pr_checks", "evaluate_v9_implementation_merge",
            "V9MergeDecision", "PR_CHECK_POLL_MAX_ATTEMPTS",
            "PR_CHECK_POLL_INTERVAL_SECONDS",
        }
        for name in canonical_additions:
            self.assertIn(name, _am.__all__)


if __name__ == "__main__":
    unittest.main()
