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

    # The LIVE managed-session failure mode (proven 2026-07-03: ARIA's Fable
    # pool ran dry). The CLI returns its limit notice as ASSISTANT CONTENT on
    # a CLEAN exit (returncode 0, zero tokens) — a returncode!=0 gate misses
    # it, which is exactly why #849's first markers did not fire.
    _LIVE_LIMIT = (
        "You've reached your Fable 5 limit. Run /usage-credits to continue "
        "or switch models with /model."
    )

    def test_detects_live_usage_limit_message_on_clean_exit(self) -> None:
        marker = claude_runtime.extract_credit_exhaustion(
            returncode=0, stderr="", events=(), final_message=self._LIVE_LIMIT,
        )
        self.assertIsNotNone(marker)
        self.assertEqual(marker["source"], "cli_usage_limit_message")
        self.assertEqual(marker["matched_marker"], "usage-credits")

    def test_detects_live_usage_limit_in_assistant_event(self) -> None:
        events = (
            {"type": "assistant", "message": {"content": [{"type": "text", "text": self._LIVE_LIMIT}]}},
            {"type": "result", "subtype": "success", "result": self._LIVE_LIMIT},
        )
        self.assertIsNotNone(claude_runtime.extract_credit_exhaustion(returncode=0, stderr="", events=events))

    def test_clean_plan_mentioning_billing_is_not_credit(self) -> None:
        # An API credit-error marker in CONTENT on a clean exit must NOT fire —
        # only the (returncode!=0) error path matches those.
        self.assertIsNone(
            claude_runtime.extract_credit_exhaustion(
                returncode=0, stderr="", events=(),
                final_message="This plan refactors the billing-service quota module.",
            ),
        )

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


