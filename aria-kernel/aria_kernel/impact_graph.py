from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .agent_routing import load_routing_table, recommended_agents_for_project
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


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


def plan_downstream_impact(
    *,
    changed_files: list[str],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    if not changed_files or not all(isinstance(path, str) and path.strip() for path in changed_files):
        raise GovernanceError("changed_files must contain at least one path")
    root = Path(workspace_root).resolve()
    if not root.exists():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    graph = _project_graph(root=root, nx_graph_file=Path(nx_graph_file) if nx_graph_file else None)
    # FILTER BEFORE SORTING, and the order is the whole bug (ORPHAN-HIGH-575).
    #
    # This read `sorted({...})` and filtered the Nones afterwards. But
    # `_project_for_path` returns `str | None`, so a change touching one path
    # the graph can place and one it cannot handed `sorted` a set of mixed
    # types and it raised `TypeError: '<' not supported between instances of
    # 'str' and 'NoneType'`.
    #
    # The trigger is the MIXTURE, which is why both halves of the obvious test
    # matrix passed: all-code produces no None, and all-docs produces a
    # one-element set that never needs a comparison. Code plus its own review
    # document — this repository's most common commit — is what crashed.
    normalized = _normalize_paths(changed_files)
    resolved = [(path, _project_for_path(path, graph["projects"])) for path in normalized]
    changed_projects = sorted({project for _, project in resolved if project})
    unknown_files = [path for path, project in resolved if project is None]
    downstream = _reverse_closure(changed_projects, graph["dependencies"])
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "changed_files": _normalize_paths(changed_files),
        "changed_projects": changed_projects,
        "direct_projects": changed_projects,
        "downstream_projects": downstream,
        "unknown_files": unknown_files,
        "graph_source": graph["graph_source"],
        "confidence": 0.9 if graph["graph_source"] == "nx_graph_json" and not unknown_files else 0.65,
        "validation_scope": _validation_scope(changed_projects, downstream, unknown_files),
    }
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
    cycle_id: str | None = None,
    nx_graph_file: str | Path | None = None,
    changed_files: list[str] | None = None,
) -> dict[str, Any]:
    """Build the project dependency graph and return the per-service analysis
    plan: projects in topological dependency order, each annotated with its
    upstream ``depends_on`` (already-understood context) and ``dependents``
    (ripple targets). When ``changed_files`` is given, annotate how many of this
    cycle's changes landed in each project (the examination focus). Pure
    computation — no ledger write."""
    root = Path(workspace_root).resolve()
    if not root.exists():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    graph = _project_graph(root=root, nx_graph_file=Path(nx_graph_file) if nx_graph_file else None)
    plan = build_service_analysis_order(graph)
    plan["cycle_id"] = cycle_id
    plan["recorded_at"] = utc_now()
    if changed_files:
        counts: dict[str, int] = {}
        for path in _normalize_paths([p for p in changed_files if isinstance(p, str) and p.strip()]):
            project = _project_for_path(path, graph["projects"])
            if project:
                counts[project] = counts.get(project, 0) + 1
        for entry in plan["order"]:
            entry["changed_files"] = counts.get(entry["project"], 0)
        plan["changed_project_count"] = sum(1 for e in plan["order"] if e.get("changed_files"))
        # The examination subset: changed services + every downstream dependent
        # (the ripple). Empty when nothing changed.
        changed_projects = [p for p, c in counts.items() if c]
        plan["impacted_projects"] = sorted(
            set(changed_projects) | set(_reverse_closure(changed_projects, graph["dependencies"]))
        )
    return plan


def _graph_fingerprint(root: Path) -> str:
    """A cheap fingerprint of the project dependency graph's INPUTS (project dir
    layout + the tsconfig alias SSoT) — does NOT read any ``*.ts`` file, so it is
    fast enough to compute every cycle to decide whether the cached order is
    still valid. The order only changes when projects are added/removed or the
    tsconfig path aliases change; both are captured here."""
    roots = sorted(meta["root"] for meta in _discover_projects(root).values())
    tsconfig = root / "tsconfig.base.json"
    ts = tsconfig.read_text(encoding="utf-8") if tsconfig.exists() else ""
    digest = hashlib.sha256()
    digest.update("\0".join(roots).encode("utf-8"))
    digest.update(b"\0")
    digest.update(ts.encode("utf-8"))
    return digest.hexdigest()


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
    cache_file = ensure_tools_dir(base_dir) / "impact" / "service-order-cache.json"
    fingerprint = _graph_fingerprint(root)
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and cached.get("graph_fingerprint") == fingerprint:
                return cached
        except (OSError, ValueError):
            pass
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


