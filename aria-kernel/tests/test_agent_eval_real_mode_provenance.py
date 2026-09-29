"""Plan 023 v3 §A-8 — agent_eval real-mode provenance binding.

Pre-Plan-023 run_agent_eval(mock_mode=False) accepted any caller-
provided real_response_envelope dict without proof that an actual
agent invocation produced it. No lease binding. No invocation_id.
No transcript ledger. The eval row simply trusted the dict shape.
A caller could file-feed an envelope and the eval ran 'real-mode'
indistinguishably from a real agent execution.

Plan 023 v3 §A-8 fix: real-mode runs require invocation_id (UUIDv7
from the upstream lease ledger) AND transcript_hash (sha256 of the
captured transcript). Both are recorded on the eval row as
provenance fields. Legacy callers that only file-feed the envelope
MUST opt in via allow_legacy_envelope_feed=True with an explicit
operator_approval_ref — the legacy path stays available but every
use is recorded with provenance_mode='legacy_envelope_feed' and an
operator_approval_ref for audit.

Tests:
1. mock_mode=True → no provenance fields required (regression).
2. mock_mode=False + invocation_id + transcript_hash → accepted +
   provenance_mode='real_invocation' on the row.
3. mock_mode=False without invocation_id and without legacy opt-in →
   real_eval_missing_provenance_fields reject.
4. mock_mode=False + allow_legacy_envelope_feed=True without
   operator_approval_ref → legacy_envelope_feed_requires_operator_
   approval_ref reject.
5. mock_mode=False + allow_legacy_envelope_feed=True + approval_ref
   → accepted + provenance_mode='legacy_envelope_feed'.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_eval import EVAL_FIXTURE_SCHEMA, run_agent_eval
from aria_kernel.agent_invocations import record_invocation_prompt, record_transcript
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.ledger_refs import ledger_ref_for_row
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_fixture(tools: Path) -> None:
    append_declared_jsonl(
        tools / "agent-evals" / "fixtures.jsonl",
        {
            "$schema": EVAL_FIXTURE_SCHEMA,
            "schema_version": 1,
            "row_id": "F999_TEST",
            "row_type": "fixture",
            "fixture_id": "F999_TEST",
            "target_agent": "test-agent",
            "role": "implementation",
            "intent": "Plan 023 §A-8 fixture",
            "scenario": "Test fixture for provenance binding tests",
            "expected_verdict_class": "true_positive",
            "expected_evidence_refs": ["src/x.ts"],
            "max_rounds": 3,
            "max_tokens": 10000,
        },
        expected_surface="agent_eval_fixtures",
    )


def _fixture_ref(tools: Path) -> dict:
    rows = [
        row for row in load_declared_jsonl(
            tools / "agent-evals" / "fixtures.jsonl",
            expected_surface="agent_eval_fixtures",
        )
        if row.get("fixture_id") == "F999_TEST"
    ]
    return ledger_ref_for_row(
        surface="agent_eval_fixtures",
        ledger_path="agent-evals/fixtures.jsonl",
        row_id="F999_TEST",
        row_type="fixture",
        row=rows[0],
    )


def _bind_real_provenance(tools: Path, *, transcript_hash: str) -> dict:
    request = append_declared_jsonl(
        tools / "agent-invocations" / "requests.jsonl",
        {
            "schema_version": 1,
            "row_id": "AIR-real-1",
            "row_type": "request",
            "request_id": "AIR-real-1",
            "target_agent": "test-agent",
        },
        expected_surface="agent_invocation_requests",
    )
    context = append_declared_jsonl(
        tools / "agent-invocations" / "contexts.jsonl",
        {
            "schema_version": 1,
            "row_id": "context-real-1",
            "row_type": "context",
            "request_id": "AIR-real-1",
            "target_agent": "test-agent",
            "context_hash": "sha256:" + "b" * 64,
        },
        expected_surface="agent_invocation_contexts",
    )
    prompt = append_declared_jsonl(
        tools / "agent-invocations" / "prompts.jsonl",
        {
            "schema_version": 1,
            "row_id": "prompt-real-1",
            "row_type": "prompt",
            "request_id": "AIR-real-1",
            "context_hash": context["context_hash"],
            "prompt_hash": "sha256:" + "c" * 64,
            "prompt_text": "test",
        },
        expected_surface="agent_invocation_prompts",
    )
    claim = append_declared_jsonl(
        tools / "agent-invocations" / "claims.jsonl",
        {
            "schema_version": 1,
            "row_id": "invocation-uuid-001",
            "row_type": "claim",
            "event": "claimed",
            "claim_id": "invocation-uuid-001",
            "invocation_id": "invocation-uuid-001",
            "request_id": "AIR-real-1",
        },
        expected_surface="agent_invocation_claims",
    )
    result = append_declared_jsonl(
        tools / "agent-invocations" / "results.jsonl",
        {
            "schema_version": 1,
            "row_id": "result-invocation-uuid-001",
            "row_type": "result",
            "claim_id": "invocation-uuid-001",
            "invocation_id": "invocation-uuid-001",
            "request_id": "AIR-real-1",
            "status": "accepted",
            "transcript_hash": transcript_hash,
        },
        expected_surface="agent_invocation_results",
    )
    transcript = append_declared_jsonl(
        tools / "agent-invocations" / "transcripts.jsonl",
        {
            "schema_version": 1,
            "row_id": "transcript-invocation-uuid-001",
            "row_type": "transcript",
            "invocation_id": "invocation-uuid-001",
            "claim_id": "invocation-uuid-001",
            "request_id": "AIR-real-1",
            "target_agent": "test-agent",
            "transcript_hash": transcript_hash,
            "fixture_run_id": "F999_TEST",
            "artifact_ref": {"sha256": transcript_hash},
        },
        expected_surface="agent_invocation_transcripts",
    )
    operator = append_declared_jsonl(
        tools / "operator-provenance" / "events.jsonl",
        {
            "schema_version": 1,
            "row_id": "approval-invocation-uuid-001",
            "row_type": "operator_approval",
            "operator_provenance_ref": "operator:approval:invocation-uuid-001",
            "operator": "test-operator",
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        },
        expected_surface="operator_provenance",
    )
    return {
        "request_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_requests",
            ledger_path="agent-invocations/requests.jsonl",
            row_id="AIR-real-1",
            row_type="request",
            row=request,
        ),
        "claim_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_claims",
            ledger_path="agent-invocations/claims.jsonl",
            row_id="invocation-uuid-001",
            row_type="claim",
            row=claim,
        ),
        "context_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_contexts",
            ledger_path="agent-invocations/contexts.jsonl",
            row_id="context-real-1",
            row_type="context",
            row=context,
        ),
        "prompt_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_prompts",
            ledger_path="agent-invocations/prompts.jsonl",
            row_id="prompt-real-1",
            row_type="prompt",
            row=prompt,
        ),
        "result_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_results",
            ledger_path="agent-invocations/results.jsonl",
            row_id="result-invocation-uuid-001",
            row_type="result",
            row=result,
        ),
        "fixture_ledger_ref": _fixture_ref(tools),
        "transcript_ledger_ref": ledger_ref_for_row(
            surface="agent_invocation_transcripts",
            ledger_path="agent-invocations/transcripts.jsonl",
            row_id="transcript-invocation-uuid-001",
            row_type="transcript",
            row=transcript,
        ),
        "operator_approval_ledger_ref": ledger_ref_for_row(
            surface="operator_provenance",
            ledger_path="operator-provenance/events.jsonl",
            row_id="approval-invocation-uuid-001",
            row_type="operator_approval",
            row=operator,
        ),
    }


def _envelope() -> dict:
    return {
        "$schema": "aria/agent-response/v1",
        "schema_version": 1,
        "verdict_class": "true_positive",
        "evidence_refs": ["src/x.ts"],
        "rounds_used": 1,
        "tokens_used": 1024,
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
            set_by="operator",
        )
        _seed_fixture(self.tools)

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

    def test_real_mode_with_invocation_id_accepted(self) -> None:
        """Plan 023 v3 §A-8: real-mode + invocation_id + transcript_hash
        → accepted with provenance_mode='real_invocation'."""
        transcript_hash = "sha256:" + "b" * 64
        refs = _bind_real_provenance(self.tools, transcript_hash=transcript_hash)
        result = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=_envelope(),
            invocation_id="invocation-uuid-001",
            transcript_hash=transcript_hash,
            **refs,
        )
        self.assertEqual(result["mock_mode"], False)
        self.assertEqual(result["provenance_mode"], "real_invocation")
        self.assertEqual(result["invocation_id"], "invocation-uuid-001")
        self.assertEqual(result["transcript_hash"], transcript_hash)

    def test_provenance_producers_emit_source_ledger_identity(self) -> None:
        prompt = record_invocation_prompt(
            request_id="AIR-produced-1",
            context_hash="sha256:" + "c" * 64,
            prompt_text="exact prompt",
            base_dir=self.tools,
        )
        transcript = record_transcript(
            invocation_id="invocation-produced-1",
            transcript_hash="sha256:" + "d" * 64,
            target_agent="test-agent",
            request_id="AIR-produced-1",
            claim_id="claim-produced-1",
            fixture_run_id="F999_TEST",
            base_dir=self.tools,
        )

        self.assertEqual(prompt["row_id"], "prompt:AIR-produced-1")
        self.assertEqual(prompt["row_type"], "prompt")
        self.assertEqual(transcript["row_id"], "transcript:invocation-produced-1")
        self.assertEqual(transcript["row_type"], "transcript")

    def test_real_mode_without_provenance_rejects(self) -> None:
        """Plan 023 v3 §A-8: real_eval_missing_provenance_fields when
        no invocation_id and no legacy opt-in."""
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=_envelope(),
                # No invocation_id, no allow_legacy_envelope_feed.
            )
        self.assertIn("real_eval_missing_provenance_fields", str(ctx.exception))

    def test_legacy_feed_without_approval_rejects(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=_envelope(),
                allow_legacy_envelope_feed=True,
                # No operator_approval_ref.
            )
        self.assertIn("real_eval_legacy_envelope_feed_removed", str(ctx.exception))

    def test_legacy_feed_with_approval_rejects(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_agent_eval(
                fixture_id="F999_TEST",
                base_dir=self.tools,
                mock_mode=False,
                real_response_envelope=_envelope(),
                allow_legacy_envelope_feed=True,
                operator_approval_ref="docs/operator/legacy/feed-001",
            )
        self.assertIn("real_eval_legacy_envelope_feed_removed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
