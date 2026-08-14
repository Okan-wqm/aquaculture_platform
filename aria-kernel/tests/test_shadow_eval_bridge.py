"""C4-d — the genesis SHADOW proof chain's real-mode bridge.

Deliberate-break of the whole C4 arc: C4-a minted operator approvals,
C4-b derived sandbox evidence, C4-c recorded the prefix chain up to
DRAFT — yet `_target_is_shadow` had never once flipped TRUE through a
production-shaped path, because nothing joined a completed invocation's
ledger rows to `run_agent_eval(mock_mode=False)` and the two
REAL_SANDBOX/SHADOW transitions. These tests prove the bridge closes
that gap end-to-end, and that a tampered transcript hash or a missing
operator-provenance row still refuses.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_eval import add_fixture
from aria_kernel.agent_genesis import record_draft_lifecycle_chain
from aria_kernel.agent_invocations import (
    _target_is_shadow,
    create_agent_invocation_request,
    record_transcript,
)
from aria_kernel.genesis_lifecycle import current_lifecycle_state
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.operator_provenance import record_operator_approval
from aria_kernel.runtime_profile import set_profile
from aria_kernel.shadow_eval_bridge import bridge_shadow_eval_from_invocation
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

AGENT = "aria-bridge-candidate"
FIXTURE_ID = "F900-BRIDGE"
FIXTURE_RUN_ID = "exec-bridge-0001"
INVOCATION_ID = "inv-bridge-0001"
REQUEST_ID = "AIR-bridge-0001"
OPERATOR_REF = "operator:approval:bridge-0001"


class ShadowEvalBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c4d-"))
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        # agent_evals + fixture-run surfaces are strict-profile writes.
        set_profile(
            "strict",
            operator_approval_ref="test:c4d-bridge",
            base_dir=self.tools,
            set_by="test-fixture",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- seeding ---------------------------------------------------------
    # WHY production writers wherever they exist (add_fixture,
    # record_operator_approval, record_draft_lifecycle_chain,
    # record_transcript): the bridge targets rows AS PRODUCTION MINTS
    # THEM — hand-shaped rows would let the test pass against a chain no
    # writer can produce. Only surfaces whose writers need live worker
    # machinery (request/claim/result) are seeded in the exact shape the
    # agent_invocations writers persist (row_id/row_type included).

    def _seed_chain(
        self,
        *,
        mint_operator: bool = True,
        tamper_result_hash: bool = False,
    ) -> None:
        if mint_operator:
            record_operator_approval(
                ref=OPERATOR_REF,
                expires_at=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
                target_agent=AGENT,
                base_dir=self.tools,
            )
        # C4-c prefix chain: PRESSURE → … → DRAFT.
        record_draft_lifecycle_chain(
            entity_id=AGENT,
            gap={
                "gap_id": "gap-bridge-1",
                "capability_gap_key": "svc:bridge:candidate",
                "primary_source": "coverage_gap",
                "source_types": ["coverage_gap", "shadow_summary"],
            },
            capability_resolution={"decision": "request"},
            operator_approval_ref=OPERATOR_REF,
            draft_ref="sha256:" + "e" * 64,
            base_dir=self.tools,
        )
        add_fixture(
            fixture={
                "fixture_id": FIXTURE_ID,
                "target_agent": AGENT,
                "role": "implementation",
                "pinned_commit_sha": "0" * 40,
                "input_envelope": {"task": "bridge fixture"},
                "expected_verdict_class": "PASS",
                "expected_evidence_refs": ["src/x.ts"],
                "max_rounds": 3,
                "max_tokens": 10000,
            },
            base_dir=self.tools,
        )
        append_declared_jsonl(
            self.tools / "fixture-runs.jsonl",
            {
                "schema_version": 1,
                "row_type": "fixture_run_suite",
                "tool_id": "bridge-tool",
                "execution_run_id": FIXTURE_RUN_ID,
                "passed": True,
                "actual_status": "pass",
            },
            expected_surface="agent_eval_fixture_runs",
        )
        transcript_artifact = self.tmp / "transcript.txt"
        transcript_artifact.write_text("bridge transcript body", encoding="utf-8")
        self.transcript_hash = (
            "sha256:" + hashlib.sha256(transcript_artifact.read_bytes()).hexdigest()
        )
        envelope_path = self.tmp / "response-envelope.json"
        envelope_path.write_text(
            json.dumps(
                {
                    "$schema": "aria/agent-response/v1",
                    "schema_version": 1,
                    "verdict_class": "PASS",
                    "evidence_refs": ["src/x.ts"],
                    "rounds_used": 1,
                    "tokens_used": 512,
                }
            ),
            encoding="utf-8",
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "requests.jsonl",
            {
                "schema_version": 1,
                "row_id": REQUEST_ID,
                "row_type": "request",
                "request_id": REQUEST_ID,
                "target_agent": AGENT,
            },
            expected_surface="agent_invocation_requests",
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "contexts.jsonl",
            {
                "schema_version": 1,
                "row_id": f"context:{REQUEST_ID}",
                "row_type": "context",
                "request_id": REQUEST_ID,
            },
            expected_surface="agent_invocation_contexts",
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "prompts.jsonl",
            {
                "schema_version": 1,
                "row_id": f"prompt:{REQUEST_ID}",
                "row_type": "prompt",
                "request_id": REQUEST_ID,
            },
            expected_surface="agent_invocation_prompts",
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "claims.jsonl",
            {
                "schema_version": 1,
                "row_id": INVOCATION_ID,
                "row_type": "claim",
                "event": "claimed",
                "claim_id": INVOCATION_ID,
                "request_id": REQUEST_ID,
            },
            expected_surface="agent_invocation_claims",
        )
        # The tamper case breaks the result↔transcript hash join — the
        # exact lie _validate_real_eval_provenance exists to catch.
        result_hash = (
            "sha256:" + "f" * 64 if tamper_result_hash else self.transcript_hash
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "results.jsonl",
            {
                "schema_version": 1,
                "row_id": f"result:{INVOCATION_ID}",
                "row_type": "result",
                "claim_id": INVOCATION_ID,
                "invocation_id": INVOCATION_ID,
                "request_id": REQUEST_ID,
                "status": "accepted",
                "transcript_hash": result_hash,
                "output_path": envelope_path.resolve().as_posix(),
            },
            expected_surface="agent_invocation_results",
        )
        record_transcript(
            invocation_id=INVOCATION_ID,
            transcript_hash=self.transcript_hash,
            target_agent=AGENT,
            request_id=REQUEST_ID,
            claim_id=INVOCATION_ID,
            fixture_run_id=FIXTURE_ID,
            artifact_ref=transcript_artifact.resolve().as_posix(),
            base_dir=self.tools,
        )

    def _bridge(self) -> dict:
        return bridge_shadow_eval_from_invocation(
            invocation_id=INVOCATION_ID,
            fixture_id=FIXTURE_ID,
            fixture_run_id=FIXTURE_RUN_ID,
            operator_approval_ref=OPERATOR_REF,
            base_dir=self.tools,
            repo_root=None,
        )

    # -- the deliberate-break of the whole C4 arc ------------------------

    def test_bridge_flips_target_to_shadow_first_time(self) -> None:
        self._seed_chain()
        self.assertFalse(_target_is_shadow(self.tools, AGENT))
        self.assertEqual(
            current_lifecycle_state(entity_id=AGENT, base_dir=self.tools), "DRAFT"
        )

        out = self._bridge()

        # The first production-shaped SHADOW in the arc's history.
        self.assertTrue(_target_is_shadow(self.tools, AGENT))
        self.assertEqual(
            current_lifecycle_state(entity_id=AGENT, base_dir=self.tools), "SHADOW"
        )
        self.assertEqual(
            [row["to_state"] for row in out["transitions"]],
            ["REAL_SANDBOX", "SHADOW"],
        )
        self.assertEqual(out["transitions"][0]["from_state"], "DRAFT")
        self.assertEqual(out["eval_run"]["passed"], True)
        self.assertEqual(out["eval_run"]["provenance_mode"], "real_invocation")
        self.assertEqual(out["eval_harness_id"], out["eval_run"]["run_id"])
        # record_transition injected the kernel-resolved proof — the
        # full 8-ref chain resolved by verify_shadow_eval_proof.
        resolved = out["transitions"][1]["evidence"]["resolved_shadow_eval_proof"]
        self.assertEqual(resolved["transcript_hash"], self.transcript_hash)
        self.assertTrue(str(resolved["transcript_ledger_hash"]).startswith("sha256:"))
        self.assertTrue(str(resolved["eval_run_ledger_hash"]).startswith("sha256:"))
        # Production consequence: a SHADOW target now refuses normal
        # invocations — the same gate the SHADOW state exists to arm.
        with self.assertRaisesRegex(GovernanceError, "shadow_agent_invocation_blocked"):
            create_agent_invocation_request(
                target_agent=AGENT,
                role="primary_plan",
                suggested_prompt="Run a normal invocation.",
                must_satisfy=[{"id": "m1", "predicate": "pass"}],
                allowed_scope=["libs/example/**"],
                base_dir=self.tools,
            )

    # -- refusals --------------------------------------------------------

    def test_tampered_transcript_hash_refuses(self) -> None:
        self._seed_chain(tamper_result_hash=True)
        with self.assertRaisesRegex(GovernanceError, "real_eval_provenance_unbound"):
            self._bridge()
        # No partial promotion: the lifecycle never left DRAFT.
        self.assertEqual(
            current_lifecycle_state(entity_id=AGENT, base_dir=self.tools), "DRAFT"
        )
        self.assertFalse(_target_is_shadow(self.tools, AGENT))

    def test_non_passing_fixture_run_refuses_before_any_eval_write(self) -> None:
        self._seed_chain()
        append_declared_jsonl(
            self.tools / "fixture-runs.jsonl",
            {
                "schema_version": 1,
                "row_type": "fixture_run_suite",
                "tool_id": "bridge-tool",
                "execution_run_id": "exec-bridge-failing",
                "passed": False,
                "actual_status": "fail",
            },
            expected_surface="agent_eval_fixture_runs",
        )
        with self.assertRaisesRegex(
            GovernanceError, "shadow_bridge_fixture_run_not_passing"
        ):
            bridge_shadow_eval_from_invocation(
                invocation_id=INVOCATION_ID,
                fixture_id=FIXTURE_ID,
                fixture_run_id="exec-bridge-failing",
                operator_approval_ref=OPERATOR_REF,
                base_dir=self.tools,
            )
        # Refusal ORDER matters: the eval ledger must not carry a run
        # minted for a broken suite (all bridge checks precede writes).
        self.assertFalse((self.tools / "agent-evals" / "runs.jsonl").exists())

    def test_failing_eval_run_never_promotes(self) -> None:
        self._seed_chain()
        # The agent's real envelope contradicts the fixture expectation.
        (self.tmp / "response-envelope.json").write_text(
            json.dumps(
                {
                    "$schema": "aria/agent-response/v1",
                    "schema_version": 1,
                    "verdict_class": "FAIL",
                    "evidence_refs": [],
                    "rounds_used": 1,
                    "tokens_used": 512,
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(GovernanceError, "shadow_bridge_eval_run_failed"):
            self._bridge()
        # The failed eval row stays on the ledger as the honest record,
        # but the lifecycle never advances.
        self.assertTrue((self.tools / "agent-evals" / "runs.jsonl").exists())
        self.assertEqual(
            current_lifecycle_state(entity_id=AGENT, base_dir=self.tools), "DRAFT"
        )
        self.assertFalse(_target_is_shadow(self.tools, AGENT))

    def test_missing_operator_provenance_row_refuses(self) -> None:
        self._seed_chain(mint_operator=False)
        with self.assertRaisesRegex(
            GovernanceError, "shadow_bridge_operator_approval_not_found"
        ):
            self._bridge()
        self.assertEqual(
            current_lifecycle_state(entity_id=AGENT, base_dir=self.tools), "DRAFT"
        )
        self.assertFalse(_target_is_shadow(self.tools, AGENT))


if __name__ == "__main__":
    unittest.main()
