"""Codex CLI runtime bridge with a shared typed-failure vocabulary.

Bounded `codex exec` spawns map JSONL events into the auth/quota/process
result shape used by the Claude runtime. The dispatch seam does not itself
wire native worker selection or establish effective managed authentication.
Codex requires a managed ChatGPT session; Z.ai credentials belong only to
its distinct transport and must not enter this child environment.

Interface facts this bridge is built on (codex-cli 0.149.1, verified live
on the runner host 2026-08-29):

  codex exec --json [--model M] [--sandbox read-only|workspace-write]
            [--output-last-message FILE] [--cd DIR] [PROMPT]

  stdout  → JSONL events: {"type": "error"|"turn.failed"|...}
  -o FILE → the agent's final message, written even on failure paths that
            produced partial output
  auth    → the caller selects managed-state locations. The environment
            owner excludes provider-key names; stored credentials and CLI
            settings still require their own effective-authentication checks.

NO MOCK MODE: production lanes never fabricate Codex output. Tests inject
the runner callable.
"""

from __future__ import annotations

import json
import os
import selectors as _selectors
import signal as _signal
import shutil as _shutil
import hashlib as _hashlib
import subprocess
import tempfile
import time as _time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from typing import TYPE_CHECKING as _TYPE_CHECKING

if _TYPE_CHECKING:
    from aria_kernel.model_fleet import _RuntimeStatusObservation

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


def _probe_codex_auth_status(
    *, environ: dict[str, str], timeout_seconds: float,
    _wrap_command: Callable[[list[str]], list[str]] | None = None,
) -> _RuntimeStatusObservation:
    """Observe a bounded public login-status response, retaining only its type.

    A reported ChatGPT login is a local status observation, not remaining
    quota, model access, or authentication enforcement for a later model run.
    Unknown output forms remain unknown; raw output never leaves this owner.
    """
    from aria_kernel.agent_env import _codex_status_environment
    from aria_kernel.model_fleet import _RuntimeStatusObservation

    command = (CODEX_BINARY, "login", "status")
    if timeout_seconds <= 0:
        return _RuntimeStatusObservation("unknown", reason="status_deadline_elapsed", command=command)
    deadline = _time.monotonic() + min(20.0, timeout_seconds)
    proc = None
    output = bytearray()
    try:
        with _selectors.DefaultSelector() as selector:
            actual_command = _wrap_command(list(command)) if _wrap_command is not None else list(command)
            proc = subprocess.Popen(
                actual_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, env=_codex_status_environment(environ),
                **({"start_new_session": True} if _wrap_command is not None else {}),
            )
            assert proc.stdout is not None
            selector.register(proc.stdout, _selectors.EVENT_READ)
            while True:
                remaining = deadline - _time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise subprocess.TimeoutExpired(command, timeout_seconds)
                if _time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(command, timeout_seconds)
                # A full allowance without observed EOF cannot prove a complete
                # response. Never consume another byte just to classify it.
                allowance = 4096 - len(output)
                if allowance <= 0:
                    return _RuntimeStatusObservation(
                        "unknown", reason="status_output_limit", command=command,
                    )
                chunk = os.read(proc.stdout.fileno(), allowance)
                if not chunk:
                    break
                output.extend(chunk)
            remaining = deadline - _time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            returncode = proc.wait(timeout=remaining)
            if _time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
    except subprocess.TimeoutExpired:
        return _RuntimeStatusObservation("unknown", reason="status_timeout", command=command)
    except OSError:
        return _RuntimeStatusObservation("unknown", reason="status_command_unavailable", command=command)
    finally:
        if proc is not None:
            if proc.poll() is None:
                if _wrap_command is not None:
                    try:
                        os.killpg(proc.pid, _signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    proc.kill()
            proc.wait()
            if proc.stdout is not None:
                proc.stdout.close()
    if (returncode != 0 and _wrap_command is not None
            and output == b"Failed to connect to bus: No medium found\n"):
        return _RuntimeStatusObservation(
            "unknown", reason="control_plane_failure", command=command, exit_code=returncode,
            control_status="unavailable", control_reason="user_bus_unavailable",
        )
    if returncode != 0:
        return _RuntimeStatusObservation(
            "unknown", reason="status_not_confirmed", command=command, exit_code=returncode,
        )
    try:
        status = output.decode("utf-8").strip()
    except UnicodeDecodeError:
        status = ""
    # The supported CLI can report an optional PATH-alias write warning
    # while successfully reading a managed login from the read-only store.
    # Admit that exact complete diagnostic only; any other extra/conflicting
    # output remains unknown rather than selecting a convenient auth substring.
    lines = status.splitlines()
    readonly_alias_warning = (
        len(lines) == 2 and lines[0] ==
        "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)"
    )
    if readonly_alias_warning:
        status = lines[1]
    elif len(lines) != 1:
        status = ""
    if status == "Logged in using ChatGPT":
        return _RuntimeStatusObservation(
            "available", reason=("cli_reported_managed_login_with_readonly_path_alias_warning"
                                 if readonly_alias_warning else "cli_reported_managed_login"), command=command,
            exit_code=returncode, auth_method="chatgpt",
        )
    if status.startswith("Logged in using an API key - "):
        return _RuntimeStatusObservation(
            "unavailable", reason=("managed_login_required_with_readonly_path_alias_warning"
                                   if readonly_alias_warning else "managed_login_required"), command=command,
            exit_code=returncode, auth_method="api_key",
        )
    return _RuntimeStatusObservation(
        "unknown", reason="status_output_unrecognized", command=command, exit_code=returncode,
    )


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
    effort: str | None = None,
) -> list[str]:
    """The exact argv for one bounded Codex dispatch.

    The prompt rides argv (codex exec's contract); JSONL events on stdout;
    the final message additionally lands in -o so a long stream never
    costs the answer.
    """
    if sandbox not in CODEX_SANDBOX_MODES:
        raise ValueError(f"codex_sandbox_mode_invalid: {sandbox!r}")
    from aria_kernel.scope_discipline import codex_network_off_config
    argv = [
        CODEX_BINARY, "exec", "--json",
        "--sandbox", sandbox,
        "--model", model,
    ]
    # ARIA scope discipline — network is OFF, pinned, not trusted to defaults
    argv += codex_network_off_config()
    if effort is not None:
        argv += ["-c", f"model_reasoning_effort={json.dumps(effort)}"]
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
             "remedy": "restore the managed ChatGPT session through the supported Codex login"}
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
    effort: str | None = None,
) -> CodexRunResult:
    """One bounded production Codex dispatch. No mock path exists here.

    The shared environment owner admits process plumbing, caller-selected
    managed-state locations and explicit noncredential data. This name policy
    does not establish effective managed authentication in CLI settings.
    """
    from aria_kernel.agent_env import _codex_exec_environment

    with tempfile.TemporaryDirectory(prefix="aria-codex-") as tmp:
        last_message_path = Path(tmp) / "last-message.txt"
        argv = build_codex_argv(
            prompt, model=model, sandbox=sandbox,
            output_last_message=last_message_path, cwd=cwd, effort=effort,
        )
        run_env = _codex_exec_environment(os.environ, extra=env)
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


