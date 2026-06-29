"""Tests for Plan 019 Phase 8.B CI executor."""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# tools/aria-poc is not on PYTHONPATH by default — add it.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


class CostCapTests(unittest.TestCase):
    def test_validate_cost_cap_passes_under_limit(self) -> None:
        with patch.dict(os.environ, {"MAX_TURNS_PER_RUN": "12"}):
            ci_executor._validate_cost_cap(request={"evidence_refs": ["a"] * 5})

    def test_validate_cost_cap_rejects_over_limit(self) -> None:
        with patch.dict(os.environ, {"MAX_TURNS_PER_RUN": "5"}):
            # cap = 5 * 4 = 20; 25 refs exceeds.
            with self.assertRaises(ci_executor.CostCapExceeded):
                ci_executor._validate_cost_cap(request={"evidence_refs": ["x"] * 25})


class LeaseTokenRedactionTests(unittest.TestCase):
    def test_redact_replaces_token_in_message(self) -> None:
        out = ci_executor._redact_lease_in_message(
            "submit failed: lease=secret-abc-123 mismatch", "secret-abc-123"
        )
        self.assertNotIn("secret-abc-123", out)
        self.assertIn("<lease-token-redacted>", out)

    def test_redact_passes_through_when_no_token(self) -> None:
        out = ci_executor._redact_lease_in_message("clean message", None)
        self.assertEqual(out, "clean message")

    def test_argv_never_contains_lease_token(self) -> None:
        # The executor passes lease tokens via env var only. The argv
        # construction in `main()` references `--lease-token-from-env
        # ARIA_LEASE_TOKEN` — assert by inspecting the source.
        src = (Path(_POC_DIR) / "ci_executor.py").read_text(encoding="utf-8")
        # Required: the env-var transit pattern.
        self.assertIn("--lease-token-from-env", src)
        self.assertIn("LEASE_TOKEN_ENV_VAR", src)
        # Forbidden: any direct argv passing of `lease_token` variable.
        self.assertNotIn('"--lease-token", lease_token', src)
        self.assertNotIn("'--lease-token', lease_token", src)


class InvokeCodexCliTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-ci-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_mock_mode_writes_envelope_to_output_path(self) -> None:
        out_path = self.tmp / "response.json"
        prompt_path = self.tmp / "prompt.md"
        prompt_path.write_text("# Test prompt", encoding="utf-8")
        # Plan 024 v3 §B-8 — invoke_claude_cli requires real
        # lease identity (claim_id + agent_id) when in mock mode so
        # the envelope can pass the Plan 023 §A-5 lease binding +
        # Plan 024 §H-4 role match. Tests pass dummy real-shaped
        # values here.
        with patch.dict(os.environ, {ci_executor.MOCK_MODE_ENV_VAR: "1"}):
            exit_code = ci_executor.invoke_claude_cli(
                request_id="REQ-test-1",
                subagent_type="aria-evidence-judge",
                prompt_file=prompt_path,
                output_path=out_path,
                timeout_seconds=300,
                claim_id="claim_test_aaaaaaaa",
                agent_id="ci-executor:gha-test",
                role="evidence_judgment",
                must_satisfy=[],
            )
        self.assertEqual(exit_code, 0)
        self.assertTrue(out_path.exists())
        envelope = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(envelope["$schema"], "aria/agent-response/v1")
        self.assertEqual(envelope["request_id"], "REQ-test-1")
        self.assertEqual(envelope["details"]["verdict"]["model"], "mock")

    def test_unavailable_when_no_binary_and_no_mock(self) -> None:
        out_path = self.tmp / "response.json"
        prompt_path = self.tmp / "prompt.md"
        prompt_path.write_text("# Test prompt", encoding="utf-8")
        with patch.dict(os.environ, {
            ci_executor.MOCK_MODE_ENV_VAR: "0",
            "CLAUDE_CLI_BINARY": "__aria_missing_claude_for_test__",
        }):
            with self.assertRaises(ci_executor.ClaudeCliUnavailable) as ctx:
                # Plan 025 §B — role is now a required keyword (no
                # default); pass a real-shaped role here. The
                # ClaudeCliUnavailable branch does NOT consume role
                # but the function signature requires it.
                ci_executor.invoke_claude_cli(
                    request_id="REQ-test-2",
                    subagent_type="aria-evidence-judge",
                    prompt_file=prompt_path,
                    output_path=out_path,
                    timeout_seconds=300,
                    role="evidence_judgment",
                )
        # Plan ARIA-V3 §B1 — spike doc was promoted to proven-contract
        # doc (DEBT-2026-05-08-001 retired by commit cf30da50). The
        # ClaudeCliUnavailable message now cites the load-bearing
        # proven-contract doc as the argv SSoT instead of the
        # spike-era "contract gap" language.
        self.assertIn("claude", str(ctx.exception))
        self.assertIn("ci_executor_contract_proven.md", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
