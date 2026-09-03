"""Plan 032 Faz 032b — kernel-owned runtime profiles (the agent envelope SSoT).

WHY: until this module, the only statement of what an agent may run as was
its own markdown frontmatter (``model:``, ``effort:``, ``tools:``), and only
``model``/``effort`` were consumed at runtime — ``tools:`` was prose the
Claude Code loader honoured for native sub-agent dispatch and the CLI
executor never passed on. An agent that can edit files can, in principle,
edit the file that describes its own permissions; the second review of
2026-09-02 named that the authority must not live where the agent can reach.

WHAT: ``data/runtime_profiles.json`` is the authority. It lives under
``aria-kernel/aria_kernel/`` — inside ``implementation_safety.READONLY_PATHS``
(ro-bind at the syscall level for every write-capable spawn) and inside the
``docs/aria/CURRENT_STATE.md`` authority hash — so changing an envelope is a
kernel change that goes through the kernel-change lane. Agent markdown
REFERENCES a profile (``runtime_profile: <id>``) and MIRRORS model/effort/tools
so the native loader keeps working; :func:`verify_agent_mirrors` refuses a
mirror that disagrees with the kernel.

The envelope a profile describes is enforced by three consumers:

* ``agent_runtime_profile`` resolves model/effort from the profile (and the
  rest of the envelope) for both executors;
* ``claude_runtime`` derives ``--disallowedTools`` from :func:`disallowed_tools_for`
  and builds the spawn environment from ``env_passthrough``;
* ``implementation_safety.wrap_bash_in_sandbox`` binds only ``write_scope``
  read-write.

Closed vocabularies on purpose: an unknown key, tool, model or effort in the
JSON is a load-time refusal, never a silently ignored field.
"""
from __future__ import annotations

import re

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError

RUNTIME_PROFILES_SCHEMA = "aria/runtime-profiles/v1"
RUNTIME_PROFILES_FILENAME = "runtime_profiles.json"
# The frontmatter key an agent markdown uses to name its envelope.
RUNTIME_PROFILE_FRONTMATTER_KEY = "runtime_profile"

# The Claude Code tools an ARIA agent may ever be granted. Mirrors the jest
# `agent-frontmatter-schema` whitelist; anything outside it is refused at load.
CLAUDE_TOOL_UNIVERSE: tuple[str, ...] = (
    "Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "NotebookEdit",
    "Bash", "Agent", "WebFetch", "WebSearch", "TodoWrite",
)
# Tools that never appear in an ARIA profile and are therefore denied on every
# spawn: network reach through tools is not something a repo-scoped agent needs
# (the CLI's own API traffic is not a tool call).
ALWAYS_DENIED_TOOLS: tuple[str, ...] = ("WebFetch", "WebSearch")
# Write tools — a profile carrying any of these is a WRITE-TIER profile.
WRITE_TOOLS: frozenset[str] = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"})

# Claude permission rules that close the external-write channels while a
# profile has ``external_writes: false``. Scoped `Bash(...)` rules deny only
# matching calls; the tool itself stays available for tests/lint/git-local.
# Documented to bind in every permission mode, bypassPermissions included.
EXTERNAL_WRITE_DENY_RULES: tuple[str, ...] = (
    "Bash(git push*)",
    "Bash(gh pr create*)",
    "Bash(gh pr comment*)",
    "Bash(gh pr edit*)",
    "Bash(gh pr merge*)",
    "Bash(gh issue*)",
    "Bash(gh api*)",
    "Bash(gh release*)",
    "Bash(gh workflow*)",
)

_PROFILE_KEYS: frozenset[str] = frozenset({
    "description", "model", "effort", "tools", "write_scope", "env_passthrough",
    "external_writes", "budget_usd_per_run", "max_concurrent",
    "mcp_servers",
})
_OPTIONAL_KEYS: frozenset[str] = frozenset({"description", "mcp_servers"})


@dataclass(frozen=True)
class RuntimeProfile:
    profile_id: str
    model: str
    effort: str
    tools: tuple[str, ...]
    write_scope: tuple[str, ...]
    env_passthrough: tuple[str, ...]
    external_writes: bool
    budget_usd_per_run: float
    max_concurrent: int
    description: str = ""
    # Plan 032 Faz 032g — MCP servers (registry names) this profile may load.
    mcp_servers: tuple[str, ...] = ()

    @property
    def write_capable(self) -> bool:
        return bool(WRITE_TOOLS & set(self.tools))


