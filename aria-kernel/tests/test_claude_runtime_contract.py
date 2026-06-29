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

    def test_exec_argv_defaults_to_opus(self) -> None:
        argv = claude_runtime.build_claude_exec_argv()
        self.assertIn("--model", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "opus")

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


if __name__ == "__main__":
    unittest.main()
