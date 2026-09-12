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

The distinction these tests pin is not cosmetic. Credit exhaustion is a
quota fact about one provider and clears with time (the request waits it out
under the provider cooldown — operator decision 2026-09-12, never a weaker
tier); a refusal is content specific and is escalated. An expired session is a
CREDENTIAL fact: every tier of the same vendor shares it, so retrying in the
same vendor is two attempts spent to learn the same thing, and then reporting
the second failure as though it were the cause. The only honest retry is on
another vendor (ARIA-HIGH-023), and only for a role its runtime can serve.
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
            cr.run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False)

        # ARIA-HIGH-023 revised the single-attempt rule: every same-vendor
        # tier shares the dead credential, so the ONLY honest second attempt
        # is a CROSS-provider one — and when that also fails auth the failure
        # is terminal and names both tiers. Two attempts means exactly one
        # cross-vendor retry; more would be chaining, none would hide a
        # curable vendor outage behind a terminal error.
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0][0], "opus")
        self.assertEqual(attempts[1][0], "glm-5.3")

    def test_a_write_scope_role_gets_no_second_attempt(self) -> None:
        # The other vendors' runtimes are read-only: an implementer whose
        # session expired is terminal after ONE attempt, in those words.
        attempts: list[tuple[str, str]] = []

        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            attempts.append((model, effort))
            return _result(
                returncode=1,
                stderr="Failed to authenticate: OAuth session expired",
                auth_failure={"kind": "auth_failure", "marker": "oauth session expired", "remedy": "re-authenticate"},
            )

        with self.assertRaises(cr.ClaudeAuthFailure) as raised:
            cr.run_with_model_fallback(run=run, model="opus", effort="max", write_capable=True)
        self.assertEqual(attempts, [("opus", "max")])
        self.assertIn("write-scope", str(raised.exception))

    def test_credit_exhaustion_is_terminal_not_retried(self) -> None:
        # Operator decision 2026-09-12: the branch in front of this one must
        # not resurrect a downgrade — an exhausted opus raises after one call.
        attempts: list[tuple[str, str]] = []

        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            attempts.append((model, effort))
            return _result(returncode=1, credit_exhaustion={"marker": "credit balance"})

        with self.assertRaises(cr.ClaudeCreditExhausted) as raised:
            cr.run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False)
        self.assertEqual(attempts, [("opus", "high")])
        self.assertEqual(raised.exception.provider, "anthropic")

    def test_a_healthy_run_is_untouched(self) -> None:
        def run(model: str, effort: str) -> cr.ClaudeRunResult:
            return _result(returncode=0, final_message="ok")

        self.assertEqual(
            cr.run_with_model_fallback(run=run, model="opus", effort="high", write_capable=True).returncode, 0,
        )


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

        # The reason may be one constant, or a conditional choosing between
        # constants (the native-runtime lane names its own condition); what
        # is forbidden is any reason that is not a specific constant at all.
        reason_expressions = [
            keyword.value
            for node in ast.walk(handlers[0])
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_release_claim"
            for keyword in node.keywords
            if keyword.arg == "reason"
        ]
        self.assertEqual(len(reason_expressions), 1, "exactly one release in the handler")
        reasons = sorted({
            node.value for node in ast.walk(reason_expressions[0])
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        })

        # A generic reason here is what made five nights of failures look like
        # five agent crashes.
        self.assertEqual(reasons, ["claude_cli_auth_failure", "native_runtime_execution_unavailable"])


if __name__ == "__main__":
    unittest.main()