def profiles_path() -> Path:
    return Path(__file__).resolve().parent / "data" / RUNTIME_PROFILES_FILENAME


def _validate_profile(profile_id: str, raw: dict[str, Any]) -> RuntimeProfile:
    from .agent_runtime_profile import VALID_EFFORTS, VALID_MODELS

    unknown = sorted(set(raw) - _PROFILE_KEYS)
    missing = sorted(_PROFILE_KEYS - _OPTIONAL_KEYS - set(raw))
    if unknown or missing:
        raise GovernanceError(
            f"runtime_profile_shape:{profile_id}:unknown={unknown}:missing={missing}"
        )
    if raw["model"] not in VALID_MODELS:
        raise GovernanceError(f"runtime_profile_model:{profile_id}:{raw['model']!r}")
    if raw["effort"] not in VALID_EFFORTS:
        raise GovernanceError(f"runtime_profile_effort:{profile_id}:{raw['effort']!r}")
    tools = tuple(str(t) for t in raw["tools"])
    bad_tools = sorted(set(tools) - set(CLAUDE_TOOL_UNIVERSE))
    if not tools or bad_tools or len(set(tools)) != len(tools):
        raise GovernanceError(f"runtime_profile_tools:{profile_id}:{bad_tools or tools}")
    if set(tools) & set(ALWAYS_DENIED_TOOLS):
        raise GovernanceError(f"runtime_profile_tools_never_granted:{profile_id}")
    write_scope = tuple(str(s) for s in raw["write_scope"])
    if write_scope and not (WRITE_TOOLS & set(tools)):
        raise GovernanceError(f"runtime_profile_write_scope_without_write_tools:{profile_id}")
    if not write_scope and ({"Edit", "Write", "MultiEdit", "NotebookEdit"} & set(tools)):
        raise GovernanceError(f"runtime_profile_edit_tools_without_write_scope:{profile_id}")
    passthrough = tuple(str(name) for name in raw["env_passthrough"])
    for name in passthrough:
        if not name or not name.replace("_", "").isalnum() or name != name.upper():
            raise GovernanceError(f"runtime_profile_env_name:{profile_id}:{name!r}")
    if not isinstance(raw["external_writes"], bool):
        raise GovernanceError(f"runtime_profile_external_writes:{profile_id}")
    budget = raw["budget_usd_per_run"]
    if not isinstance(budget, (int, float)) or isinstance(budget, bool) or budget <= 0:
        raise GovernanceError(f"runtime_profile_budget:{profile_id}")
    concurrency = raw["max_concurrent"]
    if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 1:
        raise GovernanceError(f"runtime_profile_concurrency:{profile_id}")
    mcp_servers = tuple(str(n) for n in (raw.get("mcp_servers") or []))
    if len(set(mcp_servers)) != len(mcp_servers) or any(not re.match(r"^[a-z][a-z0-9_-]{1,31}$", n) for n in mcp_servers):
        raise GovernanceError(f"runtime_profile_mcp_servers:{profile_id}:{mcp_servers}")
    return RuntimeProfile(
        profile_id=profile_id,
        model=str(raw["model"]),
        effort=str(raw["effort"]),
        tools=tools,
        write_scope=write_scope,
        env_passthrough=passthrough,
        external_writes=bool(raw["external_writes"]),
        budget_usd_per_run=float(budget),
        max_concurrent=int(concurrency),
        description=str(raw.get("description") or ""),
        mcp_servers=mcp_servers,
    )


@lru_cache(maxsize=4)
def _load_cached(path_str: str) -> dict[str, RuntimeProfile]:
    path = Path(path_str)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise GovernanceError(f"runtime_profiles_unreadable:{path.as_posix()}:{type(exc).__name__}") from exc
    if not isinstance(raw, dict) or raw.get("$schema") != RUNTIME_PROFILES_SCHEMA:
        raise GovernanceError("runtime_profiles_schema")
    profiles = raw.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        raise GovernanceError("runtime_profiles_empty")
    out: dict[str, RuntimeProfile] = {}
    for profile_id, body in profiles.items():
        if not isinstance(profile_id, str) or not profile_id.replace("_", "").isalnum():
            raise GovernanceError(f"runtime_profile_id:{profile_id!r}")
        if not isinstance(body, dict):
            raise GovernanceError(f"runtime_profile_body:{profile_id}")
        out[profile_id] = _validate_profile(profile_id, body)
    return out