def cycle_service_examination(
    *,
    workspace_root: str | Path,
    changed_files: list[str],
    pressures: list[dict[str, Any]] | None = None,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    """This cycle's per-service examination plan: the changed services + their
    downstream ripple, presented in DEPENDENCY (topological) order so the
    examination stage walks upstream-before-downstream. When ``pressures`` is
    given, each pressure is scoped to the service(s) its evidence touches and
    grouped per-service in the same dependency order (``per_service_pressures``);
    pressures whose evidence maps to no project fall under ``global_pressures``.
    Uses the cached order (no re-scan when the graph is unchanged)."""
    cache = cached_service_analysis_order(
        workspace_root=workspace_root, base_dir=base_dir, nx_graph_file=nx_graph_file
    )
    projects = {name: {"root": r} for name, r in cache["project_roots"].items()}
    counts: dict[str, int] = {}
    for path in _normalize_paths([p for p in (changed_files or []) if isinstance(p, str) and p.strip()]):
        project = _project_for_path(path, projects)
        if project:
            counts[project] = counts.get(project, 0) + 1
    changed_projects = sorted(p for p, c in counts.items() if c)
    impacted = sorted(set(changed_projects) | set(_reverse_closure(changed_projects, cache["dependencies"])))
    impacted_set = set(impacted)
    examination_order = [
        {
            "project": e["project"],
            "layer": e["layer"],
            "depends_on": e["depends_on"],
            "dependents": e["dependents"],
            "changed_files": counts.get(e["project"], 0),
            "reason": "changed" if counts.get(e["project"]) else "downstream_impact",
        }
        for e in cache["order"]  # already topological → examine upstream first
        if e["project"] in impacted_set
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
            {_project_for_path(path, projects) for path in _normalize_paths(evidence)} - {None}
        )
        summary = {
            "pressure_id": pressure.get("pressure_id"),
            "source": pressure.get("source"),
            "severity": pressure.get("severity"),
            "affected_services": services,
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
    return {
        "schema_version": 1,
        "graph_source": cache["graph_source"],
        "changed_projects": changed_projects,
        "impacted_projects": impacted,
        "examination_order": examination_order,
        "agent_coverage_gaps": agent_coverage_gaps,
        "per_service_pressures": per_service_pressures,
        "global_pressures": global_pressures,
        "project_count": cache["project_count"],
        "layer_count": cache["layer_count"],
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


def _discover_projects(root: Path) -> dict[str, dict[str, str]]:
    """Every project in the repository, by convention first and marker second.

    The conventional layout runs first because the names it produces are what
    agent routing, the validation matrix and the twin already key on; the
    marker sweep is strictly ADDITIVE on top of it, so no existing project can
    be renamed or re-rooted by a marker appearing next to it.
    """
    projects: dict[str, dict[str, str]] = {}
    for parent in ("apps", "libs"):
        for child in _children(root / parent):
            projects[child.name] = {"root": child.relative_to(root).as_posix()}
    for child in _children(root / "platform" / "libs"):
        projects[f"platform-{child.name}"] = {"root": child.relative_to(root).as_posix()}
    for child in _children(root / "web" / "modules"):
        projects[f"web-{child.name}"] = {"root": child.relative_to(root).as_posix()}
    shared = root / "web" / "shared-ui"
    if shared.exists():
        projects["web-shared-ui"] = {"root": shared.relative_to(root).as_posix()}
    shell = root / "web" / "shell"
    if shell.exists():
        projects["web-shell"] = {"root": shell.relative_to(root).as_posix()}
    _add_marker_projects(root, projects)
    return projects


def _add_marker_projects(root: Path, projects: dict[str, dict[str, str]]) -> None:
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
    queue: list[tuple[Path, int]] = [(root, 0)]
    while queue:
        directory, depth = queue.pop(0)
        if directory != root:
            rel = directory.relative_to(root).as_posix()
            # Already inside a known project: there is nothing nested to find.
            if _project_for_path(rel, projects) is not None:
                continue
            if any((directory / marker).is_file() for marker in PROJECT_MARKERS):
                name = _marker_project_name(directory, rel)
                # A name already taken is never reassigned — moving a project's
                # root under a consumer's feet is worse than not adding one.
                if name and name not in projects:
                    projects[name] = {"root": rel}
                continue
        if depth >= _MARKER_SCAN_MAX_DEPTH:
            continue
        for child in _children(directory):
            if child.name in NOT_THE_REPOSITORY or child.name.startswith("."):
                continue
            queue.append((child, depth + 1))


def _marker_project_name(directory: Path, rel: str) -> str:
    """The project's in-graph identity.

    ``project.json``'s ``name`` wins because nx owns that identity and enforces
    its uniqueness — inventing a second name would file one project under two
    identities in two consumers. The other markers declare PUBLISH identities
    (this repository's root crate publishes as ``suderra-agent``), which are
    not the repository's name for the directory, so those fall back to the
    repo-relative path.
    """
    manifest = directory / "project.json"
    if manifest.is_file():
        try:
            declared = json.loads(manifest.read_text(encoding="utf-8")).get("name")
        except (OSError, ValueError):
            declared = None
        if isinstance(declared, str) and declared.strip():
            return declared.strip()
    return rel.replace("/", "-")


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


def _project_for_path(path: str, projects: dict[str, dict[str, str]]) -> str | None:
    normalized = _normalize_path(path)
    candidates = sorted(projects.items(), key=lambda item: len(item[1]["root"]), reverse=True)
    for project, meta in candidates:
        root = meta["root"].rstrip("/")
        if normalized == root or normalized.startswith(root + "/"):
            return project
    return None


def _reverse_closure(projects: list[str], dependencies: dict[str, list[str]]) -> list[str]:
    reverse: dict[str, set[str]] = {}
    for source, deps in dependencies.items():
        for dep in deps:
            reverse.setdefault(dep, set()).add(source)
    seen: set[str] = set(projects)
    queue = list(projects)
    downstream: set[str] = set()
    while queue:
        current = queue.pop(0)
        for consumer in sorted(reverse.get(current, set())):
            if consumer not in seen:
                seen.add(consumer)
                downstream.add(consumer)
                queue.append(consumer)
    return sorted(downstream)


def _validation_scope(changed: list[str], downstream: list[str], unknown: list[str]) -> str:
    if unknown:
        return "blocked_unknown_graph"
    if downstream:
        return "downstream"
    if changed:
        return "direct"
    return "blocked_unknown_graph"


def _normalize_paths(paths: list[str]) -> list[str]:
    return [_normalize_path(path) for path in paths]


def _normalize_path(path: str) -> str:
    clean = path.replace("\\", "/").split(":", 1)[0]
    if clean.startswith("file://"):
        clean = clean.removeprefix("file://")
    clean = clean.removeprefix("./").rstrip("/")
    return clean


def _children(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted(child for child in path.iterdir() if child.is_dir())
