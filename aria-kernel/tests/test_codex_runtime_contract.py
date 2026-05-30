"""Codex CLI runtime contract tests."""
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

import codex_runtime  # noqa: E402


class CodexRuntimeContractTests(unittest.TestCase):
    def test_exec_argv_pins_json_and_xhigh(self) -> None:
        argv = codex_runtime.build_codex_exec_argv()
        self.assertEqual(
            argv,
            [
                "codex",
                "exec",
                "--json",
                "-c",
                'model_reasoning_effort="xhigh"',
            ],
        )

    def test_api_key_mode_rejected_by_default(self) -> None:
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test-secret"}, clear=False):
            with self.assertRaises(codex_runtime.CodexPolicyViolation):
                codex_runtime.assert_codex_policy_environment()

    def test_jsonl_final_message_and_usage_extracted(self) -> None:
        raw = "\n".join(
            [
                '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
                '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}',
                '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
            ]
        )
        events = codex_runtime.parse_codex_jsonl(raw)
        self.assertEqual(codex_runtime.extract_final_message(events), "final")
        self.assertEqual(
            codex_runtime.extract_usage(events),
            {"input_tokens": 10, "output_tokens": 3},
        )


if __name__ == "__main__":
    unittest.main()
