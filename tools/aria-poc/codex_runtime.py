"""Codex CLI runtime contract for ARIA agent execution.

This module is intentionally small and dependency-light so both
``ci_executor.py`` and ``worker_executor.py`` can use the same contract.
It is the executor-side SSoT for the Codex migration:

* ChatGPT-managed Codex auth is the default.
* API-key mode is disallowed unless an operator explicitly opts in via
  a future policy.
* The live invocation shape is ``codex exec --json`` with an explicit
  ``model_reasoning_effort = "xhigh"`` config override.
* Raw JSONL stays in memory; callers persist only sanitized envelopes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CODEX_BINARY_ENV_VAR = "CODEX_CLI_BINARY"
CODEX_MOCK_ENV_VAR = "CODEX_CLI_MOCK"
CODEX_REASONING_EFFORT = "xhigh"
ALLOW_API_KEY_MODE_ENV_VAR = "ARIA_ALLOW_CODEX_API_KEY_MODE"
REQUIRE_USAGE_ENV_VAR = "ARIA_CODEX_REQUIRE_USAGE"
AUTH_PREFLIGHT_SKIP_ENV_VAR = "ARIA_CODEX_AUTH_PREFLIGHT_SKIP"

API_KEY_ENV_VARS = ("OPENAI_API_KEY", "CODEX_API_KEY")
UNSAFE_DEBUG_ENV_VARS = ("CODEX_OSS_DEBUG",)
SENSITIVE_ENV_PREFIXES = ("ARIA_", "GITHUB_", "GH_")
SENSITIVE_ENV_VARS = frozenset({
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "RUNNER_TOKEN",
})
CODEX_ENV_ALLOWLIST = frozenset({
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "TERM",
    "TMPDIR",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
})


class CodexCliUnavailable(RuntimeError):
    """Codex CLI is not installed or cannot satisfy ARIA's contract."""


class CodexAuthUnavailable(RuntimeError):
    """Codex CLI auth/session/rate-limit state could not be verified."""


class CodexUsageUnavailable(RuntimeError):
    """Codex JSONL did not include required usage/account-headroom data."""


class CodexPolicyViolation(RuntimeError):
    """Environment or argv would violate ARIA's Codex policy."""


@dataclass(frozen=True)
class CodexRunResult:
    returncode: int
    stdout: str
    stderr: str
    final_message: str
    usage: dict[str, Any] | None
    events: tuple[dict[str, Any], ...]


def is_mock_mode() -> bool:
    return _parse_bool(os.environ.get(CODEX_MOCK_ENV_VAR, "0"), env_name=CODEX_MOCK_ENV_VAR)


def codex_binary() -> str:
    return os.environ.get(CODEX_BINARY_ENV_VAR, "codex")


def codex_subprocess_env() -> dict[str, str]:
    """Build the explicit environment allowed to reach Codex subprocesses."""
    env: dict[str, str] = {}
    for name in sorted(CODEX_ENV_ALLOWLIST):
        value = os.environ.get(name)
        if value is None:
            continue
        if name in SENSITIVE_ENV_VARS or name.startswith(SENSITIVE_ENV_PREFIXES):
            continue
        env[name] = value
    env.setdefault("PATH", os.defpath)
    return env


def assert_codex_policy_environment() -> None:
    """Fail closed on billing/auth/logging modes that violate the plan."""
    allow_api_key = _parse_bool(
        os.environ.get(ALLOW_API_KEY_MODE_ENV_VAR, "0"),
        env_name=ALLOW_API_KEY_MODE_ENV_VAR,
    )
    if not allow_api_key:
        leaked = [name for name in API_KEY_ENV_VARS if os.environ.get(name)]
        if leaked:
            raise CodexPolicyViolation(
                "codex_api_key_mode_disallowed: unset "
                + ", ".join(leaked)
                + " or set ARIA_ALLOW_CODEX_API_KEY_MODE=1 under a new policy"
            )
    for name in UNSAFE_DEBUG_ENV_VARS:
        if os.environ.get(name) == "1":
            raise CodexPolicyViolation(
                f"{name}=1 is forbidden in ARIA real mode because it can leak raw prompts/output"
            )


