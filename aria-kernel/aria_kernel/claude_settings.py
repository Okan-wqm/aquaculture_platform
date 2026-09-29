"""Plan 032 Faz 032b-2 — the per-spawn Claude Code settings file.

WHY: the CLI already has two enforcement layers ARIA never used — permission
rules (``permissions.allow`` / ``permissions.deny``, documented to bind in
every permission mode, ``bypassPermissions`` included) and hooks (PreToolUse
/ PostToolUse / SessionStart / SessionEnd / PreCompact). Until this module the
only settings the agent saw were whatever the runner's home carried, and the
sandbox gives it an EMPTY home, so it saw none.

WHAT: :func:`build_settings` compiles a runtime profile into one settings
document: the command policy's Claude projections (allow + deny), the
never-granted tool denies, the `.env` read denies, and the kernel hook
commands. :func:`write_settings_file` writes it to a private per-spawn path
the executor hands to ``--settings``. The document is deterministic for a
given profile + hook context, so its hash is part of the session fingerprint
(Faz 032c).

Hook commands invoke the kernel CLI (``python3 -m aria_kernel hook ...``)
with the tools dir and request id spelled out — the hook runs inside the
agent's sandbox, where nothing but argv tells it who it is working for. A
profile with a write scope also gets ``--turn-budget N`` on its PreToolUse
command (cycle_and_turn_budget_cap, :mod:`turn_budget`): the cap is compiled
into the settings document, so it is part of the session fingerprint and not
something the agent's own instructions could omit.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .command_policy import claude_permission_rules
from .runtime_profiles import RuntimeProfile, disallowed_tools_for
from .turn_budget import BUDGETED_TOOL_NAMES, turn_budget_for

SETTINGS_SCHEMA_NOTE = "aria/claude-settings/v1"
HOOK_TIMEOUT_SECONDS = 60
# Every hook event ARIA wires. Closed on purpose: a new event is a policy
# change, not a config edit.
HOOK_EVENTS: tuple[str, ...] = ("PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "PreCompact")
# The PreToolUse matcher IS the budgeted set: a tool the budget counts is a
# tool the hook is consulted about, and vice versa, by construction.
_PRE_TOOL_MATCHER = "|".join(BUDGETED_TOOL_NAMES)
_POST_TOOL_MATCHER = _PRE_TOOL_MATCHER + "|Read|Grep|Glob|Agent"
_ENV_READ_DENIES: tuple[str, ...] = ("Read(./.env)", "Read(./.env.*)", "Read(**/.env)", "Read(**/.env.*)")


def hook_command(
    *,
    python: str,
    kernel_root: str | Path,
    tools_dir: str | Path,
    workspace_root: str | Path,
    request_id: str,
    verb: str,
    turn_budget: int | None = None,
) -> str:
    """The shell line the CLI runs for one hook event. Quoted for /bin/sh.

    ``turn_budget`` is only meaningful for ``pre-tool`` — it is the cap the
    kernel admits each budgeted turn against; None leaves the spawn
    unbudgeted (a read-only or Bash-only profile has no diff to bound).
    """
    import shlex

    parts = [
        "env", f"PYTHONPATH={shlex.quote(str(kernel_root))}", shlex.quote(python), "-m", "aria_kernel",
        "hook", verb,
        "--tools-dir", shlex.quote(str(tools_dir)),
        "--workspace-root", shlex.quote(str(workspace_root)),
        "--request-id", shlex.quote(request_id),
    ]
    if turn_budget is not None:
        parts.extend(["--turn-budget", str(int(turn_budget))])
    return " ".join(parts)


def build_settings(
    profile: RuntimeProfile,
    *,
    hook_context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """The settings document for a spawn under ``profile``.

    ``hook_context`` = {python, kernel_root, tools_dir, workspace_root,
    request_id}; when None the document carries permission rules only (a
    read-only preview spawn with no ledger to journal into).
    """
    allow, deny = claude_permission_rules(external_writes=profile.external_writes)
    deny_tools = [rule for rule in disallowed_tools_for(profile)]
    turn_budget = turn_budget_for(profile)
    settings: dict[str, Any] = {
        "_aria": {
            "schema": SETTINGS_SCHEMA_NOTE,
            "profile": profile.profile_id,
            "external_writes": profile.external_writes,
            "turn_budget": turn_budget,
        },
        "permissions": {
            "allow": list(allow),
            "deny": list(dict.fromkeys([*deny, *_ENV_READ_DENIES, *deny_tools])),
        },
    }
    if hook_context is not None:
        def entry(verb: str, matcher: str | None, *, turn_budget: int | None = None) -> dict[str, Any]:
            row: dict[str, Any] = {
                "hooks": [{
                    "type": "command",
                    "command": hook_command(verb=verb, turn_budget=turn_budget, **hook_context),
                    "timeout": HOOK_TIMEOUT_SECONDS,
                }],
            }
            if matcher is not None:
                row["matcher"] = matcher
            return row

        settings["hooks"] = {
            "PreToolUse": [entry("pre-tool", _PRE_TOOL_MATCHER, turn_budget=turn_budget)],
            "PostToolUse": [entry("post-tool", _POST_TOOL_MATCHER)],
            "SessionStart": [entry("session", None)],
            "SessionEnd": [entry("session", None)],
            "PreCompact": [entry("session", None)],
        }
    return settings


def settings_hash(settings: Mapping[str, Any]) -> str:
    canonical = json.dumps(settings, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def write_settings_file(settings: Mapping[str, Any], *, directory: str | Path, request_id: str) -> Path:
    """Write the document to ``<directory>/aria-settings-<request>.json`` (0600)."""
    import os

    target_dir = Path(directory)
    target_dir.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in request_id)[:96] or "spawn"
    path = target_dir / f"aria-settings-{safe}.json"
    payload = json.dumps(settings, indent=2, sort_keys=True) + "\n"
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, payload.encode("utf-8"))
    finally:
        os.close(fd)
    return path


__all__ = [
    "HOOK_EVENTS",
    "HOOK_TIMEOUT_SECONDS",
    "SETTINGS_SCHEMA_NOTE",
    "build_settings",
    "hook_command",
    "settings_hash",
    "write_settings_file",
]
