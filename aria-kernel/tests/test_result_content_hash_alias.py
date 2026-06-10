"""Plan 026R §C.2 — accepted + rejected result rows write content_hash alias.

3 tests:

* Accepted result row carries BOTH ``output_hash`` AND
  ``content_hash`` with the same value.
* Rejected result row carries both fields (null when no output
  file; populated when the output file exists).
* Cross-review consumer that queries by ``content_hash`` resolves
  the result row (no more permanent-None lookup).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    submit_claim_result,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile
from tests._helpers.declared_fixtures import sha256_file


class ResultContentHashAliasTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c2-"))
        self.base = self.tmp / "aria-tools"
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        # Seed an evidence file the request will reference.
        (self.workspace / "docs").mkdir()
        (self.workspace / "docs" / "evidence.md").write_text(
            "# evidence", encoding="utf-8",
        )
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.email", "aria-test@example.invalid"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=self.workspace, check=True)
        subprocess.run(["git", "add", "docs/evidence.md"], cwd=self.workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "fixture: evidence"], cwd=self.workspace, check=True)
        self.target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.workspace,
            text=True,
        ).strip()

        self.req = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="verify",
            expected_output_path=str(self.workspace / "out.json"),
            must_satisfy=[{"id": "S1", "description": "evidence-grounded"}],
            allowed_scope=["docs/"],
            evidence_refs=["docs/evidence.md"],
            target_sha=self.target_sha,
            base_dir=self.base,
        )
        self.claim = claim_request(
            request_id=self.req["request_id"],
            agent_id="ext-agent",
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_envelope(self, path: Path, content_hash_extra: dict | None = None) -> None:
        envelope = {
            "$schema": "aria/agent-response/v1",
            "schema_version": 1,
            "claim_id": self.claim["claim_id"],
            "agent_id": "ext-agent",
            "request_id": self.req["request_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "S1",
                    "verdict": "satisfied",
                    "evidence_refs": ["docs/evidence.md"],
                },
            ],
            "summary": "verified",
        }
        path.write_text(json.dumps(envelope), encoding="utf-8")

    def _binding_kwargs(self, output_path: Path | None = None) -> dict[str, str]:
        transcript = self.workspace / "out.transcript.txt"
        transcript.write_text("fixture transcript for result content hash alias\n", encoding="utf-8")
        return {
            "context_hash": str(self.req["context_hash"]),
            "prompt_hash": str(self.req["prompt_hash"]),
            "transcript_hash": sha256_file(transcript),
            "transcript_artifact_ref": transcript.resolve().as_posix(),
        }

    def test_accepted_result_row_carries_both_hash_fields(self) -> None:
        out = self.workspace / "out.json"
        self._write_envelope(out)
        result = submit_claim_result(
            claim_id=self.claim["claim_id"],
            agent_id="ext-agent",
            lease_token=self.claim["lease_token"],
            output_path=str(out),
            workspace_root=str(self.workspace),
            base_dir=self.base,
            **self._binding_kwargs(),
        )
        self.assertEqual(result["status"], "accepted", result)
        row = result["row"]
        self.assertIn("output_hash", row)
        self.assertIn("content_hash", row)
        self.assertEqual(row["output_hash"], row["content_hash"])
        self.assertTrue(row["output_hash"].startswith("sha256:"))

    def test_rejected_result_row_carries_both_hash_fields(self) -> None:
        # Rejection scenario: envelope claims a satisfaction matrix
        # that doesn't reference the allowed_scope.
        out = self.workspace / "out.json"
        bad_envelope = {
            "$schema": "aria/agent-response/v1",
            "schema_version": 1,
            "claim_id": self.claim["claim_id"],
            "agent_id": "ext-agent",
            "request_id": self.req["request_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "S1",
                    "verdict": "satisfied",
                    "evidence_refs": ["out-of-scope/x.md"],
                },
            ],
            "summary": "violates scope",
        }
        out.write_text(json.dumps(bad_envelope), encoding="utf-8")
        result = submit_claim_result(
            claim_id=self.claim["claim_id"],
            agent_id="ext-agent",
            lease_token=self.claim["lease_token"],
            output_path=str(out),
            workspace_root=str(self.workspace),
            base_dir=self.base,
            **self._binding_kwargs(out),
        )
        self.assertEqual(result["status"], "rejected", result)
        row = result["row"]
        self.assertIn("output_hash", row)
        self.assertIn("content_hash", row)
        # Both populated (output file exists) and equal.
        self.assertEqual(row["output_hash"], row["content_hash"])
        self.assertTrue(row["output_hash"].startswith("sha256:"))

    def test_cross_review_lookup_by_content_hash_resolves(self) -> None:
        out = self.workspace / "out.json"
        self._write_envelope(out)
        result = submit_claim_result(
            claim_id=self.claim["claim_id"],
            agent_id="ext-agent",
            lease_token=self.claim["lease_token"],
            output_path=str(out),
            workspace_root=str(self.workspace),
            base_dir=self.base,
            **self._binding_kwargs(out),
        )
        target_hash = result["row"]["content_hash"]
        rows = load_jsonl(self.base / "agent-invocations" / "results.jsonl")
        # The lookup pattern §C.4 will use: find a row whose
        # content_hash equals the target. Pre-§C.2 the rows did NOT
        # carry content_hash so the lookup returned None.
        matches = [r for r in rows if r.get("content_hash") == target_hash]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["claim_id"], self.claim["claim_id"])


if __name__ == "__main__":
    unittest.main()
