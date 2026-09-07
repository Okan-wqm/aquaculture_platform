"""Behavioral coverage for model-aware auth readiness consumers."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Iterator
from unittest import mock


_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
import claude_runtime as cr  # noqa: E402
import worker_executor  # noqa: E402


_MISSING = object()
_SYNTHETIC_ENV_NAMES = (
    cr.CLAUDE_BINARY_ENV_VAR,
    cr.AUTH_PREFLIGHT_SKIP_ENV_VAR,
    cr.ALLOW_API_KEY_MODE_ENV_VAR,
    cr.PROVIDER_REDIRECT_POLICY_ENV_VAR,
    cr.CLAUDE_MOCK_ENV_VAR,
    cr.SANDBOX_ACK_ENV_VAR,
    "ARIA_ZAI_API_KEY",
    "ARIA_ZAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ARIA_CLAIM_METADATA",
    "ARIA_LEASE_TOKEN",
    "ARIA_TOOLS_DIR",
    "FAKE_CLAUDE_AUTH_MODE",
    "FAKE_CLAUDE_CALL_LOG",
)


@contextmanager
def _synthetic_environment(**overrides: str | None) -> Iterator[None]:
    """Install and explicitly restore every auth/dispatcher test variable."""
    names = set(_SYNTHETIC_ENV_NAMES) | set(overrides)
    saved = {name: os.environ.get(name, _MISSING) for name in names}
    baseline: dict[str, str | None] = {name: None for name in names}
    baseline.update(
        {
            cr.AUTH_PREFLIGHT_SKIP_ENV_VAR: "0",
            cr.ALLOW_API_KEY_MODE_ENV_VAR: "0",
            cr.CLAUDE_MOCK_ENV_VAR: "0",
            "FAKE_CLAUDE_AUTH_MODE": "managed",
        }
    )
    baseline.update(overrides)
    try:
        for name, value in baseline.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, value in saved.items():
            if value is _MISSING:
                os.environ.pop(name, None)
            else:
                os.environ[name] = str(value)


_FAKE_CLAUDE = """#!/usr/bin/env python3
import json
import os
import sys

