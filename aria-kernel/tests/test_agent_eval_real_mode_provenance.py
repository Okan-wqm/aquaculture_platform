"""Plan 023 v3 §A-8 — agent_eval real-mode provenance binding.

Pre-Plan-023 run_agent_eval(mock_mode=False) accepted any caller-
provided real_response_envelope dict without proof that an actual
agent invocation produced it. No lease binding. No invocation_id.
No transcript ledger. The eval row simply trusted the dict shape.
A caller could file-feed an envelope and the eval ran 'real-mode'
indistinguishably from a real agent execution.

Plan 023 v3 §A-8 + cabbfc038 closure: real-mode runs require the
caller-provided envelope to join to an ACCEPTED agent result row,
the transcript ledger row referenced by that result, operator
approval provenance, and fixture context/prompt hashes. Legacy
callers may still pass allow_legacy_envelope_feed for compatibility,
but that flag no longer turns a detached file-fed envelope into real
eval proof.

Tests:
1. mock_mode=True → no provenance fields required (regression).
2. mock_mode=False + accepted result + transcript + operator/fixture
   provenance → accepted with proof_mode='ledger_bound_accepted_result'.
3. mock_mode=False without accepted result → rejected even with
   allow_legacy_envelope_feed=True.
4. mock_mode=False without transcript row → rejected.
5. mock_mode=False without operator provenance → rejected.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_eval import add_fixture, run_agent_eval
from aria_kernel.ledger import append_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.context_binding import sha256_payload, sha256_text


def _input_envelope(request_id: str = "request-real-proof-001") -> dict:
    return {
        "claim_summary": "Plan 023 §A-8 fixture",
        "request_id": request_id,
        "context_hash": sha256_text(f"context:{request_id}"),
        "prompt_hash": sha256_text(f"prompt:{request_id}"),
    }


def _seed_fixture(tools: Path) -> dict:
    return add_fixture(
        fixture={
        "fixture_id": "F999_TEST",
        "target_agent": "test-agent",
        "role": "implementation",
        "pinned_commit_sha": "cabbfc038",
        "input_envelope": _input_envelope(),
        "expected_verdict_class": "ACCEPTED",
        "expected_evidence_refs": ["src/x.ts"],
        "max_rounds": 3,
        "max_tokens": 10000,
        },
        base_dir=tools,
    )


def _envelope() -> dict:
    return {
        "$schema": "aria/agent-response/v1",
        "schema_version": 1,
        "verdict_class": "ACCEPTED",
        "evidence_refs": ["src/x.ts"],
        "rounds_used": 1,
        "tokens_used": 1024,
    }


def _seed_proof(
    tools: Path,
    *,
    fixture: dict,
    envelope: dict,
    include_transcript: bool = True,
) -> dict[str, str]:
    input_envelope = fixture["input_envelope"]
    request_id = input_envelope["request_id"]
    claim_id = f"claim-{request_id}"
    agent_id = "real-eval-agent"
    transcript_hash = sha256_text(f"transcript:{request_id}")
    if include_transcript:
        transcript_row = append_jsonl(
            tools / "agent-invocations" / "transcripts.jsonl",
            {
                "schema_version": 1,
                "recorded_at": "2026-06-05T00:00:00+00:00",
                "invocation_id": request_id,
                "request_id": request_id,
                "claim_id": claim_id,
                "agent_id": agent_id,
                "transcript_hash": transcript_hash,
                "artifact_ref": f"/tmp/{request_id}.transcript.jsonl",
            },
        )
        transcript_ledger_hash = transcript_row["ledger_hash"]
    else:
        transcript_ledger_hash = sha256_text("missing-transcript-row")
    append_jsonl(
        tools / "agent-invocations" / "results.jsonl",
        {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "claim_id": claim_id,
            "request_id": request_id,
            "agent_id": agent_id,
            "role": fixture["role"],
            "status": "accepted",
            "envelope_evidence_hash": sha256_payload(envelope),
            "context_hash": input_envelope["context_hash"],
            "prompt_hash": input_envelope["prompt_hash"],
            "transcript_hash": transcript_hash,
            "context_ledger_hash": sha256_text(f"context-ledger:{request_id}"),
            "prompt_ledger_hash": sha256_text(f"prompt-ledger:{request_id}"),
            "transcript_ledger_hash": transcript_ledger_hash,
            "submitted_at": "2026-06-05T00:00:01+00:00",
        },
    )
    return {
        "invocation_id": request_id,
        "transcript_hash": transcript_hash,
        "operator_approval_ref": "operator:real-eval-proof",
    }


class RealModeProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a8-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        # Plan 020 Phase 1.B — agent_eval writes require strict profile.
        set_profile(
            "strict",
            operator_approval_ref="test:plan-023-a8",
            base_dir=self.tools,
            set_by="test-fixture",
        )
        self.fixture = _seed_fixture(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_mock_mode_no_provenance_required(self) -> None:
        """Regression: mock_mode=True does not require invocation_id."""
        result = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=True,
        )
        self.assertEqual(result["mock_mode"], True)
        self.assertEqual(result["provenance_mode"], "mock")

    def test_real_mode_with_ledger_bound_proof_accepted(self) -> None:
        """Real-mode + accepted result + transcript + operator/fixture
        provenance is accepted."""
        envelope = _envelope()
        proof = _seed_proof(self.tools, fixture=self.fixture, envelope=envelope)
        result = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=envelope,
            **proof,
        )
        self.assertEqual(result["mock_mode"], False)
        self.assertEqual(result["provenance_mode"], "real_invocation")
        self.assertEqual(result["proof_mode"], "ledger_bound_accepted_result")
        self.assertEqual(result["invocation_id"], proof["invocation_id"])
        self.assertEqual(result["transcript_hash"], proof["transcript_hash"])
        self.assertEqual(result["operator_approval_ref"], proof["operator_approval_ref"])

    def test_real_mode_without_provenance_rejects(self) -> None:
        """No invocation_id/operator/transcript proof rejects."""
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=_envelope(),
            )
        self.assertIn("real_eval_operator_approval_ref_required", str(ctx.exception))

    def test_legacy_feed_without_accepted_result_rejects(self) -> None:
        envelope = _envelope()
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=envelope,
                allow_legacy_envelope_feed=True,
                invocation_id=self.fixture["input_envelope"]["request_id"],
                transcript_hash=sha256_text("transcript:detached"),
                operator_approval_ref="operator:legacy-feed",
            )
        self.assertIn("real_eval_accepted_result_not_found", str(ctx.exception))

    def test_missing_transcript_row_rejects(self) -> None:
        envelope = _envelope()
        proof = _seed_proof(
            self.tools,
            fixture=self.fixture,
            envelope=envelope,
            include_transcript=False,
        )
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=envelope,
                **proof,
            )
        self.assertIn("real_eval_transcript_row_not_found", str(ctx.exception))

    def test_missing_operator_provenance_rejects(self) -> None:
        envelope = _envelope()
        proof = _seed_proof(self.tools, fixture=self.fixture, envelope=envelope)
        proof["operator_approval_ref"] = ""
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=envelope,
                **proof,
            )
        self.assertIn("real_eval_operator_approval_ref_required", str(ctx.exception))

    def test_missing_fixture_context_provenance_rejects(self) -> None:
        tools = self.tmp / "legacy-fixture-tools"
        ensure_tools_dir(tools)
        set_profile(
            "strict",
            operator_approval_ref="test:plan-023-a8-legacy-fixture",
            base_dir=tools,
            set_by="test-fixture",
        )
        fixture_path = tools / "agent-evals" / "fixtures" / "F999_TEST.json"
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_text(json.dumps({
            "fixture_id": "F999_TEST",
            "target_agent": "test-agent",
            "role": "implementation",
            "pinned_commit_sha": "cabbfc038",
            "input_envelope": {"claim_summary": "legacy"},
            "expected_verdict_class": "ACCEPTED",
            "expected_evidence_refs": ["src/x.ts"],
            "max_rounds": 3,
            "max_tokens": 10000,
        }), encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=tools,
                mock_mode=False,
                real_response_envelope=_envelope(),
                invocation_id="request-real-proof-001",
                transcript_hash=sha256_text("transcript:legacy"),
                operator_approval_ref="operator:legacy-fixture",
            )
        self.assertIn("real_eval_fixture_hash_required", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
