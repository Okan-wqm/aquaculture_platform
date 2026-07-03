"""Claude Code CLI runtime contract tests.

Validated against the real Claude Code CLI stream-json event shape
(`system` / `assistant` / `result`) — the `result` event carries the final
text in `result` and token usage in `usage`.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import claude_runtime  # noqa: E402


class ClaudeRuntimeContractTests(unittest.TestCase):
    def test_exec_argv_pins_stream_json_and_model(self) -> None:
        argv = claude_runtime.build_claude_exec_argv(model="opus")
        self.assertEqual(
            argv,
            [
                "claude",
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "opus",
                "--dangerously-skip-permissions",
            ],
        )

    def test_exec_argv_defaults_to_fable(self) -> None:
        # K5 tier flip — the fail-safe default is the most capable tier.
        argv = claude_runtime.build_claude_exec_argv()
        self.assertIn("--model", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "fable")

    def test_exec_argv_read_only_omits_skip_permissions(self) -> None:
        argv = claude_runtime.build_claude_exec_argv(model="opus", skip_permissions=False)
        self.assertNotIn("--dangerously-skip-permissions", argv)

    def test_api_key_mode_rejected_by_default(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-test-secret"}, clear=False):
            with self.assertRaises(claude_runtime.ClaudePolicyViolation):
                claude_runtime.assert_claude_policy_environment()

    def test_proxy_billing_mode_rejected_by_default(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_BASE_URL": "https://proxy.example"}, clear=False):
            with self.assertRaises(claude_runtime.ClaudePolicyViolation):
                claude_runtime.assert_claude_policy_environment()

    def test_api_key_mode_allowed_under_explicit_policy(self) -> None:
        env = {"ANTHROPIC_API_KEY": "sk-ant-test", "ARIA_ALLOW_CLAUDE_API_KEY_MODE": "1"}
        with patch.dict(os.environ, env, clear=False):
            claude_runtime.assert_claude_policy_environment()  # must not raise

    def test_stream_json_final_message_and_usage_extracted(self) -> None:
        raw = "\n".join(
            [
                '{"type":"system","subtype":"init","model":"claude-opus-4-8"}',
                '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking out loud"}]}}',
                '{"type":"result","subtype":"success","result":"final",'
                '"usage":{"input_tokens":10,"output_tokens":3}}',
            ]
        )
        events = claude_runtime.parse_claude_jsonl(raw)
        self.assertEqual(claude_runtime.extract_final_message(events), "final")
        self.assertEqual(
            claude_runtime.extract_usage(events),
            {"input_tokens": 10, "output_tokens": 3},
        )

    def test_assistant_fallback_when_no_result_text(self) -> None:
        raw = '{"type":"assistant","message":{"content":[{"type":"text","text":"only-assistant"}]}}'
        events = claude_runtime.parse_claude_jsonl(raw)
        self.assertEqual(claude_runtime.extract_final_message(events), "only-assistant")

    # ── autonomous-write permission shapes (ADR-040) ─────────────────────────
    def test_permission_mode_argv_replaces_dangerous_bypass(self) -> None:
        argv = claude_runtime.build_claude_exec_argv(model="opus", permission_mode="bypassPermissions")
        self.assertIn("--permission-mode", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "bypassPermissions")
        self.assertNotIn("--dangerously-skip-permissions", argv)

    def test_invalid_permission_mode_rejected(self) -> None:
        with self.assertRaises(claude_runtime.ClaudePolicyViolation):
            claude_runtime.build_claude_exec_argv(model="opus", permission_mode="yolo")

    def test_full_bypass_under_root_fails_closed(self) -> None:
        with patch.object(claude_runtime, "_running_as_root", return_value=True), \
                patch.dict(os.environ, {"ARIA_CLAUDE_SANDBOX": "0", "IS_SANDBOX": "0"}, clear=False):
            with self.assertRaises(claude_runtime.ClaudePolicyViolation) as ctx:
                claude_runtime.assert_write_runner_ok(skip_permissions=True, permission_mode=None)
            self.assertIn("non-root", str(ctx.exception))

    def test_full_bypass_under_root_allowed_in_acknowledged_sandbox(self) -> None:
        with patch.object(claude_runtime, "_running_as_root", return_value=True), \
                patch.dict(os.environ, {"ARIA_CLAUDE_SANDBOX": "1"}, clear=False):
            claude_runtime.assert_write_runner_ok(skip_permissions=True, permission_mode=None)  # no raise

    def test_full_bypass_non_root_is_allowed(self) -> None:
        with patch.object(claude_runtime, "_running_as_root", return_value=False):
            claude_runtime.assert_write_runner_ok(skip_permissions=True, permission_mode=None)  # no raise

    def test_accept_edits_mode_under_root_is_allowed(self) -> None:
        # acceptEdits is NOT root-blocked (verified live: it writes files as root).
        with patch.object(claude_runtime, "_running_as_root", return_value=True), \
                patch.dict(os.environ, {"ARIA_CLAUDE_SANDBOX": "0", "IS_SANDBOX": "0"}, clear=False):
            claude_runtime.assert_write_runner_ok(skip_permissions=True, permission_mode="acceptEdits")

    def test_bypass_permissions_mode_under_root_fails_closed(self) -> None:
        # bypassPermissions is root-blocked by the CLI exactly like the full bypass.
        with patch.object(claude_runtime, "_running_as_root", return_value=True), \
                patch.dict(os.environ, {"ARIA_CLAUDE_SANDBOX": "0", "IS_SANDBOX": "0"}, clear=False):
            with self.assertRaises(claude_runtime.ClaudePolicyViolation):
                claude_runtime.assert_write_runner_ok(skip_permissions=True, permission_mode="bypassPermissions")

    def test_read_only_turn_under_root_is_allowed(self) -> None:
        with patch.object(claude_runtime, "_running_as_root", return_value=True), \
                patch.dict(os.environ, {"ARIA_CLAUDE_SANDBOX": "0", "IS_SANDBOX": "0"}, clear=False):
            claude_runtime.assert_write_runner_ok(skip_permissions=False, permission_mode=None)  # no raise


if __name__ == "__main__":
    unittest.main()


class EffortArgvTests(unittest.TestCase):
    """K1 — the CLI ``--effort`` lever (ORPHAN-HIGH-283)."""

    def test_exec_argv_includes_effort_when_supplied(self) -> None:
        argv = claude_runtime.build_claude_exec_argv(model="fable", effort="xhigh")
        self.assertIn("--effort", argv)
        self.assertEqual(argv[argv.index("--effort") + 1], "xhigh")
        self.assertEqual(argv[argv.index("--model") + 1], "fable")

    def test_exec_argv_omits_effort_when_absent(self) -> None:
        argv = claude_runtime.build_claude_exec_argv(model="opus")
        self.assertNotIn("--effort", argv)

    def test_exec_argv_rejects_invalid_effort(self) -> None:
        with self.assertRaises(claude_runtime.ClaudePolicyViolation):
            claude_runtime.build_claude_exec_argv(model="opus", effort="turbo")

    def test_valid_models_includes_fable(self) -> None:
        self.assertIn("fable", claude_runtime.VALID_MODELS)
        self.assertIn("max", claude_runtime.VALID_EFFORTS)


class RefusalDetectionTests(unittest.TestCase):
    """K2 — model-safety refusal detection (ORPHAN-HIGH-284)."""

    def test_detects_assistant_stop_reason_refusal(self) -> None:
        events = (
            {"type": "system", "subtype": "init", "model": "claude-fable-5"},
            {
                "type": "assistant",
                "message": {
                    "stop_reason": "refusal",
                    "model": "claude-fable-5",
                    "stop_details": {"category": "cyber", "explanation": "declined"},
                },
            },
            {"type": "result", "subtype": "success", "is_error": False},
        )
        refusal = claude_runtime.extract_refusal(events)
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal["source"], "assistant_stop_reason")
        self.assertEqual(refusal["category"], "cyber")

    def test_detects_result_subtype_refusal(self) -> None:
        events = (
            {"type": "result", "subtype": "error_refusal", "result": "declined"},
        )
        refusal = claude_runtime.extract_refusal(events)
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal["source"], "result_subtype")

    def test_clean_run_yields_no_refusal(self) -> None:
        events = (
            {"type": "system", "subtype": "init", "model": "claude-fable-5"},
            {
                "type": "assistant",
                "message": {"stop_reason": None, "model": "claude-fable-5"},
            },
            {"type": "result", "subtype": "success", "is_error": False},
        )
        self.assertIsNone(claude_runtime.extract_refusal(events))


class CreditExhaustionDetectionTests(unittest.TestCase):
    """Credit/quota-exhaustion detection — the fable→opus fallback trigger."""

    def test_detects_credit_balance_in_stderr(self) -> None:
        marker = claude_runtime.extract_credit_exhaustion(
            returncode=1,
            stderr="Error: Your credit balance is too low to run this request.",
            events=(),
        )
        self.assertIsNotNone(marker)
        self.assertEqual(marker["matched_marker"], "credit balance")
        self.assertEqual(marker["returncode"], 1)

    def test_detects_quota_in_result_event(self) -> None:
        events = (
            {"type": "result", "subtype": "error_during_execution", "result": "quota exceeded for this account"},
        )
        marker = claude_runtime.extract_credit_exhaustion(returncode=2, stderr="", events=events)
        self.assertIsNotNone(marker)
        self.assertEqual(marker["matched_marker"], "quota exceeded")

    def test_detects_payment_required_and_billing(self) -> None:
        self.assertIsNotNone(
            claude_runtime.extract_credit_exhaustion(returncode=1, stderr="HTTP 402 Payment Required", events=()),
        )
        self.assertIsNotNone(
            claude_runtime.extract_credit_exhaustion(returncode=1, stderr="billing account is not active", events=()),
        )

    def test_clean_returncode_is_never_credit_exhaustion(self) -> None:
        # returncode 0 gate — a clean run whose TEXT happens to mention credit
        # (e.g. the agent wrote about a billing feature) must not misfire.
        self.assertIsNone(
            claude_runtime.extract_credit_exhaustion(
                returncode=0, stderr="credit balance", events=(),
            ),
        )

    def test_transient_signals_are_not_credit_exhaustion(self) -> None:
        # Overload / bare rate-limit / network stay on the requeue path.
        for stderr in ("API overloaded, please retry", "rate_limit: 429 too many requests", "network timeout"):
            self.assertIsNone(
                claude_runtime.extract_credit_exhaustion(returncode=1, stderr=stderr, events=()),
                stderr,
            )

    def test_insufficient_permissions_is_not_credit(self) -> None:
        # "insufficient permissions" is an auth error, not a credit error —
        # the markers are credit/quota/funds-specific, never bare "insufficient".
        self.assertIsNone(
            claude_runtime.extract_credit_exhaustion(
                returncode=1, stderr="insufficient permissions for this tool", events=(),
            ),
        )

    def test_run_result_defaults_credit_exhaustion_to_none(self) -> None:
        result = claude_runtime.ClaudeRunResult(
            returncode=0, stdout="", stderr="", final_message="", usage={}, events=(),
        )
        self.assertIsNone(result.credit_exhaustion)

    def test_markers_are_credit_specific_not_transient(self) -> None:
        blob = " ".join(claude_runtime.CREDIT_EXHAUSTION_MARKERS)
        self.assertIn("credit balance", claude_runtime.CREDIT_EXHAUSTION_MARKERS)
        for forbidden in ("overloaded", "429", "timeout", "network"):
            self.assertNotIn(forbidden, blob)
