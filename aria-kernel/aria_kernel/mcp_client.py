"""Plan 032 Faz 032g — MCP on the client side: registry, per-spawn config, tool rules, call ledger, quarantine.

WHY: Claude Code loads MCP servers from the repository's `.mcp.json` and the
user's settings. An autonomous spawn must load exactly what the kernel says
and nothing else — the same principle as runtime profiles and the built env.

WHAT: a kernel-owned registry (`data/mcp_registry.json`, closed keys), a
config document per spawn (only the profile's servers, minus quarantined
ones), always passed with `--strict-mcp-config`; `--disallowedTools` rules
for excluded servers/tools; every `mcp__*` call the hooks see lands on
`mcp/tool-calls.jsonl`; an error-rate threshold quarantines a server on
`mcp/quarantine.jsonl` until an operator releases it.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .agent_env import SECRET_SHAPED_ENV_NAME
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now

MCP_REGISTRY_RELPATH = ("data", "mcp_registry.json")
MCP_TRANSPORTS: tuple[str, ...] = ("stdio", "http")
_SERVER_KEYS: frozenset[str] = frozenset({"transport", "command", "args", "url", "env_passthrough", "tools", "timeout_seconds", "manifest_version", "description"})
_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
MCP_TOOL_PREFIX = "mcp__"
TOOL_CALLS_SURFACE = "mcp_tool_calls"
TOOL_CALLS_RELPATH: tuple[str, ...] = ("mcp", "tool-calls.jsonl")
QUARANTINE_SURFACE = "mcp_quarantine"
QUARANTINE_RELPATH: tuple[str, ...] = ("mcp", "quarantine.jsonl")
QUARANTINE_MIN_CALLS = 10
QUARANTINE_ERROR_RATE = 0.5
QUARANTINE_WINDOW = 50
MCP_QUARANTINED_EVENT = "mcp_server_quarantined"
MCP_RELEASED_EVENT = "mcp_server_released"


@dataclass(frozen=True)
class McpServerSpec:
    name: str
    transport: str
    command: str | None
    args: tuple[str, ...]
    url: str | None
    env_passthrough: tuple[str, ...]
    include: tuple[str, ...]
    exclude: tuple[str, ...]
    timeout_seconds: int
    manifest_version: int
    description: str = ""

    def allows_tool(self, tool: str) -> bool:
        return any(fnmatch.fnmatchcase(tool, p) for p in self.include) and not any(fnmatch.fnmatchcase(tool, p) for p in self.exclude)


@dataclass(frozen=True)
class McpRegistry:
    servers: dict[str, McpServerSpec] = field(default_factory=dict)


def registry_path() -> Path:
    return Path(__file__).resolve().parent.joinpath(*MCP_REGISTRY_RELPATH)


def _validate_server(name: str, raw: Mapping[str, Any]) -> McpServerSpec:
    if not _NAME_RE.match(name):
        raise GovernanceError(f"mcp_server_name:{name!r}")
    unknown = sorted(set(raw) - _SERVER_KEYS)
    if unknown:
        raise GovernanceError(f"mcp_server_shape:{name}:unknown={unknown}")
    transport = str(raw.get("transport") or "")
    if transport not in MCP_TRANSPORTS:
        raise GovernanceError(f"mcp_server_transport:{name}:{transport!r}")
    command = raw.get("command")
    url = raw.get("url")
    if transport == "stdio" and not (isinstance(command, str) and command.strip()):
        raise GovernanceError(f"mcp_server_command:{name}")
    if transport == "http" and not (isinstance(url, str) and url.startswith("https://")):
        raise GovernanceError(f"mcp_server_url:{name}:https_required")
    names = tuple(str(n) for n in (raw.get("env_passthrough") or []))
    for env_name in names:
        if not _ENV_NAME_RE.match(env_name):
            raise GovernanceError(f"mcp_server_env_name:{name}:{env_name!r}")
        if SECRET_SHAPED_ENV_NAME.search(env_name):
            raise GovernanceError(f"mcp_server_env_secret_shaped:{name}:{env_name}")
    tools = raw.get("tools") or {}
    if not isinstance(tools, Mapping) or set(tools) - {"include", "exclude"}:
        raise GovernanceError(f"mcp_server_tools_shape:{name}")
    include = tuple(str(p) for p in (tools.get("include") or ["*"]))
    exclude = tuple(str(p) for p in (tools.get("exclude") or []))
    timeout = int(raw.get("timeout_seconds") or 30)
    if not (1 <= timeout <= 300):
        raise GovernanceError(f"mcp_server_timeout:{name}")
    return McpServerSpec(
        name=name, transport=transport, command=str(command) if command else None,
        args=tuple(str(a) for a in (raw.get("args") or [])), url=str(url) if url else None,
        env_passthrough=names, include=include, exclude=exclude, timeout_seconds=timeout,
        manifest_version=int(raw.get("manifest_version") or 1), description=str(raw.get("description") or ""),
    )


def load_mcp_registry(path: str | Path | None = None) -> McpRegistry:
    source = Path(path) if path is not None else registry_path()
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise GovernanceError(f"mcp_registry_unreadable:{source.as_posix()}:{type(exc).__name__}") from exc
    servers = raw.get("servers") if isinstance(raw, Mapping) else None
    if not isinstance(servers, Mapping):
        raise GovernanceError("mcp_registry_schema")
    return McpRegistry(servers={name: _validate_server(str(name), spec) for name, spec in servers.items()})


def quarantined_servers(base_dir: str | Path | None = None) -> frozenset[str]:
    path = ensure_tools_dir(base_dir).joinpath(*QUARANTINE_RELPATH)
    if not path.exists():
        return frozenset()
    state: set[str] = set()
    for row in load_declared_jsonl(path, expected_surface=QUARANTINE_SURFACE):
        if row.get("event") == "quarantined":
            state.add(str(row.get("server")))
        elif row.get("event") == "released":
            state.discard(str(row.get("server")))
    return frozenset(state)


def mcp_config_for_profile(
    profile: Any,
    *,
    registry: McpRegistry | None = None,
    base_dir: str | Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """The `--mcp-config` document: ONLY the profile's servers, minus quarantined.
    A profile without `mcp_servers` (or no profile) gets an EMPTY document — with
    `--strict-mcp-config` that means no MCP server at all."""
    reg = registry or load_mcp_registry()
    env = os.environ if environ is None else environ
    wanted = tuple(getattr(profile, "mcp_servers", ()) or ())
    quarantined = quarantined_servers(base_dir) if base_dir is not None else frozenset()
    servers: dict[str, Any] = {}
    for name in wanted:
        spec = reg.servers.get(name)
        if spec is None:
            raise GovernanceError(f"mcp_server_unknown:{name}")
        if name in quarantined:
            continue
        entry: dict[str, Any] = {}
        if spec.transport == "stdio":
            entry.update({"type": "stdio", "command": spec.command, "args": list(spec.args)})
            passthrough = {n: env[n] for n in spec.env_passthrough if n in env}
            if passthrough:
                entry["env"] = passthrough
        else:
            entry.update({"type": "http", "url": spec.url})
        servers[name] = entry
    return {"mcpServers": servers}


def mcp_tool_rules(profile: Any, *, registry: McpRegistry | None = None) -> tuple[str, ...]:
    """`--disallowedTools` entries for MCP: every registry server the profile
    does not name is closed as `mcp__<server>`; a named server's excluded
    tools are closed one by one."""
    reg = registry or load_mcp_registry()
    wanted = set(getattr(profile, "mcp_servers", ()) or ())
    rules: list[str] = []
    for name, spec in sorted(reg.servers.items()):
        if name not in wanted:
            rules.append(f"{MCP_TOOL_PREFIX}{name}")
            continue
        for pattern in spec.exclude:
            if any(ch in pattern for ch in "*?["):
                continue  # glob excludes are enforced by the server's own manifest filter
            rules.append(f"{MCP_TOOL_PREFIX}{name}__{pattern}")
    return tuple(rules)


def write_mcp_config_file(config: Mapping[str, Any], *, directory: str | Path | None = None, label: str = "spawn") -> Path:
    base = Path(directory) if directory is not None else Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()) / "aria-spawn-mcp"
    base.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f"aria-mcp-{label}-", suffix=".json", dir=str(base))
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(config, handle, sort_keys=True)
    path = Path(name)
    path.chmod(0o600)
    return path


def split_mcp_tool(tool_name: str) -> tuple[str, str] | None:
    if not tool_name.startswith(MCP_TOOL_PREFIX):
        return None
    rest = tool_name[len(MCP_TOOL_PREFIX):]
    server, _, tool = rest.partition("__")
    return (server, tool or "*")


def record_mcp_call(
    *,
    tool_name: str,
    ok: bool,
    base_dir: str | Path | None,
    request_id: str | None = None,
    session_id: str | None = None,
    side: str = "client",
    duration_ms: int | None = None,
    error_class: str | None = None,
) -> dict[str, Any] | None:
    parts = split_mcp_tool(tool_name) if side == "client" else (tool_name.split("/", 1) + ["*"])[:2]
    if parts is None:
        return None
    server, tool = parts[0], parts[1]
    root = ensure_tools_dir(base_dir)
    row = {
        "schema_version": 1, "recorded_at": utc_now(), "side": side, "server": server, "tool": tool, "ok": bool(ok),
        "request_id": request_id, "session_id": session_id, "duration_ms": duration_ms, "error_class": error_class,
    }
    path = root.joinpath(*TOOL_CALLS_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(path, row, expected_surface=TOOL_CALLS_SURFACE)
    if side == "client":
        _maybe_quarantine(server, base_dir=root)
    return row


def evaluate_mcp_health(server: str, *, base_dir: str | Path | None, window: int = QUARANTINE_WINDOW) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*TOOL_CALLS_RELPATH)
    rows = [r for r in (load_declared_jsonl(path, expected_surface=TOOL_CALLS_SURFACE) if path.exists() else [])
            if r.get("server") == server and r.get("side") == "client"][-window:]
    errors = sum(1 for r in rows if not r.get("ok"))
    rate = (errors / len(rows)) if rows else 0.0
    return {"server": server, "calls": len(rows), "errors": errors, "error_rate": round(rate, 3),
            "quarantined": server in quarantined_servers(root),
            "threshold": {"min_calls": QUARANTINE_MIN_CALLS, "error_rate": QUARANTINE_ERROR_RATE}}


def _maybe_quarantine(server: str, *, base_dir: Path) -> None:
    health = evaluate_mcp_health(server, base_dir=base_dir)
    if health["quarantined"] or health["calls"] < QUARANTINE_MIN_CALLS or health["error_rate"] < QUARANTINE_ERROR_RATE:
        return
    path = base_dir.joinpath(*QUARANTINE_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), "event": "quarantined", "server": server,
                                 "calls": health["calls"], "errors": health["errors"], "error_rate": health["error_rate"]},
                          expected_surface=QUARANTINE_SURFACE)
    append_tools_governance(base_dir, MCP_QUARANTINED_EVENT, {"server": server, **{k: health[k] for k in ("calls", "errors", "error_rate")}})


def release_quarantine(server: str, *, base_dir: str | Path | None, operator_ref: str) -> dict[str, Any]:
    if not operator_ref.strip():
        raise ValueError("operator_ref is required to release a quarantined server")
    root = ensure_tools_dir(base_dir)
    if server not in quarantined_servers(root):
        raise ValueError(f"{server} is not quarantined")
    path = root.joinpath(*QUARANTINE_RELPATH)
    row = append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), "event": "released", "server": server, "operator_ref": operator_ref},
                                expected_surface=QUARANTINE_SURFACE)
    append_tools_governance(root, MCP_RELEASED_EVENT, {"server": server, "operator_ref": operator_ref})
    return row


__all__ = [
    "MCP_QUARANTINED_EVENT", "MCP_REGISTRY_RELPATH", "MCP_RELEASED_EVENT", "MCP_TOOL_PREFIX", "MCP_TRANSPORTS",
    "QUARANTINE_ERROR_RATE", "QUARANTINE_MIN_CALLS", "QUARANTINE_RELPATH", "QUARANTINE_SURFACE", "QUARANTINE_WINDOW",
    "TOOL_CALLS_RELPATH", "TOOL_CALLS_SURFACE", "McpRegistry", "McpServerSpec", "evaluate_mcp_health", "load_mcp_registry",
    "mcp_config_for_profile", "mcp_tool_rules", "quarantined_servers", "record_mcp_call", "registry_path",
    "release_quarantine", "split_mcp_tool", "write_mcp_config_file",
]
