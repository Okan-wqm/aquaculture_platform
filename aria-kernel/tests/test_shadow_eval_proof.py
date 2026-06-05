"""SHADOW eval proof rejects detached provenance.

SHADOW runs can accumulate raw findings before a tool is operator-facing.
Before those rows are treated as actionable proof, the run must join to
transcript, operator, and fixture provenance. This suite pins that fail-
closed contract for the explicit proof verifier.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_eval import add_fixture, verify_shadow_eval_proof
from aria_kernel.ledger import append_jsonl
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, register_tool
from tests._helpers.context_binding import sha256_text


def _shadow_tool() -> dict:
    return {
        "tool_id": "shadow-proof-tool",
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "declared_scope": ["**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "tools/aria-poc/fixtures/shadow-proof-tool",
        "health_thresholds": {
            "precision_min": 0.85,
            "non_critical_false_positives_30d": 3,
            "critical_false_positives": 0,
            "crash_rate_last_10": 0.2,
        },
        "allowed_read_globs": ["**/*.ts"],
        "forbidden_read_globs": [".git/**"],
        "claim_types": ["shadow-proof"],
        "owner": "platform",
        "schema_version": 2,
        "runner": {
            "type": "subprocess",
            "argv": ["python3", "shadow-proof.py"],
            "cwd": ".",
            "timeout_ms": 60000,
            "stdin_json": True,
        },
    }


def _input_envelope(request_id: str = "shadow-request-001") -> dict:
    return {
        "claim_summary": "shadow proof fixture",
        "request_id": request_id,
        "context_hash": sha256_text(f"context:{request_id}"),
        "prompt_hash": sha256_text(f"prompt:{request_id}"),
    }


def _fixture(tools: Path) -> dict:
    return add_fixture(
        fixture={
            "fixture_id": "F999_SHADOW",
            "target_agent": "shadow-proof-tool",
            "role": "shadow_eval",
            "pinned_commit_sha": "cabbfc038",
            "input_envelope": _input_envelope(),
            "expected_verdict_class": "PASS",
            "expected_evidence_refs": ["src/shadow.ts:1"],
            "max_rounds": 1,
            "max_tokens": 1000,
        },
        base_dir=tools,
    )


def _transcript(tools: Path, *, request_id: str) -> dict:
    return append_jsonl(
        tools / "agent-invocations" / "transcripts.jsonl",
        {
            "schema_version": 1,
            "recorded_at": "2026-06-05T00:00:00+00:00",
            "invocation_id": request_id,
            "request_id": request_id,
            "claim_id": f"claim-{request_id}",
            "agent_id": "shadow-agent",
            "transcript_hash": sha256_text(f"transcript:{request_id}"),
            "artifact_ref": f"/tmp/{request_id}.transcript.jsonl",
        },
    )


def _seed_run(
    tools: Path,
    *,
    fixture: dict,
    transcript_row: dict | None,
    missing: str | None = None,
) -> dict:
    input_envelope = fixture["input_envelope"]
    request_id = input_envelope["request_id"]
    provenance = {
        "operator_approval_ref": "operator:shadow-proof",
        "fixture_id": fixture["fixture_id"],
        "fixture_hash": fixture["fixture_hash"],
        "context_hash": input_envelope["context_hash"],
        "prompt_hash": input_envelope["prompt_hash"],
        "transcript_hash": sha256_text(f"transcript:{request_id}"),
        "transcript_ledger_hash": (
            transcript_row["ledger_hash"]
            if transcript_row is not None
            else sha256_text("missing-shadow-transcript-row")
        ),
    }
    if missing is not None:
        provenance.pop(missing)
    return append_jsonl(
        runs_path(tools),
        {
            "schema_version": 1,
            "run_id": f"run-shadow-{missing or 'ok'}",
            "tool_id": "shadow-proof-tool",
            "cycle_id": "cycle-shadow-proof",
            "status": "ok",
            "recorded_at": "2026-06-05T00:00:01+00:00",
            "runner": {"raw_findings_count": 1},
            "shadow_provenance": provenance,
        },
    )


class ShadowEvalProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-shadow-proof-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        register_tool(_shadow_tool(), base_dir=self.tools)
        self.fixture = _fixture(self.tools)
        self.transcript = _transcript(
            self.tools,
            request_id=self.fixture["input_envelope"]["request_id"],
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_shadow_proof_accepts_joined_provenance(self) -> None:
        run = _seed_run(
            self.tools, fixture=self.fixture, transcript_row=self.transcript,
        )
        proof = verify_shadow_eval_proof(
            run_id=run["run_id"], base_dir=self.tools,
        )
        self.assertTrue(proof["verified"])
        self.assertEqual(proof["fixture_hash"], self.fixture["fixture_hash"])
        self.assertEqual(proof["transcript_ledger_hash"], self.transcript["ledger_hash"])

    def test_shadow_proof_rejects_missing_transcript_provenance(self) -> None:
        run = _seed_run(
            self.tools,
            fixture=self.fixture,
            transcript_row=self.transcript,
            missing="transcript_hash",
        )
        with self.assertRaises(GovernanceError) as ctx:
            verify_shadow_eval_proof(run_id=run["run_id"], base_dir=self.tools)
        self.assertIn("shadow_eval_transcript_hash", str(ctx.exception))

    def test_shadow_proof_rejects_missing_transcript_row(self) -> None:
        run = _seed_run(
            self.tools, fixture=self.fixture, transcript_row=None,
        )
        with self.assertRaises(GovernanceError) as ctx:
            verify_shadow_eval_proof(run_id=run["run_id"], base_dir=self.tools)
        self.assertIn("shadow_eval_transcript_row_not_found", str(ctx.exception))

    def test_shadow_proof_rejects_missing_operator_provenance(self) -> None:
        run = _seed_run(
            self.tools,
            fixture=self.fixture,
            transcript_row=self.transcript,
            missing="operator_approval_ref",
        )
        with self.assertRaises(GovernanceError) as ctx:
            verify_shadow_eval_proof(run_id=run["run_id"], base_dir=self.tools)
        self.assertIn("shadow_eval_operator_approval_ref_required", str(ctx.exception))

    def test_shadow_proof_rejects_missing_fixture_provenance(self) -> None:
        run = _seed_run(
            self.tools,
            fixture=self.fixture,
            transcript_row=self.transcript,
            missing="fixture_hash",
        )
        with self.assertRaises(GovernanceError) as ctx:
            verify_shadow_eval_proof(run_id=run["run_id"], base_dir=self.tools)
        self.assertIn("shadow_eval_fixture_hash_required", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
