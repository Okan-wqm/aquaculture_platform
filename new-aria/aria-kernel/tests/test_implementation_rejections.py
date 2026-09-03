"""Lock test for the implementation_rejections SSoT (DRY rejection taxonomy).

WHY: implementation_rejections.py is the single source of truth that de-dups the
rejection-class taxonomy previously copied into plan_convergence (the validator)
and auto_merge_runners (the V9 emitter). These tests are the make-it-detectable
gate (CLAUDE.md tier-3) that keeps the SSoT and both consumers from drifting and
keeps the V9 merge-path-disabled class OUTSIDE the validation set.
"""

import unittest

from aria_kernel.implementation_rejections import (
    V9_MERGE_PATH_DISABLED_REJECTION_CLASS,
    VALID_IMPLEMENTATION_REJECTION_CLASSES,
)


class ImplementationRejectionsSsotTests(unittest.TestCase):
    EXPECTED_CLASSES = frozenset(
        {
            "no_claim_timeout",
            "in_flight_abandoned",
            "ci_check_timeout",
            "ci_check_red",
            "merge_policy_violation",
            "branch_tip_drift",
            "content_hash_mismatch",
            "secret_leak_detected",
            "kernel_self_modification_attempted",
            "bash_command_denylist_hit",
            "path_escape_outside_workspace",
            "file_lock_conflict",
            "validation_failed",
            "forbidden_scope_violation",
            "plan_evidence_stale",
            "branch_collision",
            "prompt_injection_detected",
            "dependency_pinning_unsafe",
            "implementer_turn_budget_exhausted",
            "cycle_budget_exhausted",
            "gh_api_scope_violation",
            "autonomous_profile_preconditions_not_met",
            "orchestrator_restart_reaped_orphan",
            "commit_signature_unverified",
        }
    )

    def test_validation_set_membership_is_the_expected_24(self) -> None:
        self.assertEqual(
            VALID_IMPLEMENTATION_REJECTION_CLASSES, self.EXPECTED_CLASSES
        )
        self.assertEqual(len(VALID_IMPLEMENTATION_REJECTION_CLASSES), 24)

    def test_validation_set_is_frozen(self) -> None:
        self.assertIsInstance(VALID_IMPLEMENTATION_REJECTION_CLASSES, frozenset)

    def test_v9_constant_value(self) -> None:
        self.assertEqual(
            V9_MERGE_PATH_DISABLED_REJECTION_CLASS,
            "v9_merge_path_disabled_use_merge_if_green",
        )

    def test_v9_class_is_not_in_the_validation_set(self) -> None:
        # The V9 merge-path-disabled class is stamped only on a V9MergeDecision
        # by the auto-merge runner; it must NEVER be accepted by
        # record_implementation_outcome's validation set.
        self.assertNotIn(
            V9_MERGE_PATH_DISABLED_REJECTION_CLASS,
            VALID_IMPLEMENTATION_REJECTION_CLASSES,
        )

    def test_plan_convergence_validator_uses_the_ssot_object(self) -> None:
        # Drift guard: the validator must reference the SSoT object identity,
        # not a re-inlined copy.
        from aria_kernel import plan_convergence

        self.assertIs(
            plan_convergence.VALID_IMPLEMENTATION_REJECTION_CLASSES,
            VALID_IMPLEMENTATION_REJECTION_CLASSES,
        )

    def test_auto_merge_runner_uses_the_ssot_constant(self) -> None:
        # Drift guard: the V9 emitter must reference the SSoT constant.
        from aria_kernel import auto_merge_runners

        self.assertIs(
            auto_merge_runners.V9_MERGE_PATH_DISABLED_REJECTION_CLASS,
            V9_MERGE_PATH_DISABLED_REJECTION_CLASS,
        )


if __name__ == "__main__":
    unittest.main()