@dataclass(frozen=True)
class _ManagedCodexContext:
    workspace: Path
    runtime_directory: Path
    auth_directory: Path
    executable: Path
    environment: dict[str, str]
    configuration: dict[str, Any]
    control_environment: dict[str, str] = field(repr=False)

    def configuration_argv(self) -> list[str]:
        arguments = []
        for name, value in self.configuration.items():
            arguments.extend(["-c", name + "=" + json.dumps(value)])
        return arguments

    def wrap(self, argv: list[str], timeout_seconds: int) -> list[str]:
        from aria_kernel.implementation_safety import (
            _wrap_runtime_state_in_sandbox, _apply_resource_limits,
        )

        command = [str(self.executable), *argv[1:]]
        if argv[1:] == ["login", "status"]:
            # Status and execution use the same store/mode and private paths.
            # These overrides are only used inside the read-only auth mount.
            command[1:1] = self.configuration_argv()
        limited = _apply_resource_limits(
            _wrap_runtime_state_in_sandbox(
                command, workspace_root=self.workspace, runtime_directory=self.runtime_directory,
                managed_auth_directory=self.auth_directory, executable=self.executable,
                environment=self.environment,
            ), timeout_seconds=timeout_seconds,
            environ={**self.environment, **self.control_environment},
        )
        # Only the trusted limiter receives user-bus plumbing. The namespace
        # wrapper clears it before installing the exact closed model env.
        return ["/usr/bin/env", *(name + "=" + value for name, value in self.control_environment.items()), *limited]

    @property
    def settings_hash(self) -> str:
        encoded = json.dumps(self.configuration, sort_keys=True, separators=(",", ":")).encode()
        return "sha256:" + _hashlib.sha256(encoded).hexdigest()


