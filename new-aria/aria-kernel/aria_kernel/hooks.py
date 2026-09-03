"""Plan 032 Faz 032b-2 — the kernel behind the Claude Code hooks.

WHY: ``implementation_safety.verify_bash_command_allowed`` had four callers,
all inside the kernel, none at the moment the agent's Bash tool fired; the
instruction to run it lived in the implementer's own markdown. A hook is the
seam the CLI offers for exactly that moment: PreToolUse decides, PostToolUse
records, the session events carry the handoff snapshot that
``handoff_ledger.VALID_TRIGGERS`` was already spelled for.

WHAT: pure decision functions over the hook payload (testable without a CLI)
plus one ledger writer per surface:

* ``hook_decisions`` (``hooks/decisions.jsonl``) — every PreToolUse verdict,
  allow or deny, with the policy reason. Observation class: it changes no
  behaviour, it records one.
* ``agent_work_journal`` (``agent-invocations/work-journal.jsonl``) — one row
  per completed tool call, SANITIZED: command family + redacted argv +
  command hash, never the raw line (the second review named the leak).
  Write-driving: Faz 032c recovery reads it to decide resume vs restart.

Fail-closed: a PreToolUse handler that raises is a DENY (exit 2) — an
unreadable policy is not permission.
"""
from __future__ import annotations

import hashlib
import json
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .command_policy import classify_command
from .implementation_safety import (
    READONLY_PATHS,
    BashAllowlistMiss,
    BashDenylistHit,
    PathEscape,
    is_gh_api_path_forbidden,
    verify_bash_command_allowed,
    verify_no_path_escape,
)
from .ledger import append_declared_jsonl
from .secret_scrub import scrub_text
from .tool_registry import ensure_tools_dir, utc_now

HOOK_DECISIONS_SURFACE = "hook_decisions"
WORK_JOURNAL_SURFACE = "agent_work_journal"
HOOK_DECISIONS_RELPATH = ("hooks", "decisions.jsonl")
WORK_JOURNAL_RELPATH = ("agent-invocations", "work-journal.jsonl")
WRITE_TOOL_NAMES: frozenset[str] = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
DECISIONS: tuple[str, ...] = ("allow", "deny")
# The CLI's hook protocol: decision JSON on stdout for PreToolUse; exit 2 blocks.
EXIT_ALLOW = 0
EXIT_BLOCK = 2
_MAX_ARGV_TOKENS = 24
_MAX_TOKEN_CHARS = 160


@dataclass(frozen=True)
class HookVerdict:
    decision: str
    reason: str
    tool_name: str
    exit_code: int

    def to_stdout(self) -> str:
        return json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": self.decision,
                "permissionDecisionReason": self.reason,
            }
        })


def _tool_name(payload: Mapping[str, Any]) -> str:
    return str(payload.get("tool_name") or "")


def _bash_argv(payload: Mapping[str, Any]) -> list[str]:
    command = str((payload.get("tool_input") or {}).get("command") or "")
    try:
        return shlex.split(command)
    except ValueError:
        # An unlexable command is refused by verify_bash_command_allowed's
        # operator detector; hand it the raw token so the refusal is named.
        return [command]


def _write_target(payload: Mapping[str, Any]) -> str:
    tool_input = payload.get("tool_input") or {}
    for key in ("file_path", "notebook_path", "path"):
        value = tool_input.get(key)
        if value:
            return str(value)
    return ""


def decide_pre_tool(payload: Mapping[str, Any], *, workspace_root: str | Path) -> HookVerdict:
    """The PreToolUse verdict. Pure: no ledger, no environment."""
    tool = _tool_name(payload)
    workspace = Path(workspace_root).resolve()
    try:
        if tool == "Bash":
            argv = _bash_argv(payload)
            if not argv:
                return HookVerdict("deny", "bash_empty_command", tool, EXIT_BLOCK)
            verify_bash_command_allowed(argv, cwd=workspace)
            if argv[:2] == ["gh", "api"]:
                for token in argv[2:]:
                    if token.startswith("/") and is_gh_api_path_forbidden(token):
                        return HookVerdict("deny", f"gh_api_path_forbidden:{token}", tool, EXIT_BLOCK)
            return HookVerdict("allow", "command_policy_allow", tool, EXIT_ALLOW)
        if tool in WRITE_TOOL_NAMES:
            target = _write_target(payload)
            if not target:
                return HookVerdict("deny", "write_target_missing", tool, EXIT_BLOCK)
            resolved = verify_no_path_escape(target, workspace)
            rel = resolved.relative_to(workspace).as_posix()
            for ro in READONLY_PATHS:
                if rel == ro.rstrip("/") or rel.startswith(ro if ro.endswith("/") else ro + "/") or rel == ro:
                    return HookVerdict("deny", f"readonly_path:{ro}", tool, EXIT_BLOCK)
            return HookVerdict("allow", "write_inside_workspace", tool, EXIT_ALLOW)
        return HookVerdict("allow", "tool_not_policed_here", tool, EXIT_ALLOW)
    except (BashAllowlistMiss, BashDenylistHit) as exc:
        return HookVerdict("deny", f"command_policy_deny:{type(exc).__name__}:{str(exc)[:160]}", tool, EXIT_BLOCK)
    except PathEscape as exc:
        return HookVerdict("deny", f"path_escape:{str(exc)[:160]}", tool, EXIT_BLOCK)
    except Exception as exc:  # noqa: BLE001 — an unreadable policy is not permission
        return HookVerdict("deny", f"hook_error:{type(exc).__name__}", tool, EXIT_BLOCK)


