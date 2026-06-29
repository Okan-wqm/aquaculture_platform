"""Claude Code CLI runtime contract for ARIA agent execution.

This module is the executor-side SSoT for ARIA's live LLM runtime: ARIA runs
its agents through the **Claude Code CLI** (the same `claude` binary a human
operator drives), NOT through a raw model API. It mirrors the small,
dependency-light shape of the previous Codex contract so both
``ci_executor.py`` and ``worker_executor.py`` consume one runtime:

* Managed Claude Code auth (a logged-in subscription session on a trusted /
  private runner) is the default. Raw ``ANTHROPIC_API_KEY`` billing is
  disallowed unless an operator explicitly opts in via a future policy —
  the same fail-closed posture the Codex contract held for ChatGPT-managed
  auth vs. API keys.
* The live invocation shape is ``claude -p --output-format stream-json
  --verbose --model <model>`` with the prompt on stdin and (on a trusted
  runner) ``--dangerously-skip-permissions`` so the agent can edit its
  assigned worktree autonomously, the way ``codex exec`` did.
* The per-agent model comes from the agent frontmatter (resolved by
  ``aria_kernel.agent_runtime_profile``); ARIA's default is Opus.
* Raw stream-json stays in memory; callers persist only sanitized envelopes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CLAUDE_BINARY_ENV_VAR = "CLAUDE_CLI_BINARY"
CLAUDE_MOCK_ENV_VAR = "CLAUDE_CLI_MOCK"
# ARIA's default model tier. The Claude Code CLI accepts a model alias
# ("opus") or a full id; the alias resolves to the latest Opus on the
# runner, keeping ARIA on the most capable tier by default. Per-agent
# overrides flow in via build_claude_exec_argv(model=...).
CLAUDE_DEFAULT_MODEL = "opus"
# The Claude Code CLI selects capability by model alias, not by a separate
# reasoning-effort knob (Codex's model_reasoning_effort had no CLI analog).
# These are the model aliases ARIA may target; the agent-runtime-profile
# maps each agent's tier to one of them.
VALID_MODELS: tuple[str, ...] = ("opus", "sonnet", "haiku")
ALLOW_API_KEY_MODE_ENV_VAR = "ARIA_ALLOW_CLAUDE_API_KEY_MODE"
REQUIRE_USAGE_ENV_VAR = "ARIA_CLAUDE_REQUIRE_USAGE"
AUTH_PREFLIGHT_SKIP_ENV_VAR = "ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP"

API_KEY_ENV_VARS = ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY")
# Claude Code honours ANTHROPIC_AUTH_TOKEN / custom base URLs for proxy
# billing; those bypass the managed subscription session the same way an
# API key does, so they are gated under the same policy switch.
UNSAFE_BILLING_ENV_VARS = ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")


class ClaudeCliUnavailable(RuntimeError):
    """Claude Code CLI is not installed or cannot satisfy ARIA's contract."""


class ClaudeAuthUnavailable(RuntimeError):
    """Claude Code CLI auth/session state could not be verified."""


class ClaudeUsageUnavailable(RuntimeError):
    """Claude stream-json did not include the required usage data."""


class ClaudePolicyViolation(RuntimeError):
    """Environment or argv would violate ARIA's Claude runtime policy."""


@dataclass(frozen=True)
class ClaudeRunResult:
    returncode: int
    stdout: str
    stderr: str
    final_message: str
    usage: dict[str, Any] | None
    events: tuple[dict[str, Any], ...]


def is_mock_mode() -> bool:
    return _parse_bool(os.environ.get(CLAUDE_MOCK_ENV_VAR, "0"), env_name=CLAUDE_MOCK_ENV_VAR)


def claude_binary() -> str:
    return os.environ.get(CLAUDE_BINARY_ENV_VAR, "claude")


def assert_claude_policy_environment() -> None:
    """Fail closed on billing/auth modes that bypass managed Claude Code auth."""
    allow_api_key = _parse_bool(
        os.environ.get(ALLOW_API_KEY_MODE_ENV_VAR, "0"),
        env_name=ALLOW_API_KEY_MODE_ENV_VAR,
    )
    if not allow_api_key:
        leaked = [
            name
            for name in (*API_KEY_ENV_VARS, *UNSAFE_BILLING_ENV_VARS)
            if os.environ.get(name)
        ]
        if leaked:
            raise ClaudePolicyViolation(
                "claude_api_key_mode_disallowed: unset "
                + ", ".join(leaked)
                + " or set ARIA_ALLOW_CLAUDE_API_KEY_MODE=1 under a new policy"
            )


