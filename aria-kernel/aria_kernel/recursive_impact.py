"""Recursive impact graph (Plan 016 Faz D1).

Walks six structural sources to compute the set of files/projects an
intended change touches transitively. Each source emits ImpactEntry
records with `status ∈ {known, unknown, explicitly_blocked}` so the
convergent gate's dispatch rule (any `unknown` blocks dispatch unless
overridden) can act on the result without re-walking the repo.

The six sources (Plan 016 §Recursive impact and freshness gates):
1. **nx_graph** — Nx graph JSON (`npx nx graph --file=...`). Captures
   project-to-project dependencies.
2. **import_graph** — Local Python / TypeScript import graph. Direct
   imports of changed files identify the smallest transitive set.
3. **event_contract** — `libs/event-contracts/src/**/*.ts` producer /
   consumer mapping for the events the change publishes or consumes.
4. **graphql_api** — GraphQL codegen output for resolver / consumer
   relationships.
5. **db_entity** — TypeORM `@Entity` decorations whose schema or
   columns intersect changed migration files.
6. **frontend_module** — Module-federation `module-federation.config.ts`
   exports / consumers.

Sources 3–6 ship with explicit `status: "unknown"` stubs that name
WHAT they would have inspected. The framework lets each source be
filled in independently without changing call sites; until then, the
operator sees an `unknown` entry per source and the convergent gate
demands an explicit operator override before dispatch.
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

from .ledger import append_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


IMPACT_STATUSES = ("known", "unknown", "explicitly_blocked")
IMPACT_SOURCES = (
    "nx_graph",
    "import_graph",
    "event_contract",
    "graphql_api",
    "db_entity",
    "frontend_module",
)
DEFAULT_MAX_DEPTH = 5


@dataclass(frozen=True)
class ImpactEntry:
    path: str
    project: str | None
    relationship: str
    status: str
    source: str
    block_reason: str | None = None
    operator_approval_ref: str | None = None
    validation_scope: tuple[str, ...] = field(default_factory=tuple)
    depth: int = 0


# --------------------------- source: nx_graph ---------------------------

def _project_for_path(workspace_root: Path, path: str) -> str | None:
    """Best-effort: derive Nx project name from the path's first two segments.

    Examples:
        apps/foo-service/src/x.ts -> "foo-service"
        libs/foo/src/x.ts        -> "foo"
        web/modules/dashboard/x.ts -> "dashboard"
    """
    parts = path.replace("\\", "/").split("/")
    if len(parts) < 2:
        return None
    if parts[0] in {"apps", "libs"} and len(parts) >= 2:
        return parts[1]
    if parts[0] == "web" and len(parts) >= 3:
        return parts[2]
    if parts[0] == "platform" and "libs" in parts and parts.index("libs") + 1 < len(parts):
        return parts[parts.index("libs") + 1]
    return None


def _nx_graph_source(
    intended_files: list[str],
    workspace_root: Path,
) -> list[ImpactEntry]:
    """Resolve Nx-level downstream projects for each intended file.

    Best-effort: invokes `npx nx graph --file=<json>` once and traverses
    the dependency map. Network-less / npm-less environments produce a
    single `unknown` entry per intended file rather than crashing.
    """
    intended_projects = {
        proj for path in intended_files
        if (proj := _project_for_path(workspace_root, path)) is not None
    }
    if not intended_projects:
        return []

    # Try to read a pre-computed graph from the conventional path first
    # (cheap, deterministic). Fall back to invoking npx only when missing.
    graph_path = workspace_root / ".nx" / "cache" / "graph.json"
    payload: dict[str, Any] | None = None
    if graph_path.exists():
        try:
            payload = json.loads(graph_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = None

    if payload is None:
        try:
            tmp = workspace_root / ".aria-poc" / "nx-graph.json"
            tmp.parent.mkdir(parents=True, exist_ok=True)
            proc = subprocess.run(
                ["npx", "nx", "graph", f"--file={tmp.as_posix()}"],
                cwd=str(workspace_root),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if proc.returncode == 0 and tmp.exists():
                payload = json.loads(tmp.read_text(encoding="utf-8"))
        except (subprocess.TimeoutExpired, subprocess.SubprocessError, json.JSONDecodeError):
            payload = None

    if payload is None:
        return [
            ImpactEntry(
                path=str(workspace_root / "package.json"),
                project=proj,
                relationship="depends_on",
                status="unknown",
                source="nx_graph",
                block_reason="nx graph unreachable (cache missing and `npx nx graph` failed)",
                validation_scope=(f"nx affected --target=test --base=HEAD~1 -- {proj}",),
            )
            for proj in sorted(intended_projects)
        ]

    deps_map = payload.get("graph", {}).get("dependencies", {}) or payload.get("dependencies", {})
    if not isinstance(deps_map, dict):
        return []

    entries: list[ImpactEntry] = []
    seen_pairs: set[tuple[str, str]] = set()
    for source_proj in intended_projects:
        for target_proj, edges in deps_map.items():
            if not isinstance(edges, list):
                continue
            for edge in edges:
                edge_target = (
                    edge.get("target") if isinstance(edge, dict) else None
                )
                if edge_target == source_proj:
                    pair = (source_proj, target_proj)
                    if pair in seen_pairs:
                        continue
                    seen_pairs.add(pair)
                    entries.append(
                        ImpactEntry(
                            path=f"<project:{target_proj}>",
                            project=target_proj,
                            relationship=f"depends_on:{source_proj}",
                            status="known",
                            source="nx_graph",
                            validation_scope=(f"nx test {target_proj}",),
                        )
                    )
    return entries


# --------------------------- source: import_graph ---------------------------

# Import-line regex shared between TS / JS / Python heuristics. Catches the
# common ES-module + CommonJS + Python forms.
_TS_IMPORT_RE = re.compile(
    r"""(?x)
    (?:
        ^\s*import\s+(?:[^'"]*?\s+from\s+)?["'](?P<spec1>[^"']+)["']  # import x from 'y'
      | ^\s*export\s+(?:\*\s+)?from\s+["'](?P<spec2>[^"']+)["']        # export * from 'y'
      | require\(\s*["'](?P<spec3>[^"']+)["']\s*\)                       # require('y')
    )
    """,
    re.MULTILINE,
)
_PY_IMPORT_RE = re.compile(
    r"""(?x)
    ^\s*
    (?:
        from\s+(?P<from>[\w.]+)\s+import
      | import\s+(?P<imp>[\w.]+)
    )
    """,
    re.MULTILINE,
)


def _import_graph_source(
    intended_files: list[str],
    workspace_root: Path,
) -> list[ImpactEntry]:
    """Naive direct-importer scan: for each intended file under apps/libs/web,
    grep the workspace for files that import its module path. Limited to
    one hop — recursion is performed by the caller's transitive walker.
    """
    entries: list[ImpactEntry] = []
    seen_paths: set[str] = set()
    for intended in intended_files:
        rel = intended.replace("\\", "/")
        # Build search needles: bare name + with/without extension.
        stem = Path(rel).stem
        if not stem or stem.startswith("."):
            continue
        search_paths = (
            workspace_root / "apps",
            workspace_root / "libs",
            workspace_root / "web",
            workspace_root / "platform",
        )
        for root in search_paths:
            if not root.exists():
                continue
            for ext in ("ts", "tsx", "js", "py"):
                # Use rg/grep when available — cheap; fall back to walk + read.
                try:
                    proc = subprocess.run(
                        ["grep", "-rln", "--include", f"*.{ext}", stem, str(root)],
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                    hits = proc.stdout.splitlines() if proc.returncode == 0 else []
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    hits = []
                for hit in hits:
                    # Skip the intended file itself.
                    if hit.endswith(rel) or hit == rel:
                        continue
                    rel_hit = (
                        Path(hit).resolve().relative_to(workspace_root).as_posix()
                        if Path(hit).is_absolute()
                        else hit
                    )
                    if rel_hit in seen_paths:
                        continue
                    seen_paths.add(rel_hit)
                    entries.append(
                        ImpactEntry(
                            path=rel_hit,
                            project=_project_for_path(workspace_root, rel_hit),
                            relationship=f"imports:{stem}",
                            status="known",
                            source="import_graph",
                            depth=1,
                        )
                    )
    return entries


# --------------------------- sources 3–6: explicit stubs ---------------------------

def _make_stub_source(name: str, surface_hint: str) -> Callable[[list[str], Path], list[ImpactEntry]]:
    """Return a stub source that emits a single `unknown` entry naming the
    surface it would have inspected. Operator must override or implement
    the source before the convergent gate accepts the impact graph.
    """
    def _stub(intended_files: list[str], workspace_root: Path) -> list[ImpactEntry]:
        if not intended_files:
            return []
        return [
            ImpactEntry(
                path=surface_hint,
                project=None,
                relationship=f"{name}_uninspected",
                status="unknown",
                source=name,
                block_reason=(
                    f"{name} source not yet implemented; convergent gate must "
                    f"either bind an implementer or apply an explicit_blocked "
                    f"operator override scoped outside the intended change."
                ),
                validation_scope=(),
            )
        ]
    return _stub


# Plan 017 Phase 5.2 — real event_contract source (partial DEBT-2026-05-07-002 closure).
# Scans changed event-contract files for `export interface XEvent extends BaseEvent`
# declarations, then greps the workspace for consumers (files that import or
# reference the event name). Emits known-status entries per consumer + a
# defines-status entry for the source file itself. Files outside
# libs/event-contracts/src/**/*.ts are skipped — the source remains a no-op
# for non-event changes (no spurious unknown entries).

_EVENT_INTERFACE_RE = re.compile(
    r"export\s+interface\s+(\w+Event)\s+extends\s+BaseEvent",
)


def _event_contract_source(
    intended_files: list[str],
    workspace_root: Path,
) -> list[ImpactEntry]:
    contract_files = [
        f for f in intended_files
        if f.replace("\\", "/").startswith("libs/event-contracts/src/") and f.endswith(".ts")
    ]
    if not contract_files:
        return []

    entries: list[ImpactEntry] = []
    seen_paths: set[str] = set()
    for contract in contract_files:
        contract_abs = workspace_root / contract
        try:
            content = contract_abs.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            entries.append(
                ImpactEntry(
                    path=contract,
                    project="event-contracts",
                    relationship="event_contract_unreadable",
                    status="unknown",
                    source="event_contract",
                    block_reason="contract file could not be read at the workspace SHA",
                    validation_scope=(),
                )
            )
            continue
        event_names = sorted({m.group(1) for m in _EVENT_INTERFACE_RE.finditer(content)})
        if not event_names:
            entries.append(
                ImpactEntry(
                    path=contract,
                    project="event-contracts",
                    relationship="event_contract_no_event_interfaces",
                    status="known",
                    source="event_contract",
                    validation_scope=("nx affected --target=test --base=HEAD~1",),
                )
            )
            continue

        # The source file itself is a known impact entry.
        entries.append(
            ImpactEntry(
                path=contract,
                project="event-contracts",
                relationship=f"defines:{','.join(event_names)}",
                status="known",
                source="event_contract",
                validation_scope=("nx test event-contracts",),
            )
        )

        # Consumer scan: grep each event name across the workspace.
        # Existing search roots are filtered to those that exist so grep
        # exits cleanly (returncode 0 with hits, 1 with no hits). When
        # mixed-existence search roots are passed grep exits 2, and
        # parsing the partial stdout matters — we accept any returncode
        # that produced output rather than gating on returncode==0.
        search_roots = [
            workspace_root / sub
            for sub in ("apps", "libs", "web", "platform")
            if (workspace_root / sub).exists()
        ]
        for event_name in event_names:
            if not search_roots:
                break
            try:
                proc = subprocess.run(
                    [
                        "grep", "-rln",
                        "--include", "*.ts",
                        "--include", "*.tsx",
                        "--exclude-dir", "node_modules",
                        "--exclude-dir", ".git",
                        "--exclude-dir", "dist",
                        "--exclude-dir", "aria-tools",
                        event_name,
                        *(str(p) for p in search_roots),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                # grep exit codes: 0 = matches found, 1 = no matches, 2 = error.
                # Accept stdout when present regardless of returncode so partial
                # results are not silently dropped.
                hits = proc.stdout.splitlines() if proc.stdout else []
            except (subprocess.TimeoutExpired, FileNotFoundError):
                hits = []
            for hit in hits:
                rel_hit = (
                    Path(hit).resolve().relative_to(workspace_root).as_posix()
                    if Path(hit).is_absolute() else hit
                )
                if rel_hit == contract or rel_hit in seen_paths:
                    continue
                seen_paths.add(rel_hit)
                entries.append(
                    ImpactEntry(
                        path=rel_hit,
                        project=_project_for_path(workspace_root, rel_hit),
                        relationship=f"consumes:{event_name}",
                        status="known",
                        source="event_contract",
                        depth=1,
                    )
                )
    return entries


# Plan 019 Phase 4.A — real graphql_api source (DEBT-2026-05-07-002 closure step 1).
# Scans .graphql schema files for `type Query/Mutation/Subscription { ... }`
# and `extend type X { ... }` blocks, then greps the workspace for resolver
# consumers (`@Resolver`, `@ResolveField`, `@Query`, `@Mutation` decorators).
# Files outside *.graphql / *.resolver.ts / *.subgraph.ts are skipped.

_GRAPHQL_TYPE_RE = re.compile(
    r"(?:type|extend\s+type)\s+(\w+)\s*\{",
)
_GRAPHQL_OP_FIELD_RE = re.compile(
    r"^\s*(\w+)\s*\(",  # field name with arguments — captures Query/Mutation field names
    re.MULTILINE,
)


_CODE_FIRST_GQL_DECORATOR_RE = re.compile(
    r"@(?:Resolver|Query|Mutation|Subscription|ResolveField|ObjectType|InputType|Field)\b",
)


def _graphql_api_source(
    intended_files: list[str],
    workspace_root: Path,
) -> list[ImpactEntry]:
    # Plan 019 Phase 9.5 (operator critique #7) — repo uses code-first
    # GraphQL: @Resolver/@Query/@Mutation/@ObjectType decorators on
    # plain .ts files, not .graphql schema sources. Schema-first naming
    # patterns (.graphql, .resolver.ts, .subgraph.ts, /codegen/) are
    # preserved for backward-compat but the primary detection path is
    # decorator-based via _CODE_FIRST_GQL_DECORATOR_RE on apps/**/*.ts.
    def _is_relevant(path_str: str) -> bool:
        normalized = path_str.replace("\\", "/")
        if (path_str.endswith(".graphql")
                or path_str.endswith(".resolver.ts")
                or path_str.endswith(".subgraph.ts")
                or "/codegen/" in normalized):
            return True
        # Code-first: any apps/**/*.ts that carries a GraphQL decorator.
        if (normalized.startswith("apps/") and normalized.endswith(".ts")
                and not normalized.endswith(".spec.ts")):
            try:
                content = (workspace_root / path_str).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                return False
            return bool(_CODE_FIRST_GQL_DECORATOR_RE.search(content))
        return False

    relevant = [f for f in intended_files if _is_relevant(f)]
    if not relevant:
        return []

    entries: list[ImpactEntry] = []
    seen_paths: set[str] = set()

    for source_file in relevant:
        abs_path = workspace_root / source_file
        try:
            content = abs_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="graphql_api_unreadable",
                    status="unknown",
                    source="graphql_api",
                    block_reason="GraphQL source file could not be read at workspace SHA",
                    validation_scope=(),
                )
            )
            continue

        type_names = sorted({m.group(1) for m in _GRAPHQL_TYPE_RE.finditer(content)})
        if not type_names:
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="graphql_api_no_types_declared",
                    status="known",
                    source="graphql_api",
                    validation_scope=("nx affected --target=test --base=HEAD~1",),
                )
            )
            continue

        entries.append(
            ImpactEntry(
                path=source_file,
                project=_project_for_path(workspace_root, source_file),
                relationship=f"defines:{','.join(type_names)}",
                status="known",
                source="graphql_api",
                validation_scope=("nx test gateway-api",),
            )
        )

        # Consumer scan: grep each type name in resolver + frontend code.
        search_roots = [
            workspace_root / sub
            for sub in ("apps", "libs", "web", "platform")
            if (workspace_root / sub).exists()
        ]
        for type_name in type_names:
            if not search_roots:
                break
            try:
                proc = subprocess.run(
                    [
                        "grep", "-rln",
                        "--include", "*.ts",
                        "--include", "*.tsx",
                        "--include", "*.graphql",
                        "--exclude-dir", "node_modules",
                        "--exclude-dir", ".git",
                        "--exclude-dir", "dist",
                        "--exclude-dir", "aria-tools",
                        type_name,
                        *(str(p) for p in search_roots),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                hits = proc.stdout.splitlines() if proc.stdout else []
            except (subprocess.TimeoutExpired, FileNotFoundError):
                hits = []
            for hit in hits:
                rel_hit = (
                    Path(hit).resolve().relative_to(workspace_root).as_posix()
                    if Path(hit).is_absolute() else hit
                )
                if rel_hit == source_file or rel_hit in seen_paths:
                    continue
                seen_paths.add(rel_hit)
                entries.append(
                    ImpactEntry(
                        path=rel_hit,
                        project=_project_for_path(workspace_root, rel_hit),
                        relationship=f"consumes:{type_name}",
                        status="known",
                        source="graphql_api",
                        depth=1,
                    )
                )
    return entries


# Plan 019 Phase 4.B — real db_entity source (DEBT-2026-05-07-002 closure step 2).
# Scans TypeORM `*.entity.ts` files for `@Entity('table', { schema: '<svc>' })`
# decorators, then greps cross-entity references (`@ManyToOne(() => Foo)`,
# `@OneToMany`, `@JoinColumn`) plus migration files that touch the same table.
# ADR-011 invariant: every @Entity must declare schema; missing schema is
# emitted as an `unknown` entry the convergent gate fails closed on.

_TYPEORM_ENTITY_RE = re.compile(
    r"@Entity\s*\(\s*['\"](?P<table>\w+)['\"](?:\s*,\s*\{\s*schema:\s*['\"](?P<schema>\w+)['\"])?",
)
_TYPEORM_RELATION_RE = re.compile(
    r"@(?:ManyToOne|OneToMany|ManyToMany|OneToOne)\s*\(\s*\(?\s*\)?\s*=>\s*(\w+)",
)


def _db_entity_source(
    intended_files: list[str],
    workspace_root: Path,
) -> list[ImpactEntry]:
    relevant = [
        f for f in intended_files
        if (f.endswith(".entity.ts")
            or "/migrations/" in f.replace("\\", "/"))
    ]
    if not relevant:
        return []

    entries: list[ImpactEntry] = []
    seen_paths: set[str] = set()

    for source_file in relevant:
        abs_path = workspace_root / source_file
        try:
            content = abs_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="db_entity_unreadable",
                    status="unknown",
                    source="db_entity",
                    block_reason="entity/migration file could not be read at workspace SHA",
                    validation_scope=(),
                )
            )
            continue

        # Migration files: extract referenced tables + emit consumes
        # entries for entities that reference those tables. We don't try
        # to fully parse SQL — a substring match on table names is enough
        # to surface the impact graph.
        if "/migrations/" in source_file.replace("\\", "/"):
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="defines:migration",
                    status="known",
                    source="db_entity",
                    validation_scope=("nx test schema-invariants",),
                )
            )
            continue

        # Entity files: enforce ADR-011 (schema declared) + cross-link
        match = _TYPEORM_ENTITY_RE.search(content)
        if not match:
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="db_entity_no_decorator",
                    status="known",
                    source="db_entity",
                    validation_scope=(),
                )
            )
            continue

        table = match.group("table")
        schema = match.group("schema")
        if not schema:
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship=f"defines:{table}_missing_schema_decl",
                    status="unknown",
                    source="db_entity",
                    block_reason=(
                        "ADR-011 violation: @Entity must declare schema. "
                        "Add { schema: '<service>' } to the decorator."
                    ),
                    validation_scope=("nx test schema-invariants",),
                )
            )
            continue

        entries.append(
            ImpactEntry(
                path=source_file,
                project=_project_for_path(workspace_root, source_file),
                relationship=f"defines:{schema}.{table}",
                status="known",
                source="db_entity",
                validation_scope=(f"nx test {_project_for_path(workspace_root, source_file) or 'aria'}",),
            )
        )

        # Cross-entity scan: which other entity files reference this one
        # via @ManyToOne / @OneToMany / @ManyToMany / @OneToOne?
        # Identify the entity class name from the file path heuristic:
        # the convention is `<EntityName>.entity.ts` -> class name from
        # the @Entity decorator's class is below it; we use a quick
        # match on `^export class (\w+)` near the decorator.
        class_match = re.search(r"export\s+class\s+(\w+)", content)
        entity_class = class_match.group(1) if class_match else None
        if not entity_class:
            continue
        search_roots = [
            workspace_root / sub
            for sub in ("apps", "libs")
            if (workspace_root / sub).exists()
        ]
        if not search_roots:
            continue
        try:
            proc = subprocess.run(
                [
                    "grep", "-rln",
                    "--include", "*.entity.ts",
                    "--include", "*.repository.ts",
                    "--include", "*.service.ts",
                    "--exclude-dir", "node_modules",
                    "--exclude-dir", ".git",
                    "--exclude-dir", "dist",
                    "--exclude-dir", "aria-tools",
                    entity_class,
                    *(str(p) for p in search_roots),
                ],
                capture_output=True,
                text=True,
                timeout=20,
            )
            hits = proc.stdout.splitlines() if proc.stdout else []
        except (subprocess.TimeoutExpired, FileNotFoundError):
            hits = []
        for hit in hits:
            rel_hit = (
                Path(hit).resolve().relative_to(workspace_root).as_posix()
                if Path(hit).is_absolute() else hit
            )
            if rel_hit == source_file or rel_hit in seen_paths:
                continue
            seen_paths.add(rel_hit)
            entries.append(
                ImpactEntry(
                    path=rel_hit,
                    project=_project_for_path(workspace_root, rel_hit),
                    relationship=f"consumes:{entity_class}",
                    status="known",
                    source="db_entity",
                    depth=1,
                )
            )
    return entries


# Plan 019 Phase 4.C — real frontend_module source (DEBT-2026-05-07-002 closure step 3).
# Scans `web/**/module-federation.config.ts` for `exposes` + `remotes`
# graph and `web/shell/src/router/*.ts` for route mounts. Cross-modules
# that consume the same `remotes` entry are linked as consumers.

_MF_EXPOSES_RE = re.compile(
    r"exposes\s*:\s*\{([^}]*)\}",
    re.DOTALL,
)
_MF_REMOTES_RE = re.compile(
    r"remotes\s*:\s*\{([^}]*)\}",
    re.DOTALL,
)
_MF_KEY_RE = re.compile(r"['\"]([^'\"]+)['\"]\s*:")


def _frontend_module_source(
    intended_files: list[str],
    workspace_root: Path,
) -> list[ImpactEntry]:
    # Plan 019 Phase 9.5 (operator critique #7) — snowball web/ surface
    # uses vite.config.ts as primary build config; only web/shell carries
    # module-federation.config.{ts,js}. Widen detection to either
    # config family + the shell router. The same _MF_EXPOSES_RE /
    # _MF_REMOTES_RE patterns work on vite.config.ts because vite's
    # module-federation plugin uses identical exposes/remotes shape.
    def _is_relevant(path_str: str) -> bool:
        normalized = path_str.replace("\\", "/")
        if normalized.endswith("/module-federation.config.ts"):
            return True
        if normalized.endswith("/module-federation.config.js"):
            return True
        if normalized.endswith("/vite.config.ts"):
            return True
        if "/web/shell/src/router/" in normalized:
            return True
        return False

    relevant = [f for f in intended_files if _is_relevant(f)]
    if not relevant:
        return []

    entries: list[ImpactEntry] = []
    seen_paths: set[str] = set()

    for source_file in relevant:
        abs_path = workspace_root / source_file
        try:
            content = abs_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="frontend_module_unreadable",
                    status="unknown",
                    source="frontend_module",
                    block_reason="module-federation/router file could not be read at workspace SHA",
                    validation_scope=(),
                )
            )
            continue

        exposes_block = _MF_EXPOSES_RE.search(content)
        remotes_block = _MF_REMOTES_RE.search(content)
        exposed_keys = (
            sorted({m.group(1) for m in _MF_KEY_RE.finditer(exposes_block.group(1))})
            if exposes_block else []
        )
        remote_keys = (
            sorted({m.group(1) for m in _MF_KEY_RE.finditer(remotes_block.group(1))})
            if remotes_block else []
        )

        if exposed_keys:
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship=f"exposes:{','.join(exposed_keys)}",
                    status="known",
                    source="frontend_module",
                    validation_scope=("nx test shared-ui",),
                )
            )
        if remote_keys:
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship=f"consumes:{','.join(remote_keys)}",
                    status="known",
                    source="frontend_module",
                    validation_scope=(),
                )
            )
        if not exposed_keys and not remote_keys:
            entries.append(
                ImpactEntry(
                    path=source_file,
                    project=_project_for_path(workspace_root, source_file),
                    relationship="frontend_module_empty_graph",
                    status="known",
                    source="frontend_module",
                    validation_scope=(),
                )
            )
            continue

        # Cross-module consumer scan: any other module that lists this
        # module's exposed keys as their `remotes` is a downstream consumer.
        if exposed_keys:
            search_roots = [
                workspace_root / "web"
                if (workspace_root / "web").exists() else None,
            ]
            search_roots = [r for r in search_roots if r is not None]
            for exposed in exposed_keys:
                if not search_roots:
                    break
                try:
                    proc = subprocess.run(
                        [
                            "grep", "-rln",
                            "--include", "module-federation.config.ts",
                            "--include", "*.tsx",
                            "--include", "*.ts",
                            "--exclude-dir", "node_modules",
                            "--exclude-dir", ".git",
                            "--exclude-dir", "dist",
                            exposed,
                            *(str(p) for p in search_roots),
                        ],
                        capture_output=True,
                        text=True,
                        timeout=20,
                    )
                    hits = proc.stdout.splitlines() if proc.stdout else []
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    hits = []
                for hit in hits:
                    rel_hit = (
                        Path(hit).resolve().relative_to(workspace_root).as_posix()
                        if Path(hit).is_absolute() else hit
                    )
                    if rel_hit == source_file or rel_hit in seen_paths:
                        continue
                    seen_paths.add(rel_hit)
                    entries.append(
                        ImpactEntry(
                            path=rel_hit,
                            project=_project_for_path(workspace_root, rel_hit),
                            relationship=f"consumes:{exposed}",
                            status="known",
                            source="frontend_module",
                            depth=1,
                        )
                    )
    return entries


_SOURCE_TABLE: tuple[tuple[str, Callable[[list[str], Path], list[ImpactEntry]]], ...] = (
    ("nx_graph", _nx_graph_source),
    ("import_graph", _import_graph_source),
    ("event_contract", _event_contract_source),
    ("graphql_api", _graphql_api_source),
    ("db_entity", _db_entity_source),
    ("frontend_module", _frontend_module_source),
)


def compute_recursive_impact(
    *,
    intended_files: list[str],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    max_depth: int = DEFAULT_MAX_DEPTH,
) -> dict[str, Any]:
    """Walk every source and aggregate the impact entries.

    Recursion: import_graph entries with `status=known` and `depth<max_depth`
    feed back into import_graph as their own intended files. Nx-level
    project edges are inherently transitive (project graph), so we do not
    re-walk Nx beyond depth 1. Stub sources do not recurse.

    Persists the resulting graph under
    `aria-tools/impact-graphs/<intended-fingerprint>.json` and emits a
    governance event with the unknown-entry count so dashboards can
    surface it via `aria_impact_unknown_total`.
    """
    if not intended_files:
        raise GovernanceError("intended_files must not be empty")
    if max_depth < 1 or max_depth > 10:
        raise GovernanceError("max_depth must be between 1 and 10")

    repo = Path(workspace_root).resolve()
    tools_root = ensure_tools_dir(base_dir)

    aggregate: list[ImpactEntry] = []
    seen_keys: set[tuple[str, str, str]] = set()  # (path, source, relationship)
    visited_intended: set[str] = set(intended_files)
    frontier = list(intended_files)
    depth = 0
    while frontier and depth < max_depth:
        next_frontier: list[str] = []
        for source_name, source_fn in _SOURCE_TABLE:
            try:
                entries = source_fn(frontier, repo)
            except Exception as exc:  # pragma: no cover — source-specific defense
                entries = [
                    ImpactEntry(
                        path=f"<source:{source_name}>",
                        project=None,
                        relationship=f"{source_name}_error",
                        status="unknown",
                        source=source_name,
                        block_reason=f"source raised {type(exc).__name__}: {exc}",
                    )
                ]
            for entry in entries:
                # Promote depth as we recurse.
                stamped = ImpactEntry(
                    path=entry.path,
                    project=entry.project,
                    relationship=entry.relationship,
                    status=entry.status,
                    source=entry.source,
                    block_reason=entry.block_reason,
                    operator_approval_ref=entry.operator_approval_ref,
                    validation_scope=entry.validation_scope,
                    depth=max(entry.depth, depth),
                )
                key = (stamped.path, stamped.source, stamped.relationship)
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                aggregate.append(stamped)
                # Only the import_graph recurses transitively (file-to-file).
                if (
                    source_name == "import_graph"
                    and stamped.status == "known"
                    and stamped.path not in visited_intended
                    and not stamped.path.startswith("<")
                ):
                    visited_intended.add(stamped.path)
                    next_frontier.append(stamped.path)
        frontier = next_frontier
        depth += 1

    summary = {
        "entry_count": len(aggregate),
        "by_status": {
            status: sum(1 for e in aggregate if e.status == status)
            for status in IMPACT_STATUSES
        },
        "by_source": {
            source: sum(1 for e in aggregate if e.source == source)
            for source in IMPACT_SOURCES
        },
        "max_depth_reached": max((e.depth for e in aggregate), default=0),
    }

    fingerprint = _intended_fingerprint(intended_files)
    payload = {
        "schema_version": 1,
        "computed_at": utc_now(),
        "intended_files": list(intended_files),
        "intended_fingerprint": fingerprint,
        "max_depth": max_depth,
        "entries": [asdict(e) for e in aggregate],
        "summary": summary,
    }
    out_path = tools_root / "impact-graphs" / f"{fingerprint}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    # Plan 019 Phase 7.5 (operator critique #5+#6) — governance event is
    # the SSoT for unknown_count. Adding source_breakdown lets the
    # dashboard render per-source coverage without re-reading the local
    # impact-graphs/ runtime artifact (now gitignored per Phase 0.3).
    append_tools_governance(
        tools_root,
        "impact_graph_computed",
        {
            "fingerprint": fingerprint,
            "entry_count": summary["entry_count"],
            "unknown_count": summary["by_status"].get("unknown", 0),
            "known_count": summary["by_status"].get("known", 0),
            "explicitly_blocked_count": summary["by_status"].get("explicitly_blocked", 0),
            "source_breakdown": dict(summary["by_source"]),
            "max_depth_reached": summary["max_depth_reached"],
            "intended_files": list(intended_files),
            "path": out_path.relative_to(tools_root).as_posix(),
        },
    )
    return payload


def _intended_fingerprint(intended_files: list[str]) -> str:
    import hashlib

    canonical = "\n".join(sorted(intended_files))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
