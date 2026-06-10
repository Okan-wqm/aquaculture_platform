from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


IMPORT_RE = re.compile(r"""from\s+['"]([^'"]+)['"]|import\s+[^'"]*['"]([^'"]+)['"]""")


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
    changed = sorted({_project_for_path(path, graph["projects"]) for path in _normalize_paths(changed_files)})
    changed_projects = [project for project in changed if project]
    unknown_files = [path for path in _normalize_paths(changed_files) if _project_for_path(path, graph["projects"]) is None]
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


def _project_graph(*, root: Path, nx_graph_file: Path | None) -> dict[str, Any]:
    if nx_graph_file and nx_graph_file.exists():
        return _read_nx_graph(root=root, graph_file=nx_graph_file)
    projects = _discover_projects(root)
    dependencies = {name: sorted(_scan_project_dependencies(root, meta, projects)) for name, meta in projects.items()}
    return {"projects": projects, "dependencies": dependencies, "graph_source": "local_import_scan_v1"}


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
    return projects


def _scan_project_dependencies(root: Path, meta: dict[str, str], projects: dict[str, dict[str, str]]) -> set[str]:
    project_root = root / meta["root"]
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
            project = _project_for_import(specifier, projects)
            if project:
                deps.add(project)
    return deps


def _project_for_import(specifier: str, projects: dict[str, dict[str, str]]) -> str | None:
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
