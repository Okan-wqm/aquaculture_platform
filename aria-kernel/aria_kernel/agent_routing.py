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


# The three shapes a routing glob takes — and therefore the three ways a path
# can belong to the surface it names. The mode is not decoration: it is the
# difference between ``infra`` owning ``infra/terraform/main.tf`` (dir) and
# ``infra`` wrongly swallowing ``infrastructure/nats/nats.conf`` (raw string
# prefix). Emitted next to the literal because only the glob knows which it is.
#   dir   — ``tests/**`` / ``apps/*/src/**``: the literal ends at a ``/``, so it
#           names a DIRECTORY; a path belongs when it is that directory or lives
#           under it.
#   stem  — ``docker-compose*`` / ``.env*``: the wildcard opens straight off the
#           literal, so the literal is a FILENAME STEM; a sibling file whose
#           name starts with it belongs, a sibling directory tree does not.
#   exact — ``Cargo.toml`` / ``CLAUDE.md``: no wildcard at all; that one path.


def pattern_surface(glob: str) -> tuple[str, str]:
    """``(literal prefix, match mode)`` for one routing glob.

    THE glob parser for this table — ``_pattern_prefix`` is this function
    with the mode dropped, so a second reader of the same column cannot
    disagree with the first about where the literal ends.
    """
    cleaned = glob.strip().strip("`").strip()
    cut = len(cleaned)
    mode = "exact"
    for i, ch in enumerate(cleaned):
        if ch in "*{":
            cut = i
            mode = "dir" if cleaned[:i].endswith("/") else "stem"
            break
    return cleaned[:cut].rstrip("/"), mode


def _pattern_prefix(glob: str) -> str:
    """The literal path prefix of a routing glob, up to the first wildcard/brace
    (``apps/farm-service/**`` → ``apps/farm-service``; ``apps/*/src/...`` → ``apps``)."""
    return pattern_surface(glob)[0]


def load_routing_table(repo_root: str | Path) -> list[dict[str, Any]]:
    """Parse the orchestrator routing table into rows of
    ``{globs, prefixes, primary, also_notify}``. Returns ``[]`` when the file is
    absent."""
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
        # The raw globs travel with the row because the literal prefix alone
        # cannot say HOW to match (see ``pattern_surface``): a reader that
        # needs the mode would otherwise have to re-split this cell itself,
        # and two splitters of one column is one too many.
        globs = [g.strip().strip("`").strip() for g in cells[0].split(",")]
        globs = [g for g in globs if g]
        prefixes = [p for p in (_pattern_prefix(g) for g in globs) if p]
        primary = _clean_agents(cells[1])
        also_notify = _clean_agents(cells[2]) if len(cells) > 2 else []
        if prefixes and (primary or also_notify):
            rows.append({
                "globs": globs,
                "prefixes": prefixes,
                "primary": primary,
                "also_notify": also_notify,
            })
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


def unowned_projects(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, str]:
    """Whole-repo: ``{project_name: project_root}`` for every project whose
    routing-table ``primary`` owner is empty — i.e. a service no domain agent
    owns (a coverage gap, and an agent-genesis candidate). Reuses the cached
    service order (no rescan when the project graph is unchanged) so this is
    cheap to call every cycle."""
    # Imported lazily: impact_graph imports this module, so a top-level import
    # here would be circular.
    from .impact_graph import cached_service_analysis_order

    cache = cached_service_analysis_order(
        workspace_root=workspace_root, base_dir=base_dir, nx_graph_file=nx_graph_file
    )
    routing = load_routing_table(workspace_root)
    return {
        name: root
        for name, root in cache.get("project_roots", {}).items()
        if not recommended_agents_for_project(root, routing)["primary"]
    }


__all__ = [
    "ROUTING_TABLE_REL",
    "load_routing_table",
    "pattern_surface",
    "recommended_agents_for_project",
    "unowned_projects",
]
