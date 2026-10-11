"""ARIA-HIGH-434 — the Z.ai write runtime: a kernel-owned tool loop under the Claude writer's gate and room.

WHY. Operator decision 2026-10-10/11: when the Claude quota window is spent,
EVERY area moves to Z.ai — the write seats too (the implementer, the worker
lane). The Z.ai transport was one chat completion (`zai_runtime.run_zai_chat`)
with no way to touch a workspace, so `model_fleet` marked it read-only and
the write seats waited by name until the reset. The 2026-09-11 policy forbids
the shortcut (pointing the `claude` CLI at Z.ai's Anthropic route with the
Z.ai key), so the loop is the kernel's own: it speaks Z.ai's documented
OpenAI-compatible function calling from OUTSIDE every sandbox, where the
credential already lives, and runs each tool call the model asks for INSIDE
the room the Claude implementer's tools run in.

WHAT IS THE SAME AS THE CLAUDE WRITER (one owner each, called, never copied):

* The policy is the settings document the Claude spawn would carry for this
  profile (`claude_settings.build_settings` over `claude_runtime._hook_context`):
  its `permissions.deny` rules, its hook matchers and its `_aria.turn_budget`.
  The envelope (denied tools, write scope, env passthrough) is
  `claude_runtime._envelope_from_profile`.
* Every call the PreToolUse matcher covers is decided by `hooks.run_hook
  ("pre-tool")` — the function the hook broker calls for the CLI — with the
  payload the CLI sends: `decide_pre_tool`, the turn budget admitted in the
  decision ledger's own transaction, the pre-write checkpoint. PostToolUse
  and the session events go through `run_hook` the same way. The document's
  deny rules then apply as the CLI applies them (`command_policy.
  claude_rule_matches` for Bash, the Read rules on every path a read tool
  names).
* The room is `implementation_safety.wrap_bash_in_sandbox` with the profile's
  write scope and the SAME git containment (the commit-capable one the
  executor holds for the implementer, else derived read-only exactly as
  `claude_runtime._apply_write_containment` derives it), the managed spawn's
  isolation flags, and `apply_resource_limits` around it.
* The kernel's own MCP view (`mcp__aria__*`, the implementer contract's
  `plan_verify`) is the same `AriaMcpServer(allow_writes=False)` the MCP
  broker serves, served where the store is.
* The transcript is Claude stream-json in shape, so every reader of a Claude
  transcript (`parse_claude_jsonl`, `extract_final_message`, `extract_usage`,
  the progress writer) reads this one.

WHAT DIFFERS, ON PURPOSE:

* No network in the room. The Claude room shares the host's network only
  because the CLI inside it calls its provider (`MANAGED_SPAWN_ALLOW_NETWORK`);
  here the provider call is the loop's, outside, so the room is the
  validation sandbox's shape: `--unshare-net`.
* One room per call. Each tool call gets a fresh room built by the same
  builder: the workspace persists between calls, `/tmp` and background
  processes do not (the Claude room's live as long as the CLI).
* No Claude credential in the room: the CLI's auth names are removed from
  the built environment, and the room refuses to start if any secret-shaped
  name remains or if the Z.ai key file lies under any path the room binds.
* A completion cap (`COMPLETIONS_PER_BUDGETED_TURN` x the turn budget): the
  CLI ends its own session; an HTTP conversation needs a bound of its own.
* No context compaction. A vendor that refuses an over-long conversation
  ends the attempt by name (`vendor_refused`).
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from claude_runtime import (
    ClaudePolicyViolation,
    ClaudeRunResult,
    UsageRecording,
    _apply_resource_limits,
    _clamp_timeout_to_job_deadline,
    _envelope_from_profile,
    _hook_context,
    _kernel_profile,
)
from zai_runtime import (
    DEFAULT_ZAI_TIMEOUT_SECONDS,
    ZAI_CREDENTIAL_ENV,
    ZAI_CREDENTIAL_FILE_ENV,
    Opener,
    ZaiExecutionContext,
    ZaiRunResult,
    resolve_zai_max_tokens,
    run_zai_turn,
)

ROOM_CHILD = Path(__file__).resolve().with_name("zai_room_child.py")
# The implementer's built-in tools — the write profiles' whole grant.
ROOM_BUILTIN_TOOLS: tuple[str, ...] = ("Read", "Grep", "Glob", "Edit", "Write", "Bash")
ROOM_FILE_TOOLS: frozenset[str] = frozenset({"Read", "Grep", "Glob", "Edit", "Write"})
READ_RULE_TOOLS: frozenset[str] = frozenset({"Read", "Grep", "Glob"})
ROOM_ALLOW_NETWORK = False
# The CLI's Bash tool bounds: 2 minutes by default, 10 at most, 30k
# characters of output.
BASH_DEFAULT_TIMEOUT_MS = 120_000
BASH_MAX_TIMEOUT_MS = 600_000
TOOL_OUTPUT_MAX_CHARS = 30_000
# A file tool touches one file or walks one tree; its room is bounded well
# below a command's.
FILE_TOOL_TIMEOUT_SECONDS = 120
COMPLETIONS_PER_BUDGETED_TURN = 2
STOP_COMPLETED = "completed"
TRANSCRIPT_RUNTIME = "zai_tool_loop"

# The harness text the CLI would otherwise supply. The rendered request (the
# envelope and the agent contract) stays the user turn and the caller's
# system text, byte for byte.
ROOM_SYSTEM_PROMPT = (
    "You run as an ARIA agent through the kernel's Z.ai tool loop. Do the work your instructions ask "
    "for with the tools offered; they behave like Claude Code's tools of the same names, and every "
    "file path is absolute or relative to the workspace root. The kernel decides every call: a refused "
    "call comes back as an error carrying the reason, and retrying it unchanged is refused again. "
    "While work remains, answer with tool calls. When the work is done, answer WITHOUT a tool call: that "
    "final answer must be exactly what your instructions require, and nothing else."
)

_TOOL_SPECS: dict[str, tuple[str, dict[str, Any], list[str]]] = {
    "Read": ("Read a file; returns `cat -n` numbered lines (2000 by default; offset is the first line number).",
             {"file_path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}},
             ["file_path"]),
    "Write": ("Write a whole file (created with its directories, or replaced).",
              {"file_path": {"type": "string"}, "content": {"type": "string"}}, ["file_path", "content"]),
    "Edit": ("Replace old_string with new_string in a file; old_string must be unique unless replace_all.",
             {"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"},
              "replace_all": {"type": "boolean"}}, ["file_path", "old_string", "new_string"]),
    "Glob": ("List files matching a glob pattern (e.g. `src/**/*.ts`), newest first.",
             {"pattern": {"type": "string"}, "path": {"type": "string"}}, ["pattern"]),
    "Grep": ("Search file contents with a regular expression.",
             {"pattern": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"},
              "output_mode": {"type": "string", "enum": ["files_with_matches", "content", "count"]},
              "-i": {"type": "boolean"}, "head_limit": {"type": "integer"}}, ["pattern"]),
    "Bash": ("Run one command line at the workspace root (no shell operators; the kernel's command policy "
             "decides). timeout in milliseconds, at most 600000.",
             {"command": {"type": "string"}, "timeout": {"type": "integer"}, "description": {"type": "string"}},
             ["command"]),
}


@dataclass(frozen=True)
class RoomSeat:
    """Who the loop runs for and where: the facts the hook broker and the
    MCP broker are constructed with for a Claude spawn."""

    agent_profile: Any
    workspace_root: Path
    tools_dir: Path
    request_id: str
    role: str
    target_agent: str
    git_containment: Any | None = None
    spawn_control: Any | None = None


@dataclass(frozen=True)
class RoomPolicy:
    turn_budget: int | None
    disallowed: frozenset[str]
    bash_deny_rules: tuple[str, ...]
    read_deny_patterns: tuple[str, ...]
    pre_tool_matcher: re.Pattern[str]
    post_tool_matcher: re.Pattern[str]
    write_scope: tuple[str, ...] | None
    passthrough: tuple[str, ...]


@dataclass(frozen=True)
class CallVerdict:
    decision: str
    reason: str
    gate: str


@dataclass(frozen=True)
class ZaiLoopResult(ZaiRunResult):
    """A finished loop, read where a single completion is read.

    ``raw_body`` is the stream-json transcript; ``final_message`` the answer
    that ended the loop; ``usage`` the sum over every turn, None when any
    turn reported none (never priced as zero)."""

    response_ids: tuple[str, ...] = ()
    stop_reason: str = ""
    completions: int = 0
    tool_calls: int = 0
    refused_calls: int = 0

    @property
    def returncode(self) -> int:
        return 0 if self.stop_reason == STOP_COMPLETED and self.http_status == 200 and self.final_message else 1

    @property
    def provider_session_ids(self) -> tuple[str, ...]:
        return self.response_ids


def _matcher(settings: dict[str, Any], event: str) -> re.Pattern[str]:
    entries = settings["hooks"][event]
    return re.compile(str(entries[0]["matcher"]))


def room_policy(seat: RoomSeat) -> RoomPolicy:
    """The settings document the Claude spawn would carry, read as policy.

    Fail-closed on a rule this loop cannot apply: a document that grows a
    rule shape the gate does not know is refused by name, never skipped."""
    from aria_kernel.claude_settings import build_settings

    kernel = _kernel_profile(seat.agent_profile)
    if kernel is None or not getattr(kernel, "write_capable", False):
        raise ClaudePolicyViolation("zai_room_requires_a_write_profile")
    recording = UsageRecording(request_id=seat.request_id, role=seat.role, target_agent=seat.target_agent,
                               base_dir=seat.tools_dir)
    hook_context = _hook_context(usage_recording=recording, workspace_root=seat.workspace_root)
    settings = build_settings(kernel, hook_context=hook_context)
    disallowed, write_scope, passthrough = _envelope_from_profile(seat.agent_profile)
    bash: list[str] = []
    read: list[str] = []
    tools: set[str] = set(disallowed)
    for rule in settings["permissions"]["deny"]:
        if rule == "Bash" or rule.startswith("Bash("):
            bash.append(rule)
        elif rule.startswith("Read(") and rule.endswith(")"):
            pattern = rule[5:-1]
            if not pattern or pattern.startswith(("/", "~")):
                raise ClaudePolicyViolation(f"zai_room_permission_rule_unsupported:{rule}")
            read.append(pattern)
        elif re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", rule):
            tools.add(rule)
        else:
            raise ClaudePolicyViolation(f"zai_room_permission_rule_unsupported:{rule}")
    turn_budget = settings["_aria"]["turn_budget"]
    return RoomPolicy(
        turn_budget=int(turn_budget) if turn_budget is not None else None, disallowed=frozenset(tools),
        bash_deny_rules=tuple(bash), read_deny_patterns=tuple(read),
        pre_tool_matcher=_matcher(settings, "PreToolUse"), post_tool_matcher=_matcher(settings, "PostToolUse"),
        write_scope=tuple(write_scope) if write_scope is not None else None, passthrough=tuple(passthrough),
    )


def _read_pattern_matches(pattern: str, path: Path, workspace: Path) -> bool:
    """The CLI's Read-rule path grammar for the shapes the document carries:
    `./x` from the workspace root, `**/x` at any depth, `x` relative."""
    try:
        relative: str | None = path.relative_to(workspace).as_posix()
    except ValueError:
        relative = None
    if pattern.startswith("**/"):
        tail = pattern[3:]
        return fnmatch.fnmatchcase(path.as_posix(), "*/" + tail) or (relative is not None and fnmatch.fnmatchcase(relative, tail))
    body = pattern[2:] if pattern.startswith("./") else pattern
    return relative is not None and fnmatch.fnmatchcase(relative, body)


def _denying_rule(policy: RoomPolicy, name: str, arguments: dict[str, Any], workspace: Path) -> str | None:
    if name == "Bash":
        command = str(arguments.get("command") or "")
        from aria_kernel.command_policy import claude_rule_matches

        return next((rule for rule in policy.bash_deny_rules if claude_rule_matches(rule, command)), None)
    if name in READ_RULE_TOOLS:
        raw = arguments.get("file_path") if name == "Read" else arguments.get("path")
        if not isinstance(raw, str) or not raw:
            return None
        lexical = Path(raw) if Path(raw).is_absolute() else workspace / raw
        candidates = (lexical, lexical.resolve())
        for pattern in policy.read_deny_patterns:
            if any(_read_pattern_matches(pattern, candidate, workspace) for candidate in candidates):
                return f"Read({pattern})"
    return None


def _hook_decision(exit_code: int, stdout: str) -> tuple[str, str]:
    """The CLI's reading of a PreToolUse answer: exit 2 blocks; otherwise
    the JSON decision. An answer the CLI could not read is a deny."""
    try:
        output = json.loads(stdout)["hookSpecificOutput"]
        decision, reason = str(output["permissionDecision"]), str(output["permissionDecisionReason"])
    except (ValueError, KeyError, TypeError):
        return "deny", "hook_answer_unreadable"
    return ("deny" if exit_code != 0 else decision), reason


def decide_call(
    name: str, arguments: dict[str, Any] | None, *, tool_use_id: str, session_id: str, offered: frozenset[str],
    policy: RoomPolicy, seat: RoomSeat, transcript_path: str,
) -> CallVerdict:
    """The gate for one call, in the CLI's order: the tool must exist, the
    PreToolUse hook decides what its matcher covers (recorded and counted by
    the hook itself), then the document's deny rules bind."""
    from aria_kernel.hooks import run_hook

    if name not in offered:
        return CallVerdict("deny", f"tool_not_offered:{name or '<none>'}", "offer")
    if arguments is None:
        return CallVerdict("deny", "tool_input_invalid", "input")
    workspace = Path(seat.workspace_root).resolve()
    reason = "tool_not_policed_here"
    if policy.pre_tool_matcher.fullmatch(name):
        exit_code, stdout = run_hook("pre-tool", {
            "session_id": session_id, "transcript_path": transcript_path, "cwd": str(workspace),
            "hook_event_name": "PreToolUse", "tool_name": name, "tool_input": arguments, "tool_use_id": tool_use_id,
        }, base_dir=seat.tools_dir, workspace_root=workspace, request_id=seat.request_id,
            turn_budget=policy.turn_budget)
        decision, reason = _hook_decision(exit_code, stdout)
        if decision != "allow":
            return CallVerdict("deny", reason, "hook")
    rule = _denying_rule(policy, name, arguments, workspace)
    if rule is not None:
        return CallVerdict("deny", f"permission_rule_deny:{rule}", "permission_rule")
    return CallVerdict("allow", reason, "hook" if policy.pre_tool_matcher.fullmatch(name) else "unpoliced")


