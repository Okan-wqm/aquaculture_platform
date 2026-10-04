"""Wire semantics for the ARIA mechanical drift scan.

WHY: a UI value is right only if it equals what the transport carrying it
accepts. Over GraphQL that is the enum KEY (NestJS ``registerEnumType``
puts keys on the wire, not the TypeScript initializers); into the database
or a REST body it is the runtime VALUE. The scan used to lower-case both
sides and keep keys only, so an hr-module filter sending ``pending`` to a
wire that carries ``PENDING`` looked fine, while a farm-module subset whose
missing value hr-service owns was reported as a cross-service HIGH drift.

WHAT: the facts that comparison needs, read from the COMPOSED supergraph —
the artifact ``scripts/ci/validate-graphql-operations.mjs`` validates
against, written by ``scripts/apollo-router/build-supergraph.mjs`` at
``dist/graphql/supergraph.graphql`` — plus the subgraph registry that maps a
graph to its ``apps/<project>``:

  * per enum: owning services (``@join__type``) and per-value owners
    (``@join__enumValue``);
  * per root field: owning services (``@join__field``), so a UI module maps
    to the backends its GraphQL operations actually hit;
  * a literal index of ``apps/<svc>`` source, the owner evidence for values
    the wire does not carry (event-contract unions, REST bodies).

Missing or unparseable inputs yield ``Wire(status="unavailable")`` with a
named reason; every comparison that needs the wire is then reported
unverifiable under that reason — never silently matched, never guessed.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from pathlib import Path
from typing import Callable

SUPERGRAPH_REL = "dist/graphql/supergraph.graphql"
SUBGRAPHS_REL = "infrastructure/apollo-router/subgraphs.json"
SEVERITY_RANK = {"LOW": 1, "MEDIUM": 2, "HIGH": 3}
_ROOT_OF = {"query": "Query", "mutation": "Mutation", "subscription": "Subscription"}
_OP_HEAD = re.compile(
    r"\b(query|mutation|subscription)\b\s*(?:[A-Za-z_]\w*)?\s*"
    r"(?:\((?:[^()]|\([^()]*\))*\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*\{"
)
_LITERAL = re.compile(r"['\"]([A-Za-z0-9_.:-]{1,64})['\"]")


@dataclasses.dataclass
class Wire:
    status: str  # "ok" | "unavailable"
    reason: str = ""
    supergraph: str = ""
    sha256: str = ""
    enums: dict[str, dict] = dataclasses.field(default_factory=dict)
    root_fields: dict[str, set[str]] = dataclasses.field(default_factory=dict)
    module_backends: dict[str, set[str]] = dataclasses.field(default_factory=dict)
    value_owners: dict[str, set[str]] = dataclasses.field(default_factory=dict)

    def summary(self) -> dict:
        return {
            "status": self.status, "reason": self.reason, "supergraph": self.supergraph,
            "sha256_first16": self.sha256[:16], "enums": len(self.enums),
            "root_fields": len(self.root_fields),
            "module_backends": {m: sorted(s) for m, s in sorted(self.module_backends.items())},
        }


class _Unavailable(Exception):
    pass


def _strip_descriptions(sdl: str) -> str:
    sdl = re.sub(r'"""[\s\S]*?"""', " ", sdl)
    return re.sub(r'^\s*"(?:[^"\\\n]|\\.)*"\s*$', " ", sdl, flags=re.M)


def _graph_services(sdl: str, registry: dict) -> dict[str, str]:
    block = re.search(r"^enum\s+join__Graph\s*\{([^}]*)\}", sdl, re.M)
    if not block:
        raise _Unavailable("supergraph_unparseable:no_join__Graph")
    projects = {
        s.get("name"): s.get("nxProject") or s.get("serviceId")
        for s in registry.get("subgraphs") or []
    }
    out: dict[str, str] = {}
    for graph, name in re.findall(r"([A-Za-z_]\w*)\s+@join__graph\(\s*name:\s*\"([^\"]+)\"", block.group(1)):
        if not projects.get(name):
            raise _Unavailable(f"subgraph_unregistered:{name}")
        out[graph] = f"apps/{projects[name]}"
    if not out:
        raise _Unavailable("supergraph_unparseable:empty_join__Graph")
    return out


def _services(graphs: list[str], by_graph: dict[str, str]) -> set[str]:
    return {by_graph[g] for g in graphs if g in by_graph}


def _parse_enums(sdl: str, by_graph: dict[str, str]) -> dict[str, dict]:
    enums: dict[str, dict] = {}
    for m in re.finditer(r"^enum\s+(\w+)([^{]*)\{([^}]*)\}", sdl, re.M):
        name, head, body = m.groups()
        if name.startswith(("join__", "link__")):
            continue
        owners = _services(re.findall(r"@join__type\(\s*graph:\s*(\w+)", head), by_graph)
        values: dict[str, set[str]] = {}
        for vm in re.finditer(r"([A-Za-z_]\w*)((?:\s*@[A-Za-z_]\w*(?:\([^)]*\))?)*)", body):
            graphs = re.findall(r"@join__enumValue\(\s*graph:\s*(\w+)", vm.group(2))
            values[vm.group(1)] = _services(graphs, by_graph) if graphs else set(owners)
        enums[name] = {"owners": owners, "values": values}
    return enums


def _parse_root_fields(sdl: str, by_graph: dict[str, str]) -> dict[str, set[str]]:
    roots: dict[str, set[str]] = {}
    for m in re.finditer(r"^type\s+(Query|Mutation|Subscription)\b([^{]*)\{", sdl, re.M):
        type_owners = _services(re.findall(r"@join__type\(\s*graph:\s*(\w+)", m.group(2)), by_graph)
        end = sdl.find("\n}", m.end())
        fields: list[tuple[str, str]] = []
        depth = 0
        for line in sdl[m.end():end if end >= 0 else len(sdl)].splitlines():
            head = re.match(r"\s*([A-Za-z_]\w*)\s*[(:]", line) if depth == 0 else None
            if head:
                fields.append((head.group(1), line))
            elif fields:
                fields[-1] = (fields[-1][0], fields[-1][1] + "\n" + line)
            depth += line.count("(") - line.count(")")
        for name, text in fields:
            graphs = re.findall(r"@join__field\(\s*graph:\s*(\w+)", text)
            roots[f"{m.group(1)}.{name}"] = _services(graphs, by_graph) if graphs else set(type_owners)
    return roots


def operation_root_fields(doc: str) -> list[tuple[str, str]]:
    """``(Query|Mutation|Subscription, field)`` for every operation in ``doc``.

    ``${...}`` interpolations (fragment injection) and comments are blanked
    first; aliases resolve to the field they alias; spreads and directives
    at the root are not fields.
    """
    doc = re.sub(r"#[^\n]*", " ", re.sub(r"\$\{[^}]*\}", " ", doc))
    out: list[tuple[str, str]] = []
    for m in _OP_HEAD.finditer(doc):
        depth, paren, chars = 1, 0, []
        for c in doc[m.end():]:
            if c == "(":
                paren += 1
            elif c == ")":
                paren -= 1
            elif not paren and c in "{}":
                depth += 1 if c == "{" else -1
            if not depth:
                break
            chars.append(c if depth == 1 and not paren and c not in "(){}" else " ")
        top = re.sub(r"\.\.\.\s*(?:on\s+)?[A-Za-z_]\w*|@[A-Za-z_]\w*", " ", "".join(chars))
        for f in re.finditer(r"([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_]\w*))?", top):
            out.append((_ROOT_OF[m.group(1)], f.group(2) or f.group(1)))
    return out


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _module_backends(repo_root: Path, fates: list, roots: dict[str, set[str]],
                     service_of: Callable[[str], str], surface_of: Callable[[str], str]) -> dict[str, set[str]]:
    backends: dict[str, set[str]] = {}
    for f in fates:
        if not f.path.startswith("web/") or surface_of(f.path) not in {"frontend_ui", "frontend_source"}:
            continue
        if not f.path.endswith((".ts", ".tsx", ".graphql", ".gql")) or f.path.endswith(".d.ts"):
            continue
        module = service_of(f.path)
        text = _read(repo_root / f.path)
        docs = [text] if f.path.endswith((".graphql", ".gql")) else re.findall(r"`([^`]*)`", text)
        for doc in docs:
            if not re.search(r"\b(?:query|mutation|subscription)\b", doc):
                continue
            for root, field in operation_root_fields(doc):
                backends.setdefault(module, set()).update(roots.get(f"{root}.{field}", set()))
    return {m: s for m, s in backends.items() if s and m != "unknown"}


def _value_owners(repo_root: Path, fates: list, service_of: Callable[[str], str],
                  surface_of: Callable[[str], str]) -> dict[str, set[str]]:
    owners: dict[str, set[str]] = {}
    for f in fates:
        if not f.path.endswith(".ts") or surface_of(f.path) != "backend_app":
            continue
        service = service_of(f.path)
        for literal in set(_LITERAL.findall(_read(repo_root / f.path))):
            owners.setdefault(literal, set()).add(service)
    return owners


def load_wire(repo_root: Path, fates: list, supergraph: str | None = None, *,
              service_of: Callable[[str], str], surface_of: Callable[[str], str]) -> Wire:
    path = Path(supergraph) if supergraph else repo_root / SUPERGRAPH_REL
    shown = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
    if not path.is_file():
        return Wire("unavailable", "supergraph_not_found", shown)
    try:
        registry = json.loads((repo_root / SUBGRAPHS_REL).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return Wire("unavailable", "subgraph_registry_not_found", shown)
    except (OSError, ValueError):
        return Wire("unavailable", "subgraph_registry_unparseable", shown)
    raw = path.read_text(encoding="utf-8", errors="replace")
    try:
        by_graph = _graph_services(raw, registry)
    except _Unavailable as exc:
        return Wire("unavailable", str(exc), shown)
    sdl = _strip_descriptions(raw)
    roots = _parse_root_fields(sdl, by_graph)
    if not roots:
        return Wire("unavailable", "supergraph_unparseable:no_root_fields", shown)
    return Wire(
        "ok", "", shown, hashlib.sha256(raw.encode()).hexdigest(), _parse_enums(sdl, by_graph), roots,
        _module_backends(repo_root, fates, roots, service_of, surface_of),
        _value_owners(repo_root, fates, service_of, surface_of),
    )


def classify_ui_pair(ui_values: set[str], source: dict, wire: Wire,
                     ui_module: str, source_service: str) -> dict:
    """Verdict for one UI option group against one related value set.

    GraphQL transport (the source enum is on the wire and owned by a
    subgraph this UI module's operations hit): compare against the wire
    values. A source owned by such a service but not on the wire is not
    what this UI sends (``source_not_on_ui_transport``). Otherwise DB/REST
    transport: compare against runtime values. Exact, case-sensitive.
    """
    if wire.status != "ok":
        return {"verdict": "unverifiable", "reason": f"wire_unverifiable:{wire.reason}"}
    backends = wire.module_backends.get(ui_module, set())
    if not backends:
        return {"verdict": "unverifiable", "reason": "wire_unverifiable:ui_backend_unmapped"}
    gql = source.get("graphql_name")
    wire_enum = wire.enums.get(gql) if gql else None
    owners = set(wire_enum["owners"]) if wire_enum else (
        {source_service} if source_service.startswith("apps/") else set())
    if gql and owners & backends:
        transport = "graphql"
        domain = dict(wire_enum["values"]) if wire_enum else {
            k: {source_service} for k in source.get("wire_values") or []}
    elif owners & backends:
        return {"verdict": "source_not_on_ui_transport", "reason": "source_not_on_ui_transport"}
    else:
        transport = "db" if source.get("kind") == "sql_enum" else "rest"
        domain = {v: set(owners) or wire.value_owners.get(v, set()) for v in source.get("values") or []}
    source_owners = owners or set().union(*domain.values())
    not_on_wire = sorted(ui_values - set(domain))
    missing = sorted(set(domain) - ui_values)
    own_missing = [v for v in missing if domain[v] & backends]
    if not_on_wire:
        verdict, severity = "ui_value_not_on_wire", "HIGH"
    elif own_missing:
        verdict, severity = "own_service_subset", "LOW"
    else:
        verdict, severity = ("foreign_service_subset" if missing else "match"), None
    return {
        "verdict": verdict, "reason": verdict, "severity": severity, "transport": transport,
        "not_on_wire": not_on_wire, "missing_in_ui": missing, "own_missing": own_missing,
        "ui_backends": sorted(backends), "source_owners": sorted(source_owners),
        "cross_service": not (source_owners & backends),
    }