def record_decision(
    verdict: HookVerdict,
    *,
    base_dir: str | Path | None,
    request_id: str,
    session_id: str,
    tool_use_id: str,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    return append_declared_jsonl(
        root.joinpath(*HOOK_DECISIONS_RELPATH),
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "request_id": request_id,
            "session_id": session_id,
            "tool_use_id": tool_use_id,
            "tool_name": verdict.tool_name,
            "decision": verdict.decision,
            "reason": verdict.reason,
        },
        expected_surface=HOOK_DECISIONS_SURFACE,
    )


def sanitize_journal_entry(payload: Mapping[str, Any]) -> dict[str, Any]:
    """The journal's view of one tool call: family, redacted argv, hash, files.

    The raw command never enters the row; a secret quoted in an argument is
    redacted by `secret_scrub` and the row says WHICH pattern class fired.
    """
    tool = _tool_name(payload)
    tool_input = payload.get("tool_input") or {}
    response = payload.get("tool_response")
    entry: dict[str, Any] = {"tool_name": tool, "command_family": None, "external_effect": False}
    if tool == "Bash":
        argv = _bash_argv(payload)
        family, external = classify_command(argv)
        redacted: list[str] = []
        redaction_types: set[str] = set()
        for token in argv[:_MAX_ARGV_TOKENS]:
            scrubbed, kinds = scrub_text(str(token)[:_MAX_TOKEN_CHARS])
            redacted.append(scrubbed)
            redaction_types.update(kinds)
        if len(argv) > _MAX_ARGV_TOKENS:
            redacted.append(f"<+{len(argv) - _MAX_ARGV_TOKENS} tokens>")
        entry.update({
            "command_family": family,
            "external_effect": external,
            "argv_redacted": redacted,
            "command_hash": "sha256:" + hashlib.sha256(" ".join(argv).encode("utf-8")).hexdigest(),
            "redaction_types": sorted(redaction_types),
        })
    elif tool.startswith("mcp__"):
        # Plan 032 Faz 032g — an MCP call: server + tool, never the arguments.
        from .mcp_client import split_mcp_tool

        server, mcp_tool = split_mcp_tool(tool) or ("?", "?")
        entry.update({"command_family": "mcp", "mcp_server": server, "mcp_tool": mcp_tool,
                      "input_hash": "sha256:" + hashlib.sha256(json.dumps(tool_input, sort_keys=True, default=str).encode("utf-8")).hexdigest()})
    elif tool in WRITE_TOOL_NAMES or tool in {"Read"}:
        target = _write_target(payload)
        entry["files_touched"] = [target] if target else []
        entry["command_family"] = "file_write" if tool in WRITE_TOOL_NAMES else "file_read"
    else:
        entry["command_family"] = "tool"
    if isinstance(response, Mapping):
        for key in ("exit_code", "interrupted", "duration_ms"):
            if key in response:
                entry[key] = response[key]
        if "stdout" in response or "stderr" in response:
            entry["output_bytes"] = len(str(response.get("stdout") or "")) + len(str(response.get("stderr") or ""))
    return entry


def record_journal(
    payload: Mapping[str, Any],
    *,
    base_dir: str | Path | None,
    request_id: str,
    session_id: str,
    tool_use_id: str,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "request_id": request_id,
        "session_id": session_id,
        "tool_use_id": tool_use_id,
        **sanitize_journal_entry(payload),
    }
    return append_declared_jsonl(
        root.joinpath(*WORK_JOURNAL_RELPATH), row, expected_surface=WORK_JOURNAL_SURFACE,
    )


def journal_rows_for(request_id: str, *, base_dir: str | Path | None) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl

    path = ensure_tools_dir(base_dir).joinpath(*WORK_JOURNAL_RELPATH)
    if not path.exists():
        return []
    return [row for row in load_declared_jsonl(path, expected_surface=WORK_JOURNAL_SURFACE)
            if row.get("request_id") == request_id]