class WriteContainmentTests(unittest.TestCase):
    """ORPHAN-CRITICAL-427 — containment is applied by the spawner.

    Pre-fix ``wrap_bash_in_sandbox`` had no kernel caller and returned argv
    unchanged when no backend existed, so a write-capable agent always ran
    unconfined and READONLY_PATHS were protected only by prose in the
    agent's own instruction file — text addressed to the process being
    contained.
    """

    _ARGV = ["claude", "-p", "--model", "opus"]

    def test_resource_limits_are_applied_by_the_spawner(self) -> None:
        """ORPHAN-MEDIUM-459 — the perimeter half that had no caller.

        `apply_resource_limits` shipped with the sandbox work, was exported,
        was name-pinned by an invariant, and nothing in production called it.
        The only instruction to run it lived in
        `.claude/agents/aria-implementer.md` — prose addressed to the process
        being limited, which is the exact mistake ORPHAN-CRITICAL-427 fixed
        for containment. A fork bomb or runaway allocation in a
        write-capable agent was bounded by nothing.
        """
        import claude_runtime as cr

        limited = cr._apply_resource_limits(["bwrap", "--", "claude"], timeout_seconds=900)
        self.assertNotEqual(limited, ["bwrap", "--", "claude"])
        # Whichever mechanism the host offers, the ORIGINAL argv must survive
        # intact as the tail — limits wrap, they never replace.
        self.assertEqual(limited[-3:], ["bwrap", "--", "claude"])
        self.assertIn(limited[0], {"systemd-run", "timeout"})

    def test_resource_limits_honour_the_callers_timeout(self) -> None:
        """A 120s default would kill every real agent run.

        `apply_resource_limits` defaults to 120 seconds; an agent invocation
        is minutes. The spawner must pass its own `timeout_seconds` through,
        so the limit is the one the caller chose.
        """
        import claude_runtime as cr

        limited = cr._apply_resource_limits(["claude"], timeout_seconds=900)
        self.assertTrue(
            any("900" in token for token in limited),
            msg=f"the caller's timeout did not reach the limiter: {limited}",
        )

    def test_run_claude_exec_applies_limits_after_containment(self) -> None:
        """Order is load-bearing: `timeout`/`systemd-run` must own the whole
        tree including bwrap, so the limits go OUTSIDE the sandbox wrapper."""
        import ast

        source = (
            _REPO_ROOT / "tools" / "aria-poc" / "claude_runtime.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        fn = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "run_claude_exec"
        )
        called = [
            node.func.id
            for node in ast.walk(fn)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        ]
        self.assertIn("_apply_write_containment", called)
        self.assertIn("_apply_resource_limits", called)
        self.assertLess(
            called.index("_apply_write_containment"),
            called.index("_apply_resource_limits"),
            msg="limits must wrap the sandboxed argv, not be wrapped by it",
        )

    def test_read_only_shapes_need_no_containment(self) -> None:
        for permission_mode, skip in ((None, False), ("plan", True), ("default", True)):
            with self.subTest(permission_mode=permission_mode, skip=skip):
                self.assertFalse(
                    claude_runtime._is_write_capable(
                        skip_permissions=skip, permission_mode=permission_mode,
                    ),
                )
                self.assertEqual(
                    claude_runtime._apply_write_containment(
                        list(self._ARGV),
                        skip_permissions=skip,
                        permission_mode=permission_mode,
                        workspace_root=None,
                    ),
                    self._ARGV,
                )

    def test_write_capable_shapes_are_identified(self) -> None:
        for permission_mode, skip in (
            (None, True), ("bypassPermissions", False), ("acceptEdits", False),
        ):
            with self.subTest(permission_mode=permission_mode, skip=skip):
                self.assertTrue(
                    claude_runtime._is_write_capable(
                        skip_permissions=skip, permission_mode=permission_mode,
                    ),
                )

    def test_write_capable_spawn_refused_without_sandbox_backend(self) -> None:
        from aria_kernel import implementation_safety

        with patch.object(implementation_safety, "_bwrap_available", return_value=False), \
             patch.dict(os.environ, {claude_runtime.UNCONFINED_ACK_ENV_VAR: "0"}):
            with self.assertRaises(claude_runtime.ClaudePolicyViolation) as ctx:
                claude_runtime._apply_write_containment(
                    list(self._ARGV),
                    skip_permissions=True,
                    permission_mode=None,
                    workspace_root=_REPO_ROOT,
                )
        self.assertIn("claude_write_containment_required", str(ctx.exception))

    def test_write_capable_spawn_is_wrapped_when_backend_present(self) -> None:
        from aria_kernel import implementation_safety

        with patch.object(implementation_safety, "_bwrap_available", return_value=True):
            wrapped = claude_runtime._apply_write_containment(
                list(self._ARGV),
                skip_permissions=True,
                permission_mode=None,
                workspace_root=_REPO_ROOT,
            )
        self.assertEqual(wrapped[0], "bwrap")
        self.assertEqual(wrapped[-len(self._ARGV):], self._ARGV)
        # The agent must reach the Claude API, so the network is NOT unshared —
        # the property bought here is filesystem containment.
        self.assertNotIn("--unshare-net", wrapped)
        # READONLY_PATHS that exist are ro-bind, so a write under them EROFSes.
        ro_targets = {
            wrapped[i + 1] for i, tok in enumerate(wrapped) if tok == "--ro-bind"
        }
        self.assertTrue(
            any("aria-kernel" in t for t in ro_targets),
            msg=f"aria-kernel not ro-bind; ro targets={sorted(ro_targets)}",
        )

    def test_operator_ack_permits_unconfined_write(self) -> None:
        """The escape hatch exists but must be named, never inferred."""
        from aria_kernel import implementation_safety

        with patch.object(implementation_safety, "_bwrap_available", return_value=False), \
             patch.dict(os.environ, {claude_runtime.UNCONFINED_ACK_ENV_VAR: "1"}):
            self.assertEqual(
                claude_runtime._apply_write_containment(
                    list(self._ARGV),
                    skip_permissions=True,
                    permission_mode=None,
                    workspace_root=_REPO_ROOT,
                ),
                self._ARGV,
            )

    def test_sandbox_helper_raises_rather_than_returning_bare_argv(self) -> None:
        from aria_kernel.implementation_safety import (
            SandboxUnavailable,
            sandbox_backend,
            wrap_bash_in_sandbox,
        )
        from aria_kernel import implementation_safety

        # ORPHAN-CRITICAL-451 — one patch, because bwrap is now the only
        # backend. firejail used to be the second, and it applied none of
        # the READONLY_PATHS while still making sandbox_backend() non-None.
        with patch.object(implementation_safety, "_bwrap_available", return_value=False):
            self.assertIsNone(sandbox_backend())
            with self.assertRaises(SandboxUnavailable):
                wrap_bash_in_sandbox(
                    ["echo", "hi"], workspace_root=_REPO_ROOT, allow_network=False,
                )
