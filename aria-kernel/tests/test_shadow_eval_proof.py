from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.ledger_refs import ledger_ref_for_row
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class ShadowEvalProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-shadow-eval-")
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.transcript_hash = "sha256:" + "a" * 64
        self.refs = self._seed_provenance_chain()
        append_declared_jsonl(
            self.tools / "genesis-lifecycle" / "events.jsonl",
            {
                "schema_version": 1,
                "entity_id": "aria-shadow-candidate",
                "entity_kind": "agent",
                "to_state": "SHADOW",
            },
            expected_surface="genesis_lifecycle_events",
        )
        append_declared_jsonl(
            self.tools / "fixture-runs.jsonl",
            {
                "schema_version": 1,
                "execution_run_id": "fixture-run-1",
                "passed": True,
                "actual_status": "pass",
            },
            expected_surface="agent_eval_fixture_runs",
        )
        append_declared_jsonl(
            self.tools / "agent-evals" / "runs.jsonl",
            {
                "schema_version": 1,
                "run_id": "eval-run-1",
                "eval_harness_id": "harness-shadow-1",
                "fixture_run_id": "fixture-run-1",
                "fixture_id": "fixture-run-1",
                "invocation_id": "inv-shadow-1",
                "target_agent": "aria-shadow-candidate",
                "passed": True,
                **self.refs,
            },
            expected_surface="agent_evals",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed_provenance_chain(self) -> dict:
        fixture = append_declared_jsonl(
            self.tools / "agent-evals" / "fixtures.jsonl",
            {
                "schema_version": 1,
                "row_id": "fixture-run-1",
                "row_type": "fixture",
                "fixture_id": "fixture-run-1",
                "target_agent": "aria-shadow-candidate",
            },
            expected_surface="agent_eval_fixtures",
        )
        request = append_declared_jsonl(
            self.tools / "agent-invocations" / "requests.jsonl",
            {
                "schema_version": 1,
                "row_id": "AIR-shadow-1",
                "row_type": "request",
                "request_id": "AIR-shadow-1",
                "target_agent": "aria-shadow-candidate",
            },
            expected_surface="agent_invocation_requests",
        )
        context = append_declared_jsonl(
            self.tools / "agent-invocations" / "contexts.jsonl",
            {
                "schema_version": 1,
                "row_id": "context-shadow-1",
                "row_type": "context",
                "request_id": "AIR-shadow-1",
            },
            expected_surface="agent_invocation_contexts",
        )
        prompt = append_declared_jsonl(
            self.tools / "agent-invocations" / "prompts.jsonl",
            {
                "schema_version": 1,
                "row_id": "prompt-shadow-1",
                "row_type": "prompt",
                "request_id": "AIR-shadow-1",
            },
            expected_surface="agent_invocation_prompts",
        )
        claim = append_declared_jsonl(
            self.tools / "agent-invocations" / "claims.jsonl",
            {
                "schema_version": 1,
                "row_id": "inv-shadow-1",
                "row_type": "claim",
                "event": "claimed",
                "claim_id": "inv-shadow-1",
                "invocation_id": "inv-shadow-1",
                "request_id": "AIR-shadow-1",
            },
            expected_surface="agent_invocation_claims",
        )
        result = append_declared_jsonl(
            self.tools / "agent-invocations" / "results.jsonl",
            {
                "schema_version": 1,
                "row_id": "result-shadow-1",
                "row_type": "result",
                "claim_id": "inv-shadow-1",
                "invocation_id": "inv-shadow-1",
                "request_id": "AIR-shadow-1",
                "status": "accepted",
                "transcript_hash": self.transcript_hash,
            },
            expected_surface="agent_invocation_results",
        )
        transcript = append_declared_jsonl(
            self.tools / "agent-invocations" / "transcripts.jsonl",
            {
                "schema_version": 1,
                "row_id": "transcript-shadow-1",
                "row_type": "transcript",
                "invocation_id": "inv-shadow-1",
                "claim_id": "inv-shadow-1",
                "request_id": "AIR-shadow-1",
                "target_agent": "aria-shadow-candidate",
                "transcript_hash": self.transcript_hash,
                "fixture_run_id": "fixture-run-1",
                "artifact_ref": {"sha256": self.transcript_hash},
            },
            expected_surface="agent_invocation_transcripts",
        )
        operator = append_declared_jsonl(
            self.tools / "operator-provenance" / "events.jsonl",
            {
                "schema_version": 1,
                "row_id": "operator-shadow-1",
                "row_type": "operator_approval",
                "operator_provenance_ref": "operator:approval:1",
                "operator": "test-operator",
                "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            },
            expected_surface="operator_provenance",
        )
        return {
            "request_ledger_ref": ledger_ref_for_row(
                surface="agent_invocation_requests",
                ledger_path="agent-invocations/requests.jsonl",
                row_id="AIR-shadow-1",
                row_type="request",
                row=request,
            ),
            "claim_ledger_ref": ledger_ref_for_row(
                surface="agent_invocation_claims",
                ledger_path="agent-invocations/claims.jsonl",
                row_id="inv-shadow-1",
                row_type="claim",
                row=claim,
            ),
            "context_ledger_ref": ledger_ref_for_row(
                surface="agent_invocation_contexts",
                ledger_path="agent-invocations/contexts.jsonl",
                row_id="context-shadow-1",
                row_type="context",
                row=context,
            ),
            "prompt_ledger_ref": ledger_ref_for_row(
                surface="agent_invocation_prompts",
                ledger_path="agent-invocations/prompts.jsonl",
                row_id="prompt-shadow-1",
                row_type="prompt",
                row=prompt,
            ),
            "result_ledger_ref": ledger_ref_for_row(
                surface="agent_invocation_results",
                ledger_path="agent-invocations/results.jsonl",
                row_id="result-shadow-1",
                row_type="result",
                row=result,
            ),
            "fixture_ledger_ref": ledger_ref_for_row(
                surface="agent_eval_fixtures",
                ledger_path="agent-evals/fixtures.jsonl",
                row_id="fixture-run-1",
                row_type="fixture",
                row=fixture,
            ),
            "transcript_ledger_ref": ledger_ref_for_row(
                surface="agent_invocation_transcripts",
                ledger_path="agent-invocations/transcripts.jsonl",
                row_id="transcript-shadow-1",
                row_type="transcript",
                row=transcript,
            ),
            "operator_approval_ledger_ref": ledger_ref_for_row(
                surface="operator_provenance",
                ledger_path="operator-provenance/events.jsonl",
                row_id="operator-shadow-1",
                row_type="operator_approval",
                row=operator,
            ),
        }

    def _request_kwargs(self) -> dict:
        return {
            "target_agent": "aria-shadow-candidate",
            "role": "primary_plan",
            "suggested_prompt": "Run shadow evaluation.",
            "must_satisfy": [{"id": "m1", "predicate": "pass"}],
            "allowed_scope": ["libs/example/**"],
            "base_dir": self.tools,
        }

    def test_shadow_eval_requires_complete_proof(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "shadow_eval_requires_harness_proof"):
            create_agent_invocation_request(
                **self._request_kwargs(),
                shadow_eval=True,
            )

    def test_shadow_lifecycle_blocks_normal_invocation(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "shadow_agent_invocation_blocked"):
            create_agent_invocation_request(**self._request_kwargs())

    def test_shadow_eval_persists_harness_proof(self) -> None:
        request = create_agent_invocation_request(
            **self._request_kwargs(),
            shadow_eval=True,
            eval_harness_id="harness-shadow-1",
            fixture_run_id="fixture-run-1",
            transcript_hash=self.transcript_hash,
            operator_provenance_ref="operator:approval:1",
        )
        self.assertTrue(request["shadow_eval"])
        proof = request["shadow_eval_proof"]
        self.assertEqual(proof["eval_harness_id"], "harness-shadow-1")
        self.assertEqual(proof["fixture_run_id"], "fixture-run-1")
        self.assertEqual(proof["transcript_hash"], self.transcript_hash)
        self.assertTrue(proof["fixture_run_ledger_hash"].startswith("sha256:"))
        self.assertTrue(proof["transcript_ledger_hash"].startswith("sha256:"))

    def test_shadow_eval_rejects_non_sha256_transcript_hash(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "shadow_eval_transcript_hash_must_be_sha256"):
            create_agent_invocation_request(
                **self._request_kwargs(),
                shadow_eval=True,
                eval_harness_id="harness-shadow-1",
                fixture_run_id="fixture-run-1",
                transcript_hash="not-a-sha",
                operator_provenance_ref="operator:approval:1",
            )

    def test_shadow_eval_rejects_missing_context_prompt_result_chain(self) -> None:
        incomplete = dict(self.refs)
        incomplete.pop("context_ledger_ref")
        incomplete.pop("prompt_ledger_ref")
        append_declared_jsonl(
            self.tools / "agent-evals" / "runs.jsonl",
            {
                "schema_version": 1,
                "run_id": "eval-run-missing-chain",
                "eval_harness_id": "harness-shadow-missing-chain",
                "fixture_run_id": "fixture-run-1",
                "fixture_id": "fixture-run-1",
                "invocation_id": "inv-shadow-1",
                "target_agent": "aria-shadow-candidate",
                "passed": True,
                **incomplete,
            },
            expected_surface="agent_evals",
        )
        with self.assertRaisesRegex(GovernanceError, "shadow_eval_proof_chain_missing"):
            create_agent_invocation_request(
                **self._request_kwargs(),
                shadow_eval=True,
                eval_harness_id="harness-shadow-missing-chain",
                fixture_run_id="fixture-run-1",
                transcript_hash=self.transcript_hash,
                operator_provenance_ref="operator:approval:1",
            )


if __name__ == "__main__":
    unittest.main()
