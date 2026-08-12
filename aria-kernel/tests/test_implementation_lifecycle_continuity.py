"""E2 — the implementation state machine gets a real entry (F1) and plans
survive their cycle (F9).

Pre-fix world, proven by audit + adversarial verification: the three
implementation transitions had ZERO production callers — the envelope
issuer's own error message promised "exactly one escape from CONVERGED"
and never wrote it; every implementer result was refused against an
unreachable IN_FLIGHT precondition; the implementer poll accepted only
MERGED/REJECTED so even success timed out; and plan identity was minted
from the cycle id so each night's answered envelopes landed on a plan
nobody watched.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.implementation_reconciler import (
    _pr_number_from_url,
    reconcile_recorded_implementations,
)
from aria_kernel.plan_convergence import (
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
    request_implementation,
    resume_candidate_plan_id,
    start_plan,
)


def _plan_content(title: str = "E2 plan") -> dict:
    return {
        "schema_version": 1,
        "title": title,
        "summary": "E2 continuity test plan.",
        "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
        "key_changes": ["change"],
        "validation_commands": [{"cmd": "true"}],
        "evidence_refs": ["docs/aria/SPEC.md"],
    }


class ImplementationChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        self.root = Path(self.tmp.name) / "workspace"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        (agents / "farm-expert.md").write_text(
            "---\nname: farm-expert\ndescription: Farm reviewer.\n---\n\nBody.\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _converged_plan(self, plan_id: str = "plan-e2") -> None:
        start_plan(
            plan_id=plan_id,
            initial_revision_id="rev-0",
            plan_content=_plan_content(),
            base_dir=self.tools,
        )
        # Drive to CONVERGED via the direct evaluator path used by the
        # existing suite (zero-risk round one converges).
        from aria_kernel.plan_convergence import evaluate_plan, record_critique, request_critics

        request_critics(
            plan_id=plan_id,
            request={
                "round_number": 1,
                "target_revision_id": "rev-0",
                "target_plan_content_hash": fold_plan_state(plan_id=plan_id, base_dir=self.tools)["latest_revision"]["content_hash"],
                "tasks": [{
                    "task_id": "t-1",
                    "task_packet_hash": "sha256:" + "a" * 64,
                    "target_agent": "farm-expert",
                    "target_revision_id": "rev-0",
                    "target_plan_content_hash": fold_plan_state(plan_id=plan_id, base_dir=self.tools)["latest_revision"]["content_hash"],
                    "sla_deadline": "2099-01-01T00:00:00+00:00",
                    "status_after": "PENDING",
                }],
            },
            base_dir=self.tools,
        )
        record_critique(
            plan_id=plan_id,
            critique={
                "task_packet_hash": "sha256:" + "a" * 64,
                "target_revision_id": "rev-0",
                "target_plan_content_hash": fold_plan_state(plan_id=plan_id, base_dir=self.tools)["latest_revision"]["content_hash"],
                "reviewer": "farm-expert",
                "risks": [],
                "critique_content_hash": "sha256:" + "b" * 64,
                "status_after": "ANSWERED",
            },
            workspace_root=self.root,
            base_dir=self.tools,
        )
        evaluate_plan(plan_id=plan_id, round_number=1, base_dir=self.tools)
        self.assertEqual(
            fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"], "CONVERGED"
        )

    def _to_recorded(self, plan_id: str = "plan-e2") -> None:
        self._converged_plan(plan_id)
        content_hash = fold_plan_state(plan_id=plan_id, base_dir=self.tools)["latest_revision"]["content_hash"]
        request_implementation(
            plan_id=plan_id,
            implementer_agent="aria-implementer",
            converged_plan_revision_id="rev-0",
            converged_plan_content_hash=content_hash,
            base_dir=self.tools,
        )
        record_implementation_started(
            plan_id=plan_id,
            claim_id="claim-1",
            implementer_agent="aria-implementer",
            started_at="2026-08-12T10:00:00Z",
            base_dir=self.tools,
        )
        record_implementation_outcome(
            plan_id=plan_id,
            claim_id="claim-1",
            pr_url="https://github.com/o/r/pull/4242",
            diff_hash="sha256:" + "c" * 64,
            branch_tip_sha="d" * 40,
            base_branch_sha="e" * 40,
            validation_results=[],
            signer_key_fp="fp-1",
            completed_at="2026-08-12T10:30:00Z",
            base_dir=self.tools,
        )
        self.assertEqual(
            fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"],
            "IMPLEMENTATION_RECORDED",
        )

    def test_full_chain_reaches_recorded(self) -> None:
        # The chain the arc audit proved unreachable: CONVERGED →
        # REQUESTED → IN_FLIGHT → RECORDED, with the real transition fns.
        self._to_recorded()

    def test_reconciler_folds_merged_pr_to_terminal(self) -> None:
        self._to_recorded()

        class _Reader:
            def readable(self):
                return (True, "ok")

            def pr_merge_state(self, pr_number: int):
                assert pr_number == 4242
                return {
                    "state": "MERGED",
                    "mergedAt": "2026-08-12T11:00:00Z",
                    "mergeCommit": {"oid": "f" * 40},
                }

        result = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual([m["plan_id"] for m in result["merged"]], ["plan-e2"])
        self.assertEqual(
            fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
            "IMPLEMENTATION_MERGED",
        )
        # Idempotent: a second pass finds a terminal plan and does nothing.
        again = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual(again["merged"], [])

    def test_reconciler_leaves_unmerged_pr_alone(self) -> None:
        self._to_recorded()

        class _Reader:
            def readable(self):
                return (True, "ok")

            def pr_merge_state(self, pr_number: int):
                return {"state": "OPEN", "mergedAt": None, "mergeCommit": None}

        result = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual(result["merged"], [])
        self.assertEqual(
            fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
            "IMPLEMENTATION_RECORDED",
        )

    def test_pr_number_extraction(self) -> None:
        self.assertEqual(_pr_number_from_url("https://github.com/o/r/pull/17"), 17)
        self.assertIsNone(_pr_number_from_url("not-a-url"))


class PlanContinuityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_mid_flight_plan_is_adopted(self) -> None:
        start_plan(
            plan_id="plan-last-night",
            initial_revision_id="rev-0",
            plan_content=_plan_content("last night"),
            base_dir=self.tools,
        )
        self.assertEqual(
            resume_candidate_plan_id(base_dir=self.tools), "plan-last-night"
        )

    def test_no_mid_flight_plan_means_fresh_start(self) -> None:
        self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))


if __name__ == "__main__":
    unittest.main()
