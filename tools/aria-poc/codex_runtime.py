"""Codex CLI runtime bridge — the third provider's executor surface.

WHY THIS EXISTS (ARIA-MEDIUM-027, operator requirement 2026-08-29): the
fleet spans Anthropic (managed Claude session), Z.ai (per-spawn redirect)
and OpenAI Codex. Codex is not Anthropic-protocol, so it gets a sibling
runtime in the worker_executor/ci_executor pattern: bounded `codex exec`
spawns whose JSONL event stream is mapped into the SAME typed failure
contract the Claude path reports (auth failure, credit/quota, process
exit) so the cross-provider ladder in claude_runtime.run_with_model_
fallback can treat a Codex tier like any other rung.

Interface facts this bridge is built on (codex-cli 0.149.1, verified live
on the runner host 2026-08-29):

  codex exec --json [--model M] [--sandbox read-only|workspace-write]
            [--output-last-message FILE] [--cd DIR] [PROMPT]

  stdout  → JSONL events: {"type": "error"|"turn.failed"|...}
  -o FILE → the agent's final message, written even on failure paths that
            produced partial output
  auth    → OPENAI_API_KEY env, or a ChatGPT-managed session under
            CODEX_HOME; a missing/invalid credential surfaces as
            turn.failed with 401 in the event stream — mapped here to the
            typed auth_failure record, never a mock answer.

NO MOCK MODE: production lanes never fabricate Codex output. Tests inject
the runner callable.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

CODEX_BINARY = "codex"
DEFAULT_CODEX_MODEL = "gpt-5.2-codex"
DEFAULT_CODEX_TIMEOUT_SECONDS = 600

# Sandbox tiers map 1:1 onto ARIA's containment language.
CODEX_SANDBOX_MODES = ("read-only", "workspace-write")

# Markers mined from live 401/quota events (2026-08-29) and the Codex
# non-interactive docs: auth misses carry 401/bearer, quota carries the
# usage-limit phrasing family.
CODEX_AUTH_MARKERS = ("401", "unauthorized", "missing bearer", "authentication")
CODEX_QUOTA_MARKERS = ("usage limit", "rate limit", "quota", "billing")


@dataclass(frozen=True)
class CodexRunResult:
    """The Codex sibling of claude_runtime.ClaudeRunResult.

    Field names deliberately mirror the Claude result so the shared
    fallback ladder and downstream auditors read both runtimes through one
    vocabulary.
    """

    returncode: int
    stdout: str
    stderr: str
    final_message: str
    events: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    auth_failure: dict[str, Any] | None = None
    credit_exhaustion: dict[str, Any] | None = None
    model: str = DEFAULT_CODEX_MODEL


def build_codex_argv(
    prompt: str,
    *,
    model: str = DEFAULT_CODEX_MODEL,
    sandbox: str = "read-only",
    output_last_message: Path | None = None,
    cwd: Path | None = None,
) -> list[str]:
    """The exact argv for one bounded Codex dispatch.

    The prompt rides argv (codex exec's contract); JSONL events on stdout;
    the final message additionally lands in -o so a long stream never
    costs the answer.
    """
    if sandbox not in CODEX_SANDBOX_MODES:
        raise ValueError(f"codex_sandbox_mode_invalid: {sandbox!r}")
    argv = [
        CODEX_BINARY, "exec", "--json",
        "--sandbox", sandbox,
        "--model", model,
    ]
    if output_last_message is not None:
        argv += ["--output-last-message", str(output_last_message)]
    if cwd is not None:
        argv += ["--cd", str(cwd)]
    argv.append(prompt)
    return argv


def classify_codex_events(events: list[dict[str, Any]], returncode: int) -> CodexRunResult:
    """Map the JSONL stream onto the shared typed-failure vocabulary."""
    blob = json.dumps(events).lower()
    auth = next((m for m in CODEX_AUTH_MARKERS if m in blob), None)
    quota = next((m for m in CODEX_QUOTA_MARKERS if m in blob), None)
    return CodexRunResult(  # typed fields; caller merges final_message
        returncode=returncode,
        stdout=json.dumps(events),
        stderr="",
        final_message="",
        events=tuple(events),
        auth_failure=(
            {"kind": "auth_failure", "marker": auth, "returncode": returncode,
             "remedy": "provide OPENAI_API_KEY or authenticate the Codex session"}
            if auth and returncode != 0 else None
        ),
        credit_exhaustion=(
            {"kind": "credit_exhaustion", "matched_marker": quota, "returncode": returncode}
            if quota and returncode != 0 else None
        ),
    )


def run_codex_exec(
    prompt: str,
    *,
    model: str = DEFAULT_CODEX_MODEL,
    sandbox: str = "read-only",
    cwd: Path | None = None,
    timeout_seconds: int = DEFAULT_CODEX_TIMEOUT_SECONDS,
    env: dict[str, str] | None = None,
) -> CodexRunResult:
    """One bounded production Codex dispatch. No mock path exists here.

    The bridge inherits the caller's environment plus any explicit env
    (OPENAI_API_KEY / CODEX_HOME routing lives with the caller — the fleet
    module proves availability, this module runs the spawn).
    """
    with tempfile.TemporaryDirectory(prefix="aria-codex-") as tmp:
        last_message_path = Path(tmp) / "last-message.txt"
        argv = build_codex_argv(
            prompt, model=model, sandbox=sandbox,
            output_last_message=last_message_path, cwd=cwd,
        )
        run_env = {**os.environ, **(env or {})}
        proc = subprocess.run(
            argv, capture_output=True, text=True,
            timeout=timeout_seconds, check=False,
            env=run_env, cwd=str(cwd) if cwd else None,
        )
        events: list[dict[str, Any]] = []
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        result = classify_codex_events(events, proc.returncode)
        final_message = ""
        if last_message_path.exists():
            final_message = last_message_path.read_text(encoding="utf-8", errors="replace")
        return CodexRunResult(
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            final_message=final_message,
            events=tuple(events),
            auth_failure=result.auth_failure,
            credit_exhaustion=result.credit_exhaustion,
            model=model,
        )


def codex_dispatch(
    prompt: str,
    *,
    model: str = DEFAULT_CODEX_MODEL,
    sandbox: str = "read-only",
    cwd: Path | None = None,
    run: Callable[..., CodexRunResult] = run_codex_exec,
    **run_kwargs: Any,
) -> CodexRunResult:
    """Dispatch seam: production callers go through here; tests inject `run`."""
    return run(prompt, model=model, sandbox=sandbox, cwd=cwd, **run_kwargs)