with open(os.environ["FAKE_CLAUDE_CALL_LOG"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:] == ["--version"]:
    print("2.1.261 (Claude Code)")
    raise SystemExit(0)
if sys.argv[1:] != ["auth", "status"]:
    raise SystemExit(64)
if os.environ.get("FAKE_CLAUDE_AUTH_MODE") == "managed":
    print('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}')
else:
    print('{"loggedIn":false,"authMethod":"claude.ai","apiProvider":"firstParty"}')
"""


def _ok_result_event() -> str:
    return json.dumps(
        {
            "type": "result",
            "result": "ok",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
    ) + "\n"


class AuthConsumerRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.binary = self.tmp / "claude"
        self.binary.write_text(_FAKE_CLAUDE, encoding="utf-8")
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)
        self.call_log = self.tmp / "claude-calls.jsonl"

    def _env(self, **overrides: str | None) -> AbstractContextManager[None]:
        return _synthetic_environment(
            **{
                cr.CLAUDE_BINARY_ENV_VAR: str(self.binary),
                "FAKE_CLAUDE_CALL_LOG": str(self.call_log),
                **overrides,
            }
        )

    def _cli_calls(self) -> list[list[str]]:
        if not self.call_log.exists():
            return []
        return [json.loads(line) for line in self.call_log.read_text(encoding="utf-8").splitlines()]

    def test_authorized_redirect_reaches_real_runtime_spawn_without_managed_status(self) -> None:
        captured: dict[str, object] = {}

        def inference_boundary(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            captured["argv"] = argv
            captured["env"] = kwargs["env"]
            return subprocess.CompletedProcess(argv, 0, _ok_result_event(), "")

        with self._env(
            FAKE_CLAUDE_AUTH_MODE="false",
            ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
            ARIA_ZAI_API_KEY="synthetic-zai-key",
        ), mock.patch.object(cr, "_run_spawn", side_effect=inference_boundary):
            result = cr.run_claude_exec(
                prompt_text="synthetic prompt",
                timeout_seconds=5,
                model="glm-5.3",
                effort="max",
                require_usage=False,
                cwd=self.tmp,
                skip_permissions=False,
            )

        argv = captured["argv"]
        assert isinstance(argv, list)
        self.assertEqual(argv[argv.index("--model") + 1], "glm-5.3")
        run_env = captured["env"]
        assert isinstance(run_env, dict)
        self.assertEqual(run_env["ANTHROPIC_AUTH_TOKEN"], "synthetic-zai-key")
        self.assertEqual(result.final_message, "ok")
        self.assertEqual(self._cli_calls(), [["--version"]])

    def test_redirect_configuration_refusals_precede_spawn_even_with_skip(self) -> None:
        for policy, key, detail in (
            (None, "synthetic-zai-key", "provider_redirect_unauthorised"),
            ("policy:test", None, "provider_redirect_token_missing"),
        ):
            with self.subTest(detail=detail), self._env(
                ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP="1",
                ARIA_PROVIDER_REDIRECT_POLICY_REF=policy,
                ARIA_ZAI_API_KEY=key,
            ), mock.patch.object(cr, "_run_spawn") as spawn:
                with self.assertRaises(cr.ProviderRedirectUnavailable) as caught:
                    cr.run_claude_exec(
                        prompt_text="must not run",
                        timeout_seconds=5,
                        model="glm-5.3",
                        require_usage=False,
                        cwd=self.tmp,
                        skip_permissions=False,
                    )
                self.assertIn(detail, str(caught.exception))
                spawn.assert_not_called()

    def test_ambient_billing_denial_on_redirect_does_not_spawn_or_fallback(self) -> None:
        with self._env(
            ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
            ARIA_ZAI_API_KEY="synthetic-zai-key",
            ANTHROPIC_API_KEY="synthetic-ambient-key",
        ), mock.patch.object(cr, "_run_spawn") as spawn:
            with self.assertRaises(cr.ClaudePolicyViolation):
                cr.run_claude_exec(
                    prompt_text="must not run",
                    timeout_seconds=5,
                    model="glm-5.3",
                    require_usage=False,
                    cwd=self.tmp,
                    skip_permissions=False,
                )
            spawn.assert_not_called()

        self.assertEqual(self._cli_calls(), [])

    def test_dispatcher_does_not_convert_typed_configuration_errors_into_fallback(self) -> None:
        typed_errors = (
            cr.ClaudeCliUnavailable("no cli"),
            cr.ClaudePolicyViolation("billing denied"),
            cr.ProviderRedirectUnavailable("route denied"),
        )
        for typed_error in typed_errors:
            calls: list[str] = []

            def refuse(*, timeout_seconds: int, model: str | None) -> dict[str, object]:
                del timeout_seconds
                calls.append(str(model))
                raise typed_error

            with self.subTest(error=type(typed_error).__name__), mock.patch.object(
                cr, "preflight_claude_auth", side_effect=refuse,
            ):
                with self.assertRaises(type(typed_error)):
                    cr.preflight_claude_dispatch(model="opus")
            self.assertEqual(calls, ["opus"])

    def test_runtime_fallback_does_not_catch_typed_configuration_errors(self) -> None:
        typed_errors = (
            cr.ClaudeCliUnavailable("no cli"),
            cr.ClaudePolicyViolation("billing denied"),
            cr.ProviderRedirectUnavailable("route denied"),
        )
        for typed_error in typed_errors:
            attempts: list[tuple[str, str]] = []

            def refuse(model: str, effort: str) -> cr.ClaudeRunResult:
                attempts.append((model, effort))
                raise typed_error

            with self.subTest(error=type(typed_error).__name__):
                with self.assertRaises(type(typed_error)):
                    cr.run_with_model_fallback(run=refuse, model="opus", effort="max")
            self.assertEqual(attempts, [("opus", "max")])

    def _real_readiness_recorder(self, observed: list[dict[str, object]]):
        def check(*, model: str, timeout_seconds: int = 20) -> dict[str, object]:
            result = cr.preflight_claude_dispatch(
                model=model, timeout_seconds=timeout_seconds,
            )
            observed.append(result)
            return result

        return check

    def test_consumer_list_path_allows_direct_and_managed_to_redirect_readiness(self) -> None:
        original_run = subprocess.run
        cases = (
            ("aria-adversarial-judge", "managed"),
            ("aria-evidence-judge", "false"),
        )
        for target_agent, managed_mode in cases:
            observed: list[dict[str, object]] = []
            queue_calls: list[list[str]] = []

            def route_subprocess(argv: list[str], *args: object, **kwargs: object):
                if argv and argv[0] == str(self.binary):
                    return original_run(argv, *args, **kwargs)
                queue_calls.append(argv)
                if "agent-invocations" in argv:
                    pending = [{"request_id": "req-1", "target_agent": target_agent}]
                    return subprocess.CompletedProcess(argv, 0, json.dumps(pending), "")
                return subprocess.CompletedProcess(argv, 0, "done", "")

            with self.subTest(target_agent=target_agent), self._env(
                FAKE_CLAUDE_AUTH_MODE=managed_mode,
                ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
                ARIA_ZAI_API_KEY="synthetic-zai-key",
            ), mock.patch.object(ci_executor.subprocess, "run", side_effect=route_subprocess), \
                 mock.patch.object(
                     ci_executor,
                     "preflight_claude_dispatch",
                     side_effect=self._real_readiness_recorder(observed),
                 ):
                result = ci_executor.claim_and_dispatch_one(
                    role="evidence_judgment",
                    tools_dir=self.tmp / "tools",
                    repo_root=_REPO_ROOT,
                )

            self.assertEqual(result["status"], "dispatched")
            self.assertEqual(observed[0]["status"], "route_configured")
            self.assertEqual(len(queue_calls), 2)

    def test_self_claim_main_allows_direct_and_managed_to_redirect_before_claim(self) -> None:
        original_run = subprocess.run
        old_cwd = Path.cwd()
        self.addCleanup(os.chdir, old_cwd)
        os.chdir(_REPO_ROOT)
        cases = (
            ("aria-adversarial-judge", "managed"),
            ("aria-evidence-judge", "false"),
        )
        for target_agent, managed_mode in cases:
            observed: list[dict[str, object]] = []
            claim_calls: list[list[str]] = []

            def route_subprocess(argv: list[str], *args: object, **kwargs: object):
                if argv and argv[0] == str(self.binary):
                    return original_run(argv, *args, **kwargs)
                claim_calls.append(argv)
                return subprocess.CompletedProcess(argv, 9, "", "synthetic claim stop")

            with self.subTest(target_agent=target_agent), self._env(
                FAKE_CLAUDE_AUTH_MODE=managed_mode,
                ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
                ARIA_ZAI_API_KEY="synthetic-zai-key",
            ), mock.patch.object(ci_executor.subprocess, "run", side_effect=route_subprocess), \
                 mock.patch.object(ci_executor, "_record_mock_mode_audit"), \
                 mock.patch.object(ci_executor, "_sandbox_backend", return_value="bwrap"), \
                 mock.patch.object(
                     ci_executor,
                     "preflight_claude_dispatch",
                     side_effect=self._real_readiness_recorder(observed),
                 ):
                rc = ci_executor.main(["req-1", target_agent])

            self.assertEqual(rc, 1)
            self.assertEqual(observed[0]["status"], "route_configured")
            self.assertEqual(len(claim_calls), 1)
            self.assertIn("claim", claim_calls[0])

    def test_unavailable_redirect_causes_no_consumer_dispatch_or_self_claim(self) -> None:
        original_run = subprocess.run
        pending = [{"request_id": "req-1", "target_agent": "aria-adversarial-judge"}]
        list_calls: list[list[str]] = []

        def list_only(argv: list[str], *args: object, **kwargs: object):
            if argv and argv[0] == str(self.binary):
                return original_run(argv, *args, **kwargs)
            list_calls.append(argv)
            if "agent-invocations" in argv:
                return subprocess.CompletedProcess(argv, 0, json.dumps(pending), "")
            raise AssertionError(f"unexpected queue mutation: {argv}")

        with self._env(
            ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
            ARIA_ZAI_API_KEY=None,
        ), mock.patch.object(ci_executor.subprocess, "run", side_effect=list_only):
            result = ci_executor.claim_and_dispatch_one(
                role="evidence_judgment",
                tools_dir=self.tmp / "tools",
                repo_root=_REPO_ROOT,
            )

        self.assertEqual(result["status"], "dispatchers_unavailable")
        self.assertEqual(len(list_calls), 1)

        old_cwd = Path.cwd()
        self.addCleanup(os.chdir, old_cwd)
        os.chdir(_REPO_ROOT)
        claim_calls: list[list[str]] = []

        def no_claim(argv: list[str], *args: object, **kwargs: object):
            if argv and argv[0] == str(self.binary):
                return original_run(argv, *args, **kwargs)
            claim_calls.append(argv)
            raise AssertionError(f"unexpected claim: {argv}")

        with self._env(
            ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
            ARIA_ZAI_API_KEY=None,
        ), mock.patch.object(ci_executor.subprocess, "run", side_effect=no_claim), \
             mock.patch.object(ci_executor, "_record_mock_mode_audit"), \
             mock.patch.object(ci_executor, "_sandbox_backend", return_value="bwrap"), \
             mock.patch.object(ci_executor, "_append_tools_governance"):
            rc = ci_executor.main(["req-1", "aria-adversarial-judge"])

        self.assertEqual(rc, 1)
        self.assertEqual(claim_calls, [])

    def test_worker_propagates_managed_attempt_then_redirect_attempt_to_runtime(self) -> None:
        worktree = self.tmp / "worker-tree"
        worktree.mkdir()
        assignment = {
            "assignment_id": "assignment-1",
            "worktree_path": str(worktree),
            "required_tests": [],
            "timeout_seconds": 5,
        }
        attempts: list[tuple[str | None, str | None]] = []
        spawned: list[list[str]] = []

        def real_runtime_boundary(**kwargs: object) -> cr.ClaudeRunResult:
            attempts.append((kwargs.get("model"), kwargs.get("effort")))
            return cr.run_claude_exec(
                prompt_text=str(kwargs["prompt_text"]),
                timeout_seconds=int(kwargs["timeout_seconds"]),
                model=str(kwargs["model"]),
                effort=str(kwargs["effort"]),
                require_usage=False,
                cwd=worktree,
                skip_permissions=False,
            )

        def inference_boundary(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            del kwargs
            spawned.append(argv)
            return subprocess.CompletedProcess(argv, 0, _ok_result_event(), "")

        old_cwd = Path.cwd()
        self.addCleanup(os.chdir, old_cwd)
        os.chdir(_REPO_ROOT)
        with self._env(
            FAKE_CLAUDE_AUTH_MODE="false",
            ARIA_PROVIDER_REDIRECT_POLICY_REF="policy:test",
            ARIA_ZAI_API_KEY="synthetic-zai-key",
            ARIA_LEASE_TOKEN="synthetic-lease",
        ), mock.patch.object(worker_executor, "_resolve_assignment", return_value=assignment), \
             mock.patch.object(worker_executor, "run_claude_exec", side_effect=real_runtime_boundary), \
             mock.patch.object(worker_executor, "_submit_worker_result", return_value=0), \
             mock.patch.object(worker_executor, "emit_dispatch_result_summary"), \
             mock.patch.object(cr, "_run_spawn", side_effect=inference_boundary):
            rc = worker_executor.main(["assignment-1", "aria-worker"])

        self.assertEqual(rc, 0)
        self.assertEqual(attempts, [("opus", "max"), ("glm-5.3", "max")])
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0][spawned[0].index("--model") + 1], "glm-5.3")
        self.assertEqual(
            self._cli_calls(),
            [["--version"], ["auth", "status"], ["--version"]],
        )


if __name__ == "__main__":
    unittest.main()
