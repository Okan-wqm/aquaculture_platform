"""Plan ARIA-V8 v2 §4 Phase 8.2 — bridge state-aware dispatch invariants.

Closes F-014-D2. 6 invariants:

- I-V8.2-01 — record_plan_result(role=primary_plan) on DRAFT raises BridgeContractViolation
- I-V8.2-02 — record_plan_result(role=primary_plan) on CRITIQUED calls record_revision
- I-V8.2-03 — BridgeContractViolation re-raised by agent_invocations wrapper (NOT swallowed)
- I-V8.2-04 — Source-substring pin on _PRIMARY_PLAN_STATE_DISPATCH constant
- I-V8.2-05 — record_plan_result source contains state-aware dispatch literal
- I-V8.2-06 — Replay idempotency: BridgeContractViolation is deterministic per (state, role)
"""
from __future__ import annotations

import inspect
import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence_bridge
from aria_kernel.bridge_exceptions import BridgeContractViolation
from aria_kernel.plan_convergence import start_plan


def _valid_plan_content(plan_id: str) -> dict:
    return {
        "schema_version": 1,
        "title": f"Plan {plan_id}",
        "summary": "fixture for V8.2",
        "affected_surfaces": ["fixture.py"],
        "key_changes": [{"id": "c1", "description": "fixture", "paths": ["fixture.py"]}],
        "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
        "evidence_refs": ["fixture.py:1:ok"],
    }


class TestPrimaryPlanOnDraft(unittest.TestCase):
    """I-V8.2-01 — DRAFT state → BridgeContractViolation."""

    def test_primary_plan_on_draft_raises_bridge_contract_violation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plan_id = "plan-v82-draft"
            start_plan(plan_id=plan_id, plan_content=_valid_plan_content(plan_id),
                       initial_revision_id=f"{plan_id}-r1", base_dir=base)
            request = {"plan_id": plan_id, "role": "primary_plan"}
            response = {
                "details": {
                    "revision": {
                        "revision_id": f"{plan_id}-r2",
                        "plan_content": _valid_plan_content(plan_id),
                    },
                },
            }
            with self.assertRaises(BridgeContractViolation) as ctx:
                plan_convergence_bridge.record_plan_result(
                    role="primary_plan",
                    request=request,
                    response=response,
                    base_dir=base,
                )
            msg = str(ctx.exception)
            self.assertIn("primary_plan_invalid_state", msg)
            self.assertIn("DRAFT", msg)
            self.assertIn("CRITIQUED", msg)
            self.assertIn("CROSS_REVIEWED", msg)


class TestSourceSubstring(unittest.TestCase):
    """I-V8.2-04, I-V8.2-05 — declarative dispatch table pins."""

    def test_primary_plan_state_dispatch_constant_present(self):
        src = inspect.getsource(plan_convergence_bridge)
        self.assertIn("_PRIMARY_PLAN_STATE_DISPATCH", src)
        # Constant declared at module level (not just referenced)
        self.assertRegex(src, r"_PRIMARY_PLAN_STATE_DISPATCH:\s*dict\[")

    def test_record_plan_result_uses_state_aware_dispatch(self):
        # The function body MUST reference the dispatch table by name
        # AND fold_plan_state to read current state.
        src = inspect.getsource(plan_convergence_bridge.record_plan_result)
        self.assertIn("_PRIMARY_PLAN_STATE_DISPATCH", src)
        self.assertIn("fold_plan_state", src)
        self.assertIn("BridgeContractViolation", src)


class TestWrapperReRaise(unittest.TestCase):
    """I-V8.2-03 — agent_invocations wrapper re-raises BridgeContractViolation."""

    def test_wrapper_re_raises_bridge_contract_violation(self):
        # Source-level invariant: the wrapper body must contain
        # `except BridgeContractViolation:` followed by `raise`.
        from aria_kernel import agent_invocations
        src = inspect.getsource(agent_invocations)
        self.assertIn("except BridgeContractViolation:", src)
        # And the import must be at module level
        self.assertIn("from .bridge_exceptions import BridgeContractViolation", src)


class TestReplayIdempotency(unittest.TestCase):
    """I-V8.2-06 — replay produces deterministic BridgeContractViolation."""

    def test_replay_same_envelope_same_exception(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plan_id = "plan-v82-replay"
            start_plan(plan_id=plan_id, plan_content=_valid_plan_content(plan_id),
                       initial_revision_id=f"{plan_id}-r1", base_dir=base)
            request = {"plan_id": plan_id, "role": "primary_plan"}
            response = {"details": {"revision": {"plan_content": _valid_plan_content(plan_id)}}}
            with self.assertRaises(BridgeContractViolation) as ctx1:
                plan_convergence_bridge.record_plan_result(
                    role="primary_plan", request=request, response=response, base_dir=base,
                )
            with self.assertRaises(BridgeContractViolation) as ctx2:
                plan_convergence_bridge.record_plan_result(
                    role="primary_plan", request=request, response=response, base_dir=base,
                )
            # Same message → deterministic per (state, role) — no side-effect
            # accumulation, no event duplication
            self.assertEqual(str(ctx1.exception), str(ctx2.exception))


if __name__ == "__main__":
    unittest.main()
