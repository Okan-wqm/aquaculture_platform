from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.autonomy_unlock import (
    assert_autonomy_unlocked,
    evaluate_autonomy_unlock,
    record_acceptance_event,
)
from aria_kernel.capability_resolver import require_capability_resolution, resolve_capability
from aria_kernel.policy_approval import record_policy_approval, verify_policy_approval
from aria_kernel.risk_policy import classify_change, risk_policy_hash
from aria_kernel.rollback_bundle import (
    record_rollback_bundle,
    record_rollback_simulation,
    verify_rollback_bundle,
)
from aria_kernel.runner_attestation import record_runner_attestation, verify_runner_attestation
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


HEAD_SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64


class EnterprisePolicyOwnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-enterprise-policy-")
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_risk_policy_classifies_from_policy_hash(self) -> None:
        l1 = classify_change(["docs/aria/SPEC.md"])
        self.assertTrue(l1.valid)
        self.assertEqual(l1.lane, "L1")
        self.assertEqual(l1.policy_hash, risk_policy_hash())

        l2 = classify_change(["apps/farm-service/src/app.module.ts"])
        self.assertTrue(l2.valid)
        self.assertEqual(l2.lane, "L2")

        l3 = classify_change([".github/workflows/aria-merge-authority.yml"])
        self.assertTrue(l3.valid)
        self.assertEqual(l3.lane, "L3")

        blocked = classify_change(["apps/billing-service/src/pricing.ts"])
        self.assertFalse(blocked.valid)
        self.assertEqual(blocked.lane, "blocked")

    def test_autonomy_unlock_thresholds_and_critical_violation(self) -> None:
        blocked = evaluate_autonomy_unlock(lane="L1", base_dir=self.tools)
        self.assertFalse(blocked.valid)
        self.assertTrue(any("observe_successes" in reason for reason in blocked.reasons))

        for index in range(30):
            record_acceptance_event(
                event_type="observe_success",
                pr_number=1,
                head_sha=f"{index:040x}"[-40:],
                base_dir=self.tools,
            )
        self.assertTrue(assert_autonomy_unlocked(lane="L1", base_dir=self.tools).valid)

        record_acceptance_event(
            event_type="critical_violation",
            pr_number=1,
            head_sha=HEAD_SHA,
            reason="fixture critical regression",
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "critical_violation"):
            assert_autonomy_unlocked(lane="L1", base_dir=self.tools)

    def test_policy_approval_requires_two_distinct_actors(self) -> None:
        common = {
            "approval_id": "approval-1",
            "pr_number": 42,
            "head_sha": HEAD_SHA,
            "policy_hash": risk_policy_hash(),
            "expires_at": "2999-06-21T00:00:00Z",
        }
        record_policy_approval({**common, "stage": "risk_owner", "actor": "alice"}, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "missing_required_stages"):
            verify_policy_approval(
                pr_number=42,
                head_sha=HEAD_SHA,
                policy_hash=risk_policy_hash(),
                base_dir=self.tools,
            )
        record_policy_approval({**common, "stage": "exception_owner", "actor": "alice"}, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "separation_of_duties"):
            verify_policy_approval(
                pr_number=42,
                head_sha=HEAD_SHA,
                policy_hash=risk_policy_hash(),
                base_dir=self.tools,
            )
        record_policy_approval({**common, "approval_id": "approval-2", "stage": "exception_owner", "actor": "bob"}, base_dir=self.tools)
        self.assertTrue(
            verify_policy_approval(
                pr_number=42,
                head_sha=HEAD_SHA,
                policy_hash=risk_policy_hash(),
                base_dir=self.tools,
            )["valid"]
        )

    def test_runner_and_rollback_proofs_are_ledger_bound(self) -> None:
        common = {
            "repo": "example/aqua",
            "pr_number": 42,
            "target_ref": "main",
            "head_ref": "feature/docs",
            "head_sha": HEAD_SHA,
            "readiness_claim_id": "ready-42",
        }
        with self.assertRaisesRegex(GovernanceError, "runner_attestation_required"):
            verify_runner_attestation(
                pr_number=42,
                head_sha=HEAD_SHA,
                readiness_claim_id="ready-42",
                base_dir=self.tools,
            )
        record_runner_attestation(
            {
                **common,
                "runner_id": "runner-1",
                "runner_group": "aria-private",
                "ephemeral_runner": True,
                "approved_runner_group": True,
                "sandbox_available": True,
                "claude_auth": "managed_claude_code_cli",
                "api_key_auth": False,
                # ARIA-AUDIT-016: identity claims carry platform evidence.
                "platform_verified": True,
            },
            base_dir=self.tools,
        )
        self.assertTrue(
            verify_runner_attestation(
                pr_number=42,
                head_sha=HEAD_SHA,
                readiness_claim_id="ready-42",
                base_dir=self.tools,
            )["valid"]
        )

        record_rollback_bundle(
            {**common, "rollback_bundle_id": "bundle-1", "rollback_plan_sha256": DIGEST},
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "rollback_simulation_required"):
            verify_rollback_bundle(
                pr_number=42,
                head_sha=HEAD_SHA,
                readiness_claim_id="ready-42",
                base_dir=self.tools,
            )
        record_rollback_simulation(
            {
                **common,
                "rollback_bundle_id": "bundle-1",
                "rollback_simulation_id": "simulation-1",
                "status": "passed",
            },
            base_dir=self.tools,
        )
        self.assertTrue(
            verify_rollback_bundle(
                pr_number=42,
                head_sha=HEAD_SHA,
                readiness_claim_id="ready-42",
                base_dir=self.tools,
            )["valid"]
        )

    def test_capability_resolution_required_before_genesis(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "capability_resolution_required"):
            require_capability_resolution(
                capability_key="farm:missing",
                requested_kind="skill",
                base_dir=self.tools,
            )
        row = resolve_capability(
            capability_key="farm:missing",
            requested_kind="skill",
            title="Farm Missing Skill",
            base_dir=self.tools,
        )
        self.assertEqual(row["decision"], "request")
        self.assertEqual(
            require_capability_resolution(
                capability_key="farm:missing",
                requested_kind="skill",
                base_dir=self.tools,
            )["ledger_hash"],
            row["ledger_hash"],
        )


if __name__ == "__main__":
    unittest.main()
