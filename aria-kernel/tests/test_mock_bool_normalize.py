"""Plan 026R §B.2 — _is_mock_mode case-insensitive multi-token bool.

4 tests:

* Truthy values: 1, true, TRUE, yes, YES, on, ON.
* Falsy values: 0, false, FALSE, no, off, empty string.
* Invalid values raise ClaudePolicyViolation (no silent fallback).
* Workflow default ``CLAUDE_CLI_MOCK=true`` activates mock mode (the
  pre-§B.2 silent fail).
"""
from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch


ARIA_POC = Path(__file__).resolve().parent.parent.parent / "tools" / "aria-poc"


def _load_ci_executor():
    spec = importlib.util.spec_from_file_location(
        "ci_executor", ARIA_POC / "ci_executor.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class MockBoolNormalizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ci = _load_ci_executor()

    def test_truthy_values_accept(self) -> None:
        for val in ("1", "true", "TRUE", "True", "yes", "YES", "on", "ON"):
            with patch.dict(os.environ, {self.ci.MOCK_MODE_ENV_VAR: val}):
                self.assertTrue(
                    self.ci._is_mock_mode(),
                    f"value {val!r} should activate mock mode",
                )

    def test_falsy_values_reject(self) -> None:
        for val in ("0", "false", "FALSE", "False", "no", "NO", "off", "OFF", ""):
            with patch.dict(os.environ, {self.ci.MOCK_MODE_ENV_VAR: val}):
                self.assertFalse(
                    self.ci._is_mock_mode(),
                    f"value {val!r} should NOT activate mock mode",
                )

    def test_invalid_value_raises(self) -> None:
        with patch.dict(os.environ, {self.ci.MOCK_MODE_ENV_VAR: "maybe"}):
            with self.assertRaises(self.ci.ClaudePolicyViolation) as ctx:
                self.ci._is_mock_mode()
            self.assertIn("not a valid boolean", str(ctx.exception))
        with patch.dict(os.environ, {self.ci.MOCK_MODE_ENV_VAR: "1f"}):
            with self.assertRaises(self.ci.ClaudePolicyViolation):
                self.ci._is_mock_mode()

    def test_workflow_default_true_activates_mock(self) -> None:
        # The today's-CI workflow exports CLAUDE_CLI_MOCK=true; pre-§B.2
        # this silently fell to mock=OFF + ClaudeCliUnavailable raise.
        # Post-§B.2 the value parses to True.
        with patch.dict(os.environ, {self.ci.MOCK_MODE_ENV_VAR: "true"}):
            self.assertTrue(self.ci._is_mock_mode())


if __name__ == "__main__":
    unittest.main()
