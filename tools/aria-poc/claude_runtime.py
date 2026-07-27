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
  ``aria_kernel.agent_runtime_profile``); ARIA's fail-safe default is Fable.
* Raw stream-json stays in memory; callers persist only sanitized envelopes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


CLAUDE_BINARY_ENV_VAR = "CLAUDE_CLI_BINARY"
CLAUDE_MOCK_ENV_VAR = "CLAUDE_CLI_MOCK"
# ARIA's default model tier. The Claude Code CLI accepts a model alias
# ("fable") or a full id; the alias resolves to Claude Fable 5 on the
# runner, keeping ARIA's fail-safe on the most capable tier (K5 tier
# flip, operator policy 2026-07-01). Per-agent overrides flow in via
# build_claude_exec_argv(model=...).
CLAUDE_DEFAULT_MODEL = "fable"
# The Claude Code CLI selects capability by model alias AND, since CLI 2.1.x,
# by an explicit ``--effort`` flag (low|medium|high|xhigh|max). These are the
# model aliases and effort levels ARIA may target; the agent-runtime-profile
# maps each agent's frontmatter to one of them.
VALID_MODELS: tuple[str, ...] = ("opus", "sonnet", "haiku", "fable")
VALID_EFFORTS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
ALLOW_API_KEY_MODE_ENV_VAR = "ARIA_ALLOW_CLAUDE_API_KEY_MODE"
REQUIRE_USAGE_ENV_VAR = "ARIA_CLAUDE_REQUIRE_USAGE"
AUTH_PREFLIGHT_SKIP_ENV_VAR = "ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP"
# Operator acknowledgement that the autonomous-write executor runs inside a
# real isolated sandbox/container. The Claude Code CLI refuses
# ``--dangerously-skip-permissions`` under root/sudo for security; a genuine
# sandboxed runner sets this so the runtime passes ``IS_SANDBOX=1`` through to
# the CLI. The recommended production path is a NON-ROOT runner (no env needed)
# — see ADR-040.
SANDBOX_ACK_ENV_VAR = "ARIA_CLAUDE_SANDBOX"
# Claude Code CLI permission modes the autonomous executor may select instead
# of the full ``--dangerously-skip-permissions`` bypass. ``acceptEdits`` /
# ``bypassPermissions`` enable autonomous worktree writes; ``plan`` / ``default``
# are read-only / human-gated.
VALID_PERMISSION_MODES: tuple[str, ...] = ("acceptEdits", "bypassPermissions", "plan", "default")

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
    # K2 (ORPHAN-HIGH-284) — model-safety refusal record extracted from the
    # stream-json events, or None. Callers own the fallback policy; the
    # runtime only detects and reports.
    refusal: dict[str, Any] | None = None
    # Credit/quota-exhaustion record (fable primary → opus fallback sibling of
    # the K2 refusal path), or None. Detection only; executors own the policy.
    credit_exhaustion: dict[str, Any] | None = None


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
    effort: str | None = None,
    skip_permissions: bool = True,
    permission_mode: str | None = None,
) -> list[str]:
    """Build the live Claude Code CLI invocation argv.

    Autonomous worktree writes need one of two permission shapes:

    * ``permission_mode`` → ``--permission-mode <mode>``. Verified live: the
      Claude Code CLI allows ``acceptEdits`` under root (auto-accepts file edits
      — the root-COMPATIBLE autonomous-write lever, proven to write a real file
      as root in an isolated dir), but refuses ``bypassPermissions`` under root
      exactly like the full bypass.
    * ``skip_permissions`` (default, no ``permission_mode``) →
      ``--dangerously-skip-permissions`` (full bypass). Requires a NON-ROOT or
      acknowledged-sandbox runner (enforced by :func:`assert_write_runner_ok`).

    A read-only/preview turn passes ``skip_permissions=False`` with no
    ``permission_mode`` (the autonomy a judge/scout never needs).
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
    if effort is not None:
        if effort not in VALID_EFFORTS:
            raise ClaudePolicyViolation(
                f"invalid effort {effort!r}; allowed: {VALID_EFFORTS}"
            )
        argv.extend(["--effort", effort])
    if permission_mode is not None:
        if permission_mode not in VALID_PERMISSION_MODES:
            raise ClaudePolicyViolation(
                f"invalid permission_mode {permission_mode!r}; allowed: {VALID_PERMISSION_MODES}"
            )
        argv.extend(["--permission-mode", permission_mode])
    elif skip_permissions:
        argv.append("--dangerously-skip-permissions")
    return argv


def _running_as_root() -> bool:
    """True when the current process is uid 0. ``os.geteuid`` is POSIX-only;
    on platforms without it ARIA is never root, so return False."""
    geteuid = getattr(os, "geteuid", None)
    return geteuid is not None and geteuid() == 0


def _sandbox_acknowledged() -> bool:
    """True when the operator has acknowledged a real isolated sandbox via
    ``ARIA_CLAUDE_SANDBOX`` (or the CLI's own ``IS_SANDBOX``)."""
    return _parse_bool(
        os.environ.get(SANDBOX_ACK_ENV_VAR, "0"), env_name=SANDBOX_ACK_ENV_VAR
    ) or _parse_bool(os.environ.get("IS_SANDBOX", "0"), env_name="IS_SANDBOX")


def assert_write_runner_ok(*, skip_permissions: bool, permission_mode: str | None) -> None:
    """Fail closed BEFORE the subprocess when the autonomous-write shape cannot
    run on this runner.

    The Claude Code CLI refuses BOTH ``--dangerously-skip-permissions`` AND
    ``--permission-mode bypassPermissions`` under root/sudo for security (verified
    live). Rather than surface that as a cryptic non-zero subprocess exit, ARIA
    detects it at preflight and raises with the operator-actionable fix: run the
    autonomous-write executor as a NON-ROOT user, OR select
    ``permission_mode='acceptEdits'`` (the root-compatible autonomous-write
    lever), OR acknowledge a genuine sandbox via ``ARIA_CLAUDE_SANDBOX=1``
    (ADR-040). ``acceptEdits`` / ``plan`` / ``default`` are NOT root-blocked.
    """
    root_blocked = (permission_mode is None and skip_permissions) or permission_mode == "bypassPermissions"
    if root_blocked and _running_as_root() and not _sandbox_acknowledged():
        raise ClaudePolicyViolation(
            "claude_autonomous_write_runner_is_root: the Claude Code CLI refuses "
            "--dangerously-skip-permissions / bypassPermissions under root. Run the "
            "autonomous-write executor as a non-root user, pass "
            "permission_mode='acceptEdits' (root-compatible), or set "
            "ARIA_CLAUDE_SANDBOX=1 inside a genuine isolated sandbox (ADR-040)."
        )


# ORPHAN-CRITICAL-427 — operator escape hatch for a host with no sandbox
# backend. Named explicitly rather than inferred, and audited in the refusal
# message, so running a write-capable agent unconfined is a recorded decision
# and never a silent default.
UNCONFINED_ACK_ENV_VAR = "ARIA_ALLOW_UNCONFINED_WRITE"


def _is_write_capable(*, skip_permissions: bool, permission_mode: str | None) -> bool:
    """True when this invocation can edit files without asking.

    Read-only turns (``skip_permissions=False`` with no permission_mode, and
    ``plan``) need no filesystem containment because they cannot write.
    """
    if permission_mode in {"bypassPermissions", "acceptEdits"}:
        return True
    if permission_mode in {"plan", "default"}:
        return False
    return skip_permissions


def _apply_write_containment(
    argv: list[str],
    *,
    skip_permissions: bool,
    permission_mode: str | None,
    workspace_root: str | Path | None,
) -> list[str]:
    """Wrap a write-capable spawn so READONLY_PATHS are enforced by the OS.

    Fail-closed: with no sandbox backend the spawn is REFUSED unless the
    operator has set ``ARIA_ALLOW_UNCONFINED_WRITE``. Pre-fix
    ``wrap_bash_in_sandbox`` had no caller at all, so a write-capable agent
    always ran unconfined and the containment existed only as text the
    agent could ignore.

    ``allow_network=True`` because the agent process must reach the Claude
    API. Network egress from the agent's own bash commands is a separate
    concern; the property bought here is that the kernel, workflows and
    agent definitions cannot be mutated regardless of what the agent
    decides to do.
    """
    if not _is_write_capable(
        skip_permissions=skip_permissions, permission_mode=permission_mode,
    ):
        return argv
    workspace = Path(workspace_root) if workspace_root is not None else Path.cwd()
    try:
        from aria_kernel.implementation_safety import (
            SandboxUnavailable,
            wrap_bash_in_sandbox,
        )
    except ImportError as exc:  # pragma: no cover - kernel always importable here
        raise ClaudePolicyViolation(
            f"claude_write_containment_unavailable: cannot import the sandbox "
            f"helper ({exc}); refusing to spawn a write-capable agent unconfined"
        ) from exc
    try:
        return wrap_bash_in_sandbox(
            argv, workspace_root=workspace, allow_network=True,
        )
    except SandboxUnavailable as exc:
        if _parse_bool(
            os.environ.get(UNCONFINED_ACK_ENV_VAR, "0"),
            env_name=UNCONFINED_ACK_ENV_VAR,
        ):
            return argv
        # ORPHAN-CRITICAL-451 — this message used to say "install bwrap or
        # firejail". Following the second option satisfied the S0 exit
        # criterion with the kernel fully writable, because the firejail
        # branch applied none of the READONLY_PATHS. bwrap is now the only
        # accepted backend, so it is the only one suggested.
        raise ClaudePolicyViolation(
            f"claude_write_containment_required: {exc}. Install bwrap on the "
            f"runner AND give it unprivileged user namespaces, use a "
            f"read-only shape (skip_permissions=False), or set "
            f"{UNCONFINED_ACK_ENV_VAR}=1 to accept an unconfined "
            f"write-capable agent on this host."
        ) from exc


def _apply_resource_limits(argv: list[str], *, timeout_seconds: int) -> list[str]:
    """Bound the spawned agent's memory, CPU, task count and wall clock.

    ORPHAN-MEDIUM-459 — the kernel half of this shipped with the sandbox
    work and had no production caller; the only instruction to run it was a
    line in `.claude/agents/aria-implementer.md`, which is prose addressed to
    the process being limited. `ORPHAN-CRITICAL-427` fixed exactly that
    mistake for containment and left it standing here.

    Lazy import mirroring `_apply_write_containment`, and it fails the same
    way: a kernel that cannot be imported means the perimeter cannot be
    applied, and a write-capable agent must not be spawned unbounded on the
    strength of an ImportError.
    """
    try:
        from aria_kernel.implementation_safety import apply_resource_limits
    except ImportError as exc:  # pragma: no cover - kernel always importable here
        raise ClaudePolicyViolation(
            f"claude_resource_limits_unavailable: cannot import the limit "
            f"helper ({exc}); refusing to spawn an unbounded agent"
        ) from exc
    return apply_resource_limits(argv, timeout_seconds=timeout_seconds)


def run_claude_exec(
    *,
    prompt_text: str,
    timeout_seconds: int,
    model: str | None = None,
    effort: str | None = None,
    require_usage: bool | None = None,
    cwd: str | Path | None = None,
    skip_permissions: bool = True,
    permission_mode: str | None = None,
) -> ClaudeRunResult:
    preflight_claude_auth()
    assert_write_runner_ok(skip_permissions=skip_permissions, permission_mode=permission_mode)
    argv = build_claude_exec_argv(
        model=model,
        effort=effort,
        skip_permissions=skip_permissions,
        permission_mode=permission_mode,
    )
    # ORPHAN-CRITICAL-427 — containment is applied HERE, by the code that
    # spawns the process, not by prose in the agent's own instruction file.
    # A write-capable shape (full permission bypass or acceptEdits) gets
    # wrapped so READONLY_PATHS are ro-bind: a write under aria-kernel/ or
    # .github/ then fails with EROFS at the syscall level instead of
    # depending on the agent choosing to obey.
    argv = _apply_write_containment(
        argv,
        skip_permissions=skip_permissions,
        permission_mode=permission_mode,
        workspace_root=cwd,
    )
    # ORPHAN-MEDIUM-459 — resource limits, applied by the spawner for the same
    # reason containment is. `apply_resource_limits` shipped with the sandbox
    # work, was exported, was name-pinned by a test, and had ZERO production
    # callers: its only instruction to actually run it lived in
    # `.claude/agents/aria-implementer.md`, addressed to the process being
    # limited. A fork bomb or a runaway allocation in a write-capable agent
    # was bounded by nothing.
    #
    # OUTSIDE the sandbox wrapper on purpose: `timeout` and `systemd-run`
    # must own the whole process tree including bwrap, not run inside it.
    #
    # The caller's `timeout_seconds`, not the helper's 120s default — an
    # agent run is minutes, and a 120s cap would kill every real invocation.
    # The subprocess timeout below stays 30s looser so the cgroup/`timeout`
    # limit fires first and its exit status is what the caller sees.
    argv = _apply_resource_limits(argv, timeout_seconds=timeout_seconds)
    # In an acknowledged sandbox, pass IS_SANDBOX=1 so the CLI permits the full
    # bypass even under root; the non-root runner path needs no env change.
    run_env = os.environ.copy()
    if _sandbox_acknowledged():
        run_env["IS_SANDBOX"] = "1"
    proc = subprocess.run(
        argv,
        input=prompt_text,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 30,
        check=False,
        cwd=str(cwd) if cwd is not None else None,
        env=run_env,
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
        refusal=extract_refusal(events),
        credit_exhaustion=extract_credit_exhaustion(
            returncode=proc.returncode, stderr=proc.stderr, events=events,
            final_message=final_message,
        ),
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


def extract_refusal(events: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    """Detect a model-safety refusal in Claude stream-json events (K2).

    Two candidate shapes are matched, per the 2026-07-01 live probe of the
    stream-json surface (assistant events embed the API message with
    ``stop_reason`` + ``stop_details``; the terminal ``result`` event carries
    ``subtype``):

    * an ``assistant`` event whose ``message.stop_reason == "refusal"`` —
      the API-level classifier decline (Fable safety classifiers; category
      commonly ``cyber``/``bio``);
    * a ``result`` event whose ``subtype`` names a refusal.

    Returns a record naming which shape fired (``source``) plus the
    ``category``/``explanation`` from ``stop_details`` when present, or
    ``None`` when no refusal marker exists. Detection only — the fallback
    policy (single audited retry on the fallback tier, HUMAN_REQUIRED on a
    second refusal) lives in the executors.
    """
    for event in events:
        if event.get("type") == "assistant":
            message = event.get("message") or {}
            if message.get("stop_reason") == "refusal":
                details = message.get("stop_details") or {}
                return {
                    "source": "assistant_stop_reason",
                    "category": details.get("category"),
                    "explanation": details.get("explanation"),
                    "model": message.get("model"),
                }
        if event.get("type") == "result":
            subtype = str(event.get("subtype") or "")
            if "refusal" in subtype:
                return {
                    "source": "result_subtype",
                    "category": None,
                    "explanation": str(event.get("result") or "")[:300],
                    "model": None,
                }
    return None


# Credit/quota exhaustion has TWO distinct wire shapes under managed-session
# auth — proven live 2026-07-03 when ARIA's Fable pool ran dry:
#
# (1) CLI USAGE-LIMIT MESSAGE — the Claude Code CLI returns its OWN limit
#     notice as ASSISTANT CONTENT on a CLEAN run (returncode 0, zero output
#     tokens, terminal_reason=completed):
#       "You've reached your Fable 5 limit. Run /usage-credits to continue or
#        switch models with /model."
#     It is NOT a stderr error and NOT a nonzero exit, so it MUST be matched on
#     the response TEXT regardless of returncode. These markers are specific
#     enough that content-matching is false-positive-safe (an agent plan does
#     not naturally contain "/usage-credits" or "switch models with /model").
USAGE_LIMIT_MARKERS: tuple[str, ...] = (
    "usage-credits",              # the /usage-credits purchase command
    "switch models with /model",  # the model-switch hint in the limit notice
)
# (2) API CREDIT/QUOTA ERROR — an actual failure (returncode != 0) whose text
#     names a credit/quota/billing problem.
#
# Transient signals ("overloaded", a bare per-minute rate limit / HTTP 429,
# network/timeout) are in NEITHER set — they stay on the EXTERNAL_OUTAGE
# requeue path (retry on the SAME model clears them), whereas credit exhaustion
# is deterministic and model-pool specific (only a different tier's pool
# resolves it), exactly like a refusal.
CREDIT_ERROR_MARKERS: tuple[str, ...] = (
    "credit balance",          # "Your credit balance is too low"
    "insufficient credit",
    "insufficient_quota",
    "insufficient funds",
    "quota exceeded",
    "quota_exceeded",
    "out of credits",
    "purchase more credits",
    "billing",
    "payment required",        # HTTP 402 reason phrase (avoids a bare "402" match)
    "usage limit reached",
)
# Union kept under the original name for external/test references. The operator
# tunes these from production: every credit fallback emits a governance row
# carrying the real matched marker.
CREDIT_EXHAUSTION_MARKERS: tuple[str, ...] = USAGE_LIMIT_MARKERS + CREDIT_ERROR_MARKERS


def run_with_model_fallback(
    *,
    run: Callable[[str, str], ClaudeRunResult],
    model: str,
    effort: str,
    on_credit: Callable[[dict[str, Any]], None] | None = None,
    on_refusal: Callable[[dict[str, Any]], None] | None = None,
) -> ClaudeRunResult:
    """Run one dispatch and apply the fable→opus fallback policy.

    ``run(model, effort)`` executes a single attempt. This is the SSoT for
    the fallback behaviour both executors share (extracted so it is unit-
    testable without a full lease/dispatch environment):

    * Fallback fires ONLY when the primary ``model`` is ``fable``.
    * A credit/quota exhaustion retries once on ``opus`` at ``xhigh``
      ("ultra code") effort — opus is a separate credit pool.
    * A refusal retries once on ``opus`` at the ORIGINAL effort (K2).
    * Total retries are bounded to exactly ONE: each branch returns the
      opus result directly, so a credit/refusal signal on THAT result
      escalates at the caller (its unresolved-* branch) instead of
      re-retrying. Credit takes precedence over refusal.
    * A failure already on a non-fable model is returned unchanged
      (fail-closed at the caller).

    The ``on_credit`` / ``on_refusal`` hooks receive the detection record so
    the caller can emit its own audit (ci_executor: governance rows;
    worker_executor: stderr). Hooks never alter control flow.
    """
    completed = run(model, effort)
    if model != "fable":
        return completed
    if completed.credit_exhaustion is not None:
        if on_credit is not None:
            on_credit(completed.credit_exhaustion)
        return run("opus", "xhigh")
    if completed.refusal is not None:
        if on_refusal is not None:
            on_refusal(completed.refusal)
        return run("opus", effort)
    return completed


def extract_credit_exhaustion(
    *,
    returncode: int,
    stderr: str,
    events: tuple[dict[str, Any], ...],
    final_message: str = "",
) -> dict[str, Any] | None:
    """Detect a credit/quota-exhaustion failure (detection only — sibling of
    :func:`extract_refusal`; the fable→opus fallback policy lives in the
    executors).

    Two shapes are matched over the FULL response text (stderr + final message
    + assistant content + the terminal ``result`` event):

    * A CLI **usage-limit message** (``USAGE_LIMIT_MARKERS`` or the
      "reached your … limit" co-occurrence) fires REGARDLESS of returncode —
      the CLI returns its limit notice as assistant content on a clean exit,
      so a ``returncode != 0`` gate would miss it (the 2026-07-03 live case).
    * An API **credit/quota error** (``CREDIT_ERROR_MARKERS``) fires only on a
      real failure (``returncode != 0``), so a plan that merely mentions
      "billing" on a clean run is never misread.

    Returns a record naming the matched marker, or ``None``.
    """
    haystacks: list[str] = [stderr or "", final_message or ""]
    for event in events:
        if event.get("type") == "assistant":
            haystacks.append(_assistant_text(event.get("message")))
        if event.get("type") == "result":
            haystacks.append(str(event.get("result") or ""))
            haystacks.append(str(event.get("error") or ""))
            haystacks.append(str(event.get("subtype") or ""))
    blob = "\n".join(haystacks).lower()
    # (1) CLI usage-limit MESSAGE — content-based, returncode-independent.
    limit_marker = next((m for m in USAGE_LIMIT_MARKERS if m in blob), None)
    if limit_marker is None and "reached your" in blob and "limit" in blob:
        limit_marker = "reached_your_limit"
    if limit_marker is not None:
        return {
            "source": "cli_usage_limit_message",
            "matched_marker": limit_marker,
            "returncode": returncode,
        }
    # (2) API credit/quota ERROR — gated on a real (nonzero-exit) failure.
    if returncode != 0:
        for marker in CREDIT_ERROR_MARKERS:
            if marker in blob:
                return {
                    "source": "cli_error_text",
                    "matched_marker": marker,
                    "returncode": returncode,
                }
    return None


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
