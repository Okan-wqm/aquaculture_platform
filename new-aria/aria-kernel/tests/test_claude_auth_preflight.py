"""Managed Claude authentication preflight behavior."""
from __future__ import annotations

import os
import stat
import sys
import tempfile
import traceback
import unittest
from pathlib import Path
from unittest import mock


_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import claude_runtime  # noqa: E402


_FAKE_CLAUDE = """#!/usr/bin/env python3
import os
import sys
import time

if sys.argv[1:] == ["--version"]:
    print("2.1.261 (Claude Code)")
    if os.environ.get("FAKE_CLAUDE_AUTH_MODE") == "execution_error":
        os.unlink(sys.argv[0])
    raise SystemExit(0)
if sys.argv[1:] != ["auth", "status"]:
    raise SystemExit(64)

mode = os.environ.get("FAKE_CLAUDE_AUTH_MODE", "managed")
if mode == "managed":
    print('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"private@example.test"}')
elif mode == "api_key":
    print('{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}')
elif mode == "other_provider":
    print('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}')
elif mode == "false":
    print('{"loggedIn":false,"authMethod":"claude.ai","apiProvider":"firstParty"}')
elif mode == "nonboolean":
    print('{"loggedIn":"true","authMethod":"claude.ai","apiProvider":"firstParty"}')
elif mode == "missing":
    print('{"loggedIn":true,"authMethod":"claude.ai"}')
elif mode == "malformed":
    print('{definitely-not-json')
elif mode == "array":
    print('[]')
elif mode == "nonzero":
    print("account=private@example.test", file=sys.stderr)
    raise SystemExit(7)
elif mode == "timeout":
    print("account=private@example.test", flush=True)
    time.sleep(2)
elif mode == "invalid_stdout":
    sys.stdout.buffer.write(b"account=private-invalid-stdout@example.test\\n" + bytes([255]))
elif mode == "invalid_stderr":
    sys.stderr.buffer.write(b"account=private-invalid-stderr@example.test\\n" + bytes([255]))
    raise SystemExit(7)
else:
    raise SystemExit(65)
"""


class ManagedClaudeAuthPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.binary = Path(self._tmp.name) / "claude"
        self.binary.write_text(_FAKE_CLAUDE, encoding="utf-8")
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)
        self.config_dir = Path(self._tmp.name) / "config"
        self.config_dir.mkdir()
        self._env = mock.patch.dict(
            os.environ,
            {
                claude_runtime.CLAUDE_BINARY_ENV_VAR: str(self.binary),
                "CLAUDE_CONFIG_DIR": str(self.config_dir),
                "FAKE_CLAUDE_AUTH_MODE": "managed",
                claude_runtime.AUTH_PREFLIGHT_SKIP_ENV_VAR: "0",
                claude_runtime.ALLOW_API_KEY_MODE_ENV_VAR: "0",
                "ANTHROPIC_API_KEY": "",
                "CLAUDE_API_KEY": "",
                "ANTHROPIC_AUTH_TOKEN": "",
                "ANTHROPIC_BASE_URL": "",
            },
            clear=False,
        )
        self._env.start()
        self.addCleanup(self._env.stop)

    def test_config_file_alone_cannot_establish_managed_login(self) -> None:
        (self.config_dir / "config.json").write_text("{}", encoding="utf-8")
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "false"

        with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
            claude_runtime.preflight_claude_auth()

    def test_approved_managed_status_returns_only_readiness_and_version(self) -> None:
        result = claude_runtime.preflight_claude_auth()

        self.assertEqual(result, {"status": "ok", "version": "2.1.261 (Claude Code)"})
        self.assertNotIn("email", result)

    def test_authorized_redirect_is_configured_without_managed_status(self) -> None:
        os.environ[claude_runtime.PROVIDER_REDIRECT_POLICY_ENV_VAR] = "policy:test"
        os.environ["ARIA_ZAI_API_KEY"] = "synthetic-key"
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "timeout"
        result = claude_runtime.preflight_claude_auth(model="glm-5.3")
        self.assertEqual(result["status"], "route_configured")
        self.assertEqual(result["provider"], "zai")

    def test_redirect_skip_still_requires_policy_and_key(self) -> None:
        os.environ[claude_runtime.AUTH_PREFLIGHT_SKIP_ENV_VAR] = "1"
        for policy, key in (("", "synthetic-key"), ("policy:test", "")):
            with self.subTest(policy=policy, key=bool(key)):
                os.environ[claude_runtime.PROVIDER_REDIRECT_POLICY_ENV_VAR] = policy
                os.environ["ARIA_ZAI_API_KEY"] = key
                with self.assertRaises(claude_runtime.ProviderRedirectUnavailable):
                    claude_runtime.preflight_claude_auth(model="glm-5.3")

    def test_alternate_key_does_not_satisfy_default_managed_preflight(self) -> None:
        os.environ[claude_runtime.PROVIDER_REDIRECT_POLICY_ENV_VAR] = "policy:test"
        os.environ["ARIA_ZAI_API_KEY"] = "synthetic-key"
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "false"
        with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
            claude_runtime.preflight_claude_auth()

    def test_invalid_auth_stream_bytes_are_sanitized(self) -> None:
        cases = (
            ("invalid_stdout", "private-invalid-stdout@example.test"),
            ("invalid_stderr", "private-invalid-stderr@example.test"),
        )
        for mode, private_account in cases:
            with self.subTest(mode=mode):
                os.environ["FAKE_CLAUDE_AUTH_MODE"] = mode
                with self.assertRaises(claude_runtime.ClaudeAuthUnavailable) as caught:
                    claude_runtime.preflight_claude_auth()
                message = str(caught.exception)
                rendered = "".join(traceback.format_exception(caught.exception))
                self.assertEqual(message, "claude_auth_status_invalid_encoding")
                self.assertNotIn(private_account, message)
                self.assertNotIn(private_account, rendered)
                self.assertNotIn("account=", rendered)
                self.assertNotIn("xff", rendered)

    def test_api_key_auth_method_is_refused(self) -> None:
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "api_key"

        with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
            claude_runtime.preflight_claude_auth()

    def test_non_first_party_provider_is_refused(self) -> None:
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "other_provider"

        with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
            claude_runtime.preflight_claude_auth()

    def test_malformed_and_non_object_status_are_refused(self) -> None:
        for mode in ("malformed", "array"):
            with self.subTest(mode=mode):
                os.environ["FAKE_CLAUDE_AUTH_MODE"] = mode
                with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
                    claude_runtime.preflight_claude_auth()

    def test_missing_and_nonboolean_fields_are_refused(self) -> None:
        for mode in ("missing", "nonboolean"):
            with self.subTest(mode=mode):
                os.environ["FAKE_CLAUDE_AUTH_MODE"] = mode
                with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
                    claude_runtime.preflight_claude_auth()

    def test_nonzero_status_never_leaks_cli_output_or_account_data(self) -> None:
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "nonzero"

        try:
            claude_runtime.preflight_claude_auth()
        except claude_runtime.ClaudeAuthUnavailable as exc:
            rendered = "".join(traceback.format_exception(exc))
        else:
            self.fail("nonzero auth status was accepted")

        self.assertNotIn("private@example.test", rendered)
        self.assertNotIn("account=", rendered)

    def test_timeout_never_leaks_partial_cli_output_or_account_data(self) -> None:
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "timeout"

        try:
            claude_runtime.preflight_claude_auth(timeout_seconds=1)
        except claude_runtime.ClaudeAuthUnavailable as exc:
            rendered = "".join(traceback.format_exception(exc))
        else:
            self.fail("timed-out auth status was accepted")

        self.assertNotIn("private@example.test", rendered)
        self.assertNotIn("account=", rendered)

    def test_auth_status_execution_error_fails_closed_without_path_details(self) -> None:
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "execution_error"

        try:
            claude_runtime.preflight_claude_auth()
        except claude_runtime.ClaudeAuthUnavailable as exc:
            rendered = "".join(traceback.format_exception(exc))
            message = str(exc)
        else:
            self.fail("auth status execution error was accepted")

        self.assertNotIn(str(self.binary), rendered)
        self.assertEqual(message, "claude_auth_status_execution_failed")

    def test_explicit_dry_run_skip_is_not_ok(self) -> None:
        os.environ[claude_runtime.AUTH_PREFLIGHT_SKIP_ENV_VAR] = "1"

        result = claude_runtime.preflight_claude_auth()

        self.assertEqual(result, {"status": "skipped_by_env", "version": "2.1.261 (Claude Code)"})
        self.assertNotEqual(result["status"], "ok")

    def test_run_claude_exec_refuses_denied_auth_before_inference_spawn(self) -> None:
        os.environ["FAKE_CLAUDE_AUTH_MODE"] = "false"

        with mock.patch.object(
            claude_runtime,
            "_run_spawn",
            side_effect=AssertionError("inference spawn reached"),
        ):
            with self.assertRaises(claude_runtime.ClaudeAuthUnavailable):
                claude_runtime.run_claude_exec(
                    prompt_text="must not run",
                    timeout_seconds=1,
                    skip_permissions=False,
                    require_usage=False,
                )


if __name__ == "__main__":
    unittest.main()