def preflight_claude_auth(*, timeout_seconds: int = 20) -> dict[str, Any]:
    """Verify the Claude Code CLI is present and managed-auth is usable
    without spending tokens.

    The Claude Code CLI does not expose a token-free ``login status --json``
    probe, so the preflight is: (1) policy-environment check (no API-key /
    proxy billing leak), (2) ``claude --version`` must succeed, (3) a
    managed-auth credential surface must exist on the runner (the logged-in
    session file). If the credential surface is absent, real mode fails
    closed. Local tests may set ``ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP=1``.
    """
    assert_claude_policy_environment()
    binary = claude_binary()
    if shutil.which(binary) is None:
        raise ClaudeCliUnavailable(f"`{binary}` binary not on PATH")

    try:
        version_proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ClaudeCliUnavailable(f"claude_version_probe_failed: {exc}") from exc
    if version_proc.returncode != 0:
        raise ClaudeCliUnavailable(
            f"claude_version_probe_failed: {version_proc.stderr.strip() or version_proc.stdout.strip()}"
        )
    version = version_proc.stdout.strip() or version_proc.stderr.strip()

    if _parse_bool(
        os.environ.get(AUTH_PREFLIGHT_SKIP_ENV_VAR, "0"),
        env_name=AUTH_PREFLIGHT_SKIP_ENV_VAR,
    ):
        return {"status": "skipped_by_env", "version": version}

    if not _managed_auth_present():
        raise ClaudeAuthUnavailable(
            "claude_managed_auth_absent: no logged-in Claude Code session found; "
            "run `claude` login on the runner or set "
            "ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP=1 for a dry-run"
        )
    return {"status": "ok", "version": version}


def _managed_auth_present() -> bool:
    """True when a logged-in Claude Code session credential surface exists.

    Claude Code persists the managed session under ``$CLAUDE_CONFIG_DIR``
    (default ``~/.claude``). We probe for the credentials file or the
    config dir's auth record rather than invoking a billable turn.
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    candidates = []
    if config_dir:
        candidates.append(Path(config_dir))
    home = Path(os.path.expanduser("~"))
    candidates.append(home / ".claude")
    for base in candidates:
        if (base / ".credentials.json").is_file():
            return True
        if (base / "config.json").is_file():
            return True
    return False


def build_claude_exec_argv(
    *,
    model: str | None = None,
    skip_permissions: bool = True,
) -> list[str]:
    """Build the live Claude Code CLI invocation argv.

    ``skip_permissions`` defaults True because the autonomous executor runs
    on a trusted/private runner and must edit its assigned worktree without a
    human approving each tool call (the autonomy ``codex exec`` provided).
    Callers that want a read-only/preview turn pass ``skip_permissions=False``.
    """
    resolved_model = model or CLAUDE_DEFAULT_MODEL
    argv = [
        claude_binary(),
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        resolved_model,
    ]
    if skip_permissions:
        argv.append("--dangerously-skip-permissions")
    return argv


def run_claude_exec(
    *,
    prompt_text: str,
    timeout_seconds: int,
    model: str | None = None,
    require_usage: bool | None = None,
    cwd: str | Path | None = None,
    skip_permissions: bool = True,
) -> ClaudeRunResult:
    preflight_claude_auth()
    argv = build_claude_exec_argv(model=model, skip_permissions=skip_permissions)
    proc = subprocess.run(
        argv,
        input=prompt_text,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 30,
        check=False,
        cwd=str(cwd) if cwd is not None else None,
    )
    events = parse_claude_jsonl(proc.stdout)
    final_message = extract_final_message(events)
    usage = extract_usage(events)
    if require_usage is None:
        require_usage = _parse_bool(
            os.environ.get(REQUIRE_USAGE_ENV_VAR, "1"),
            env_name=REQUIRE_USAGE_ENV_VAR,
        )
    if proc.returncode == 0 and require_usage and usage is None:
        raise ClaudeUsageUnavailable("claude_stream_json_missing_result_usage")
    return ClaudeRunResult(
        returncode=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        final_message=final_message,
        usage=usage,
        events=events,
    )


def parse_claude_jsonl(raw: str) -> tuple[dict[str, Any], ...]:
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
    """Return the agent's final text.

    Claude Code stream-json terminates with a ``{"type":"result",...}`` event
    whose ``result`` field is the final assistant text. We prefer that; if it
    is absent (e.g. an error-typed result) we fall back to the last
    ``assistant`` message's concatenated text blocks.
    """
    final = ""
    for event in events:
        if event.get("type") == "result":
            result_text = event.get("result")
            if isinstance(result_text, str):
                final = result_text
        elif event.get("type") == "assistant":
            text = _assistant_text(event.get("message"))
            if text:
                final = text
    return final


def _assistant_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "".join(p for p in parts if isinstance(p, str))
    return ""


def extract_usage(events: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    """Return the token usage from the terminal ``result`` event.

    Claude Code attaches ``usage`` (input/output/cache tokens) to the final
    ``result`` event. We scan from the end so the terminal turn wins.
    """
    for event in reversed(events):
        if event.get("type") == "result":
            usage = event.get("usage")
            if isinstance(usage, dict):
                return dict(usage)
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
    raise ClaudePolicyViolation(f"{env_name}={raw!r} is not a valid boolean")
