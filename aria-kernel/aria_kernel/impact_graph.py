from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import Any, Protocol

from .agent_routing import load_routing_table, recommended_agents_for_project
from .canonical_path import lexical_repo_path
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import (
    GovernanceError,
    declared_bound_repo_root,
    ensure_tools_dir,
    tools_dir,
    utc_now,
)


IMPORT_RE = re.compile(r"""from\s+['"]([^'"]+)['"]|import\s+[^'"]*['"]([^'"]+)['"]""")

# A directory is a project when it carries one of these. ``project.json`` is
# nx's own SSoT; the other three cover the deliverable roots nx does not model
# (the Rust edge gateway, ARIA's Python kernel, the standalone PWA). The
# vocabulary is closed on purpose — every additional marker nominates
# directories, and a graph that names non-projects misroutes as badly as one
# that misses projects.
PROJECT_MARKERS = ("project.json", "package.json", "Cargo.toml", "pyproject.toml")

# Directories that are not this repository's source: dependencies, build
# output, and vendored third-party trees. They carry markers of their own and
# would otherwise flood the graph with projects nobody here maintains.
NOT_THE_REPOSITORY = frozenset(
    {"node_modules", "dist", "build", "coverage", "target", "vendor", "tmp", "__pycache__"}
)

# The walk prunes at every project it finds, so depth is reached only inside
# grouping directories (``web/apps/…``, ``tools/executors/…``). The bound is a
# cost guard on pathological trees, not a statement about repository layout.
_MARKER_SCAN_MAX_DEPTH = 6


# SE-4 (service-expertise PLAN §1.1 step 3, §2 'Service impact closure') — the typed edges the one
# closure walks besides ``import``. ``subgraphs.json`` is generated from the service catalog and
# names each subgraph's nx project; the project that composes them is the catalog's gateway entry
# (``platform/libs/service-catalog/src/index.ts``, ``nxProject: 'gateway-api'``), which the
# generated file does not repeat.
SUBGRAPHS_RELPATH = "infrastructure/apollo-router/subgraphs.json"
GATEWAY_PROJECT = "gateway-api"
CONTRACT_EDGES_UNAVAILABLE = "contract_edges_unavailable"
_NX_PROJECT_LINE = re.compile(r'"nxProject"\s*:\s*"([^"]+)"')
# The edge kinds, strongest first. When several edges reach a project at one depth, the entry's
# ``reason`` is the strongest kind's (PLAN §1.1 step 3: auth-service -> gateway-api is the subgraph
# relation even when an auth event is also consumed there); the reason string is never the rank —
# 'contract:event:...' sorts before 'contract:gateway_subgraph'.
EDGE_KIND_PRECEDENCE = ("gateway_subgraph", "event", "import")
# (impacted project, edge kind, reason, evidence ``path:line`` or None for an import edge)
_Edge = tuple[str, str, str, "str | None"]


