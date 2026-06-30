"""Map a project/service to the domain review agent(s) that own it, by reading
the Lane-A orchestrator routing table — the SAME SSoT the orchestrator uses to
dispatch reviewers (`.claude/shared/orchestrator-routing-table.md`). The
per-service examination plan consumes this so it can recommend WHICH agent
examines each impacted service, and surface services with NO owning agent as a
coverage gap (an agent-genesis candidate — see agent_genesis.draft_agent_from_gap).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

ROUTING_TABLE_REL = ".claude/shared/orchestrator-routing-table.md"
# Agent names are kebab-case; this also rejects table placeholders like
# ``{respective domain expert}`` and italic notes like ``*all consumers*``.
_AGENT_RE = re.compile(r"^[a-z][a-z0-9-]+$")


def _clean_agents(cell: str) -> list[str]:
    agents: list[str] = []
    for raw in cell.split(","):
        # drop parentheticals like ``messaging-expert (chat persistence)``
        name = re.sub(r"\(.*?\)", "", raw).strip().strip("`*").strip()
        if _AGENT_RE.match(name) and name not in agents:
            agents.append(name)
    return agents


def _pattern_prefix(glob: str) -> str:
    """The literal path prefix of a routing glob, up to the first wildcard/brace
    (``apps/farm-service/**`` → ``apps/farm-service``; ``apps/*/src/...`` → ``apps``)."""
    cleaned = glob.strip().strip("`").strip()
    cut = len(cleaned)
    for i, ch in enumerate(cleaned):
        if ch in "*{":
            cut = i
            break
    return cleaned[:cut].rstrip("/")


def load_routing_table(repo_root: str | Path) -> list[dict[str, Any]]:
    """Parse the orchestrator routing table into rows of
    ``{prefixes, primary, also_notify}``. Returns ``[]`` when the file is absent."""
    path = Path(repo_root) / ROUTING_TABLE_REL
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or stripped.startswith("| File Pattern"):
            continue
        if set(stripped) <= set("|-: "):  # header separator row
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 2:
            continue
        prefixes = [p for p in (_pattern_prefix(g) for g in cells[0].split(",")) if p]
        primary = _clean_agents(cells[1])
        also_notify = _clean_agents(cells[2]) if len(cells) > 2 else []
        if prefixes and (primary or also_notify):
            rows.append({"prefixes": prefixes, "primary": primary, "also_notify": also_notify})
    return rows


def _matches(prefix: str, project_root: str) -> bool:
    if not prefix:
        return False
    # The agent owns the whole project, a sub-area of it, or a broader surface
    # that contains it.
    return (
        prefix == project_root
        or prefix.startswith(project_root + "/")
        or project_root.startswith(prefix + "/")
    )


def recommended_agents_for_project(
    project_root: str, routing: list[dict[str, Any]]
) -> dict[str, list[str]]:
    """The primary + also-notify agents whose routing globs intersect the given
    project root (union across all matching rows). ``primary`` empty ⇒ no agent
    owns this project (a coverage gap)."""
    primary: list[str] = []
    also_notify: list[str] = []
    for row in routing:
        if any(_matches(prefix, project_root) for prefix in row["prefixes"]):
            for agent in row["primary"]:
                if agent not in primary:
                    primary.append(agent)
            for agent in row["also_notify"]:
                if agent not in also_notify:
                    also_notify.append(agent)
    also_notify = [a for a in also_notify if a not in primary]
    return {"primary": sorted(primary), "also_notify": sorted(also_notify)}


__all__ = [
    "ROUTING_TABLE_REL",
    "load_routing_table",
    "recommended_agents_for_project",
]
