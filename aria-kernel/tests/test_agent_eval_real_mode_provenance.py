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

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_eval import EVAL_FIXTURE_SCHEMA, run_agent_eval
from aria_kernel.agent_invocations import record_transcript
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_fixture(tools: Path) -> None:
    fixture_path = tools / "agent-evals" / "fixtures" / "F999_TEST.json"
    fixture_path.parent.mkdir(parents=True, exist_ok=True)
    fixture_path.write_text(json.dumps({
        "$schema": EVAL_FIXTURE_SCHEMA,
        "fixture_id": "F999_TEST",
        "target_agent": "test-agent",
        "role": "implementation",
        "intent": "Plan 023 §A-8 fixture",
        "scenario": "Test fixture for provenance binding tests",
        "expected_verdict_class": "true_positive",
        "expected_evidence_refs": ["src/x.ts"],
        "max_rounds": 3,
        "max_tokens": 10000,
    }), encoding="utf-8")


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
            set_by="test-fixture",
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
        append_declared_jsonl(
            self.tools / "agent-invocations" / "claims.jsonl",
            {
                "schema_version": 1,
                "event": "claimed",
                "claim_id": "invocation-uuid-001",
                "request_id": "AIR-real-1",
            },
            expected_surface="agent_invocation_claims",
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "results.jsonl",
            {
                "schema_version": 1,
                "claim_id": "invocation-uuid-001",
                "invocation_id": "invocation-uuid-001",
                "request_id": "AIR-real-1",
                "status": "accepted",
                "transcript_hash": transcript_hash,
            },
            expected_surface="agent_invocation_results",
        )
        record_transcript(
            invocation_id="invocation-uuid-001",
            claim_id="invocation-uuid-001",
            request_id="AIR-real-1",
            target_agent="test-agent",
            transcript_hash=transcript_hash,
            fixture_run_id="F999_TEST",
            base_dir=self.tools,
        )
        result = run_agent_eval(
            fixture_id="F999_TEST",
            base_dir=self.tools,
            mock_mode=False,
            real_response_envelope=_envelope(),
            invocation_id="invocation-uuid-001",
            transcript_hash=transcript_hash,
        )
        self.assertEqual(result["mock_mode"], False)
        self.assertEqual(result["provenance_mode"], "real_invocation")
        self.assertEqual(result["invocation_id"], "invocation-uuid-001")
        self.assertEqual(result["transcript_hash"], transcript_hash)

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
