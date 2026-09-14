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

Hook commands run the kernel's hook CLIENT by path
(``<python> <kernel_root>/aria_kernel/hook_client.py <verb>``, ARIA-HIGH-123):
inside the agent's sandbox the command ships the verb and the CLI's payload
to the kernel-side broker (:mod:`hook_broker`) over the socket the wrapper
binds in, and the broker decides and journals OUTSIDE the sandbox with the
kernel's own facts — the store, the workspace, the request id and the turn
cap are the broker's, never argv the agent can read or a store the agent
can reach. The command therefore names no store, no request and no cap. A
profile with a write scope is still BUDGETED (cycle_and_turn_budget_cap,
:mod:`turn_budget`): N is the ``implementer_turn_budget.budgeted_turns`` of
the policy of the workspace the spawn's store (``hook_context["tools_dir"]``)
is bound to (:mod:`turn_budget_policy`), recorded in the settings document
(``_aria.turn_budget``) so it is part of the session fingerprint, and handed
to the broker by the spawner (``claude_runtime``) from that same document.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .command_policy import claude_permission_rules
from .hook_client import HOOK_VERBS as HOOK_CLIENT_VERBS
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


HOOK_CLIENT_RELPATH = ("aria_kernel", "hook_client.py")


def hook_client_path(kernel_root: str | Path) -> Path:
    """The in-sandbox hook client under ``kernel_root`` (the workspace's
    ``aria-kernel/``, which READONLY_PATHS keeps read-only)."""
    return Path(kernel_root).joinpath(*HOOK_CLIENT_RELPATH)


def hook_command(
    *,
    python: str,
    kernel_root: str | Path,
    verb: str,
) -> str:
    """The shell line the CLI runs for one hook event. Quoted for /bin/sh.

    The client is run BY PATH, not as ``-m aria_kernel …``: it imports
    nothing from the kernel package, so no kernel code runs inside the
    sandbox for a hook, and the line carries nothing but the verb — the
    store, the request id and the cap are the broker's.
    """
    import shlex

    if verb not in HOOK_CLIENT_VERBS:
        raise ValueError(f"unknown hook verb {verb!r}")
    return " ".join([shlex.quote(python), shlex.quote(str(hook_client_path(kernel_root))), verb])


def build_settings(
    profile: RuntimeProfile,
    *,
    hook_context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """The settings document for a spawn under ``profile``.

    ``hook_context`` = {python, kernel_root, tools_dir, workspace_root,
    request_id}; when None the document carries permission rules only (a
    read-only preview spawn with no ledger to journal into). Raises
    ``GovernanceError`` when the bound workspace's policy carries an invalid
    turn cap: a write-scope spawn is not compiled under a number the policy
    refuses.
    """
    allow, deny = claude_permission_rules(external_writes=profile.external_writes)
    deny_tools = [rule for rule in disallowed_tools_for(profile)]
    # The cap is read from the policy of the store this spawn journals into;
    # a document without hooks compiles no cap, because nothing would admit
    # turns against it (such a spawn is refused upstream when write-capable).
    turn_budget = (
        turn_budget_for(profile, base_dir=hook_context["tools_dir"]) if hook_context is not None else None
    )
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
        def entry(verb: str, matcher: str | None) -> dict[str, Any]:
            row: dict[str, Any] = {
                "hooks": [{
                    "type": "command",
                    "command": hook_command(
                        verb=verb, python=str(hook_context["python"]), kernel_root=hook_context["kernel_root"],
                    ),
                    "timeout": HOOK_TIMEOUT_SECONDS,
                }],
            }
            if matcher is not None:
                row["matcher"] = matcher
            return row

        settings["hooks"] = {
            "PreToolUse": [entry("pre-tool", _PRE_TOOL_MATCHER)],
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
    "HOOK_CLIENT_RELPATH",
    "HOOK_EVENTS",
    "HOOK_TIMEOUT_SECONDS",
    "SETTINGS_SCHEMA_NOTE",
    "build_settings",
    "hook_client_path",
    "hook_command",
    "settings_hash",
    "write_settings_file",
]
