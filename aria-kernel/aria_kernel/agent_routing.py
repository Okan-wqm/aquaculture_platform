"""THE path -> Lane-A agent map (service-expertise PLAN §2, SE-2): the Lane-A
orchestrator routing table, the SAME SSoT the orchestrator dispatches
reviewers from (`.claude/shared/orchestrator-routing-table.md`), read here and
nowhere else in the kernel.

Every kernel answer to "which agent reviews this path" comes from this module:
the per-service examination plan (`recommended_agents_for_project`, services
with NO owning agent are a coverage gap and an agent-genesis candidate — see
agent_genesis.draft_agent_from_gap), the merge-time experts of ARIA's own
implementation PRs (`specialist_review_runner.select_specialist_agents`,
`expert_review_gate`), a finding's reviewing agents, capability-gap
relatedness and CI review targets (`reviewing_agents_for_paths`). SE-2 deleted
the two copies that answered differently: the in-code touch map
(`specialist_review_runner`) and the agents' frontmatter ``scope_globs``
(`agent_priors`), which stay a genesis draft's evidence boundary, not routing.

Because this table picks the reviewers of ARIA's own changes, its directory
(`ROUTING_INPUT_DIR`) is a member of the derived authority set
(`self_improvement.ROUTING_INPUT_MEMBERS`) and CODEOWNED: a change cannot
choose its own reviewers.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .canonical_path import lexical_repo_path

# The routing inputs the kernel consumes live under this directory (this
# table, and the product-audit routing `agent_network` hashes).
ROUTING_INPUT_DIR = ".claude/shared/"
ROUTING_TABLE_REL = f"{ROUTING_INPUT_DIR}orchestrator-routing-table.md"
# Agent names are kebab-case; this also rejects table placeholders like
# ``{respective domain expert}`` and italic notes like ``*all consumers*``.
_AGENT_RE = re.compile(r"^[a-z][a-z0-9-]+$")
# A path glob in the pattern cell is a markdown code span; the cell's prose
# (``(handler implementations)``, cross-cutting rows) is not a path.
_CODE_SPAN_RE = re.compile(r"`([^`]+)`")


def _clean_agents(cell: str) -> list[str]:
    agents: list[str] = []
    for raw in cell.split(","):
        # drop parentheticals like ``messaging-expert (chat persistence)``
        name = re.sub(r"\(.*?\)", "", raw).strip().strip("`*").strip()
        if _AGENT_RE.match(name) and name not in agents:
            agents.append(name)
    return agents


def _pattern_prefix(glob: str) -> str:
    """The literal path prefix of one code-span routing glob, up to the first
    wildcard/brace (``apps/farm-service/**`` → ``apps/farm-service``;
    ``apps/*/src/...`` → ``apps``). A brace group ``{a,b}`` is cut at ``{``,
    so its comma-separated alternatives never yield a sibling-branch fragment."""
    cleaned = glob.strip()
    cut = len(cleaned)
    for i, ch in enumerate(cleaned):
        if ch in "*{":
            cut = i
            break
    return cleaned[:cut].rstrip("/")


def _owned_subtree(glob: str) -> str | None:
    """The repo subtree one code-span routing glob claims WHOLE: the glob is a
    literal path or ``<literal>/**`` (``apps/farm-service/**`` →
    ``apps/farm-service``; ``CLAUDE.md`` → ``CLAUDE.md``). ``None`` when a
    wildcard or brace cuts the glob earlier (``apps/*/src/gdpr/**``,
    ``apps/auth-service/src/{privacy,modules/gdpr}/**``, ``docker-compose*``):
    such a row reaches only some paths under its prefix, so it reviews them
    without owning them."""
    cleaned = glob.strip()
    prefix = _pattern_prefix(cleaned)
    if prefix and cleaned in (prefix, f"{prefix}/**"):
        return prefix
    return None


def load_routing_table(repo_root: str | Path) -> list[dict[str, Any]]:
    """Parse the orchestrator routing table into rows of
    ``{prefixes, subtrees, primary, also_notify}``. Returns ``[]`` when the
    file is absent. ``prefixes`` are the literal prefixes of every glob (what
    the row can reach); ``subtrees`` are the ones it claims whole
    (`_owned_subtree`, what the row owns).

    Prefixes come only from the code-span globs of the pattern cell. A prose
    row (no code span, e.g. the cross-cutting supply-chain row) is an
    instruction to the LLM orchestrator and owns no path prefix, so it is
    not a routing row here."""
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
        globs = _CODE_SPAN_RE.findall(cells[0])
        prefixes = [p for p in (_pattern_prefix(g) for g in globs) if p]
        subtrees = [t for t in (_owned_subtree(g) for g in globs) if t is not None]
        primary = _clean_agents(cells[1])
        also_notify = _clean_agents(cells[2]) if len(cells) > 2 else []
        if prefixes and (primary or also_notify):
            rows.append({"prefixes": prefixes, "subtrees": subtrees, "primary": primary,
                         "also_notify": also_notify})
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


def reviewing_agents_for_paths(
    paths: Iterable[str], routing: list[dict[str, Any]]
) -> list[str]:
    """THE path -> reviewing agents answer: the union, over every repo path
    (a file, a directory or a ``path:line`` ref), of the primary and
    also-notify agents `recommended_agents_for_project` derives for it. A
    path no row reaches contributes nothing; an empty result means no agent
    reviews any of the paths."""
    agents: set[str] = set()
    for path in paths:
        recommended = recommended_agents_for_project(lexical_repo_path(path).rstrip("/"), routing)
        agents.update(recommended["primary"])
        agents.update(recommended["also_notify"])
    return sorted(agents)


def owning_agents_for_paths(
    paths: Iterable[str], routing: list[dict[str, Any]]
) -> list[str]:
    """The owners of a path set: the primary agents of every row that claims
    a whole subtree (``subtrees``) containing a path. A subset of
    `reviewing_agents_for_paths`: a row cut by a wildcard
    (``apps/*/src/gdpr/**`` reaches every ``apps/*`` file through the prefix
    ``apps``) still reviews the path but does not own it. The merge-time cost
    cap keeps owners ahead of every wider reviewer
    (`specialist_review_runner.select_specialist_agents`), so a touched
    service's own domain expert is never cut for a wider one (DECISIONS.md
    Q4: the merge-time reviewer set must not narrow silently)."""
    owners: set[str] = set()
    for path in paths:
        clean = lexical_repo_path(path).rstrip("/")
        for row in routing:
            if any(clean == tree or clean.startswith(tree + "/") for tree in row["subtrees"]):
                owners.update(row["primary"])
    return sorted(owners)


def routing_domain_for_path(path: str, routing: list[dict[str, Any]]) -> str | None:
    """The review domain a path falls in: the most specific routing prefix
    that is the path itself or contains it (``apps/farm-service/src/x.ts``
    -> ``apps/farm-service``). ``None`` when no row owns the path. Two paths
    in different domains make a change multi-domain."""
    clean = lexical_repo_path(path).rstrip("/")
    owning = [prefix for row in routing for prefix in row["prefixes"]
              if clean == prefix or clean.startswith(prefix + "/")]
    return max(owning, key=len) if owning else None


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
    "ROUTING_INPUT_DIR",
    "ROUTING_TABLE_REL",
    "load_routing_table",
    "owning_agents_for_paths",
    "recommended_agents_for_project",
    "reviewing_agents_for_paths",
    "routing_domain_for_path",
    "unowned_projects",
]
