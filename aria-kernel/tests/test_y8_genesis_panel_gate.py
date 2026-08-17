"""Y8 (ORPHAN-709) — the genesis ladder is gated by the agent panel.

Sixteen capability gaps sat parked on per-gap operator approval while
skill_genesis reported no_requests: the ladder hardcoded a HUMAN_REQUIRED
step only a signed operator ref could satisfy, and the policy key that
claimed to govern it was read by nobody. Operator directive 2026-08-17:
genesis proceeds on panel approval; the operator keeps kernel-scope writes,
promotion proofs, ground truth, and the synthetic override.

Deliberate-breakage pins:
- REQUEST accepts EXACTLY one proof: panel adjudication_ref (resolved
  kernel-side against the record — forged refs cannot validate) or the
  operator's signed ref;
- parked gaps become idempotent, capped genesis_candidate escalations;
- a panel resolve quorum yields the genesis request + draft; a refuse
  quorum closes the question without minting;
- approve_agent_pr's panel path demands a RESOLVED adjudication and the
  synthetic override stays operator-only.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_genesis import sweep_candidate_gaps_for_adjudication
from aria_kernel.capability_gap import GENESIS_ADJUDICATION_BLOCK_TOKEN
from aria_kernel.genesis_lifecycle import validate_transition
from aria_kernel.genesis_policy import genesis_lifecycle_policy, genesis_panel_policy
from aria_kernel.human_required import (
    RESOLVED_BY_AGENT_PANEL,
    record_human_required,
    resolve_human_required,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class HookOrderParityPin(unittest.TestCase):
    def test_every_registered_learning_hook_is_selectable(self) -> None:
        """A hook in the registry but absent from LEARNING_HOOK_ORDER is
        structurally dead (_run_learning_hooks selects by order membership).
        genesis_panel_sweep shipped exactly that way and left zero trace on
        its first night — this pin derives parity from the SOURCE so the
        class cannot recur."""
        import inspect
        import re

        from aria_kernel import learning

        src = inspect.getsource(learning._run_learning_hooks)
        registered = set(re.findall(r'\(\s*"([a-z0-9_]+)",\s*lambda', src))
        self.assertTrue(registered, "registry parse failed")
        missing = registered - set(learning.LEARNING_HOOK_ORDER)
        self.assertEqual(missing, set(), f"registered but never selectable: {missing}")


class PolicyPins(unittest.TestCase):
    def test_panel_is_the_default_approval_mode(self) -> None:
        self.assertEqual(genesis_lifecycle_policy().get("request_approval_mode"), "panel")

    def test_genesis_panel_block_is_real_configuration(self) -> None:
        block = genesis_panel_policy()
        self.assertTrue(block["enabled"])
        self.assertEqual(block["max_panel_opens_per_cycle"], 4)


class RequestGateTests(unittest.TestCase):
    def test_panel_mode_requires_adjudication_ref(self) -> None:
        verdict = validate_transition(
            from_state="HUMAN_REQUIRED", to_state="REQUEST",
            evidence={"approval_mode": "panel"},
        )
        self.assertIn("request_requires_panel_adjudication_ref", verdict.reasons)

    def test_operator_mode_keeps_the_signed_ref_requirement(self) -> None:
        verdict = validate_transition(
            from_state="HUMAN_REQUIRED", to_state="REQUEST", evidence={},
        )
        self.assertIn("request_requires_signed_operator_feedback", verdict.reasons)

    def test_each_mode_passes_with_its_own_proof(self) -> None:
        panel = validate_transition(
            from_state="HUMAN_REQUIRED", to_state="REQUEST",
            evidence={"approval_mode": "panel", "adjudication_ref": "genesis:abc"},
        )
        operator = validate_transition(
            from_state="HUMAN_REQUIRED", to_state="REQUEST",
            evidence={"operator_feedback_ref": "op-ref-1"},
        )
        self.assertTrue(panel.valid, panel.reasons)
        self.assertTrue(operator.valid, operator.reasons)


class _GapStoreCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-y8-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _seed_gap_batch(self, gaps: list[dict]) -> None:
        append_declared_jsonl(
            self.tools / "capability-gaps" / "gaps.jsonl",
            {"schema_version": 1, "cycle_id": "cyc-test", "gap_count": len(gaps), "gaps": gaps},
            expected_surface="capability_gaps",
        )

    @staticmethod
    def _gap(n: int, *, blocked: bool = True) -> dict:
        return {
            "gap_id": f"gap-{n}",
            "capability_gap_key": f"shadow_run:tool-{n}",
            "title": f"Triage tool-{n}",
            "evidence_refs": [f"apps/svc/src/f{n}.ts"],
            "blocked_by": [GENESIS_ADJUDICATION_BLOCK_TOKEN] if blocked else [],
            "primary_source": "shadow-run",
            "source_types": ["shadow-run"],
        }

    def _governance_kinds(self) -> list[str]:
        gov = self.tools / "governance.jsonl"
        if not gov.exists():
            return []
        return [json.loads(l)["kind"] for l in gov.read_text(encoding="utf-8").splitlines() if l.strip()]


class BacklogSweepTests(_GapStoreCase):
    def test_parked_gaps_become_capped_idempotent_escalations(self) -> None:
        self._seed_gap_batch([self._gap(n) for n in range(6)] + [self._gap(9, blocked=False)])
        first = sweep_candidate_gaps_for_adjudication(base_dir=self.tools)
        self.assertEqual(len(first["opened"]), 4)  # policy cap
        second = sweep_candidate_gaps_for_adjudication(base_dir=self.tools)
        reasons = {s.get("reason") for s in second["skipped"]}
        self.assertIn("already_escalated", reasons)
        # The two beyond the cap get their turn once the first four moved.
        self.assertEqual(len(second["opened"]), 2)

    def test_escalations_are_panel_adjudicable(self) -> None:
        self._seed_gap_batch([self._gap(1)])
        opened = sweep_candidate_gaps_for_adjudication(base_dir=self.tools)["opened"]
        record_path = self.tools / "human-required" / f"{opened[0]['escalation_id']}.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        self.assertEqual(record["context"]["kind"], "genesis_candidate")
        self.assertTrue(hra.escalation_adjudicability(record).adjudicable)

    def test_identityless_genesis_record_is_not_adjudicable(self) -> None:
        verdict = hra.escalation_adjudicability(
            {"context": {"kind": "genesis_candidate", "capability_gap_key": "k"}},
        )
        self.assertFalse(verdict.adjudicable)


class PanelApprovalChainTests(_GapStoreCase):
    def _escalate_one_gap(self) -> str:
        # Five recorded batches → valid_cycles=5: the CANDIDATE maturity
        # gate (5 cycles OR 2 source types) is REAL and stays load-bearing
        # under panel approval — an immature gap's execution fails loudly
        # and the record re-opens for a later cycle.
        for _ in range(5):
            self._seed_gap_batch([self._gap(1)])
        opened = sweep_candidate_gaps_for_adjudication(base_dir=self.tools)["opened"]
        return str(opened[0]["escalation_id"])

    def _panel_resolve(self, escalation_id: str, verdict_value: str) -> None:
        record = json.loads(
            (self.tools / "human-required" / f"{escalation_id}.json").read_text(encoding="utf-8"),
        )
        row = hra.open_adjudication(
            escalation_request_id=escalation_id,
            record=record,
            base_dir=self.tools,
        )
        invocations = self.tools / "agent-invocations"
        for rid, agent in zip(row["request_ids"], ("judge-a", "judge-b", "judge-c")):
            output = invocations / f"{rid}.opinion.json"
            output.write_text(
                json.dumps({"verdict": verdict_value, "rationale": f"{agent}"}),
                encoding="utf-8",
            )
            append_declared_jsonl(
                invocations / "claims.jsonl",
                {"request_id": rid, "claim_id": f"claim-{rid}", "agent_id": agent},
                expected_surface="agent_invocation_claims",
            )
            append_declared_jsonl(
                invocations / "results.jsonl",
                {"request_id": rid, "role": hra.ADJUDICATION_ROLE, "status": "accepted",
                 "agent_id": agent, "output_path": output.as_posix(),
                 "output_hash": "sha256:" + "0" * 64},
                expected_surface="agent_invocation_results",
            )

    def test_resolve_quorum_yields_request_and_draft_with_panel_proof(self) -> None:
        escalation_id = self._escalate_one_gap()
        self._panel_resolve(escalation_id, hra.RESOLVE_VERDICT)
        verdict = hra.adjudicate_human_required(
            escalation_request_id=escalation_id, base_dir=self.tools,
        )
        self.assertTrue(verdict.clears_escalation)
        self.assertNotIn("genesis_panel_execution_failed", self._governance_kinds())
        from aria_kernel.agent_genesis import load_jsonl

        drafts = load_jsonl(self.tools / "agent-genesis" / "drafts.jsonl")
        self.assertGreaterEqual(len(drafts), 1)
        from aria_kernel.ledger import load_declared_jsonl

        events = load_declared_jsonl(
            self.tools / "genesis-lifecycle" / "events.jsonl",
            expected_surface="genesis_lifecycle_events",
        )
        request_rows = [e for e in events if e.get("to_state") == "REQUEST"]
        self.assertEqual(len(request_rows), 1)
        evidence = request_rows[0]["evidence"]
        self.assertEqual(evidence["approval_mode"], "panel")
        self.assertEqual(evidence["adjudication_ref"], escalation_id)
        self.assertEqual(
            evidence["resolved_panel_adjudication"]["adjudication_ref"], escalation_id,
        )

    def test_refuse_quorum_closes_without_minting(self) -> None:
        escalation_id = self._escalate_one_gap()
        self._panel_resolve(escalation_id, hra.REFUSE_VERDICT)
        hra.adjudicate_human_required(
            escalation_request_id=escalation_id, base_dir=self.tools,
        )
        record = json.loads(
            (self.tools / "human-required" / f"{escalation_id}.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(record["status"], "resolved")
        self.assertIn("genesis_candidate_refused", self._governance_kinds())
        self.assertFalse((self.tools / "agent-genesis" / "drafts.jsonl").exists())

    def test_forged_adjudication_ref_cannot_validate(self) -> None:
        from aria_kernel.genesis_lifecycle import _resolve_panel_adjudication_proof

        with self.assertRaises(GovernanceError):
            _resolve_panel_adjudication_proof(
                adjudication_ref="genesis:forged", capability_gap_key="k",
                base_dir=self.tools,
            )
        # An OPEN (unresolved) record must also refuse.
        record_human_required(
            request_id="genesis:open1", severity="MEDIUM", reason="pending",
            context={"kind": "genesis_candidate", "capability_gap_key": "k"},
            base_dir=self.tools,
        )
        with self.assertRaises(GovernanceError):
            _resolve_panel_adjudication_proof(
                adjudication_ref="genesis:open1", capability_gap_key="k",
                base_dir=self.tools,
            )


class ApproveAgentPrTests(_GapStoreCase):
    def test_both_or_neither_refs_refuse(self) -> None:
        from aria_kernel.agent_genesis import approve_agent_pr

        with self.assertRaises(GovernanceError):
            approve_agent_pr(draft_id="d-1", base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            approve_agent_pr(
                draft_id="d-1", operator_approval_ref="op-1",
                adjudication_ref="genesis:x", base_dir=self.tools,
            )

    def test_synthetic_override_stays_operator_only(self) -> None:
        from aria_kernel.agent_genesis import approve_agent_pr

        with self.assertRaises(GovernanceError) as ctx:
            approve_agent_pr(
                draft_id="d-1", adjudication_ref="genesis:x",
                operator_synthetic_override=True, base_dir=self.tools,
            )
        self.assertIn("synthetic_override_is_operator_only", str(ctx.exception))

    def test_panel_ref_must_resolve_to_a_resolved_record(self) -> None:
        from aria_kernel.agent_genesis import approve_agent_pr

        with self.assertRaises(GovernanceError) as ctx:
            approve_agent_pr(
                draft_id="d-1", adjudication_ref="genesis:absent", base_dir=self.tools,
            )
        self.assertIn("genesis_panel_adjudication_not_found", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