class _Room:
    """The per-call room: the Claude writer's sandbox shape, built per call."""

    def __init__(self, seat: RoomSeat, policy: RoomPolicy) -> None:
        from aria_kernel.agent_env import CLAUDE_AUTH_ENV_NAMES, CLAUDE_CONFIG_ENV_PREFIX, SECRET_SHAPED_ENV_NAME, build_agent_env
        from aria_kernel.git_containment import GitContainmentRefusal, derive_git_containment

        self.workspace = Path(seat.workspace_root).resolve()
        self.write_scope = policy.write_scope
        git = seat.git_containment
        if git is None:
            try:
                git = derive_git_containment(self.workspace, commit_capable=False)
            except GitContainmentRefusal as exc:
                raise ClaudePolicyViolation(f"zai_room_git_refused:{exc.reason}") from exc
        self.git = git
        built = build_agent_env(os.environ, profile_passthrough=policy.passthrough, extra={
            "ARIA_REQUEST_ID": seat.request_id, "PYTHONPATH": str(self.workspace / "aria-kernel"),
        })
        self.home = built.env["HOME"]
        # The CLI's login is the CLI's: nothing in this room runs it.
        self.env = {name: value for name, value in built.env.items()
                    if name not in CLAUDE_AUTH_ENV_NAMES and not name.startswith(CLAUDE_CONFIG_ENV_PREFIX)}
        leaked = sorted(name for name in self.env if SECRET_SHAPED_ENV_NAME.search(name)
                        or name in (ZAI_CREDENTIAL_ENV, ZAI_CREDENTIAL_FILE_ENV))
        if leaked:
            raise ClaudePolicyViolation(f"zai_room_env_carries_credential_names:{leaked}")
        import sys

        self.interpreter = os.path.realpath(sys.executable)
        bash = shutil.which("bash", path=self.env.get("PATH"))
        if bash is None:
            raise ClaudePolicyViolation("zai_room_bash_unavailable")
        self.bash = os.path.realpath(bash)
        key_file = os.environ.get(ZAI_CREDENTIAL_FILE_ENV, "").strip()
        self.key_file = Path(key_file).resolve() if key_file else None

    def argv(self, inner: list[str], *, timeout_seconds: int) -> list[str]:
        from aria_kernel.implementation_safety import (
            MANAGED_SPAWN_ISOLATION_FLAGS,
            SandboxUnavailable,
            wrap_bash_in_sandbox,
        )

        try:
            command = wrap_bash_in_sandbox(
                inner, workspace_root=self.workspace, allow_network=ROOM_ALLOW_NETWORK, write_scope=self.write_scope,
                extra_ro_binds=(ROOM_CHILD,), git=self.git,
            )
        except SandboxUnavailable as exc:
            # No unconfined acknowledgement here: this room runs a model
            # this host never ran a write seat on without one.
            raise ClaudePolicyViolation(f"zai_room_containment_required: {exc}") from exc
        separator = command.index("--")
        command = command[:separator] + list(MANAGED_SPAWN_ISOLATION_FLAGS) + command[separator:]
        self._refuse_credential_binds(command[:separator])
        return _apply_resource_limits(command, timeout_seconds=timeout_seconds, environ=self.env,
                                      control_source=os.environ)

    def _refuse_credential_binds(self, flags: list[str]) -> None:
        """The key file must not be under any source the room binds."""
        if self.key_file is None:
            return
        for index, flag in enumerate(flags[:-1]):
            if flag in ("--bind", "--ro-bind", "--bind-try", "--ro-bind-try", "--dev-bind"):
                source = Path(flags[index + 1]).resolve()
                if self.key_file == source or source in self.key_file.parents:
                    raise ClaudePolicyViolation(f"zai_room_binds_the_credential:{source}")

    def run(self, inner: list[str], *, stdin: str, timeout_seconds: int) -> tuple[int | None, str, str, bool, int]:
        started = time.monotonic()
        try:
            done = subprocess.run(
                self.argv(inner, timeout_seconds=timeout_seconds), input=stdin, capture_output=True, text=True,
                env=self.env, timeout=timeout_seconds + 30, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            out = exc.stdout.decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            return None, out, "timed out", True, int((time.monotonic() - started) * 1000)
        return done.returncode, done.stdout, done.stderr, False, int((time.monotonic() - started) * 1000)

    def close(self) -> None:
        from aria_kernel.agent_env import cleanup_synthetic_home

        cleanup_synthetic_home(self.home)


def _bash_result(room: _Room, arguments: dict[str, Any], remaining: float) -> tuple[bool, str, dict[str, Any]]:
    requested = arguments.get("timeout")
    millis = min(int(requested), BASH_MAX_TIMEOUT_MS) if isinstance(requested, int) and requested > 0 else BASH_DEFAULT_TIMEOUT_MS
    timeout = max(1, min(millis // 1000 or 1, int(remaining)))
    code, out, err, interrupted, elapsed = room.run([room.bash, "-c", str(arguments.get("command") or "")],
                                                    stdin="", timeout_seconds=timeout)
    text = out + (("\n" if out and err else "") + err if err else "")
    if len(text) > TOOL_OUTPUT_MAX_CHARS:
        text = text[:TOOL_OUTPUT_MAX_CHARS] + f"\n... [{len(text) - TOOL_OUTPUT_MAX_CHARS} characters truncated]"
    failed = interrupted or code != 0
    if failed:
        text = (f"Command timed out after {timeout}s\n" if interrupted else f"Exit code {code}\n") + text
    return (not failed), text, {"stdout": out[:TOOL_OUTPUT_MAX_CHARS], "stderr": err[:TOOL_OUTPUT_MAX_CHARS],
                                "exit_code": code, "interrupted": interrupted, "duration_ms": elapsed}


def _file_result(room: _Room, name: str, arguments: dict[str, Any], remaining: float) -> tuple[bool, str, dict[str, Any]]:
    timeout = max(1, min(FILE_TOOL_TIMEOUT_SECONDS, int(remaining)))
    request = json.dumps({"tool": name, "input": arguments, "workspace": str(room.workspace)})
    code, out, err, interrupted, elapsed = room.run([room.interpreter, "-I", str(ROOM_CHILD)], stdin=request,
                                                    timeout_seconds=timeout)
    try:
        answer = json.loads(out)
        ok, text = bool(answer["ok"]), str(answer["content"])
    except (ValueError, KeyError, TypeError):
        ok, text = False, f"room_child_failed: exit={code} interrupted={interrupted} {err.strip()[-400:]}"
    return ok, text, {"success": ok, "exit_code": code, "interrupted": interrupted, "duration_ms": elapsed}


def _kernel_mcp_tools(seat: RoomSeat, policy: RoomPolicy) -> dict[str, tuple[Any, str, dict[str, Any]]]:
    """`mcp__<server>__<tool>` -> (server, tool, schema) for the profile's
    kernel-served servers; a server the kernel does not serve is refused."""
    from aria_kernel.mcp_client import KERNEL_SOCKET_TRANSPORT, MCP_TOOL_PREFIX, load_mcp_registry, quarantined_servers
    from aria_kernel.mcp_server import AriaMcpServer

    kernel = _kernel_profile(seat.agent_profile)
    registry = load_mcp_registry()
    quarantined = quarantined_servers(seat.tools_dir)
    offered: dict[str, tuple[Any, str, dict[str, Any]]] = {}
    for server_name in tuple(getattr(kernel, "mcp_servers", ()) or ()):
        spec = registry.servers.get(server_name)
        if spec is None or spec.transport != KERNEL_SOCKET_TRANSPORT:
            raise ClaudePolicyViolation(f"zai_room_mcp_server_unsupported:{server_name}")
        if server_name in quarantined or f"{MCP_TOOL_PREFIX}{server_name}" in policy.disallowed:
            continue
        server = AriaMcpServer(base_dir=seat.tools_dir, workspace_root=seat.workspace_root, allow_writes=False,
                               request_id=seat.request_id)
        for tool in server.tools():
            name = f"{MCP_TOOL_PREFIX}{server_name}__{tool['name']}"
            if spec.allows_tool(tool["name"]) and name not in policy.disallowed:
                offered[name] = (server, tool["name"], tool)
    return offered


def _function(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {
        "type": "object", "properties": properties, "required": required}}}


class _Transcript:
    """Claude stream-json lines, fed to the progress observer as they land."""

    def __init__(self, on_event: Callable[[dict[str, Any]], Any] | None) -> None:
        self.lines: list[str] = []
        self.on_event = on_event
        self.seen = 0

    def emit(self, event: dict[str, Any]) -> None:
        self.lines.append(json.dumps(event, sort_keys=True))
        self.seen += 1
        if self.on_event is not None:
            try:
                self.on_event(event)
            except Exception:  # noqa: BLE001 — a progress observer never fails the run
                pass

    def body(self) -> bytes:
        return ("\n".join(self.lines) + "\n").encode("utf-8")


def run_zai_tool_loop(
    context: ZaiExecutionContext, *, seat: RoomSeat, model: str, effort: str | None, system: str, user: str,
    timeout_seconds: int, opener: Opener | None = None,
) -> ZaiLoopResult:
    """Run one write seat on Z.ai to its answer, or to a named stop.

    A vendor refusal (auth, quota) ends the loop and rides the result's
    `auth_failure` / `credit_exhaustion`, exactly as a single completion's
    does; a transport failure raises `ZaiTransportUnavailable` as it does.
    """
    from aria_kernel.hooks import run_hook

    timeout_seconds = _clamp_timeout_to_job_deadline(int(timeout_seconds))
    deadline = time.monotonic() + timeout_seconds
    policy = room_policy(seat)
    kernel = _kernel_profile(seat.agent_profile)
    builtins = [tool for tool in ROOM_BUILTIN_TOOLS if tool in kernel.tools and tool not in policy.disallowed]
    mcp_tools = _kernel_mcp_tools(seat, policy)
    offered = frozenset([*builtins, *mcp_tools])
    specs = [_function(name, *_TOOL_SPECS[name]) for name in builtins] + [
        _function(name, str(tool.get("description") or ""), dict(tool["inputSchema"].get("properties") or {}),
                  list(tool["inputSchema"].get("required") or [])) for name, (_s, _t, tool) in mcp_tools.items()]
    max_completions = COMPLETIONS_PER_BUDGETED_TURN * (policy.turn_budget or 0) or COMPLETIONS_PER_BUDGETED_TURN
    room = _Room(seat, policy)
    control = seat.spawn_control
    transcript = _Transcript(getattr(control, "on_event", None) if control is not None else None)
    session_id = str(uuid.uuid4())
    transcript_path = f"zai-tool-loop:{session_id}"
    workspace = room.workspace
    hook_args = {"base_dir": seat.tools_dir, "workspace_root": workspace, "request_id": seat.request_id,
                 "turn_budget": policy.turn_budget}
    transcript.emit({"type": "system", "subtype": "init", "session_id": session_id, "model": model,
                     "tools": sorted(offered), "cwd": str(workspace), "runtime": TRANSCRIPT_RUNTIME})
    run_hook("session", {"hook_event_name": "SessionStart", "session_id": session_id, "source": "startup"}, **hook_args)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    response_ids: list[str] = []
    totals: dict[str, int] | None = {"input_tokens": 0, "output_tokens": 0}
    final = ""
    stop = "completion_cap"
    last = None
    calls = refused = completions = 0
    elapsed_ms = 0
    try:
        while completions < max_completions:
            if control is not None and control.should_cancel is not None and control.should_cancel():
                # The loop stops at its next boundary — the CLI's graceful
                # (SIGTERM) stage; no process outlives a call's room.
                control.cancelled, control.cancel_signal = True, "sigterm"
                stop = "operator_cancelled"
                break
            remaining = deadline - time.monotonic()
            if remaining <= 1:
                stop = "deadline"
                break
            last = run_zai_turn(
                context.credential, base_url=context.base_url, model=model, messages=messages, tools=specs,
                timeout_seconds=min(remaining, DEFAULT_ZAI_TIMEOUT_SECONDS),
                max_tokens=resolve_zai_max_tokens(dict(os.environ)), reasoning_effort=effort, opener=opener,
            )
            completions += 1
            elapsed_ms += last.elapsed_ms
            if last.response_id:
                response_ids.append(last.response_id)
            if totals is not None and last.usage is not None:
                totals = {key: totals[key] + last.usage[key] for key in totals}
            elif last.http_status == 200:
                totals = None
            if last.http_status != 200 or last.message is None or last.error_code is not None:
                stop = "vendor_refused" if last.http_status != 200 else str(last.error_code)
                break
            ids = [call["id"] or f"zai_{completions}_{index}" for index, call in enumerate(last.tool_calls)]
            blocks: list[dict[str, Any]] = [{"type": "text", "text": last.content}] if last.content else []
            parsed: list[dict[str, Any] | None] = []
            for call, call_id in zip(last.tool_calls, ids):
                try:
                    arguments = json.loads(call["arguments"] or "{}")
                except ValueError:
                    arguments = None
                parsed.append(arguments if isinstance(arguments, dict) else None)
                blocks.append({"type": "tool_use", "id": call_id, "name": call["name"],
                               "input": arguments if isinstance(arguments, dict) else {"_unparsed": call["arguments"][:2000]}})
            transcript.emit({"type": "assistant", "message": {
                "id": last.response_id, "model": last.model or model, "role": "assistant", "content": blocks,
                "stop_reason": last.finish_reason, "usage": last.usage}, "session_id": session_id})
            if not last.tool_calls:
                final = last.content
                stop = STOP_COMPLETED if final else "empty_answer"
                break
            assistant = dict(last.message)
            assistant["tool_calls"] = [{**entry, "id": call_id} for entry, call_id in zip(last.message["tool_calls"], ids)]
            messages.append(assistant)
            results: list[dict[str, Any]] = []
            for call, call_id, arguments in zip(last.tool_calls, ids, parsed):
                calls += 1
                name = call["name"]
                verdict = decide_call(name, arguments, tool_use_id=call_id, session_id=session_id, offered=offered,
                                      policy=policy, seat=seat, transcript_path=transcript_path)
                if verdict.decision != "allow":
                    refused += 1
                    ok, text, response = False, verdict.reason, None
                elif name in mcp_tools:
                    server, tool, _schema = mcp_tools[name]
                    answer = server.call_tool(tool, arguments)
                    ok = not answer.get("isError")
                    text = "".join(str(block.get("text") or "") for block in answer.get("content") or [])
                    response = {"is_error": not ok}
                elif name == "Bash":
                    ok, text, response = _bash_result(room, arguments or {}, deadline - time.monotonic())
                else:
                    ok, text, response = _file_result(room, name, arguments or {}, deadline - time.monotonic())
                if response is not None and policy.post_tool_matcher.fullmatch(name):
                    run_hook("post-tool", {
                        "session_id": session_id, "transcript_path": transcript_path, "cwd": str(workspace),
                        "hook_event_name": "PostToolUse", "tool_name": name, "tool_input": arguments,
                        "tool_use_id": call_id, "tool_response": response,
                    }, **hook_args)
                messages.append({"role": "tool", "tool_call_id": call_id, "content": text})
                results.append({"type": "tool_result", "tool_use_id": call_id, "content": text, "is_error": not ok})
            transcript.emit({"type": "user", "message": {"role": "user", "content": results}, "session_id": session_id})
    finally:
        try:
            run_hook("session", {"hook_event_name": "SessionEnd", "session_id": session_id, "reason": stop}, **hook_args)
        finally:
            room.close()
    usage = totals if completions else None
    transcript.emit({
        "type": "result", "subtype": "success" if stop == STOP_COMPLETED else f"error_{stop}",
        "is_error": stop != STOP_COMPLETED, "result": final, "usage": usage, "session_id": session_id,
        "num_turns": completions, "model": model, "runtime": TRANSCRIPT_RUNTIME,
        "tool_calls": calls, "refused_calls": refused,
    })
    return ZaiLoopResult(
        http_status=last.http_status if last is not None else None, final_message=final, usage=usage,
        auth_failure=last.auth_failure if last is not None else None,
        credit_exhaustion=last.credit_exhaustion if last is not None else None,
        error_code=(None if stop == STOP_COMPLETED else (last.error_code if last is not None and last.error_code else stop)),
        error_message=last.error_message if last is not None else None,
        response_id=response_ids[-1] if response_ids else None, model=last.model if last is not None else None,
        finish_reason=last.finish_reason if last is not None else None, elapsed_ms=elapsed_ms,
        raw_body=transcript.body(), response_ids=tuple(response_ids), stop_reason=stop, completions=completions,
        tool_calls=calls, refused_calls=refused,
    )


def claude_run_result(
    completed: ZaiRunResult, *, model: str, credential_location: str, stdout: str,
    events: tuple[dict[str, Any], ...],
) -> ClaudeRunResult:
    """A Z.ai result in the shape the shared auth failover and the
    executors read (`claude_runtime.run_with_model_fallback`): `auth_failure`
    / `credit_exhaustion` from the transport's own classification, the auth
    remedy naming the credential BOUNDARY, never a value."""
    auth_failure = credit_exhaustion = failure_class = None
    if completed.auth_failure is not None:
        auth_failure = {
            "signature": completed.exhaustion_signature,
            "marker": completed.auth_failure, "matched_marker": completed.auth_failure,
            "vendor_error_code": completed.error_code, "vendor_error_message": completed.error_message,
            "remedy": f"re-provision the Z.ai subscription key at its boundary ({credential_location})",
        }
        failure_class = "auth_failed"
    elif completed.credit_exhaustion is not None:
        credit_exhaustion = {
            "signature": completed.exhaustion_signature,
            "marker": completed.credit_exhaustion, "matched_marker": completed.credit_exhaustion,
            "vendor_error_code": completed.error_code, "vendor_error_message": completed.error_message,
        }
        failure_class = "credit_exhausted"
    elif completed.returncode != 0:
        failure_class = "process_exit"
    return ClaudeRunResult(
        returncode=completed.returncode, stdout=stdout,
        stderr="" if completed.error_message is None else f"{completed.error_code}: {completed.error_message}",
        final_message=completed.final_message, usage=completed.usage, events=events,
        auth_failure=auth_failure, credit_exhaustion=credit_exhaustion,
        failure_class=failure_class, retryable=False if failure_class else None,
        failure_detail_code=(completed.auth_failure or completed.credit_exhaustion
                             or (None if completed.returncode == 0 else
                                 f"zai_loop_{completed.stop_reason}" if isinstance(completed, ZaiLoopResult)
                                 else f"http_{completed.http_status}")),
        model=model,
    )


def run_zai_writer(
    *, seat: RoomSeat, model: str, effort: str | None, system: str, user: str, timeout_seconds: int,
    usage_recording: UsageRecording | None,
) -> ClaudeRunResult:
    """The tool loop as a rung of the spawn lane and the worker lane.

    The credential is resolved from its boundary here, as the reader rung
    resolves it (`zai_runtime.prepare_zai_context`); a boundary that refuses
    is `ClaudeAuthUnavailable`, an unreached vendor `ClaudeProviderUnreachable`
    (ARIA-HIGH-366's `zai_unreachable`). The result's stdout IS the
    stream-json transcript, so the executor's transcript file holds every
    turn and its envelope builder reads the final answer from it.
    """
    from claude_runtime import ClaudeAuthUnavailable, ClaudeProviderUnreachable, _record_usage_best_effort, parse_claude_jsonl
    from aria_kernel.model_fleet import dispatching_provider_for_model
    from zai_runtime import ZaiCredentialUnavailable, ZaiTransportUnavailable, prepare_zai_context

    try:
        context = prepare_zai_context(dict(os.environ), default_model=model)
    except ZaiCredentialUnavailable as exc:
        raise ClaudeAuthUnavailable(f"zai_{exc.reason}: {exc}") from exc
    try:
        completed = run_zai_tool_loop(context, seat=seat, model=model, effort=effort, system=system, user=user,
                                      timeout_seconds=timeout_seconds)
    except ZaiTransportUnavailable as exc:
        raise ClaudeProviderUnreachable(
            f"zai_transport_unavailable: {exc}", provider=dispatching_provider_for_model(model), model=model,
            detail={"signature": "zai_unreachable", "marker": str(exc)},
        ) from exc
    if usage_recording is not None and completed.usage is not None:
        _record_usage_best_effort(recording=usage_recording, model=model, usage=completed.usage)
    transcript = completed.raw_body.decode("utf-8")
    return claude_run_result(completed, model=model, credential_location=context.credential.location,
                             stdout=transcript, events=parse_claude_jsonl(transcript))


__all__ = [
    "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "COMPLETIONS_PER_BUDGETED_TURN", "CallVerdict",
    "ROOM_ALLOW_NETWORK", "ROOM_BUILTIN_TOOLS", "ROOM_CHILD", "ROOM_SYSTEM_PROMPT", "RoomPolicy", "RoomSeat",
    "STOP_COMPLETED", "ZaiLoopResult", "claude_run_result", "decide_call", "room_policy", "run_zai_tool_loop",
    "run_zai_writer",
]