def preflight_codex_auth(*, timeout_seconds: int = 20) -> dict[str, Any]:
    """Verify Codex CLI and managed-auth availability without spending tokens.

    Codex CLI auth/status subcommands can vary by version. ARIA accepts
    either a successful JSON-capable ``codex login status`` probe or a
    successful ``codex doctor --json`` probe. If neither works, real mode
    fails closed. Local tests may set ``ARIA_CODEX_AUTH_PREFLIGHT_SKIP=1``.
    """
    assert_codex_policy_environment()
    binary = codex_binary()
    if shutil.which(binary) is None:
        raise CodexCliUnavailable(f"`{binary}` binary not on PATH")

    try:
        version_proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            env=codex_subprocess_env(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexCliUnavailable(f"codex_version_probe_failed: {exc}") from exc
    if version_proc.returncode != 0:
        raise CodexCliUnavailable(
            f"codex_version_probe_failed: {version_proc.stderr.strip() or version_proc.stdout.strip()}"
        )

    if _parse_bool(
        os.environ.get(AUTH_PREFLIGHT_SKIP_ENV_VAR, "0"),
        env_name=AUTH_PREFLIGHT_SKIP_ENV_VAR,
    ):
        return {
            "status": "skipped_by_env",
            "version": version_proc.stdout.strip() or version_proc.stderr.strip(),
        }

    probes = (
        [binary, "login", "status", "--json"],
        [binary, "doctor", "--json"],
    )
    last_error = ""
    for argv in probes:
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
                env=codex_subprocess_env(),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            last_error = str(exc)
            continue
        if proc.returncode != 0:
            last_error = proc.stderr.strip() or proc.stdout.strip()
            continue
        payload = _parse_first_json_object(proc.stdout)
        if payload is None:
            last_error = "auth_probe_output_not_json"
            continue
        mode_text = json.dumps(payload, sort_keys=True).lower()
        if "apikey" in mode_text or "api_key" in mode_text:
            raise CodexPolicyViolation(
                "codex_auth_mode_api_key_disallowed_under_no_extra_token_policy"
            )
        if any(token in mode_text for token in ("chatgpt", "authenticated", "authorized", "pro", "plus", "team", "max")):
            return {
                "status": "ok",
                "version": version_proc.stdout.strip() or version_proc.stderr.strip(),
                "probe": argv[1:],
                "payload": payload,
            }
        last_error = "auth_probe_did_not_confirm_chatgpt_managed_auth"
    raise CodexAuthUnavailable(last_error or "codex_auth_probe_failed")


def build_codex_exec_argv(*, output_schema: Path | None = None) -> list[str]:
    argv = [
        codex_binary(),
        "exec",
        "--json",
        "-c",
        f'model_reasoning_effort="{CODEX_REASONING_EFFORT}"',
    ]
    if output_schema is not None:
        argv.extend(["--output-schema", str(output_schema)])
    return argv


def run_codex_exec(
    *,
    prompt_text: str,
    timeout_seconds: int,
    output_schema: Path | None = None,
    require_usage: bool | None = None,
    cwd: str | Path | None = None,
) -> CodexRunResult:
    preflight_codex_auth()
    argv = build_codex_exec_argv(output_schema=output_schema)
    proc = subprocess.run(
        argv,
        input=prompt_text,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 30,
        check=False,
        cwd=str(cwd) if cwd is not None else None,
        env=codex_subprocess_env(),
    )
    events = parse_codex_jsonl(proc.stdout)
    final_message = extract_final_message(events)
    usage = extract_usage(events)
    if require_usage is None:
        require_usage = _parse_bool(
            os.environ.get(REQUIRE_USAGE_ENV_VAR, "1"),
            env_name=REQUIRE_USAGE_ENV_VAR,
        )
    if proc.returncode == 0 and require_usage and usage is None:
        raise CodexUsageUnavailable("codex_jsonl_missing_turn_completed_usage")
    return CodexRunResult(
        returncode=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        final_message=final_message,
        usage=usage,
        events=events,
    )


def parse_codex_jsonl(raw: str) -> tuple[dict[str, Any], ...]:
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return tuple(events)


def extract_final_message(events: tuple[dict[str, Any], ...]) -> str:
    final = ""
    for event in events:
        item = event.get("item")
        if isinstance(item, dict) and item.get("type") == "agent_message":
            text = item.get("text")
            if isinstance(text, str):
                final = text
        elif event.get("type") == "message":
            text = event.get("text")
            if isinstance(text, str):
                final = text
    return final


def extract_usage(events: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    for event in reversed(events):
        usage = event.get("usage")
        if isinstance(usage, dict):
            return dict(usage)
    return None


def _parse_bool(raw: str, *, env_name: str) -> bool:
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off", ""}:
        return False
    raise CodexPolicyViolation(f"{env_name}={raw!r} is not a valid boolean")


def _parse_first_json_object(raw: str) -> dict[str, Any] | None:
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None
