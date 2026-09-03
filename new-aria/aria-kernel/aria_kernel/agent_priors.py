from __future__ import annotations

import fnmatch
import re
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


AGENT_PATH_RE = re.compile(r"`([^`\n*?]+/\*\*[^`\n]*)`|`([^`\n]+\.(?:ts|tsx|rs|md))`")


def map_agent_priors(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    agents_dir = root / ".claude" / "agents"
    if not agents_dir.exists():
        raise GovernanceError(".claude/agents directory was not found")
    agents = []
    seen_names: dict[str, Path] = {}
    for path in sorted(agents_dir.rglob("*.md")):
        if path.name == "README.md":
            continue
        agent = _parse_agent(path, root)
        if agent is None:
            continue
        name = agent["name"]
        if name in seen_names:
            raise GovernanceError(f"reviewer_name_conflict: {name}")
        seen_names[name] = path
        agents.append(agent)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "agent_count": len(agents),
        "agents": agents,
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "agent-priors" / "agent-map.jsonl", row, expected_surface="agent_priors_map")


def reviewer_names(*, workspace_root: str | Path) -> set[str]:
    root = Path(workspace_root).resolve()
    agents_dir = root / ".claude" / "agents"
    if not agents_dir.exists():
        raise GovernanceError(".claude/agents directory was not found")
    names: dict[str, Path] = {}
    for path in sorted(agents_dir.rglob("*.md")):
        if path.name == "README.md":
            continue
        content = path.read_text(encoding="utf-8", errors="ignore")
        name = _frontmatter_value(content, "name")
        if not _valid_agent_name(name):
            continue
        if name in names:
            raise GovernanceError(f"reviewer_name_conflict: {name}")
        names[name] = path
    return set(names)


def latest_agent_priors(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "agent-priors" / "agent-map.jsonl")
    return rows[-1] if rows else None


def related_agents_for_paths(
    *,
    paths: list[str],
    base_dir: str | Path | None = None,
) -> list[str]:
    priors = latest_agent_priors(base_dir=base_dir)
    if not priors:
        return []
    related = set()
    for agent in priors.get("agents", []):
        scopes = agent.get("scope_globs", []) if isinstance(agent, dict) else []
        for path in paths:
            if any(fnmatch.fnmatch(path, scope) or path.startswith(scope.rstrip("*")) for scope in scopes):
                related.add(str(agent.get("name")))
    return sorted(related)


def _parse_agent(path: Path, root: Path) -> dict[str, Any] | None:
    content = path.read_text(encoding="utf-8", errors="ignore")
    name = _frontmatter_value(content, "name")
    if not _valid_agent_name(name):
        return None
    description = _frontmatter_value(content, "description")
    scope_globs = sorted(set(_extract_scope_globs(content)))
    if not scope_globs:
        scope_globs = _default_scope_for_agent(name)
    return {
        "name": name,
        "path": path.relative_to(root).as_posix(),
        "description": description,
        "domain": _domain(name, description),
        "scope_globs": scope_globs,
        "claim_types": _claim_types(name, description),
        "output_contract": _output_contract(content),
    }


def _frontmatter_value(content: str, key: str) -> str:
    frontmatter = _frontmatter(content)
    match = re.search(rf"(?m)^{re.escape(key)}:\s*(.+)$", frontmatter)
    return match.group(1).strip().strip('"') if match else ""


def _frontmatter(content: str) -> str:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    collected = []
    for line in lines[1:]:
        if line.strip() == "---":
            return "\n".join(collected)
        collected.append(line)
    return ""


def _valid_agent_name(name: str) -> bool:
    return bool(re.match(r"^[a-z][a-z0-9-]{1,80}$", name or ""))


def _extract_scope_globs(content: str) -> list[str]:
    globs = []
    for match in AGENT_PATH_RE.finditer(content):
        value = _normalize_scope(match.group(1) or match.group(2) or "")
        if value and _looks_like_owned_scope(value):
            globs.append(value)
    return globs


def _normalize_scope(value: str) -> str:
    value = value.strip()
    # Strip any absolute-path prefix down to repo-relative. The literal
    # "/var/aqua-saas/" was a host-bound hardcode — replace with a generic
    # "last path-segment-pair" strip that works on any clone path.
    if value.startswith("/"):
        # Keep only the repo-relative tail: strip everything up to and
        # including the last "apps/", "libs/", "web/", "tools/", "aria-"
        # boundary. If no boundary found, strip to the final two segments.
        import re
        m = re.search(r"(apps/|libs/|web/|tools/|aria-|platform/|tests/)", value)
        if m:
            value = value[m.start():]
        else:
            parts = value.rstrip("/").split("/")
            value = "/".join(parts[-2:]) if len(parts) > 1 else parts[-1]
    for prefix in ("./", "../"):
        while value.startswith(prefix):
            value = value[len(prefix):]
    return value


def _looks_like_owned_scope(value: str) -> bool:
    if not value or value.startswith("@") or value.startswith(".claude/") or value.startswith("/"):
        return False
    excluded_prefixes = (
        "docs/research/",
        "docs/reviews/",
        "docs/recommendations/",
        "docs/reports/",
        "layer-",
        "2026-",
        "YYYY-",
        "Fixes ",
    )
    if value.startswith(excluded_prefixes):
        return False
    allowed_prefixes = (
        "apps/",
        "libs/",
        "platform/",
        "web/",
        "sens-api-gateway/",
        "sensorprotocols/",
        "infra/",
        "infrastructure/",
        "docker/",
        "mcp/",
        "tests/",
        "e2e/",
        "tools/",
        "database/",
        "nginx/",
    )
    if value.startswith(allowed_prefixes):
        return True
    return (value.startswith("*.") or value.startswith("**/")) and not value.endswith(".md")


def _default_scope_for_agent(name: str) -> list[str]:
    mapping = {
        "auth": ["apps/auth-service/**", "libs/backend-common/src/security/**"],
        "security": ["apps/**/src/**", "libs/backend-common/src/security/**", "web/**/src/**"],
        "tenant": ["apps/**/src/**", "libs/**/src/**"],
        "database": ["apps/**/src/database/**", "libs/backend-common/src/database/**"],
        "frontend": ["web/**"],
        "edge": ["sens-api-gateway/**", "sensorprotocols/**"],
        "infra": ["infra/**", ".github/**", "docker/**"],
        "farm": ["apps/farm-service/**"],
        "billing": ["apps/billing-service/**", "apps/admin-api-service/src/billing/**"],
    }
    for token, scopes in mapping.items():
        if token in name:
            return scopes
    return []


def _domain(name: str, description: str) -> str:
    text = f"{name} {description}".lower()
    for token in ("auth", "security", "tenant", "database", "frontend", "edge", "infra", "farm", "billing", "performance", "observability", "messaging"):
        if token in text:
            return token
    return "general"


def _claim_types(name: str, description: str) -> list[str]:
    text = f"{name} {description}".lower()
    claims = []
    for token in ("security", "tenant", "schema", "performance", "test", "contract", "compliance", "observability"):
        if token in text:
            claims.append(token)
    return claims or ["architecture"]


def _output_contract(content: str) -> str:
    if "finding" in content.lower() and "severity" in content.lower():
        return "finding_with_severity"
    return "review_notes"
