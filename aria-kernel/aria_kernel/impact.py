from __future__ import annotations

from pathlib import Path
from typing import Any

from .impact_graph import normalize_paths as _normalize_paths, plan_downstream_impact
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


def plan_impact(
    *,
    changed_files: list[str],
    action_class: str,
    workspace_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    nx_graph_file: str | Path | None = None,
) -> dict[str, Any]:
    if not changed_files or not all(isinstance(item, str) and item.strip() for item in changed_files):
        raise GovernanceError("changed_files must contain at least one path")
    # ONE normalizer, not two (ORPHAN-HIGH-576).
    #
    # This used to be an inline `item.replace("\\", "/").lstrip("./")`, a second
    # answer to "what is a normalized path" that disagreed with
    # `impact_graph._normalize_paths`. `lstrip` strips CHARACTERS, not a
    # prefix, so every dotfile directory was mangled: `.github/workflows/x.yml`
    # became `github/workflows/x.yml` and `.claude/agents/x.md` became
    # `claude/agents/x.md`. Those mangled paths were then written to the
    # impact-plans ledger as the record of what a change touched, and no
    # project root begins with `github/`, so the mangling also guaranteed the
    # path could never be placed.
    #
    # Calling the graph's normalizer means there is no second normalizer left
    # to drift from the first.
    normalized = _normalize_paths(list(changed_files))
    graph = None
    if workspace_root is not None:
        graph = plan_downstream_impact(
            changed_files=normalized,
            workspace_root=workspace_root,
            base_dir=base_dir,
            cycle_id=cycle_id,
            nx_graph_file=nx_graph_file,
        )
    risk_class = _risk_class(normalized, action_class)
    validations = _validation_commands(risk_class, normalized, graph)
    blocked_by = [] if risk_class not in ("unknown", "forbidden") else ["operator_scope_decision_required"]
    if graph and graph.get("validation_scope") == "blocked_unknown_graph":
        blocked_by = sorted(set(blocked_by + ["impact_graph_unknown"]))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "action_class": action_class,
        "changed_files": normalized,
        "risk_class": risk_class,
        "validation_commands": validations,
        "blocked_by": blocked_by,
        "affected_projects_hint": _affected_projects_hint(normalized),
        "impact_graph_ref": graph.get("ledger_hash") if graph else None,
        "direct_projects": graph.get("direct_projects", []) if graph else [],
        "downstream_projects": graph.get("downstream_projects", []) if graph else [],
        "graph_confidence": graph.get("confidence") if graph else None,
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "impact" / "impact-plans.jsonl",
        row,
        expected_surface="impact_plans",
    )


def list_impact_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "impact" / "impact-plans.jsonl",
        expected_surface="impact_plans",
    )


def _risk_class(paths: list[str], action_class: str) -> str:
    if any(_matches(path, ("infra/", "docker/", ".github/workflows/")) for path in paths):
        return "forbidden"
    if any("/migrations/" in path or "Migration" in path for path in paths):
        return "migration"
    if any(_matches(path, ("apps/", "libs/", "platform/libs/", "web/")) and "/src/" in path for path in paths):
        if any(token in path.lower() for path in paths for token in ("auth", "tenant", "security", "billing")):
            return "auth_tenant_data"
        return "runtime"
    if all(path.endswith(".md") or path.startswith("docs/") for path in paths):
        return "docs_only"
    if action_class in ("formatting_only", "documentation_update"):
        return "low"
    return "unknown"


def _validation_commands(risk_class: str, paths: list[str], graph: dict[str, Any] | None = None) -> list[str]:
    if risk_class == "docs_only":
        return ["npm run gates:banned-phrase"]
    if risk_class == "migration":
        return ["npm run gates:migration-sql", "npm run invariants:fast", "npm run type-check"]
    if risk_class == "auth_tenant_data":
        return ["npm run test", "npm run lint", "npm run type-check", "npm run invariants:full"]
    if risk_class == "runtime":
        if graph and graph.get("validation_scope") == "downstream":
            projects = graph.get("direct_projects", []) + graph.get("downstream_projects", [])
            return [
                f"npx nx run-many --target=test --projects={','.join(sorted(set(projects)))}",
                f"npx nx run-many --target=lint --projects={','.join(sorted(set(projects)))}",
                "npm run type-check",
            ]
        return ["npm run test", "npm run lint", "npm run build", "npm run type-check"]
    if risk_class == "low":
        return ["npm run format:check", "npm run gates:all"]
    return ["npm run test", "npm run lint", "npm run build", "npm run type-check"]


def _affected_projects_hint(paths: list[str]) -> list[str]:
    projects = []
    for path in paths:
        parts = path.split("/")
        if len(parts) >= 2 and parts[0] in ("apps", "libs"):
            projects.append(parts[1])
        elif len(parts) >= 3 and parts[0] == "web" and parts[1] == "modules":
            projects.append(parts[2])
        elif len(parts) >= 2 and parts[0] == "web":
            projects.append(parts[1])
        elif len(parts) >= 3 and parts[0] == "platform" and parts[1] == "libs":
            projects.append(parts[2])
    return sorted(set(projects))


def _matches(path: str, prefixes: tuple[str, ...]) -> bool:
    return any(path.startswith(prefix) for prefix in prefixes)
