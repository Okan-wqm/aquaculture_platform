"""End-to-end test for the Plan 016 Faz C submit-result lifecycle.

Walks the full flow: create_agent_invocation_request -> claim_request ->
write a valid aria/agent-response/v1 envelope -> submit_claim_result ->
state transitions to ACCEPTED. Plus the reject paths: malformed envelope,
missing satisfaction matrix entries, evidence ref missing on disk.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    derive_request_state,
    submit_claim_result,
)
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.context_binding import sha256_file, submit_binding_kwargs


def _seed_repo() -> Path:
    """Create a tempdir that looks like a repo root."""
    repo = Path(tempfile.mkdtemp(prefix="aria-e2e-"))
    (repo / "src.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    return repo


class SubmitResultE2ETests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _claim(self) -> tuple[dict, dict]:
        # Plan 024 §B-2 — submit_claim_result E2E exercises the strict
        # path. allowed_scope=["**"] permits the canonical fixture
        # evidence path (src.txt at repo root from _seed_repo) without
        # bringing in real aria-kernel paths the temp repo doesn't carry.
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="validate F-001 evidence",
            must_satisfy=[
                {"id": "F-001-evidence", "criterion": "F-001 evidence is sufficient"},
            ],
            allowed_scope=["**"],
            convergence_id="conv-001",
            base_dir=self.tools,
        )
        claim = claim_request(
            request_id=request["request_id"],
            agent_id="judge-worker-001",
            base_dir=self.tools,
        )
        return request, claim

    def _good_envelope(self, *, request: dict, claim: dict) -> Path:
        # Plan 024 §B-2 — request now carries must_satisfy=[F-001-evidence]
        # and allowed_scope=aria-kernel/** + aria-tools/**. The "good"
        # envelope must satisfy every criterion (or risk
        # response_schema rejection) and place evidence inside the
        # request's allowed_scope.
        envelope = {
            "$schema": "aria/agent-response/v1",
            "request_id": request["request_id"],
            "claim_id": claim["claim_id"],
            "agent_id": claim["agent_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "F-001-evidence",
                    "verdict": "satisfied",
                    "evidence_refs": ["src.txt:1"],
                },
            ],
            "evidence_refs": ["src.txt:1"],
            "details": {"verdict": "true_positive", "confidence": 0.92},
        }
        # Plan 020 Phase 7.B — output_path_match compliance check requires
        # the response file to land at the request's expected_output_path
        # (kernel-canonical location). Pre-Plan-020 tests wrote to custom
        # paths because no gate enforced the contract; the new gate fires.
        out_path = Path(request["expected_output_path"])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(envelope), encoding="utf-8")
        return out_path

    def _binding_kwargs(self, request: dict, *, name: str = "transcript.jsonl") -> dict[str, str]:
        return submit_binding_kwargs(
            request,
            transcript_dir=self.tools / "agent-invocations" / "transcripts",
            transcript_name=name,
            transcript_text=f"fixture transcript for {request['request_id']}\n",
        )

    def test_full_claim_submit_accept_flow(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **self._binding_kwargs(request),
        )
        self.assertEqual(result["status"], "accepted", result)
        # Plan 026R §C.5 — derive_request_state is bridge-aware. For
        # BRIDGE_REQUIRED roles (this test uses evidence_judgment) the
        # state lifts to ACCEPTED_PENDING_BRIDGE when the bridge has
        # not yet succeeded; ACCEPTED when it has. This e2e test does
        # not drive a fully-bridgeable judgment envelope, so the
        # bridge may legitimately end in pending_retry. The assertion
        # preserves the test's original architectural intent (accept
        # != reject) without overspecifying the bridge sub-state —
        # bridge-specific assertions live in test_bridge_retry.py.
        state = derive_request_state(
            request_id=request["request_id"], base_dir=self.tools,
        )
        self.assertIn(state, {"ACCEPTED", "ACCEPTED_PENDING_BRIDGE"})

    def test_evidence_pointing_at_missing_file_rejected(self) -> None:
        request, claim = self._claim()
        # Plan 024 §B-2 — preserve the original missing-file rejection
        # intent: the satisfaction matrix is non-empty and matches the
        # criterion, evidence_refs path is inside allowed_scope but the
        # file genuinely doesn't exist on disk. The rejection should
        # surface from the file-existence check, not the matrix or
        # scope gates.
        envelope = {
            "$schema": "aria/agent-response/v1",
            "request_id": request["request_id"],
            "claim_id": claim["claim_id"],
            "agent_id": claim["agent_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "F-001-evidence",
                    "verdict": "satisfied",
                    "evidence_refs": ["does/not/exist.ts:1"],
                },
            ],
            "evidence_refs": ["does/not/exist.ts:1"],
            "details": {"verdict": "true_positive", "confidence": 0.92},
        }
        out = self.tools / "agent-invocations" / "outputs" / "bad.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(envelope), encoding="utf-8")
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **self._binding_kwargs(request, name="missing-file.transcript.jsonl"),
        )
        self.assertEqual(result["status"], "rejected")
        joined = " ".join(result["reasons"])
        self.assertIn("evidence", joined)
        self.assertEqual(
            derive_request_state(request_id=request["request_id"], base_dir=self.tools),
            "REJECTED",
        )

    def test_lease_token_mismatch_raises(self) -> None:
        _, claim = self._claim()
        out = self.tools / "agent-invocations" / "outputs" / "x.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("{}", encoding="utf-8")
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaisesRegex(GovernanceError, "lease_token mismatch"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token="00" * 24,
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
            )

    def test_missing_context_hash_blocks_submit(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        binding = self._binding_kwargs(request, name="missing-context.transcript.jsonl")
        binding.pop("context_hash")
        with self.assertRaisesRegex(GovernanceError, "context_hash_must_be_sha256"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **binding,
            )

    def test_mismatched_prompt_hash_blocks_submit(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        binding = self._binding_kwargs(request, name="bad-prompt.transcript.jsonl")
        binding["prompt_hash"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(GovernanceError, "invocation_prompt_hash_binding_mismatch"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **binding,
            )

    def test_mismatched_transcript_hash_blocks_submit(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        binding = self._binding_kwargs(request, name="bad-transcript.transcript.jsonl")
        binding["transcript_hash"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(GovernanceError, "transcript_hash_mismatch"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **binding,
            )

    def test_transcript_artifact_cannot_equal_output_envelope(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        binding = self._binding_kwargs(request, name="unused.transcript.jsonl")
        binding["transcript_artifact_ref"] = out.resolve().as_posix()
        binding["transcript_hash"] = sha256_file(out)
        with self.assertRaisesRegex(GovernanceError, "transcript_artifact_cannot_equal_output_envelope"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **binding,
            )

    def test_separation_of_duties_blocks_self_approval(self) -> None:
        # Build a request whose forbidden_agent_ids excludes the submitter.
        # Plan 024 §B-2 — strict path goes through claim_request, so
        # real must_satisfy + allowed_scope prevent _strict_request_view
        # from rejecting the legacy-shape conversion.
        request = create_agent_invocation_request(
            target_agent="aria-primary-planner",
            role="primary_plan",
            suggested_prompt="draft architecture-first plan",
            must_satisfy=[
                {"id": "sod-test", "criterion": "separation of duties enforced"},
            ],
            allowed_scope=["aria-kernel/**"],
            convergence_id="conv-002",
            base_dir=self.tools,
        )
        # Patch the request row so separation_of_duties forbids judge-worker-001.
        # (Direct edit is fine for the test; in production the planner sets it.)
        from aria_kernel.ledger import load_jsonl, rewrite_jsonl
        req_path = self.tools / "agent-invocations" / "requests.jsonl"
        rows = load_jsonl(req_path)
        rows[-1]["separation_of_duties"] = {"forbidden_agent_ids": ["judge-worker-001"]}
        rewrite_jsonl(req_path, rows)

        claim = claim_request(
            request_id=request["request_id"],
            agent_id="judge-worker-001",
            base_dir=self.tools,
        )
        envelope = {
            "$schema": "aria/agent-response/v1",
            "request_id": request["request_id"],
            "claim_id": claim["claim_id"],
            "agent_id": claim["agent_id"],
            "role": "primary_plan",
            "status": "submitted",
            "satisfaction_matrix": [],
            "evidence_refs": ["src.txt:1"],
        }
        out = self.tools / "agent-invocations" / "outputs" / "sod.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(envelope), encoding="utf-8")
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **self._binding_kwargs(request, name="sod.transcript.jsonl"),
        )
        self.assertEqual(result["status"], "rejected")
        joined = " ".join(result["reasons"])
        self.assertIn("separation_of_duties", joined)

    def test_unreadable_envelope_rejected_gracefully(self) -> None:
        request, claim = self._claim()
        out = self.tools / "agent-invocations" / "outputs" / "junk.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("not-json", encoding="utf-8")
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **self._binding_kwargs(request, name="unreadable.transcript.jsonl"),
        )
        self.assertEqual(result["status"], "rejected")
        joined = " ".join(result["reasons"])
        self.assertIn("envelope_unreadable", joined)


if __name__ == "__main__":
    unittest.main()
