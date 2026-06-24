"""Plan 026R §E.6 — materialize_agent_draft sandbox + synthetic gate.

5 tests:

* No sandbox row at all → raise.
* Sandbox decision="fail" → raise.
* Sandbox decision="pass" + synthetic_test_mode=True (no override) → raise.
* Sandbox decision="pass" + synthetic_test_mode=True + override → succeed.
* Sandbox decision="pass" + synthetic_test_mode=False + acknowledge=True
  → succeed.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.agent_genesis import materialize_agent_draft
from aria_kernel.tool_registry import GovernanceError


class MaterializeAgentDraftGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-e6-"))
        self.base = self.tmp / "aria-tools"
        from aria_kernel.runtime_profile import set_profile
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        # Plan ARIA-V3 §A4 + §A5 — gate.acquire_or_consume calls
        # ack_ledger which needs an HMAC key. Initialise here so
        # the test materialise path can auto-mint + consume.
        from aria_kernel.ack_ledger import init_ack_ledger
        init_ack_ledger(
            base_dir=self.base,
            reason="materialize gate test ledger init",
            operator_approval_ref="RFC-MAT-TEST",
        )
        self.worktree = self.tmp / "worktree"
        self.worktree.mkdir()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _draft(self) -> dict:
        # Plan ARIA-V3 §A3 — kernel no longer produces markdown; the
        # ``body`` field is populated by the drafter (worker_executor
        # spawning ``claude code agent --subagent-type aria-drafter``).
        # This test isolates materialize so we synthesise the body
        # directly. Without an ``intent`` field the grammar validator
        # at materialize is skipped (intent-less drafts pre-date the
        # V3 grammar gate; production flow always has intent).
        return {
            "draft_id": "drf-e6",
            "target_path": ".claude/agents/aria-test-agent.md",
            "body": "# test agent body",
        }

    def _dispatch(self) -> dict:
        return {
            "assignment_id": "as-e6",
            "worktree_path": str(self.worktree),
        }

    def _materialize(self, sandbox_state, **kwargs):
        from aria_kernel.ack_ledger import mint_operator_ack
        from aria_kernel.auto_action_gate import gate_from_test_fixture

        # Plan ARIA-V3 §A4 + §2l — pre-V3 ``acknowledge=True`` is
        # gone; construct a Gate and consume an explicit operator ack.
        ack = mint_operator_ack(
            base_dir=self.base,
            draft_id="drf-e6",
            intent_id="intent-e6",
            target_path=".claude/agents/aria-test-agent.md",
            kind="agent",
            operator_user_id="test-operator",
            reason="materialize gate test ack",
            profile_name="autonomous",
            profile_state_at_mint="autonomous:v1",
            commit_sha_at_mint="test-head",
        )
        gate = gate_from_test_fixture(
            profile="autonomous",
            lane="L0-main",
            classifier_passed=True,
            policy_requires_acknowledge=False,
        )
        with patch(
            "aria_kernel.agent_genesis._find_draft",
            return_value=self._draft(),
        ), patch(
            "aria_kernel.agent_genesis._latest_sandbox",
            return_value=sandbox_state,
        ), patch(
            "aria_kernel.agent_genesis._find_dispatch",
            return_value=self._dispatch(),
        ):
            return materialize_agent_draft(
                draft_id="drf-e6",
                assignment_id="as-e6",
                workspace_root=self.tmp,
                gate=gate,
                base_dir=self.base,
                ack_id=ack.ack_id,
                **kwargs,
            )

    def test_no_sandbox_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._materialize(None)
        self.assertIn("materialize_requires_passing_sandbox", str(ctx.exception))

    def test_failing_sandbox_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._materialize({"decision": "fail", "synthetic_test_mode": False})
        self.assertIn("materialize_requires_passing_sandbox", str(ctx.exception))

    def test_synthetic_sandbox_without_override_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._materialize({"decision": "pass", "synthetic_test_mode": True})
        self.assertIn("synthetic_sandbox_cannot_materialize", str(ctx.exception))

    def test_synthetic_sandbox_with_override_succeeds(self) -> None:
        row = self._materialize(
            {"decision": "pass", "synthetic_test_mode": True},
            operator_synthetic_override=True,
        )
        self.assertEqual(row["status"], "accepted")

    def test_passing_non_synthetic_sandbox_succeeds(self) -> None:
        row = self._materialize(
            {"decision": "pass", "synthetic_test_mode": False},
        )
        self.assertEqual(row["status"], "accepted")


if __name__ == "__main__":
    unittest.main()