def impact_closure(
    *,
    changed_files: list[str],
    workspace_root: str | Path,
    base_dir: str | Path | None,
    service_facts: Mapping[str, Any],
    depth: int | None = None,
    changed_hunks: Mapping[str, Iterable[tuple[int, int]]] | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    """THE service impact closure: which projects a change reaches, and over which edge.

    One function over three typed edges, walked breadth-first from the touched projects
    (``project_for_path`` over the cached map):

    * ``import`` — the cached project graph's reverse dependents (no site: the graph records
      project edges, not import lines);
    * ``contract:gateway_subgraph`` — a touched or reached subgraph project reaches
      ``GATEWAY_PROJECT``; evidence is its ``nxProject`` line in ``subgraphs.json`` of
      ``workspace_root``, the tree ``service_facts`` were computed on (``compute_service_facts``
      verified it is ``facts_sha``);
    * ``contract:event:<T>`` — SE-3's code producer x code subscription edges; and when a
      changed file holds an event definition (``changed_hunks`` intersecting its site, or the
      whole file when no hunk is given) the producers and consumers of that type, each with its
      own site.

    ``depth`` bounds the walk (None = the whole closure). A project keeps every edge that reaches
    it at its first depth (``edges``, strongest first by ``EDGE_KIND_PRECEDENCE``); its ``kind``,
    ``reason``, ``evidence`` and ``reached_from`` are the strongest edge's. ``impacted`` is the
    closure minus touched, contract edges ranked first, then by depth and name. Facts that were not computed give ``{"hold":
    "contract_edges_unavailable:<reason>"}`` and no impacted set: a change is never routed on an
    import-only closure (PLAN §3.3).
    """
    if service_facts.get("verdict") != "computed":
        return {"hold": f"{CONTRACT_EDGES_UNAVAILABLE}:{(service_facts.get('witness') or {}).get('error')}"}
    root = Path(workspace_root).resolve()
    subgraph_lines = _subgraph_lines(root)
    if isinstance(subgraph_lines, str):
        return {"hold": f"{CONTRACT_EDGES_UNAVAILABLE}:{subgraph_lines}"}
    cache = cached_service_analysis_order(workspace_root=root, base_dir=base_dir, nx_graph_file=nx_graph_file)
    # FILTER BEFORE SORTING (ORPHAN-HIGH-575): a change touching a placed and an unplaced path
    # must not hand `sorted` a mixture of names and None.
    resolved = [(path, project_for_path(path, cache["project_roots"])) for path in normalize_paths(changed_files)]
    touched = sorted({project for _, project in resolved if project})
    event_facts = service_facts["event_facts"]
    edges: dict[str, list[_Edge]] = {}
    for source, deps in cache["dependencies"].items():
        for dep in deps:
            edges.setdefault(dep, []).append((source, "import", "import", None))
    for project, line in subgraph_lines.items():
        if project != GATEWAY_PROJECT:
            edges.setdefault(project, []).append(
                (GATEWAY_PROJECT, "gateway_subgraph", "contract:gateway_subgraph", f"{SUBGRAPHS_RELPATH}:{line}")
            )
    for service in event_facts["services"]:
        for edge in service["edges"]:
            edges.setdefault(service["service"], []).append(
                (edge["to"], "event", f"contract:event:{edge['subject']}", edge["to_ref"])
            )
    reached: dict[str, dict[str, Any]] = {}
    frontier = [(project, project) for project in touched]
    seeds = _changed_type_edges(resolved, changed_hunks, event_facts)
    level = 0
    # Seeds exist only for a touched contract file, so the frontier is never empty when they are not.
    while frontier and (depth is None or level < depth):
        level += 1
        candidates = [(origin, edge) for current, origin in frontier for edge in edges.get(current, [])]
        if level == 1:
            candidates += seeds
        arrivals: dict[str, set[tuple[int, str, str, str, str]]] = {}
        for origin, (project, kind, reason, evidence) in candidates:
            if project not in touched and project not in reached:
                rank = EDGE_KIND_PRECEDENCE.index(kind)
                arrivals.setdefault(project, set()).add((rank, kind, reason, evidence or "", origin))
        for project, found in sorted(arrivals.items()):
            ordered = [
                {"kind": kind, "reason": reason, "evidence": evidence or None, "reached_from": origin}
                for _, kind, reason, evidence, origin in sorted(found)
            ]
            reached[project] = {"project": project, **ordered[0], "depth": level, "edges": ordered}
        frontier = [(project, reached[project]["reached_from"]) for project in sorted(arrivals)]
    impacted = sorted(
        reached.values(),
        key=lambda entry: (entry["kind"] == "import", entry["depth"], entry["project"]),
    )
    return {
        "touched": touched,
        "impacted": impacted,
        "unknown_files": [path for path, project in resolved if project is None],
        "graph_source": cache["graph_source"],
    }


def _subgraph_lines(root: Path) -> dict[str, int] | str:
    """Each subgraph's nx project -> the line naming it in ``subgraphs.json``; a named error
    string when the file exists and cannot be read. No file means no subgraph relation."""
    path = root / SUBGRAPHS_RELPATH
    if not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
        projects = {entry["nxProject"] for entry in json.loads(text)["subgraphs"]}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return f"subgraphs_unreadable:{SUBGRAPHS_RELPATH}: {type(exc).__name__}"
    lines: dict[str, int] = {}
    for number, line in enumerate(text.splitlines(), start=1):
        match = _NX_PROJECT_LINE.search(line)
        if match and match.group(1) in projects:
            lines.setdefault(match.group(1), number)
    return lines


def _changed_type_edges(
    resolved: list[tuple[str, str | None]],
    changed_hunks: Mapping[str, Iterable[tuple[int, int]]] | None,
    event_facts: Mapping[str, Any],
) -> list[tuple[str, _Edge]]:
    """The producers and consumers of every event type whose definition a change touches, as
    edges from the project owning the definition file."""
    owners = {path: project for path, project in resolved if project}
    changed_types: dict[str, str] = {}
    for definition in event_facts["event_definitions"]:
        path, _, line = definition["site"].rpartition(":")
        if path not in owners:
            continue
        hunks = None if changed_hunks is None else changed_hunks.get(path)
        if hunks is None or any(start <= int(line) <= end for start, end in hunks):
            changed_types.setdefault(definition["event_type"], owners[path])
    seeds: list[tuple[str, _Edge]] = []
    for service in event_facts["services"]:
        for fact in (*service["events_produced"], *service["events_consumed"]):
            if fact["event_type"] in changed_types:
                origin = changed_types[fact["event_type"]]
                seeds.append(
                    (origin, (service["service"], "event", f"contract:event:{fact['event_type']}", fact["site"]))
                )
    return seeds


def plan_downstream_impact(
    *,
    changed_files: list[str],
    workspace_root: str | Path,
    service_facts: Mapping[str, Any],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    """The `impact_closure` of a change, recorded in the impact-graphs ledger.

    A held closure is recorded as held (``hold``, no project lists), never as a change that
    reaches nothing."""
    if not changed_files or not all(isinstance(path, str) and path.strip() for path in changed_files):
        raise GovernanceError("changed_files must contain at least one path")
    root = Path(workspace_root).resolve()
    if not root.exists():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    row: dict[str, Any] = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "changed_files": normalize_paths(changed_files),
    }
    closure = impact_closure(
        changed_files=changed_files, workspace_root=root, base_dir=base_dir,
        service_facts=service_facts, nx_graph_file=nx_graph_file,
    )
    if "hold" in closure:
        row["hold"] = closure["hold"]
        return append_declared_jsonl(
            ensure_tools_dir(base_dir) / "impact" / "impact-graphs.jsonl", row, expected_surface="impact_graphs",
        )
    cache = cached_service_analysis_order(workspace_root=root, base_dir=base_dir, nx_graph_file=nx_graph_file)
    roots = cache["project_roots"]
    changed_projects = closure["touched"]
    downstream = [entry["project"] for entry in closure["impacted"]]
    unknown_files = closure["unknown_files"]
    # ARIA-HIGH-357 — the projects the changed ones import directly: the
    # contracts a change consumes (the generated GraphQL types a web module
    # renders, the shared library a service calls). One hop, because that is
    # where a consumed contract is declared; the closure above is unchanged.
    upstream = sorted({
        dep for project in changed_projects for dep in cache["dependencies"].get(project, [])
    } - {*changed_projects, *downstream})
    row.update({
        "changed_projects": changed_projects,
        "direct_projects": changed_projects,
        "downstream_projects": downstream,
        "impacted": closure["impacted"],
        # ADR-0021 — where each closure project lives, so a reader can bound
        # paths by the closure without building the graph a second time.
        "project_roots": {name: roots[name] for name in [*changed_projects, *downstream] if name in roots},
        "upstream_projects": upstream,
        "upstream_project_roots": {name: roots[name] for name in upstream if name in roots},
        "unknown_files": unknown_files,
        "graph_source": closure["graph_source"],
        "confidence": 0.9 if closure["graph_source"] == "nx_graph_json" and not unknown_files else 0.65,
        "validation_scope": _validation_scope(changed_projects, downstream, unknown_files),
    })
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "impact" / "impact-graphs.jsonl",
        row,
        expected_surface="impact_graphs",
    )


