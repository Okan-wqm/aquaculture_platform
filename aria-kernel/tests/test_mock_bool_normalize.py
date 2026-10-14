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
    from tests._helpers.executor_module import load_ci_executor

    return load_ci_executor("ci_executor")


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


class WorkerExecutorMockBoolTests(unittest.TestCase):
    """ARIA-MEDIUM-463 — the worker lane reads CLAUDE_CLI_MOCK through the same parser.

    worker_executor kept its own truthy-set check, so an unknown value
    silently read as mock OFF on the worker lane while the CI lane raised.
    """

    def setUp(self) -> None:
        import sys

        if str(ARIA_POC) not in sys.path:
            sys.path.insert(0, str(ARIA_POC))
        import claude_runtime
        import worker_executor

        self.worker = worker_executor
        self.env_var = claude_runtime.CLAUDE_MOCK_ENV_VAR
        self.violation = claude_runtime.ClaudePolicyViolation

    def test_unknown_value_raises(self) -> None:
        with patch.dict(os.environ, {self.env_var: "maybe"}):
            with self.assertRaises(self.violation):
                self.worker._is_mock_mode()

    def test_known_values_parse(self) -> None:
        with patch.dict(os.environ, {self.env_var: "true"}):
            self.assertTrue(self.worker._is_mock_mode())
        with patch.dict(os.environ, {self.env_var: "0"}):
            self.assertFalse(self.worker._is_mock_mode())


if __name__ == "__main__":
    unittest.main()