def load_runtime_profiles(path: str | Path | None = None) -> dict[str, RuntimeProfile]:
    """Every declared profile, validated. Refuses (GovernanceError) on any
    unknown key/tool/model — a profile file that half-loads is worse than none."""
    return dict(_load_cached(str(Path(path) if path else profiles_path())))


def profile_by_id(profile_id: str, *, path: str | Path | None = None) -> RuntimeProfile:
    profiles = load_runtime_profiles(path)
    try:
        return profiles[profile_id]
    except KeyError as exc:
        raise GovernanceError(f"runtime_profile_unknown:{profile_id}") from exc


def disallowed_tools_for(profile: RuntimeProfile) -> tuple[str, ...]:
    """The ``--disallowedTools`` list a spawn under ``profile`` carries.

    Bare tool names REMOVE tools the profile does not grant (the universe minus
    the grant, always including the never-granted set); scoped rules close the
    external-write channels while ``external_writes`` is False. Deterministic
    order so the argv is stable across runs and pinnable by tests.
    """
    granted = set(profile.tools)
    removed = [tool for tool in CLAUDE_TOOL_UNIVERSE if tool not in granted]
    rules: list[str] = list(removed)
    if not profile.external_writes and "Bash" in granted:
        rules.extend(EXTERNAL_WRITE_DENY_RULES)
    return tuple(rules)


def verify_agent_mirrors(*, repo_root: str | Path) -> list[dict[str, Any]]:
    """Every ``aria-*`` agent markdown names a profile and mirrors it exactly.

    Returns one row per defect; empty means every mirror agrees with the
    kernel. Used by the Plan 032 invariant test and available to `doctor`.
    """
    from .agent_runtime_profile import _find_agent_file, _parse_frontmatter_field  # noqa: PLC0415

    root = Path(repo_root)
    agents_dir = root / ".claude" / "agents"
    defects: list[dict[str, Any]] = []
    profiles = load_runtime_profiles()
    for path in sorted(agents_dir.glob("aria-*.md")):
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(root).as_posix()
        profile_id = _parse_frontmatter_field(text, RUNTIME_PROFILE_FRONTMATTER_KEY)
        if not profile_id:
            defects.append({"ref": rel, "reason": "runtime_profile_missing"})
            continue
        profile = profiles.get(profile_id)
        if profile is None:
            defects.append({"ref": rel, "reason": "runtime_profile_unknown", "profile": profile_id})
            continue
        mirror_model = _parse_frontmatter_field(text, "model")
        mirror_effort = _parse_frontmatter_field(text, "effort")
        if mirror_model != profile.model or mirror_effort != profile.effort:
            defects.append({
                "ref": rel, "reason": "runtime_profile_mirror_drift",
                "field": "model/effort",
                "mirror": f"{mirror_model}/{mirror_effort}",
                "kernel": f"{profile.model}/{profile.effort}",
            })
        mirror_tools = _parse_frontmatter_tools(text)
        if mirror_tools != set(profile.tools):
            defects.append({
                "ref": rel, "reason": "runtime_profile_mirror_drift", "field": "tools",
                "mirror": sorted(mirror_tools), "kernel": sorted(profile.tools),
            })
    return defects


def _parse_frontmatter_tools(text: str) -> set[str]:
    import re

    match = re.match(r"\A---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return set()
    field = re.search(r"^tools:\s*(.+?)\s*$", match.group(1), re.MULTILINE)
    if not field:
        return set()
    return {token.strip() for token in field.group(1).split(",") if token.strip()}


__all__ = [
    "ALWAYS_DENIED_TOOLS",
    "CLAUDE_TOOL_UNIVERSE",
    "EXTERNAL_WRITE_DENY_RULES",
    "RUNTIME_PROFILES_SCHEMA",
    "RUNTIME_PROFILE_FRONTMATTER_KEY",
    "RuntimeProfile",
    "WRITE_TOOLS",
    "disallowed_tools_for",
    "load_runtime_profiles",
    "profile_by_id",
    "profiles_path",
    "verify_agent_mirrors",
]
