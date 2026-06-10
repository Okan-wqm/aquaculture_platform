from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class ShadowEvalProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-shadow-eval-")
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.transcript_hash = "sha256:" + "a" * 64
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
                "target_agent": "aria-shadow-candidate",
                "passed": True,
            },
            expected_surface="agent_evals",
        )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "transcripts.jsonl",
            {
                "schema_version": 1,
                "target_agent": "aria-shadow-candidate",
                "transcript_hash": self.transcript_hash,
            },
            expected_surface="agent_invocation_transcripts",
        )
        append_declared_jsonl(
            self.tools / "operator-provenance" / "events.jsonl",
            {
                "schema_version": 1,
                "operator_provenance_ref": "operator:approval:1",
                "operator": "test-operator",
            },
            expected_surface="operator_provenance",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

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


if __name__ == "__main__":
    unittest.main()
