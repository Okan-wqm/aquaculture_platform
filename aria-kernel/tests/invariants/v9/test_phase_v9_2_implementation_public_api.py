"""Plan ARIA-V9.2 — implementation-phase public-API invariants.

Pins the 5 event-writer functions on plan_convergence: their existence,
state-precondition validation, payload-shape validation, idempotency.

Closes:
  * arb CRIT-002/003 — surfaces the state-machine extension
    through callable APIs (not just event-type whitelist)
  * arb HIGH-007 — IMPLEMENTATION_MERGED transition concretized
  * arb HIGH-012 — Closes: trailer format already accepted by
    commit-msg validator (both docs/reviews/...md and
    aria-findings/F-NNN.json); no kernel change needed here
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence as _pc
from aria_kernel.tool_registry import GovernanceError


class TestV9PublicApiExists(unittest.TestCase):
    """I-V9-IMPL-02 — kernel exposes the 5 implementation event
    writers."""

    def test_request_implementation_callable(self):
        self.assertTrue(callable(_pc.request_implementation))

    def test_record_implementation_started_callable(self):
        self.assertTrue(callable(_pc.record_implementation_started))

    def test_record_implementation_outcome_callable(self):
        self.assertTrue(callable(_pc.record_implementation_outcome))

    def test_record_implementation_merged_callable(self):
        self.assertTrue(callable(_pc.record_implementation_merged))

    def test_record_implementation_rejected_callable(self):
        self.assertTrue(callable(_pc.record_implementation_rejected))


def _start_and_converge(workspace: str, plan_id: str = "v92-test-plan") -> dict:
    """Helper: drive a plan to CONVERGED state via direct event writes
    so we can test the V9.2 transitions without re-implementing the
    P+C+CR pipeline."""
    import os
    os.environ.setdefault("ARIA_TOOLS_DIR", workspace)
    base = workspace
    plan_content = {
        "schema_version": 1,
        "title": "V9.2 test plan",
        "summary": "test plan for V9.2 implementation public API",
        "affected_surfaces": ["test.py"],
        "key_changes": [{"file": "test.py", "description": "test change"}],
        "validation_commands": [{
            "cmd": "echo ok",
            "expected_exit": 0,
            "timeout_ms": 5000,
        }],
        "evidence_refs": ["test.py:1"],
    }
    _pc.start_plan(
        plan_id=plan_id,
        plan_content=plan_content,
        initial_revision_id="rev-001",
        base_dir=base,
    )
    # Directly drive state to CONVERGED via manual event append
    # (avoids the full P+C+CR machinery for unit-test focus).
    root = Path(base)
    from aria_kernel.tool_registry import ensure_tools_dir
    tools_dir = ensure_tools_dir(base)
    _pc._append_event(
        root=tools_dir,
        plan_id=plan_id,
        event_type="plan_evaluated",
        payload={
            "round_number": 1,
            "terminal_state": "CONVERGED",
            "risks_rollup_summary": {},
            "gate_decisions": [],
            "reason_codes": ["converged_clean"],
        },
        idempotency_key=_pc._idempotency_key(plan_id, "evaluate", {"round_number": 1}),
    )
    return _pc.fold_plan_state(plan_id=plan_id, base_dir=base)


class TestV9StatePreconditions(unittest.TestCase):
    """State preconditions enforced by the validators in _mutate
    BEFORE the event lands on disk (defense-in-depth complement to
    the reducer-side V9.0-B check)."""

    def test_request_implementation_rejects_draft_state(self):
        with tempfile.TemporaryDirectory() as workspace:
            plan_id = "test-draft-reject"
            plan_content = {
                "schema_version": 1,
                "title": "draft-state reject test",
                "summary": "verifies request_implementation rejects non-CONVERGED states",
                "affected_surfaces": ["x.py"],
                "key_changes": [{"file": "x.py", "description": "test"}],
                "validation_commands": [{"cmd": "true", "expected_exit": 0, "timeout_ms": 1000}],
                "evidence_refs": ["x.py:1"],
            }
            _pc.start_plan(
                plan_id=plan_id,
                plan_content=plan_content,
                initial_revision_id="r1",
                base_dir=workspace,
            )
            # State is DRAFT (not CONVERGED) → must reject
            with self.assertRaises(GovernanceError) as ctx:
                _pc.request_implementation(
                    plan_id=plan_id,
                    implementer_agent="aria-implementer",
                    converged_plan_revision_id="r1",
                    converged_plan_content_hash="sha256:" + "0" * 64,
                    base_dir=workspace,
                )
            self.assertIn("DRAFT", str(ctx.exception))

    def test_request_implementation_accepts_converged_state(self):
        with tempfile.TemporaryDirectory() as workspace:
            plan_id = "test-converged-accept"
            _start_and_converge(workspace, plan_id=plan_id)
            result = _pc.request_implementation(
                plan_id=plan_id,
                implementer_agent="aria-implementer",
                converged_plan_revision_id="rev-001",
                converged_plan_content_hash="sha256:" + "a" * 64,
                base_dir=workspace,
            )
            self.assertTrue(result["event_appended"])
            self.assertEqual(result["event"]["event_type"], "implementation_requested")
            # Confirm state transition
            state = _pc.fold_plan_state(plan_id=plan_id, base_dir=workspace)
            self.assertEqual(state["state"], "IMPLEMENTATION_REQUESTED")

    def test_full_chain_to_merged(self):
        """End-to-end: CONVERGED → REQUESTED → IN_FLIGHT → RECORDED
        → MERGED. Pins the 4-event linear chain."""
        with tempfile.TemporaryDirectory() as workspace:
            plan_id = "test-full-chain"
            _start_and_converge(workspace, plan_id=plan_id)

            _pc.request_implementation(
                plan_id=plan_id,
                implementer_agent="aria-implementer",
                converged_plan_revision_id="rev-001",
                converged_plan_content_hash="sha256:" + "a" * 64,
                base_dir=workspace,
            )
            _pc.record_implementation_started(
                plan_id=plan_id,
                claim_id="claim-001",
                implementer_agent="aria-implementer",
                started_at="2026-05-18T16:00:00Z",
                base_dir=workspace,
            )
            _pc.record_implementation_outcome(
                plan_id=plan_id,
                claim_id="claim-001",
                pr_url="https://github.com/test/pull/42",
                diff_hash="sha256:" + "b" * 64,
                branch_tip_sha="abcdef0123456789",
                base_branch_sha="0123456789abcdef",
                validation_results=[
                    {"command": "nx affected --target=test", "exit_code": 0},
                ],
                signer_key_fp="SHA256:test/abc",
                completed_at="2026-05-18T16:05:00Z",
                base_dir=workspace,
            )
            _pc.record_implementation_merged(
                plan_id=plan_id,
                merge_sha="merge0123456789",
                merged_at="2026-05-18T16:10:00Z",
                idempotency_key_hash="sha256:" + "c" * 64,
                base_dir=workspace,
            )
            state = _pc.fold_plan_state(plan_id=plan_id, base_dir=workspace)
            self.assertEqual(state["state"], "IMPLEMENTATION_MERGED")
            self.assertEqual(state["terminal_state"], "IMPLEMENTATION_MERGED")
            self.assertEqual(state["implementation"]["pr_url"], "https://github.com/test/pull/42")

    def test_full_chain_to_rejected(self):
        """End-to-end: CONVERGED → REQUESTED → IN_FLIGHT → REJECTED."""
        with tempfile.TemporaryDirectory() as workspace:
            plan_id = "test-rejected-chain"
            _start_and_converge(workspace, plan_id=plan_id)

            _pc.request_implementation(
                plan_id=plan_id,
                implementer_agent="aria-implementer",
                converged_plan_revision_id="rev-001",
                converged_plan_content_hash="sha256:" + "a" * 64,
                base_dir=workspace,
            )
            _pc.record_implementation_started(
                plan_id=plan_id,
                claim_id="claim-002",
                implementer_agent="aria-implementer",
                started_at="2026-05-18T16:00:00Z",
                base_dir=workspace,
            )
            _pc.record_implementation_rejected(
                plan_id=plan_id,
                rejection_class="validation_failed",
                rejected_at="2026-05-18T16:05:00Z",
                base_dir=workspace,
            )
            state = _pc.fold_plan_state(plan_id=plan_id, base_dir=workspace)
            self.assertEqual(state["state"], "IMPLEMENTATION_REJECTED")
            self.assertEqual(state["implementation"]["rejection_class"], "validation_failed")
            self.assertEqual(state["implementation"]["rejected_from_state"], "IMPLEMENTATION_IN_FLIGHT")


class TestV9PayloadValidation(unittest.TestCase):

    def test_request_implementation_validates_empty_agent(self):
        with tempfile.TemporaryDirectory() as workspace:
            with self.assertRaises(GovernanceError):
                _pc.request_implementation(
                    plan_id="x",
                    implementer_agent="",
                    converged_plan_revision_id="r1",
                    converged_plan_content_hash="sha256:" + "0" * 64,
                    base_dir=workspace,
                )

    def test_record_implementation_outcome_requires_diff_hash(self):
        with tempfile.TemporaryDirectory() as workspace:
            plan_id = "outcome-validates"
            _start_and_converge(workspace, plan_id=plan_id)
            _pc.request_implementation(
                plan_id=plan_id, implementer_agent="aria-implementer",
                converged_plan_revision_id="rev-001",
                converged_plan_content_hash="sha256:" + "a" * 64,
                base_dir=workspace,
            )
            _pc.record_implementation_started(
                plan_id=plan_id, claim_id="c1", implementer_agent="aria-implementer",
                started_at="t", base_dir=workspace,
            )
            with self.assertRaises(GovernanceError):
                _pc.record_implementation_outcome(
                    plan_id=plan_id, claim_id="c1",
                    pr_url="https://x", diff_hash="not-a-hash",  # WRONG
                    branch_tip_sha="x", base_branch_sha="y",
                    validation_results=[],
                    signer_key_fp="SHA256:x",
                    completed_at="t",
                    base_dir=workspace,
                )


class TestV9Idempotency(unittest.TestCase):

    def test_request_implementation_idempotent(self):
        with tempfile.TemporaryDirectory() as workspace:
            plan_id = "idem-test"
            _start_and_converge(workspace, plan_id=plan_id)
            r1 = _pc.request_implementation(
                plan_id=plan_id, implementer_agent="aria-implementer",
                converged_plan_revision_id="rev-001",
                converged_plan_content_hash="sha256:" + "a" * 64,
                base_dir=workspace,
            )
            r2 = _pc.request_implementation(
                plan_id=plan_id, implementer_agent="aria-implementer",
                converged_plan_revision_id="rev-001",
                converged_plan_content_hash="sha256:" + "a" * 64,
                base_dir=workspace,
            )
            self.assertTrue(r1["event_appended"])
            self.assertFalse(r2["event_appended"])
            self.assertTrue(r2["idempotent"])


if __name__ == "__main__":
    unittest.main()