def list_impact_graphs(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "impact" / "impact-graphs.jsonl",
        expected_surface="impact_graphs",
    )


def build_service_analysis_order(graph: dict[str, Any]) -> dict[str, Any]:
    """Order projects so each is examined AFTER its dependencies (upstream
    foundational layers first), with each project's dependents surfaced so
    cross-service impact is explicit.

    This is the "logical order" for per-service analysis: discovery scans the
    whole repo ONCE (it must, to build the graph); the examination stage then
    walks services in THIS order so a downstream service is analysed with its
    upstream dependencies already understood, and an upstream change's ripple
    reaches its dependents. ``layer`` is the topological depth (0 = no in-graph
    dependencies). Within a layer projects are name-sorted for determinism;
    cycles are broken by forcing the lexicographically smallest stuck node, so
    the order is always TOTAL and STABLE.
    """
    deps_raw = graph.get("dependencies") or {}
    nodes = sorted(deps_raw.keys())
    node_set = set(nodes)
    deps = {
        n: {d for d in (deps_raw.get(n) or []) if d in node_set and d != n}
        for n in nodes
    }
    dependents: dict[str, set[str]] = {n: set() for n in nodes}
    for n in nodes:
        for d in deps[n]:
            dependents[d].add(n)

    placed: set[str] = set()
    layers: list[list[str]] = []
    cycle_broken: list[str] = []
    while len(placed) < len(nodes):
        ready = sorted(n for n in nodes if n not in placed and deps[n] <= placed)
        if not ready:
            # Dependency cycle: force the smallest unplaced node so the order
            # stays total + deterministic (recorded for audit).
            forced = sorted(n for n in nodes if n not in placed)[0]
            cycle_broken.append(forced)
            ready = [forced]
        layers.append(ready)
        placed.update(ready)

    order = [
        {
            "project": project,
            "layer": layer_idx,
            "depends_on": sorted(deps[project]),
            "dependents": sorted(dependents[project]),
        }
        for layer_idx, layer in enumerate(layers)
        for project in layer
    ]
    return {
        "schema_version": 1,
        "graph_source": graph.get("graph_source"),
        "project_count": len(nodes),
        "layer_count": len(layers),
        "cycle_broken_projects": cycle_broken,
        "order": order,
    }


def plan_service_analysis_order(
    *,
    workspace_root: str | Path,
    service_facts: Mapping[str, Any],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    nx_graph_file: str | Path | None = None,
    changed_files: list[str] | None = None,
) -> dict[str, Any]:
    """Build the project dependency graph and return the per-service analysis
    plan: projects in topological dependency order, each annotated with its
    upstream ``depends_on`` (already-understood context) and ``dependents``
    (ripple targets). When ``changed_files`` is given, annotate how many of this
    cycle's changes landed in each project (the examination focus) and the
    `impact_closure` they reach (``impacted_projects``, or the closure's
    ``hold``). Pure computation — no ledger write."""
    root = Path(workspace_root).resolve()
    if not root.exists():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    graph = _project_graph(root=root, nx_graph_file=Path(nx_graph_file) if nx_graph_file else None)
    plan = build_service_analysis_order(graph)
    plan["cycle_id"] = cycle_id
    plan["recorded_at"] = utc_now()
    if changed_files:
        counts: dict[str, int] = {}
        for path in normalize_paths([p for p in changed_files if isinstance(p, str) and p.strip()]):
            project = _project_for_path(path, graph["projects"])
            if project:
                counts[project] = counts.get(project, 0) + 1
        for entry in plan["order"]:
            entry["changed_files"] = counts.get(entry["project"], 0)
        plan["changed_project_count"] = sum(1 for e in plan["order"] if e.get("changed_files"))
        # The examination subset: changed services + the closure they reach.
        closure = impact_closure(
            changed_files=changed_files, workspace_root=root, base_dir=base_dir,
            service_facts=service_facts, nx_graph_file=nx_graph_file,
        )
        if "hold" in closure:
            plan["hold"] = closure["hold"]
        else:
            plan["impacted_projects"] = sorted(
                {*closure["touched"], *(entry["project"] for entry in closure["impacted"])}
            )
    return plan


