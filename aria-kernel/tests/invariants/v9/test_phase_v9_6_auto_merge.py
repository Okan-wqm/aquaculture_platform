"""Plan ARIA-V9.6 — auto_merge_runners V9 implementation-phase
merge surface invariants.

Closes arb CRIT-004, HIGH-006; sec CRIT-003, HIGH-002, MED-004;
ai HIGH-007, MED-016; perf MED-012.
"""
from __future__ import annotations

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


class TestV9MergeOrchestration(unittest.TestCase):
    """ARIA-MEDIUM-467 — the V9 surface refuses every merge and never reaches ``gh``.

    The global ``subprocess.run`` is patched so ANY process the surface
    started — CI polling, a branch-tip recheck, a merge — would be seen.
    """

    def test_every_merge_is_refused_without_touching_github(self):
        with mock.patch("subprocess.run") as run:
            d = _am.evaluate_v9_implementation_merge(
                plan_id="p", pr_number=42,
                diff_hash="sha256:" + "0" * 64,
                branch_tip_sha="EXPECTED_TIP", base_branch="main",
            )
        run.assert_not_called()
        self.assertFalse(d.eligible)
        self.assertEqual(d.rejection_class, "v9_merge_path_disabled_use_merge_if_green")
        self.assertIsNone(d.merge_sha)
        self.assertEqual(
            d.idempotency_key_hash,
            _am.compute_v9_idempotency_key(
                plan_id="p", diff_hash="sha256:" + "0" * 64, pr_number=42,
                base_branch="main", branch_tip_sha="EXPECTED_TIP",
            ),
        )

    def test_the_signature_carries_only_the_key_fields(self):
        # ARIA-MEDIUM-467 — no dead profile/adapter/policy/gh/sleep parameters kept
        # "so callers keep compiling": nothing in production calls this.
        import inspect

        self.assertEqual(
            sorted(inspect.signature(_am.evaluate_v9_implementation_merge).parameters),
            ["base_branch", "branch_tip_sha", "diff_hash", "plan_id", "pr_number"],
        )


class TestV9PublicApi(unittest.TestCase):

    def test_v96_exports(self):
        canonical_additions = {
            "compute_v9_idempotency_key",
            "evaluate_v9_implementation_merge",
            "V9MergeDecision",
        }
        for name in canonical_additions:
            self.assertIn(name, _am.__all__)
        # ARIA-MEDIUM-467 — the poller the V9.6 banner described had no production
        # caller; the surface it would feed refuses every merge.
        for retired in ("poll_pr_checks", "PR_CHECK_POLL_MAX_ATTEMPTS", "PR_CHECK_POLL_INTERVAL_SECONDS"):
            self.assertFalse(hasattr(_am, retired), retired)
            self.assertNotIn(retired, _am.__all__)


if __name__ == "__main__":
    unittest.main()
