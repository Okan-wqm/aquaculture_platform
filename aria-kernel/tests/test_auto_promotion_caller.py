"""C7/E8 — the V6.4 auto-promote token gets its first caller.

The token had a producer (compute_auto_promote_token), a consumer predicate
in transition_tool (I-V6.4-04), a policy block, and four invariant tests —
and ZERO production callers: the entire autonomous-promotion lane was dead
wire. These pin the wiring: promote_tool without an operator ref tries the
token path (one gate, two authorities), attempt_auto_promotions sweeps
SHADOW adapters, and the policy default (enabled=False) keeps every attempt
an honest recorded no-op until the operator flips it.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.promotion import attempt_auto_promotions, promote_tool
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class PromoteToolTokenPathTests(unittest.TestCase):
    def test_no_ref_and_default_policy_is_refused_with_reason(self) -> None:
        """Default policy: enabled=False → the token path refuses loudly,
        naming BOTH the missing operator ref and the ineligibility."""
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with patch("aria_kernel.promotion.get_tool",
                       return_value={"tool_id": "adapter-x", "status": "SHADOW", "kind": "adapter"}), \
                 patch("aria_kernel.promotion.latest_fixture_status",
                       return_value={"current_tool_passed": True}):
                with self.assertRaisesRegex(
                    GovernanceError,
                    "operator approval ref .*auto-promote ineligible.*auto_promote_disabled_by_policy",
                ):
                    promote_tool(
                        "adapter-x", "ACTIVE", reason="test", base_dir=root
                    )

    def test_eligible_token_reaches_transition(self) -> None:
        """When the policy gates pass, the token flows into transition_tool
        as the autonomous authority (operator_approval stays False)."""
        captured: dict = {}

        def fake_transition(tool_id, target, **kwargs):
            captured.update(kwargs, tool_id=tool_id, target=target)
            return {"tool_id": tool_id, "status": target}

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with patch("aria_kernel.promotion.get_tool",
                       return_value={"tool_id": "adapter-x", "status": "SHADOW", "kind": "adapter"}), \
                 patch("aria_kernel.promotion.latest_fixture_status",
                       return_value={"current_tool_passed": True}), \
                 patch("aria_kernel.adapter_calibration.compute_auto_promote_token",
                       return_value="deadbeef" * 8), \
                 patch("aria_kernel.promotion.adapter_active_readiness",
                       return_value={
                           "active_ready": True, "zero_finding_lane": False,
                           "precision": 0.97, "critical_false_positives": 0,
                           "blocked_by": [],
                       }), \
                 patch("aria_kernel.promotion.transition_tool", fake_transition):
                result = promote_tool(
                    "adapter-x", "ACTIVE", reason="auto", base_dir=root
                )
        self.assertEqual(result["status"], "ACTIVE")
        self.assertEqual(captured["auto_promote_token"], "deadbeef" * 8)
        self.assertFalse(captured["operator_approval"])
        self.assertEqual(captured["precision"], 0.97)

    def test_operator_ref_path_never_computes_a_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with patch("aria_kernel.promotion.get_tool",
                       return_value={"tool_id": "adapter-x", "status": "SHADOW", "kind": "adapter"}), \
                 patch("aria_kernel.promotion.latest_fixture_status",
                       return_value={"current_tool_passed": True}), \
                 patch("aria_kernel.adapter_calibration.compute_auto_promote_token",
                       side_effect=AssertionError("token path must not fire")), \
                 patch("aria_kernel.promotion.adapter_active_readiness",
                       return_value={
                           "active_ready": True, "zero_finding_lane": True,
                           "precision": None, "critical_false_positives": 0,
                           "blocked_by": [],
                       }), \
                 patch("aria_kernel.promotion.transition_tool",
                       return_value={"tool_id": "adapter-x", "status": "ACTIVE"}):
                promote_tool(
                    "adapter-x", "ACTIVE", reason="op",
                    operator_approval_ref="APPROVAL-1", base_dir=root,
                )


class AttemptAutoPromotionsTests(unittest.TestCase):
    def test_default_policy_records_honest_ineligibility(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with patch("aria_kernel.tool_registry.list_tools", return_value=[
                {"tool_id": "adapter-a", "kind": "adapter", "status": "SHADOW"},
                {"tool_id": "adapter-b", "kind": "adapter", "status": "ACTIVE"},
                {"tool_id": "agent-c", "kind": "agent", "status": "SHADOW"},
            ]), patch("aria_kernel.promotion.get_tool",
                      return_value={"tool_id": "adapter-a", "status": "SHADOW", "kind": "adapter"}), \
                 patch("aria_kernel.promotion.latest_fixture_status",
                       return_value={"current_tool_passed": True}):
                result = attempt_auto_promotions(cycle_id="cyc-c7", base_dir=root)
        # Only the SHADOW adapter was attempted; default policy refuses it.
        self.assertEqual(result["promoted"], [])
        self.assertEqual(result["ineligible_count"], 1)
        self.assertEqual(result["ineligible"][0]["tool_id"], "adapter-a")
        self.assertIn("auto_promote_disabled_by_policy", result["ineligible"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