def _graph_fingerprint(root: Path) -> str:
    """A cheap fingerprint of the project dependency graph's INPUTS (project
    names and dir layout + the tsconfig alias SSoT) — does NOT read any
    ``*.ts`` file, so it is fast enough to compute every cycle to decide
    whether the cached order is still valid. The order only changes when
    projects are added/removed/renamed or the tsconfig path aliases change;
    all are captured here."""
    # Name AND root: a project's identity is part of the published map
    # (`project_roots`), so a ``project.json`` rename with the directory
    # unchanged must invalidate the cache like a moved root does.
    entries = sorted(f"{name}={meta['root']}" for name, meta in _discover_projects(root).items())
    tsconfig = root / "tsconfig.base.json"
    ts = tsconfig.read_text(encoding="utf-8") if tsconfig.exists() else ""
    digest = hashlib.sha256()
    digest.update("\0".join(entries).encode("utf-8"))
    digest.update(b"\0")
    digest.update(ts.encode("utf-8"))
    return digest.hexdigest()


_SERVICE_ORDER_CACHE = Path("impact") / "service-order-cache.json"


def _read_service_order_cache(cache_file: Path) -> dict[str, Any] | None:
    """The published service order, or None when there is none to read.

    Absent and unreadable are the same answer on purpose: both mean the
    writer (`cached_service_analysis_order`) has to run before anyone can
    read a map, and the writer overwrites an unreadable file.
    """
    if not cache_file.is_file():
        return None
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return cached if isinstance(cached, dict) else None


