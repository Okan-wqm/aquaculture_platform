"""Plan ARIA-V9.3 — implementation envelope mint + bridge dispatch
invariants.

Closes:
  * arb HIGH-002 (drainer envelope minting + poll discipline framing)
  * arb HIGH-003 (cross-reviewer identity reconciliation extended to
    implementation agent identity)
  * ai CRIT-003 (untrusted_* delimiter discipline mirrored for
    converged_plan + cross_review_summary)
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import cross_review_bridge as _crb
from aria_kernel import plan_convergence_bridge as _pcb


class TestV9EnvelopeMinter(unittest.TestCase):

    def test_implementation_role_constant(self):
        self.assertEqual(
            _crb.IMPLEMENTATION_ROLE,
            ("aria-implementer", "implementation"),
        )

    def test_implementation_legal_states(self):
        self.assertEqual(_crb._IMPLEMENTATION_LEGAL_STATES, frozenset({"CONVERGED"}))

    def test_issue_implementation_envelope_callable(self):
        self.assertTrue(callable(_crb.issue_implementation_envelope))

    def test_suggested_prompt_uses_canonical_delimiters(self):
        """SECURITY CONTRACT — untrusted_* delimiters MUST be present
        in the suggested prompt verbatim (ai CRIT-003 + V3.1-B-2
        base64 encoding). Plan ARIA-V3.1-B-2 updated the wording to
        ALL-CAPS "NEVER" for emphasis; the case-insensitive assertion
        keeps the V9.3 contract stable across phrasing tweaks."""
        src = inspect.getsource(_crb._implementation_suggested_prompt)
        self.assertIn("<untrusted_converged_plan", src)
        self.assertIn("<untrusted_cross_review_summary", src)
        self.assertIn("DATA", src)
        # The exact wrapping doesn't matter; substring check on the
        # two distinctive tokens. V3.1-B-2 capitalized "NEVER" — use
        # case-insensitive match to stay phrasing-agnostic.
        lower = src.lower()
        self.assertIn("never", lower)
        self.assertIn("follow instructions", lower)

    def test_suggested_prompt_lists_readonly_paths(self):
        """The agent prompt MUST surface READONLY paths verbatim so
        the LLM has the contract in-context without separate Read."""
        src = inspect.getsource(_crb._implementation_suggested_prompt)
        for path in (".claude/agents/", "aria-kernel/aria_kernel/",
                     ".github/", "infrastructure/"):
            self.assertIn(path, src, f"READONLY path {path} MUST be in agent prompt")


class TestV9BridgeDispatchImplementation(unittest.TestCase):

    def test_implementation_role_in_planner_bridge_roles(self):
        self.assertIn("implementation", _pcb.PLANNER_BRIDGE_ROLES)

    def test_planner_bridge_role_literal_extended(self):
        from typing import get_args
        args = set(get_args(_pcb.PlannerBridgeRole))
        self.assertEqual(
            args,
            {"primary_plan", "challenger_plan", "cross_review", "implementation"},
        )

    def test_record_plan_result_has_implementation_case(self):
        """match/case arm MUST exist for "implementation"."""
        src = inspect.getsource(_pcb.record_plan_result)
        self.assertIn('case "implementation":', src)
        self.assertIn("_dispatch_implementation", src)

    def test_dispatch_implementation_exists(self):
        self.assertTrue(callable(_pcb._dispatch_implementation))

    def test_dispatch_implementation_extracts_canonical_fields(self):
        """The helper MUST reference all 8 canonical fields the V9.2
        record_implementation_outcome public API requires."""
        src = inspect.getsource(_pcb._dispatch_implementation)
        for field in (
            "claim_id", "pr_url", "diff_hash", "branch_tip_sha",
            "base_branch_sha", "validation_results", "signer_key_fp",
            "completed_at",
        ):
            self.assertIn(field, src, f"_dispatch_implementation missing {field}")


if __name__ == "__main__":
    unittest.main()