def _prepare_managed_codex_context(
    *, workspace: Path, runtime_directory: Path, environment: dict[str, str], profile: Any,
) -> _ManagedCodexContext:
    from aria_kernel.agent_env import _codex_exec_environment
    from aria_kernel.implementation_safety import SANDBOX_HOME, SandboxUnavailable

    if profile.write_capable or profile.external_writes or set(profile.tools) - {"Read", "Grep", "Glob"}:
        raise SandboxUnavailable("codex_native_profile_controls_unavailable")
    binary = _shutil.which(CODEX_BINARY, path=environment.get("PATH", os.defpath))
    if binary is None:
        raise SandboxUnavailable("codex_cli_unavailable")
    auth = Path(environment.get("CODEX_HOME") or str(Path(environment.get("HOME", str(Path.home()))) / ".codex"))
    if not auth.is_absolute() or not auth.is_dir():
        raise SandboxUnavailable("codex_managed_auth_directory_unavailable")
    if not (auth / "auth.json").is_file():
        raise SandboxUnavailable("codex_managed_auth_file_unavailable")
    runtime = runtime_directory.resolve(strict=True)
    for name in ("codex-home", "sqlite", "logs", "tmp", "cache", "config", "data", "state"):
        (runtime / name).mkdir()
    env = _codex_exec_environment(environment, extra={
        "HOME": SANDBOX_HOME, "CODEX_HOME": str(runtime / "codex-home"),
        "CODEX_SQLITE_HOME": str(runtime / "sqlite"), "TMPDIR": str(runtime / "tmp"),
        "XDG_CACHE_HOME": str(runtime / "cache"), "XDG_CONFIG_HOME": str(runtime / "config"),
        "XDG_DATA_HOME": str(runtime / "data"), "XDG_STATE_HOME": str(runtime / "state"),
    })
    configuration = {
        "sqlite_home": str(runtime / "sqlite"), "log_dir": str(runtime / "logs"),
        "history.persistence": "none", "model_provider": "openai", "web_search": "disabled",
        "cli_auth_credentials_store": "file", "forced_login_method": "chatgpt",
        # This first native read-only route uses its sealed supplied context.
        # It grants no general shell, application connector or network tool.
        "features.shell_tool": False, "features.unified_exec": False, "features.apps": False,
    }
    control_environment = {name: environment[name] for name in
                           ("DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR") if name in environment}
    context = _ManagedCodexContext(workspace.resolve(), runtime, auth.resolve(), Path(binary).resolve(),
                                  env, configuration, control_environment)
    # This reaches the existing real namespace/limiter probes. A binary or
    # auth marker alone never turns the control observation into available.
    context.wrap([CODEX_BINARY, "login", "status"], 20)
    return context


def _run_managed_codex_exec(
    context: _ManagedCodexContext, prompt: str, *, model: str, effort: str,
    timeout_seconds: int, control: Any,
) -> CodexRunResult:
    from claude_runtime import _run_spawn

    output = context.runtime_directory / "last-message.txt"
    argv = build_codex_argv(prompt, model=model, sandbox="read-only", output_last_message=output,
                            cwd=context.workspace, effort=effort)
    settings = ["--ignore-user-config", "--ephemeral", *context.configuration_argv()]
    argv[-1:-1] = settings
    completed = _run_spawn(
        context.wrap(argv, timeout_seconds), input_text="", timeout_seconds=timeout_seconds,
        cwd=str(context.workspace), env=context.environment, control=control,
    )
    events = []
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    classification = classify_codex_events(events, completed.returncode)
    return CodexRunResult(
        completed.returncode, completed.stdout, completed.stderr,
        output.read_text(encoding="utf-8") if output.is_file() else "",
        tuple(events), classification.auth_failure, classification.credit_exhaustion, model,
    )


def codex_dispatch(
    prompt: str,
    *,
    model: str = DEFAULT_CODEX_MODEL,
    sandbox: str = "read-only",
    cwd: Path | None = None,
    run: Callable[..., CodexRunResult] = run_codex_exec,
    effort: str | None = None,
    **run_kwargs: Any,
) -> CodexRunResult:
    """Dispatch seam: production callers go through here; tests inject `run`."""
    if effort is not None:
        run_kwargs["effort"] = effort
    return run(prompt, model=model, sandbox=sandbox, cwd=cwd, **run_kwargs)
