"""ARIA-HIGH-188 — a failed native Claude attempt records its cause.

On ``origin/aria/state`` 227 native Claude attempts ended ``provider_nonzero``
(exit 1) against 100 successes, and every ``runtime_attempt_finished`` row
carried only ``exit_code`` and ``result_admission``: ``invoke_claude_cli``
returned a bare int, the classified ``DispatchFailure`` went to the dispatch
summary file only, and the child's stderr went to ``sys.stderr`` only.

These tests pin:
1. ``_bounded_stderr_tail`` keeps the LAST bytes, bounds them, scrubs secrets
   and redacts the lease token the executor holds.
2. ``invoke_claude_cli``'s one terminal-summary seam hands its outcome to an
   ``on_outcome`` observer (mock path: success, no failure).
3. ``_invoke_native_claude`` writes the observed outcome — failure class,
   detail code and the bounded tail — on the ``runtime_attempt_finished`` row
   when the spawn exits non-zero.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


class BoundedStderrTailTests(unittest.TestCase):
    def test_keeps_the_last_bytes_within_the_bound(self) -> None:
        tail = ci_executor._bounded_stderr_tail("x" * 5000 + "LAST-WORDS")
        self.assertTrue(tail.endswith("LAST-WORDS"))
        self.assertLessEqual(len(tail), ci_executor.STDERR_TAIL_MAX_CHARS)

    def test_scrubs_secrets_and_the_held_lease(self) -> None:
        lease = "lease-" + "a" * 40
        stderr = f"boom token=ghp_{'A' * 36} lease={lease}"
        with patch.dict(os.environ, {ci_executor.LEASE_TOKEN_ENV_VAR: lease}):
            tail = ci_executor._bounded_stderr_tail(stderr)
        self.assertNotIn("ghp_" + "A" * 36, tail)
        self.assertNotIn(lease, tail)
        self.assertIn("<lease-token-redacted>", tail)

    def test_empty_stderr_is_none(self) -> None:
        self.assertIsNone(ci_executor._bounded_stderr_tail(""))
        self.assertIsNone(ci_executor._bounded_stderr_tail(None))


class InvokeClaudeCliOutcomeTests(unittest.TestCase):
    def test_mock_success_reports_no_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prompt = Path(tmp) / "prompt.md"
            prompt.write_text("# prompt", encoding="utf-8")
            seen: list[dict[str, Any] | None] = []
            with patch.dict(os.environ, {ci_executor.MOCK_MODE_ENV_VAR: "1"}):
                code = ci_executor.invoke_claude_cli(
                    request_id="REQ-outcome-1",
                    subagent_type="aria-evidence-judge",
                    prompt_file=prompt,
                    output_path=Path(tmp) / "out.json",
                    timeout_seconds=60,
                    claim_id="claim_test_aaaaaaaa",
                    agent_id="ci-executor:gha-test",
                    role="evidence_judgment",
                    must_satisfy=[],
                    on_outcome=seen.append,
                )
        self.assertEqual(code, 0)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["outcome"], "succeeded")
        self.assertIsNone(seen[0]["failure_class"])


class NativeAttemptRowCarriesCauseTests(unittest.TestCase):
    def test_nonzero_exit_records_class_detail_and_tail(self) -> None:
        rows: list[tuple[str, dict[str, Any]]] = []

        def fake_invoke(**kwargs: Any) -> int:
            kwargs["on_outcome"]({
                "outcome": "failed",
                "failure_class": "process_exit",
                "detail_code": "claude_exit_1",
                "retryable": True,
                "exit_code": 1,
                "stderr_tail": "Failed to connect to bus: No medium found",
            })
            return 1

        class _Plan:
            route = {"provider": "anthropic", "runtime": "claude", "model": "opus", "effort": "max"}
            observation = {"auth_method": "subscription", "pricing": {}}
            policy = type("P", (), {"policy_digest": "sha256:p"})()
            context = type("C", (), {"settings_hash": "sha256:s"})()
            admission: dict[str, Any] = {}

        request = {"role": "consensus_arbitration", "request_ledger_hash": "r", "claim_ledger_hash": "c"}
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(ci_executor, "invoke_claude_cli", side_effect=fake_invoke), \
                patch("aria_kernel.budget._reserve_native_runtime_attempt", return_value={"ledger_hash": "att-1"}), \
                patch("aria_kernel.tool_registry.append_tools_governance",
                      side_effect=lambda _d, kind, details: rows.append((kind, details))):
            code = ci_executor._invoke_native_claude(
                native_runtime=_Plan(), repo=Path(tmp), tools_dir=Path(tmp), request=request,
                request_id="REQ-native-1", claim_id="claim-1", agent_id="ci-executor:gha-1",
                lease_token="lease-x", target_agent="aria-consensus-arbiter", session_id="sess-1",
                prompt="p", output_path=Path(tmp) / "out.json", transcript_path=Path(tmp) / "t.jsonl",
                timeout_seconds=60, spawn_control=None, prompt_file=Path(tmp) / "p.md", resume=False,
            )
        self.assertEqual(code, 1)
        finished = [details for kind, details in rows if kind == "runtime_attempt_finished"]
        self.assertEqual(len(finished), 1)
        row = finished[0]
        self.assertEqual(row["result_admission"], "provider_nonzero")
        self.assertEqual(row["exit_code"], 1)
        self.assertEqual(row["dispatch_outcome"]["failure_class"], "process_exit")
        self.assertEqual(row["dispatch_outcome"]["detail_code"], "claude_exit_1")
        self.assertIn("No medium found", row["dispatch_outcome"]["stderr_tail"])


if __name__ == "__main__":
    unittest.main()