def _take_pre_write_checkpoint(*, base_dir, workspace_root, request_id: str, session_id: str, tool_use_id: str) -> None:
    try:
        from .checkpoint import take_checkpoint

        touched = [p for row in journal_rows_for(request_id, base_dir=base_dir) for p in (row.get("files_touched") or [])]
        take_checkpoint(workspace_root=workspace_root, request_id=request_id, reason="pre_write",
                        base_dir=base_dir, journal_files=touched)
    except Exception as exc:  # noqa: BLE001
        try:
            record_decision(HookVerdict("allow", f"checkpoint_skipped:{type(exc).__name__}", "checkpoint", EXIT_ALLOW),
                            base_dir=base_dir, request_id=request_id, session_id=session_id, tool_use_id=tool_use_id)
        except Exception:  # noqa: BLE001
            return

_SESSION_TRIGGERS = {"SessionStart": "session_start", "SessionEnd": "session_stop", "PreCompact": "pre_compact"}


def handle_session_event(payload: Mapping[str, Any], *, base_dir: str | Path | None, request_id: str, repo_root: str | Path) -> dict[str, Any]:
    """Session hooks → the handoff ledger (its trigger vocabulary was already
    the hook vocabulary; this is the producer that never existed)."""
    from .handoff_ledger import take_handoff_snapshot

    event = str(payload.get("hook_event_name") or "")
    trigger = _SESSION_TRIGGERS.get(event)
    if trigger is None:
        return {"status": "ignored", "event": event}
    session_id = str(payload.get("session_id") or request_id)
    snapshot = take_handoff_snapshot(
        session_id=f"{request_id}:{session_id}", trigger=trigger, base_dir=base_dir, repo_root=repo_root,
        operator_note=f"claude hook {event} for {request_id}",
    )
    return {"status": "recorded", "trigger": trigger, "session_id": snapshot.get("session_id")}


def run_hook(
    verb: str,
    payload: Mapping[str, Any],
    *,
    base_dir: str | Path | None,
    workspace_root: str | Path,
    request_id: str,
) -> tuple[int, str]:
    """(exit_code, stdout) for one hook invocation — the CLI's whole body."""
    session_id = str(payload.get("session_id") or "")
    tool_use_id = str(payload.get("tool_use_id") or "")
    if verb == "pre-tool":
        verdict = decide_pre_tool(payload, workspace_root=workspace_root)
        try:
            record_decision(verdict, base_dir=base_dir, request_id=request_id, session_id=session_id, tool_use_id=tool_use_id)
        except Exception as exc:  # noqa: BLE001 — a decision that cannot be recorded is a deny
            verdict = HookVerdict("deny", f"decision_unrecordable:{type(exc).__name__}", verdict.tool_name, EXIT_BLOCK)
        if verdict.decision == "allow" and verdict.tool_name in WRITE_TOOL_NAMES:
            # Plan 032 Faz 032c — the safety net BEFORE the first write of a
            # turn (folded within the checkpoint's own interval). Best-effort:
            # a checkpoint that cannot be taken must not turn an allowed edit
            # into a denied one; it is named on the decision ledger instead.
            _take_pre_write_checkpoint(base_dir=base_dir, workspace_root=workspace_root, request_id=request_id,
                                       session_id=session_id, tool_use_id=tool_use_id)
        return verdict.exit_code, verdict.to_stdout()
    if verb == "post-tool":
        try:
            record_journal(payload, base_dir=base_dir, request_id=request_id, session_id=session_id, tool_use_id=tool_use_id)
            tool = _tool_name(payload)
            if tool.startswith("mcp__"):
                # Plan 032 Faz 032g — MCP calls feed the health ledger that quarantines a failing server.
                from .mcp_client import record_mcp_call

                response = payload.get("tool_response")
                failed = bool(isinstance(response, Mapping) and (response.get("is_error") or response.get("isError")))
                record_mcp_call(tool_name=tool, ok=not failed, base_dir=base_dir, request_id=request_id, session_id=session_id,
                                error_class="ToolError" if failed else None)
        except Exception as exc:  # noqa: BLE001 — PostToolUse cannot block; say so on stderr-shaped stdout
            return EXIT_ALLOW, json.dumps({"aria_journal": f"unrecorded:{type(exc).__name__}"})
        return EXIT_ALLOW, ""
    if verb == "session":
        try:
            result = handle_session_event(payload, base_dir=base_dir, request_id=request_id, repo_root=workspace_root)
        except Exception as exc:  # noqa: BLE001
            result = {"status": f"unrecorded:{type(exc).__name__}"}
        return EXIT_ALLOW, json.dumps({"aria_session": result})
    return EXIT_BLOCK, json.dumps({"error": f"unknown hook verb {verb!r}"})


__all__ = [
    "DECISIONS",
    "EXIT_ALLOW",
    "EXIT_BLOCK",
    "HOOK_DECISIONS_RELPATH",
    "HOOK_DECISIONS_SURFACE",
    "HookVerdict",
    "WORK_JOURNAL_RELPATH",
    "WORK_JOURNAL_SURFACE",
    "WRITE_TOOL_NAMES",
    "decide_pre_tool",
    "handle_session_event",
    "journal_rows_for",
    "record_decision",
    "record_journal",
    "run_hook",
    "sanitize_journal_entry",
]
