"""Plan 026R §E.2 — approve_agent_pr synthetic-sandbox reject.

3 tests:

* sandbox.decision="pass" + synthetic_test_mode=False → approve.
* sandbox.decision="pass" + synthetic_test_mode=True (no override) → raise.
* sandbox.decision="pass" + synthetic_test_mode=True + operator_synthetic_override=True
  → approve (operator audit trail).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.agent_genesis import approve_agent_pr
from aria_kernel.tool_registry import GovernanceError


class ApproveAgentPrSyntheticTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-e2-"))
        self.base = self.tmp / "aria-tools"
        from aria_kernel.runtime_profile import set_profile
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _draft(self) -> dict:
        return {
            "draft_id": "drf-e2",
            "name": "aria-test-agent",
            "target_path": ".claude/agents/aria-test-agent.md",
            "content": "# test agent",
        }

    def _sandbox(self, *, decision: str, synthetic: bool) -> dict:
        return {
            "draft_id": "drf-e2",
            "decision": decision,
            "synthetic_test_mode": synthetic,
            "ledger_hash": "sha256:sandbox",
        }

    def test_non_synthetic_sandbox_approves(self) -> None:
        with patch(
            "aria_kernel.agent_genesis._find_draft",
            return_value=self._draft(),
        ), patch(
            "aria_kernel.agent_genesis._latest_sandbox",
            return_value=self._sandbox(decision="pass", synthetic=False),
        ):
            row = approve_agent_pr(
                draft_id="drf-e2",
                operator_approval_ref="op-1",
                base_dir=self.base,
            )
        self.assertEqual(row["status"], "approved_for_agent_pr")

    def test_synthetic_sandbox_rejects_without_override(self) -> None:
        with patch(
            "aria_kernel.agent_genesis._find_draft",
            return_value=self._draft(),
        ), patch(
            "aria_kernel.agent_genesis._latest_sandbox",
            return_value=self._sandbox(decision="pass", synthetic=True),
        ):
            with self.assertRaises(GovernanceError) as ctx:
                approve_agent_pr(
                    draft_id="drf-e2",
                    operator_approval_ref="op-1",
                    base_dir=self.base,
                )
            self.assertIn(
                "synthetic_sandbox_cannot_approve_agent_pr",
                str(ctx.exception),
            )

    def test_synthetic_sandbox_with_operator_override_approves(self) -> None:
        with patch(
            "aria_kernel.agent_genesis._find_draft",
            return_value=self._draft(),
        ), patch(
            "aria_kernel.agent_genesis._latest_sandbox",
            return_value=self._sandbox(decision="pass", synthetic=True),
        ):
            row = approve_agent_pr(
                draft_id="drf-e2",
                operator_approval_ref="op-1",
                base_dir=self.base,
                operator_synthetic_override=True,
            )
        self.assertEqual(row["status"], "approved_for_agent_pr")


if __name__ == "__main__":
    unittest.main()