def cached_service_analysis_order(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    """The topological service order, cached by graph fingerprint so the
    expensive import scan runs ONLY when the project layout / tsconfig aliases
    change. Cache is a plain JSON file (not a declared ledger) under
    ``tools/impact/service-order-cache.json`` — read-through, write-back."""
    root = Path(workspace_root).resolve()
    cache_file = ensure_tools_dir(base_dir) / _SERVICE_ORDER_CACHE
    fingerprint = _graph_fingerprint(root)
    cached = _read_service_order_cache(cache_file)
    if cached is not None and cached.get("graph_fingerprint") == fingerprint:
        return cached
    graph = _project_graph(root=root, nx_graph_file=Path(nx_graph_file) if nx_graph_file else None)
    plan = build_service_analysis_order(graph)
    payload = {
        "graph_fingerprint": fingerprint,
        "graph_source": graph["graph_source"],
        "project_roots": {name: meta["root"] for name, meta in graph["projects"].items()},
        "dependencies": graph["dependencies"],
        "order": plan["order"],
        "layer_count": plan["layer_count"],
        "project_count": plan["project_count"],
        "cycle_broken_projects": plan["cycle_broken_projects"],
    }
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        cache_file.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    except OSError:
        pass
    return payload


class ProjectMap(Mapping[str, str]):
    """A ``project_roots`` map (name -> root) together with its own identity.

    The identity travels with the map because a name is only meaningful
    against the map that produced it: a ``project.json`` rename or a new
    project changes the answer `project_for_path` gives for the same path.
    A finding stamped with the names of one map and read against another has
    to be re-derived, and only a map that says which map it is can tell the
    reader so (`service_dimension.services_for_finding_row`).

    ``fingerprint`` is computed HERE, as a sha256 over the sorted
    ``name=root`` pairs this object wraps, never handed in. SE-1-R2 appellate
    R1 (b): it used to be the cache's ``graph_fingerprint``, which digests the
    discovery layout the cache is KEYED by, not the map stored under that
    key. A map built from an nx graph file and the discovery map that later
    replaced it shared that key, so a stamp of the first was read as stored
    against the second. A fingerprint that is a digest of the wrapped map
    cannot describe a different map.
    """

    __slots__ = ("_roots", "fingerprint")

    def __init__(self, roots: Mapping[str, str]) -> None:
        self._roots = dict(roots)
        digest = hashlib.sha256()
        digest.update("\0".join(sorted(f"{name}={root}" for name, root in self._roots.items())).encode("utf-8"))
        self.fingerprint = digest.hexdigest()

    def __getitem__(self, name: str) -> str:
        return self._roots[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._roots)

    def __len__(self) -> int:
        return len(self._roots)


def project_map(*, base_dir: str | Path | None, workspace_root: str | Path | None = None) -> ProjectMap:
    """THE accessor for the map `project_for_path` attributes against.

    It always resolves through `cached_service_analysis_order`, which checks
    the published cache's graph fingerprint against the workspace and
    rebuilds a stale one, so no caller can be handed the names of a layout
    the tree no longer has. The workspace is ``workspace_root`` when the
    caller holds it, else the one the store DECLARES
    (`tool_registry.declared_bound_repo_root`).

    SE-1 round 2 (review-r1 B1 / BLOCKER-1). Round 1 had a second accessor
    that returned the published file as it stood. The cycle's 'tools' phase
    mints before 'service_examination' refreshes the publication, so a
    finding on a project the tree had just gained was minted with no
    service, and after a ``project.json`` rename the tool-finding mint and
    `finding.emit_finding` filed one defect under two names.

    A store that declares no workspace, asked without one, cannot produce a
    map and is refused by name (``service_key_map_unavailable``, review-r1
    B2). Answering "no map" with an empty attribution made "cannot
    attribute" and "attributed to nothing" the same answer. The layout
    convention (``<workspace>/aria-tools``) is deliberately not guessed: a
    scratch store's parent is a temp directory, and a project graph of
    ``/tmp`` is not a map of anything.
    """
    workspace = workspace_root if workspace_root is not None else declared_bound_repo_root(base_dir)
    if workspace is None:
        raise GovernanceError(
            "service_key_map_unavailable: the store at "
            f"{tools_dir(base_dir).as_posix()} declares no workspace "
            "(tool_registry.ensure_tools_binding) and none was given, so no project map can "
            "attribute a path to a service"
        )
    cache = cached_service_analysis_order(workspace_root=workspace, base_dir=base_dir)
    return ProjectMap(cache["project_roots"])


def cycle_service_examination(
    *,
    workspace_root: str | Path,
    changed_files: list[str],
    service_facts: Mapping[str, Any],
    pressures: list[dict[str, Any]] | None = None,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    """This cycle's per-service examination plan: the changed services + the
    `impact_closure` they reach, presented in DEPENDENCY (topological) order so the
    examination stage walks upstream-before-downstream; each reached entry names
    its edge (``reason``) and the edge's ``evidence``. A held closure gives
    ``hold`` and no examination order. When ``pressures`` is
    given, each pressure is scoped to the service(s) its evidence touches and
    grouped per-service in the same dependency order (``per_service_pressures``);
    pressures whose evidence maps to no project fall under ``global_pressures``.
    Uses the cached order (no re-scan when the graph is unchanged)."""
    cache = cached_service_analysis_order(
        workspace_root=workspace_root, base_dir=base_dir, nx_graph_file=nx_graph_file
    )
    projects = {name: {"root": r} for name, r in cache["project_roots"].items()}
    changed = [p for p in (changed_files or []) if isinstance(p, str) and p.strip()]
    closure = impact_closure(
        changed_files=changed, workspace_root=workspace_root, base_dir=base_dir,
        service_facts=service_facts, nx_graph_file=nx_graph_file,
    )
    counts: dict[str, int] = {}
    for path in normalize_paths(changed):
        project = _project_for_path(path, projects)
        if project:
            counts[project] = counts.get(project, 0) + 1
    reached = {entry["project"]: entry for entry in closure.get("impacted", [])}
    impacted = sorted({*counts, *reached})
    examination_order = [
        {
            "project": e["project"],
            "layer": e["layer"],
            "depends_on": e["depends_on"],
            "dependents": e["dependents"],
            "changed_files": counts.get(e["project"], 0),
            "reason": "changed" if counts.get(e["project"]) else reached[e["project"]]["reason"],
            "evidence": None if counts.get(e["project"]) else reached[e["project"]]["evidence"],
        }
        for e in cache["order"]  # already topological → examine upstream first
        if e["project"] in impacted
    ]
    # Recommend WHICH domain agent(s) examine each impacted service, from the
    # Lane-A routing SSoT. A service with no primary owner is a coverage gap —
    # an agent-genesis candidate (agent_genesis.draft_agent_from_gap).
    routing = load_routing_table(workspace_root)
    project_root_of = cache["project_roots"]
    for entry in examination_order:
        root = project_root_of.get(entry["project"], entry["project"])
        entry["recommended_agents"] = recommended_agents_for_project(root, routing)
    agent_coverage_gaps = sorted(
        entry["project"] for entry in examination_order
        if not entry["recommended_agents"]["primary"]
    )
    # Scope each pressure to the service(s) its evidence touches, then group
    # per-service in the same topological order (upstream first). A pressure
    # whose evidence maps to no project is global (cross-cutting).
    layer_of = {e["project"]: e["layer"] for e in cache["order"]}
    order_pos = {e["project"]: i for i, e in enumerate(cache["order"])}
    by_service: dict[str, list[dict[str, Any]]] = {}
    global_pressures: list[dict[str, Any]] = []
    for pressure in pressures or []:
        if not isinstance(pressure, dict):
            continue
        evidence = [p for p in (pressure.get("evidence") or []) if isinstance(p, str) and p.strip()]
        services = sorted(
            {_project_for_path(path, projects) for path in normalize_paths(evidence)} - {None}
        )
        summary = {
            "pressure_id": pressure.get("pressure_id"),
            "source": pressure.get("source"),
            "severity": pressure.get("severity"),
            "affected_services": services,
            # ARIA-HIGH-245 — the refs that scoped the pressure here travel
            # with it: the service seeder records the ones in its project as
            # the mission's evidence, which a summary without them could not.
            "evidence": evidence,
        }
        if services:
            for service in services:
                by_service.setdefault(service, []).append(summary)
        else:
            global_pressures.append(summary)
    per_service_pressures = [
        {"service": service, "layer": layer_of.get(service), "pressures": by_service[service]}
        for service in sorted(by_service, key=lambda s: order_pos.get(s, len(order_pos)))
    ]
    examination: dict[str, Any] = {
        "schema_version": 1,
        "graph_source": cache["graph_source"],
        "changed_projects": sorted(counts),
        "per_service_pressures": per_service_pressures,
        "global_pressures": global_pressures,
        "project_count": cache["project_count"],
        "layer_count": cache["layer_count"],
    }
    if "hold" in closure:
        # The pressures are scoped by their own evidence paths, not by the closure, so they stand.
        return {**examination, "hold": closure["hold"]}
    return {
        **examination,
        "impacted_projects": impacted,
        "examination_order": examination_order,
        "agent_coverage_gaps": agent_coverage_gaps,
    }


def _project_graph(*, root: Path, nx_graph_file: Path | None) -> dict[str, Any]:
    if nx_graph_file and nx_graph_file.exists():
        return _read_nx_graph(root=root, graph_file=nx_graph_file)
    projects = _discover_projects(root)
    # The repo resolves cross-project imports through tsconfig path aliases
    # (``@platform/cqrs`` → platform/libs/cqrs, ``@aquaculture/backend-common``
    # → libs/backend-common), NOT bare directory names. Reading that alias SSoT
    # is what makes the local-scan dependency graph reflect reality instead of a
    # flat single-layer graph.
    alias_targets = _tsconfig_alias_targets(root)
    dependencies = {
        name: sorted(_scan_project_dependencies(root, meta, projects, alias_targets))
        for name, meta in projects.items()
    }
    return {"projects": projects, "dependencies": dependencies, "graph_source": "local_import_scan_v1"}


def _tsconfig_alias_targets(root: Path) -> dict[str, str]:
    """Map each tsconfig.base.json path alias to its (normalized) target path,
    stripped of the trailing ``/*`` glob. Returns ``{}`` when the file is absent
    or unparseable so callers fall back to the directory-name heuristic."""
    config = root / "tsconfig.base.json"
    if not config.exists():
        return {}
    try:
        raw = config.read_text(encoding="utf-8")
        raw = re.sub(r"//[^\n]*", "", raw)
        raw = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
        paths = (json.loads(raw).get("compilerOptions") or {}).get("paths") or {}
    except (OSError, ValueError):
        return {}
    targets: dict[str, str] = {}
    if isinstance(paths, dict):
        for alias, mapped in paths.items():
            if not isinstance(mapped, list) or not mapped:
                continue
            key = alias[:-2] if alias.endswith("/*") else alias
            target = str(mapped[0])
            target = target[:-2] if target.endswith("/*") else target
            targets[key] = _normalize_path(target)
    return targets


def _read_nx_graph(*, root: Path, graph_file: Path) -> dict[str, Any]:
    payload = json.loads(graph_file.read_text(encoding="utf-8"))
    raw_nodes = payload.get("graph", {}).get("nodes", payload.get("nodes", {}))
    raw_deps = payload.get("graph", {}).get("dependencies", payload.get("dependencies", {}))
    projects = {}
    for name, node in raw_nodes.items():
        data = node.get("data", {}) if isinstance(node, dict) else {}
        project_root = data.get("root")
        if isinstance(project_root, str) and project_root:
            projects[str(name)] = {"root": project_root.replace("\\", "/").rstrip("/")}
    if not projects:
        projects = _discover_projects(root)
    dependencies: dict[str, list[str]] = {}
    for source, edges in raw_deps.items() if isinstance(raw_deps, dict) else []:
        deps = []
        for edge in edges if isinstance(edges, list) else []:
            target = edge.get("target") if isinstance(edge, dict) else None
            if isinstance(target, str) and target in projects:
                deps.append(target)
        dependencies[str(source)] = sorted(set(deps))
    for project in projects:
        dependencies.setdefault(project, [])
    return {"projects": projects, "dependencies": dependencies, "graph_source": "nx_graph_json"}


class _ProjectTree(Protocol):
    """The read surface project discovery needs, over repo-relative paths
    (``""`` is the repository root). One discovery rule runs over the working
    tree (`_FileTree`) and over a git revision (`_ListedTree`), so the map of
    a revision is the map of the same layout checked out."""

    def child_dirs(self, rel: str) -> list[str]: ...

    def is_dir(self, rel: str) -> bool: ...

    def is_file(self, rel: str) -> bool: ...

    def read_text(self, rel: str) -> str: ...


class _FileTree:
    def __init__(self, root: Path) -> None:
        self._root = root

    def child_dirs(self, rel: str) -> list[str]:
        base = self._root / rel
        if not base.is_dir():
            return []
        return sorted(child.relative_to(self._root).as_posix() for child in base.iterdir() if child.is_dir())

    def is_dir(self, rel: str) -> bool:
        return (self._root / rel).is_dir()

    def is_file(self, rel: str) -> bool:
        return (self._root / rel).is_file()

    def read_text(self, rel: str) -> str:
        return (self._root / rel).read_text(encoding="utf-8")


class _ListedTree:
    """A tree known by its file listing (``git ls-tree -r --name-only``) and a
    reader for one file's text at the same revision."""

    def __init__(self, files: Iterable[str], read_text: Callable[[str], str]) -> None:
        self._files: set[str] = set()
        self._children: dict[str, set[str]] = {}
        for path in files:
            parts = [part for part in path.split("/") if part]
            if not parts:
                continue
            self._files.add("/".join(parts))
            for depth in range(1, len(parts)):
                parent = "/".join(parts[: depth - 1])
                self._children.setdefault(parent, set()).add("/".join(parts[:depth]))
        self._read_text = read_text

    def child_dirs(self, rel: str) -> list[str]:
        return sorted(self._children.get(rel, set()))

    def is_dir(self, rel: str) -> bool:
        return rel in self._children

    def is_file(self, rel: str) -> bool:
        return rel in self._files

    def read_text(self, rel: str) -> str:
        return self._read_text(rel)


# The conventional project families: (parent, name for a root that declares no
# ``project.json`` name). Single roots are their own parent's one child.
_CONVENTIONAL_FAMILIES: tuple[tuple[str, Callable[[str], str]], ...] = (
    ("apps", lambda child: child),
    ("libs", lambda child: child),
    ("platform/libs", lambda child: f"platform-{child}"),
    ("web/modules", lambda child: f"web-{child}"),
)
_CONVENTIONAL_ROOTS: tuple[tuple[str, str], ...] = (
    ("web/shared-ui", "web-shared-ui"),
    ("web/shell", "web-shell"),
)


def _discover_projects(root: Path) -> dict[str, dict[str, str]]:
    """Every project in the working tree at ``root`` (`_discover`)."""
    return _discover(_FileTree(root))


def project_roots_of_listed_tree(
    files: Iterable[str], read_text: Callable[[str], str]
) -> dict[str, str]:
    """The ``project_roots`` map of a tree given by its file listing — a git
    revision the caller lists and reads (``branch_update_lineage`` maps main's
    tree, not the checkout, so a branch cannot rename its way out of the
    quarantine policy). The same discovery as the working tree's map; there is
    no second rule for "which project owns this path" at a revision.
    """
    return {name: meta["root"] for name, meta in _discover(_ListedTree(files, read_text)).items()}


def _discover(tree: _ProjectTree) -> dict[str, dict[str, str]]:
    """Every project in the repository, by convention first and marker second.

    Conventional roots (``apps/*``, ``libs/*``, ``platform/libs/*``,
    ``web/modules/*``, ``web/shared-ui``, ``web/shell``) are named by their
    ``project.json`` ``name`` — nx's identity, the one the finding dimension
    adopts (owner decision Q9) and the name the TypeScript code-fact side
    (`tools/gates/event-consumer-index.ts` ``applicationNames``) files event
    sites under. Only a conventional root that declares no name falls back to
    the layout name (``platform-<dir>``, ``web-<dir>``, the directory).

    SE-1 round 2 (review-r1 B3). Round 1 named only ``apps/*`` by
    ``project.json``; 18 of the repository's 59 ``project.json``-bearing roots
    (``platform/libs/event-bus`` as ``platform-event-bus``, every web module,
    ``libs/farm-shared`` as ``farm-shared``) were stamped ``nx_project/v1``
    under names nx does not know, and the quarantine policy's
    ``knownUnstableProjects`` (nx names) could not match them.

    The marker sweep runs after the convention and only ADDS: a name already
    taken is never reassigned and a directory inside a known project is never
    a second project.
    """
    projects: dict[str, dict[str, str]] = {}
    for parent, layout_name in _CONVENTIONAL_FAMILIES:
        for child in tree.child_dirs(parent):
            name = _declared_project_name(tree, child) or layout_name(child.rsplit("/", 1)[-1])
            projects[name] = {"root": child}
    for rel, layout_name in _CONVENTIONAL_ROOTS:
        if tree.is_dir(rel):
            projects[_declared_project_name(tree, rel) or layout_name] = {"root": rel}
    _add_marker_projects(tree, projects)
    return projects


def _add_marker_projects(tree: _ProjectTree, projects: dict[str, dict[str, str]]) -> None:
    """Add the marker-bearing directories the conventional layout does not name.

    The conventional list was accurate for the repository it was written
    against and then stopped growing with it: ``crates/``, ``mcp/``,
    ``tests/``, ``tools/executors/``, ``e2e/``, ``scripts/``, the Rust edge
    gateway and ARIA's own Python kernel were all invisible to it, which made
    every path under them ``unknown_files`` and every plan touching them
    ``blocked_unknown_graph``. Discovering by marker means a project joins the
    graph when it acquires its marker, with no list to remember to edit.

    Walk order is shallow-first, which is what makes containment come out
    right: ``sens-api-gateway`` is a project and ``sens-api-gateway/fuzz`` is
    part of it, not a sibling. Two guards below enforce that, and each is
    sufficient alone (measured: removing either leaves the suite green,
    removing both turns it red) — the prune catches a nested marker reached by
    another route, the ``continue`` means it is not reached at all. The
    ``continue`` earns its place on cost, not on correctness: without it the
    walk lists the children of every project it finds.
    """
    queue: list[tuple[str, int]] = [("", 0)]
    while queue:
        rel, depth = queue.pop(0)
        if rel:
            # Already inside a known project: there is nothing nested to find.
            if _project_for_path(rel, projects) is not None:
                continue
            if any(tree.is_file(f"{rel}/{marker}") for marker in PROJECT_MARKERS):
                name = _marker_project_name(tree, rel)
                # A name already taken is never reassigned — moving a project's
                # root under a consumer's feet is worse than not adding one.
                if name and name not in projects:
                    projects[name] = {"root": rel}
                continue
        if depth >= _MARKER_SCAN_MAX_DEPTH:
            continue
        for child in tree.child_dirs(rel):
            name = child.rsplit("/", 1)[-1]
            if name in NOT_THE_REPOSITORY or name.startswith("."):
                continue
            queue.append((child, depth + 1))


def _marker_project_name(tree: _ProjectTree, rel: str) -> str:
    """The project's in-graph identity.

    ``project.json``'s ``name`` wins because nx owns that identity and enforces
    its uniqueness — inventing a second name would file one project under two
    identities in two consumers. The other markers declare PUBLISH identities
    (this repository's root crate publishes as ``suderra-agent``), which are
    not the repository's name for the directory, so those fall back to the
    repo-relative path.
    """
    return _declared_project_name(tree, rel) or rel.replace("/", "-")


def _declared_project_name(tree: _ProjectTree, rel: str) -> str | None:
    """``project.json``'s ``name`` — nx's identity for the directory — or None
    when the directory carries no ``project.json`` or the file names nothing.

    ONE rule with the TypeScript side (`event-consumer-index.ts`
    ``applicationNames``): a non-empty string ``name`` is the name exactly as
    written, and a file that cannot be read as JSON is a refusal naming the
    file. Round 1 stripped whitespace and fell back to the directory name on
    malformed JSON while TypeScript threw (review-r1 note (b)), so the two
    sides could file one application under two names.
    """
    manifest = f"{rel}/project.json"
    if not tree.is_file(manifest):
        return None
    try:
        parsed = json.loads(tree.read_text(manifest))
    except (OSError, ValueError) as exc:
        raise GovernanceError(
            f"project_manifest_unreadable:{manifest}: {type(exc).__name__}: {exc}"
        ) from exc
    declared = parsed.get("name") if isinstance(parsed, dict) else None
    return declared if isinstance(declared, str) and declared else None


def _scan_project_dependencies(
    root: Path,
    meta: dict[str, str],
    projects: dict[str, dict[str, str]],
    alias_targets: dict[str, str] | None = None,
) -> set[str]:
    project_root = root / meta["root"]
    self_project = _project_for_path(meta["root"], projects)
    deps: set[str] = set()
    for source in list(project_root.rglob("*.ts")) + list(project_root.rglob("*.tsx")):
        if any(part in ("node_modules", "dist", "build", "coverage") for part in source.parts):
            continue
        try:
            content = source.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for match in IMPORT_RE.finditer(content):
            specifier = match.group(1) or match.group(2) or ""
            project = _project_for_import(specifier, projects, alias_targets)
            if project and project != self_project:
                deps.add(project)
    return deps


def _project_for_import(
    specifier: str,
    projects: dict[str, dict[str, str]],
    alias_targets: dict[str, str] | None = None,
) -> str | None:
    # Resolve through tsconfig path aliases first (the repo's real module map) —
    # longest alias prefix wins so ``@aquaculture/backend-common/auth`` beats
    # ``@aquaculture/backend-common``.
    if alias_targets:
        for alias in sorted(alias_targets, key=len, reverse=True):
            if specifier == alias or specifier.startswith(alias + "/"):
                project = _project_for_path(alias_targets[alias], projects)
                if project:
                    return project
    # Fallback: directory-name heuristic (synthetic fixtures / no tsconfig paths).
    for project, meta in projects.items():
        root = meta["root"]
        if specifier.startswith(root) or specifier.startswith(f"@/{root}"):
            return project
        parts = root.split("/")
        if len(parts) >= 2 and specifier.startswith(f"@aqua/{parts[-1]}"):
            return project
    return None


def project_for_path(path: str, project_roots: Mapping[str, str]) -> str | None:
    """THE path -> project attribution, over the ``project_roots`` map that
    `cached_service_analysis_order` publishes: longest matching root prefix.

    The kernel's ONE service key (service-expertise plan SE-1, owner decision
    Q9). The finding dimension, the impacted set, missions and routing all
    name a project through this function, in nx project names (every root
    that carries a ``project.json`` is named by it, `_discover`). Callers get
    the map from `project_map` — fingerprint-checked, so never the names of a
    layout the tree no longer has; there is no string mapping to fall back
    on.

    It used to have a twin. ``service_dimension.service_for_path`` attributed
    findings in a vocabulary of its own (``apps/<dir>``, ``shared:<lib>``,
    ``web:<app>``): measured against this repository, 54 of 71 nx project
    names were values it could never produce, and ``libs/X`` and
    ``platform/libs/X`` collapsed into one ``shared:X``. A finding filed in
    one vocabulary and looked up in the other landed under a service no
    impacted set contains — `cycle._phase_service_mission_seed` wrote "no
    derivable evidence" about the very paths that had selected a project.
    SE-1 deleted the twin and moved every caller here; rows minted before
    that carry no ``service_vocabulary`` and are re-derived from their paths
    at read time, never string-mapped.
    """
    normalized = _normalize_path(path)
    candidates = sorted(project_roots.items(), key=lambda item: len(item[1]), reverse=True)
    for project, root in candidates:
        root = root.rstrip("/")
        if normalized == root or normalized.startswith(root + "/"):
            return project
    return None


def _project_for_path(path: str, projects: dict[str, dict[str, str]]) -> str | None:
    """The same rule over the graph's ``{name: {"root": ...}}`` shape.

    An adapter, deliberately not a second implementation: the graph builders
    carry per-project metadata, the cache publishes a flat map, and one of
    those shapes had to be the one the rule is written against.
    """
    return project_for_path(path, {name: meta["root"] for name, meta in projects.items()})


def _validation_scope(changed: list[str], downstream: list[str], unknown: list[str]) -> str:
    if unknown:
        return "blocked_unknown_graph"
    if downstream:
        return "downstream"
    if changed:
        return "direct"
    return "blocked_unknown_graph"


def normalize_paths(paths: list[str]) -> list[str]:
    """THE normalizer for changed-file paths — there is deliberately only one.

    Exported rather than private because `impact.py` used to carry a second,
    subtly different one (ORPHAN-HIGH-576): an inline `lstrip("./")` that
    strips CHARACTERS rather than a prefix, so `.github/...` became
    `github/...`. Two normalizers is one more than the number of correct
    answers to "what is a normalized path".
    """
    return [_normalize_path(path) for path in paths]


def _normalize_path(path: str) -> str:
    clean = path.replace("\\", "/").split(":", 1)[0]
    if clean.startswith("file://"):
        clean = clean.removeprefix("file://")
    return lexical_repo_path(clean).rstrip("/")

