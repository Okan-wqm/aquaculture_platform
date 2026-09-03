"""Plan 033 Faz 033c — the Asset & Attack Graph (versioned, content-addressed).

WHY: findings need a map — which principal reaches which endpoint reaches which
datastore/tenant boundary. The graph is DERIVED from the profile + a bounded repo
scan; every edge carries evidence + an epistemic status (OBSERVED vs INFERRED), so a
guess is never mistaken for a proven path.

Versioning: a snapshot is bound to (repo_sha, profile_digest, pack_digests,
built_at, staleness_horizon). A campaign that selects a graph digest turns the graph
into a write-driving input; a rebuild cannot silently change that campaign, and a
graph older than its horizon is STALE and may not drive a campaign.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now

GRAPH_SURFACE = "security_attack_graph"
GRAPH_RELPATH: tuple[str, ...] = ("security", "attack-graph.jsonl")
GRAPH_ARTIFACT_RELDIR: tuple[str, ...] = ("security", "attack-graph-store")
NODE_KINDS = ("principal", "endpoint", "service", "datastore", "broker", "tenant_boundary", "external")
EDGE_KINDS = ("authenticates", "invokes", "reads", "writes", "crosses")
EPISTEMIC = ("OBSERVED", "INFERRED")
DEFAULT_STALENESS_HORIZON_SECONDS = 24 * 3600
_ROUTE_RE = re.compile(r"@(Get|Post|Put|Patch|Delete|Query|Mutation)\s*\(")


@dataclass(frozen=True)
class Node:
    node_id: str
    kind: str
    label: str


@dataclass(frozen=True)
class Edge:
    src: str
    dst: str
    kind: str
    epistemic: str
    evidence: tuple[str, ...] = ()


@dataclass(frozen=True)
class AttackGraphSnapshot:
    repo_sha: str
    profile_digest: str
    pack_digests: tuple[str, ...]
    nodes: tuple[Node, ...]
    edges: tuple[Edge, ...]
    graph_digest: str
    built_at: str
    staleness_horizon_seconds: int = DEFAULT_STALENESS_HORIZON_SECONDS

    def to_artifact(self) -> dict[str, Any]:
        return {
            "schema_version": 1, "repo_sha": self.repo_sha, "profile_digest": self.profile_digest,
            "pack_digests": list(self.pack_digests), "built_at": self.built_at,
            "staleness_horizon_seconds": self.staleness_horizon_seconds, "graph_digest": self.graph_digest,
            "nodes": [asdict(n) for n in self.nodes], "edges": [asdict(e) for e in self.edges],
        }

    def index_row(self) -> dict[str, Any]:
        return {
            "schema_version": 1, "recorded_at": utc_now(), "graph_digest": self.graph_digest,
            "repo_sha": self.repo_sha, "profile_digest": self.profile_digest, "pack_digests": list(self.pack_digests),
            "built_at": self.built_at, "staleness_horizon_seconds": self.staleness_horizon_seconds,
            "node_count": len(self.nodes), "edge_count": len(self.edges),
        }


def _claim(profile_row: dict[str, Any], key: str) -> Any:
    for c in profile_row.get("claims", []):
        if c.get("key") == key:
            return c.get("value")
    return None


def _endpoints(root: Path, service: str, cap: int = 80) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    base = root / "apps" / service
    if not base.is_dir():
        return hits
    for path in itertools.islice(itertools.chain(base.glob("**/*.controller.ts"), base.glob("**/*.resolver.ts")), cap):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:200_000]
        except OSError:
            continue
        for m in _ROUTE_RE.finditer(text):
            hits.append((m.group(1), path.relative_to(root).as_posix()))
    return hits[:cap]


def build_graph(*, workspace_root: str | Path, profile_row: dict[str, Any], pack_digests: tuple[str, ...] = (),
                staleness_horizon_seconds: int = DEFAULT_STALENESS_HORIZON_SECONDS) -> AttackGraphSnapshot:
    root = Path(workspace_root).resolve()
    nodes: dict[str, Node] = {}
    edges: list[Edge] = []

    def add(node: Node) -> str:
        nodes.setdefault(node.node_id, node)
        return node.node_id

    anon = add(Node("principal:anonymous", "principal", "anonymous internet caller"))
    tenant_user = add(Node("principal:tenant_user", "principal", "authenticated tenant user"))
    isolation = _claim(profile_row, "isolation_strategy")
    if isolation in ("row_level_security", "hybrid", "schema_per_tenant"):
        boundary = add(Node("tenant_boundary:db", "tenant_boundary", f"tenant boundary ({isolation})"))
    else:
        boundary = None
    for datastore in _claim(profile_row, "datastores_and_brokers") or []:
        kind = "broker" if datastore in ("redis", "nats", "mqtt") else "datastore"
        add(Node(f"{kind}:{datastore}", kind, datastore))
    for service in _claim(profile_row, "services") or []:
        svc = add(Node(f"service:{service}", "service", service))
        eps = _endpoints(root, service)
        for verb, ref in eps:
            ep = add(Node(f"endpoint:{service}:{verb}:{ref}", "endpoint", f"{verb} {ref}"))
            caller = anon if verb in ("Get", "Query") else tenant_user
            edges.append(Edge(caller, ep, "invokes", "OBSERVED", (ref,)))
            edges.append(Edge(ep, svc, "invokes", "OBSERVED", (ref,)))
        # inferred: a service that has any endpoint reaches the datastores + crosses the tenant boundary
        for node_id, node in list(nodes.items()):
            if node.kind in ("datastore", "broker"):
                edges.append(Edge(svc, node_id, "reads", "INFERRED"))
        if boundary and eps:
            edges.append(Edge(svc, boundary, "crosses", "INFERRED"))
    node_tuple = tuple(sorted(nodes.values(), key=lambda n: n.node_id))
    edge_tuple = tuple(sorted(set(edges), key=lambda e: (e.src, e.dst, e.kind)))
    repo_sha = str(_claim(profile_row, "__repo_sha") or profile_row.get("repo_sha") or "unknown")
    profile_digest = str(profile_row.get("profile_digest") or "unknown")
    payload = {"repo_sha": repo_sha, "profile_digest": profile_digest, "pack_digests": sorted(pack_digests),
               "nodes": [asdict(n) for n in node_tuple], "edges": [asdict(e) for e in edge_tuple]}
    digest = "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
    return AttackGraphSnapshot(
        repo_sha=repo_sha, profile_digest=profile_digest, pack_digests=tuple(sorted(pack_digests)),
        nodes=node_tuple, edges=edge_tuple, graph_digest=digest, built_at=utc_now(),
        staleness_horizon_seconds=staleness_horizon_seconds,
    )


def record_graph(snapshot: AttackGraphSnapshot, *, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Store the full graph as a content-addressed artifact; the ledger keeps digest + counts."""
    root = ensure_tools_dir(base_dir)
    store = root.joinpath(*GRAPH_ARTIFACT_RELDIR)
    store.mkdir(parents=True, exist_ok=True)
    (store / f"{snapshot.graph_digest.replace(':', '_')}.json").write_text(
        json.dumps(snapshot.to_artifact(), sort_keys=True), encoding="utf-8")
    path = root.joinpath(*GRAPH_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, snapshot.index_row(), expected_surface=GRAPH_SURFACE)


def load_graph_artifact(graph_digest: str, *, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    path = ensure_tools_dir(base_dir).joinpath(*GRAPH_ARTIFACT_RELDIR, f"{graph_digest.replace(':', '_')}.json")
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def latest_graph_row(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    path = ensure_tools_dir(base_dir).joinpath(*GRAPH_RELPATH)
    if not path.exists():
        return None
    rows = load_declared_jsonl(path, expected_surface=GRAPH_SURFACE)
    return rows[-1] if rows else None


def is_stale(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    stamp = now or datetime.now(timezone.utc)
    try:
        built = datetime.fromisoformat(str(row.get("built_at")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True
    return (stamp - built).total_seconds() > int(row.get("staleness_horizon_seconds") or DEFAULT_STALENESS_HORIZON_SECONDS)


__all__ = [
    "DEFAULT_STALENESS_HORIZON_SECONDS", "EDGE_KINDS", "EPISTEMIC", "GRAPH_ARTIFACT_RELDIR",
    "GRAPH_RELPATH", "GRAPH_SURFACE", "NODE_KINDS", "AttackGraphSnapshot", "Edge", "Node",
    "build_graph", "is_stale", "latest_graph_row", "load_graph_artifact", "record_graph",
]
