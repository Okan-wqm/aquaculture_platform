"""An agent runtime that cannot start must say so, in those words.

Measured on the production runner, 2026-08-08:

    $ sudo -u gharunner claude -p "say OK"
    Failed to authenticate: OAuth session expired and could not be refreshed

Every nightly executor run from 2026-08-04 to 2026-08-08 failed on that, and
every one of them recorded the same thing a crashed agent records: `claude exec
exited 1`, claim released as `claude_cli_exit_1`. So ARIA kept minting agent
requests into a runtime that could not start, the judgment → consensus →
calibration → gold-corpus chain stayed empty, and the reason was visible only
to someone who ran the CLI by hand as the runner user.

The distinction these tests pin is not cosmetic. Credit exhaustion is
model-pool specific and a lower tier can clear it; a refusal is content
specific and another model can clear it. An expired session clears on NEITHER —
every tier authenticates through the same credential — so retrying is two
attempts spent to learn the same thing, and then reporting the second failure
as though it were the cause.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))

import claude_runtime as cr  # noqa: E402


def _result(**kwargs) -> cr.ClaudeRunResult:
    base = {
        "returncode": 0,
        "stdout": "",
        "stderr": "",
        "final_message": "",
        "usage": None,
        "events": (),
    }
    base.update(kwargs)
    return cr.ClaudeRunResult(**base)


class AuthFailureDetectionTest(unittest.TestCase):
    def test_names_the_message_production_actually_emitted(self) -> None:
        detected = cr.extract_auth_failure(
            returncode=1,
            stdout="",
            stderr="Failed to authenticate: OAuth session expired and could not be refreshed",
            final_message="",
        )

        self.assertIsNotNone(detected)
        assert detected is not None
        self.assertEqual(detected["kind"], "auth_failure")
        # The remedy travels with the detection: a human clears this one, and
        # 03:00 is the wrong time to go looking for which runbook says how.
        self.assertIn("re-authenticate", detected["remedy"])

    def test_a_clean_exit_is_never_an_auth_failure(self) -> None:
        # An agent writing ABOUT authentication must not be read as the runtime
        # failing to start. The nonzero-exit requirement is what separates them.
        self.assertIsNone(
            cr.extract_auth_failure(
                returncode=0,
                stdout="the handler raises when the oauth session expired",
                stderr="",
                final_message="",
            )
        )

    def test_an_ordinary_failure_is_left_alone(self) -> None:
        self.assertIsNone(
            cr.extract_auth_failure(
                returncode=1, stdout="", stderr="segmentation fault", final_message=""
            )
        )


class AuthFailureIsNotRetriedTest(unittest.TestCase):
    def test_raises_instead_of_returning_a_result_that_reads_like_an_answer(self) -> None:
        attempts: list[tuple[str, str]] = []

        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            attempts.append((model, effort))
            return _result(
                returncode=1,
                stderr="Failed to authenticate: OAuth session expired",
                auth_failure={"kind": "auth_failure", "marker": "oauth session expired", "remedy": "re-authenticate"},
            )

        with self.assertRaises(cr.ClaudeAuthFailure):
            cr.run_with_model_fallback(run=run, model="fable", effort="high")

        # Exactly one attempt: the fallback tier authenticates through the same
        # credential, so a second try can only fail the same way and would then
        # be the failure the caller sees.
        self.assertEqual(len(attempts), 1)

    def test_credit_exhaustion_still_falls_back(self) -> None:
        # The new branch must not swallow the behaviour it sits in front of.
        attempts: list[tuple[str, str]] = []

        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            attempts.append((model, effort))
            if len(attempts) == 1:
                return _result(returncode=1, credit_exhaustion={"marker": "credit balance"})
            return _result(returncode=0, final_message="ok")

        out = cr.run_with_model_fallback(run=run, model="fable", effort="high")

        self.assertEqual(out.returncode, 0)
        self.assertEqual(len(attempts), 2)

    def test_a_healthy_run_is_untouched(self) -> None:
        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            return _result(returncode=0, final_message="ok")

        self.assertEqual(cr.run_with_model_fallback(run=run, model="opus", effort="high").returncode, 0)


class ExecutorReleasesUnderItsOwnReasonTest(unittest.TestCase):
    def test_the_handler_releases_the_claim_under_its_own_reason(self) -> None:
        """Node-shape, not text: Plan 026R §H.1 forbids asserting on source
        markers, and it is right to — a string match passes on a handler that
        was commented out. This parses the module and looks for the actual
        `except ClaudeAuthFailure` node, then for a `_release_claim` call
        inside it whose `reason` is the distinct one. Constructing a full
        dispatch instead would mock the very boundary under test.
        """
        import ast

        source = (
            Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)

        handlers = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ExceptHandler)
            and isinstance(node.type, ast.Name)
            and node.type.id == "ClaudeAuthFailure"
        ]
        self.assertEqual(len(handlers), 1, "exactly one auth-failure handler")

        reasons = [
            keyword.value.value
            for node in ast.walk(handlers[0])
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_release_claim"
            for keyword in node.keywords
            if keyword.arg == "reason" and isinstance(keyword.value, ast.Constant)
        ]

        # A generic reason here is what made five nights of failures look like
        # five agent crashes.
        self.assertEqual(reasons, ["claude_cli_auth_failure"])


if __name__ == "__main__":
    unittest.main()
